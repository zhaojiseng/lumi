import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import net from 'node:net';
import { gzipSync } from 'node:zlib';
import { once } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';
import { createGateway } from '../dev/transport.mjs';

const CLIENT_KEY = 'fixture-client-key-0123456789';
const UPSTREAM_KEY = 'fixture-upstream-key-9876543210';

function fakeEngine(prepare) {
  const calls = { prepare: [], observe: [], finish: [] };
  return {
    calls,
    async request(method, input) {
      assert.ok(method === 'prepare' || method === 'observe' || method === 'finish');
      calls[method].push(input);
      if (method === 'prepare') return prepare ? prepare(input) : { bodyB64: input.bodyB64, modified: false };
      if (method === 'observe') return { observedBytes: input.offsetBytes + input.segments.reduce((count, segment) => count + Buffer.from(segment.dataB64, 'base64').length, 0) };
      return { saved: true };
    },
  };
}
async function fixture(t, handler, overrides = {}) {
  const upstream = http.createServer(handler);
  upstream.listen(0, '127.0.0.1');
  await once(upstream, 'listening');
  const engine = overrides.engine ?? fakeEngine();
  const config = {
    schemaVersion: 1, listen: '127.0.0.1:0', maxRequestBytes: 2 * 1024 * 1024,
    maxConcurrency: 32, recording: { bodies: false }, rules: [],
    routes: [{ id: 'test', client: 'codex', upstream: 'http://127.0.0.1:' + upstream.address().port + '/v1', protocol: 'openai' }],
    ...overrides.config,
  };
  const gateway = await createGateway({ config, routeSecrets: overrides.routeSecrets ?? [
    { routeId: 'test', clientKey: CLIENT_KEY, upstreamKey: UPSTREAM_KEY },
  ], engine, drainTimeoutMs: overrides.drainTimeoutMs ?? 50 });
  t.after(async () => {
    await gateway.stop();
    upstream.closeAllConnections();
    await new Promise(resolve => upstream.close(resolve));
  });
  return { gateway, upstream, engine, config };
}
function send(gateway, options = {}) {
  return new Promise((resolve, reject) => {
    const body = options.body ?? Buffer.from('{"model":"fixture"}');
    const req = http.request('http://' + gateway.address, {
      path: options.path ?? '/test/v1/responses', method: options.method ?? 'POST', agent: false,
      headers: Object.fromEntries(Object.entries({
        authorization: 'Bearer ' + CLIENT_KEY, 'content-type': 'application/json',
        ...(!options.chunks ? { 'content-length': String(body.length) } : {}),
        ...(options.headers ?? {}),
      }).filter(([, value]) => value !== undefined)),
    }, res => {
      const chunks = [];
      res.on('data', chunk => chunks.push(chunk));
      res.once('error', reject);
      res.once('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }));
    });
    req.once('error', reject);
    if (options.chunks) { for (const chunk of options.chunks) req.write(chunk); req.end(); }
    else req.end(body);
  });
}
async function readRequest(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  return Buffer.concat(chunks);
}
async function waitFor(predicate, label) {
  const deadline = Date.now() + 2000;
  while (!predicate()) {
    assert.ok(Date.now() < deadline, label);
    await delay(5);
  }
}
async function raw(gateway, request) {
  const socket = net.connect(Number(gateway.address.split(':').at(-1)), '127.0.0.1');
  await once(socket, 'connect');
  const chunks = [];
  socket.on('data', chunk => chunks.push(chunk));
  socket.write(request);
  await once(socket, 'end');
  socket.destroy();
  return Buffer.concat(chunks).toString('utf8');
}

test('actual upstream receives engine rewrite, fixed path and only its own credential', async t => {
  const received = [];
  const engine = fakeEngine(input => {
    const value = JSON.parse(Buffer.from(input.bodyB64, 'base64'));
    value.service_tier = 'priority';
    return { bodyB64: Buffer.from(JSON.stringify(value)).toString('base64'), modified: true };
  });
  const { gateway } = await fixture(t, async (req, res) => {
    received.push({ headers: req.headers, url: req.url, body: await readRequest(req) });
    res.writeHead(201, { 'content-type': 'application/json', 'x-request-id': 'upstream-fixture-id', 'set-cookie': 'must-not-forward=1' });
    res.end('{"service_tier":"default"}');
  }, { engine });
  const result = await send(gateway, {
    body: Buffer.from('{"model":"fixture","service_tier":"old"}'),
    headers: {
      cookie: 'secret-cookie', 'proxy-authorization': 'secret-proxy', 'x-local-key': CLIENT_KEY,
      'x-untrusted-header': 'never-forward', connection: 'x-client-request-id', 'x-client-request-id': 'drop-me',
    },
  });
  assert.equal(result.status, 201);
  assert.equal(result.headers['x-request-id'], 'upstream-fixture-id');
  assert.equal(result.headers['set-cookie'], undefined);
  assert.equal(result.body.toString(), '{"service_tier":"default"}');
  assert.equal(received.length, 1);
  assert.equal(received[0].url, '/v1/responses');
  assert.equal(JSON.parse(received[0].body).service_tier, 'priority');
  assert.equal(received[0].headers.authorization, 'Bearer ' + UPSTREAM_KEY);
  for (const header of ['cookie', 'proxy-authorization', 'x-local-key', 'x-untrusted-header', 'x-client-request-id']) {
    assert.equal(received[0].headers[header], undefined);
  }
  assert.ok(!JSON.stringify(received[0].headers).includes(CLIENT_KEY));
  assert.equal(Number(received[0].headers['content-length']), received[0].body.length);
  await waitFor(() => engine.calls.finish.length === 1, 'finish should be sent');
  assert.equal(engine.calls.finish[0].status, 'completed');
  assert.equal(engine.calls.prepare[0].requestId, engine.calls.finish[0].requestId);
});

test('preserve transmits exact body bytes and upstream errors without retrying or downgrading tier', async t => {
  const bodies = [];
  const { gateway, engine } = await fixture(t, async (req, res) => {
    bodies.push(await readRequest(req));
    res.writeHead(429, { 'content-type': 'application/json', 'retry-after': '7' });
    res.end('{"error":"tier rejected"}');
  });
  const body = Buffer.from(' \n{"n":123456789012345678901234567890,"service_tier":"custom"}\t');
  const result = await send(gateway, { body });
  assert.equal(result.status, 429);
  assert.equal(result.headers['retry-after'], '7');
  assert.equal(result.body.toString(), '{"error":"tier rejected"}');
  assert.equal(bodies.length, 1);
  assert.deepEqual(bodies[0], body);
  await waitFor(() => engine.calls.finish.length === 1, 'finish should be sent');
  assert.equal(engine.calls.finish[0].status, 'upstream-error');
});

test('SSE first chunk is delivered while upstream remains open and UTF-8 bytes stay exact', async t => {
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  const first = Buffer.from('data: {"text":"你');
  const rest = Buffer.from('好"}\n\ndata: [DONE]\n\n');
  const { gateway, engine } = await fixture(t, async (req, res) => {
    await readRequest(req);
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    // Intentionally split one multibyte character across upstream writes.
    res.write(first.subarray(0, first.length - 1));
    await gate;
    res.write(first.subarray(first.length - 1));
    res.end(rest);
  });
  const chunks = [];
  let firstResolve;
  const firstSeen = new Promise(resolve => { firstResolve = resolve; });
  const done = new Promise((resolve, reject) => {
    const req = http.request('http://' + gateway.address + '/test/v1/responses', {
      method: 'POST', agent: false, headers: { authorization: 'Bearer ' + CLIENT_KEY, 'content-type': 'application/json' },
    }, res => {
      res.on('data', chunk => { chunks.push(chunk); firstResolve(); });
      res.once('end', resolve);
      res.once('error', reject);
    });
    req.once('error', reject);
    req.end('{}');
  });
  await firstSeen;
  assert.equal(engine.calls.finish.length, 0);
  assert.deepEqual(Buffer.concat(chunks), first.subarray(0, first.length - 1));
  release();
  await done;
  assert.deepEqual(Buffer.concat(chunks), Buffer.concat([first, rest]));
  await waitFor(() => engine.calls.finish.length === 1, 'SSE finish should be sent');
  const finish = engine.calls.finish[0];
  assert.equal(finish.responseIsSse, true);
  assert.equal(finish.recordingPartial, false);
  assert.deepEqual(Buffer.concat(finish.segments.map(segment => Buffer.from(segment.dataB64, 'base64'))), Buffer.concat([first, rest]));
});

test('recording capture stops at one MiB while all response bytes continue to the client', async t => {
  const payload = Buffer.alloc(1024 * 1024 + 23456, 0x61);
  const { gateway, engine } = await fixture(t, async (req, res) => {
    await readRequest(req);
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(payload);
  });
  const result = await send(gateway);
  assert.deepEqual(result.body, payload);
  await waitFor(() => engine.calls.finish.length === 1, 'large response finish should be sent');
  const finish = engine.calls.finish[0];
  assert.equal(finish.responseBytes, payload.length);
  assert.equal(finish.recordingPartial, true);
  assert.equal(finish.segments.reduce((total, segment) => total + Buffer.from(segment.dataB64, 'base64').length, 0), 1024 * 1024);
  assert.equal(finish.streamingObservation, true);
  assert.equal(finish.observationPartial, false);
  assert.equal(engine.calls.observe.reduce((total, call) => total + call.segments.reduce((bytes, segment) => bytes + Buffer.from(segment.dataB64, 'base64').length, 0), 0), payload.length);
  for (const call of engine.calls.observe) assert.ok(call.segments.reduce((bytes, segment) => bytes + Buffer.from(segment.dataB64, 'base64').length, 0) <= 64 * 1024);
});

test('a stalled observer has bounded in-flight work and cannot prevent complete response forwarding', async t => {
  const engine = fakeEngine();
  const original = engine.request;
  let attempts = 0;
  engine.request = async (method, input) => {
    if (method === 'observe') { attempts += 1; return new Promise(() => {}); }
    return original(method, input);
  };
  const payload = Buffer.alloc(3 * 1024 * 1024, 'x');
  const {gateway} = await fixture(t, async (req, res) => { await readRequest(req);res.writeHead(200, {'content-type':'text/event-stream'});res.end(payload); }, {engine});
  const started=Date.now();const result=await send(gateway);assert.deepEqual(result.body,payload);
  assert.ok(Date.now()-started<2500,'observation timeout must resume original response forwarding');
  await waitFor(()=>engine.calls.finish.length===1,'observation gap must finish once');
  assert.equal(attempts,1);
  assert.equal(engine.calls.finish[0].observationPartial,true);
  assert.equal(engine.calls.finish[0].responseBytes,payload.length);
  assert.equal(engine.calls.finish[0].streamingObservation,true);
});

test('a slow local observer applies bounded backpressure and resumes without losing tail bytes', async t => {
  const engine=fakeEngine(),original=engine.request;
  let active=0,maximum=0;
  engine.request=async(method,input)=>{
    if(method!=='observe')return original(method,input);
    active+=1;maximum=Math.max(maximum,active);
    await delay(35);
    try{return await original(method,input);}finally{active-=1;}
  };
  const first=Buffer.from('data: {"type":"response.output_text.delta","delta":"first"}\n\n');
  const tail=Buffer.from('data: {"type":"response.completed","response":{"service_tier":"flex","usage":{"output_tokens":53}}}\n\n');
  const payload=Buffer.concat([first,...Array(300).fill(Buffer.from(': '+ 'x'.repeat(4096)+'\n\n')),tail]);
  const {gateway}=await fixture(t,async(req,res)=>{
    await readRequest(req);res.writeHead(200,{'content-type':'text/event-stream'});
    for(let start=0;start<payload.length;start+=16003){if(!res.write(payload.subarray(start,start+16003)))await once(res,'drain');}res.end();
  },{engine});
  assert.deepEqual((await send(gateway)).body,payload);
  await waitFor(()=>engine.calls.finish.length===1,'slow observer should drain before the single finish');
  assert.equal(maximum,1);
  assert.equal(engine.calls.finish[0].observationPartial,false);
  const observed=Buffer.concat(engine.calls.observe.flatMap(call=>call.segments.map(segment=>Buffer.from(segment.dataB64,'base64'))));
  assert.deepEqual(observed,payload);assert.ok(observed.subarray(-tail.length).equals(tail));
});

test('client pause and observation pressure resume independently while preserving the entire stream', async t => {
  const engine=fakeEngine(),original=engine.request;
  let active=0,maximum=0;
  engine.request=async(method,input)=>{
    if(method!=='observe')return original(method,input);
    active+=1;maximum=Math.max(maximum,active);await delay(6);
    try{return await original(method,input);}finally{active-=1;}
  };
  const unit=Buffer.from('data: {"type":"response.output_text.delta","delta":"'+ '流🙂'.repeat(700)+'"}\n\n');
  const tail=Buffer.from('data: {"type":"response.completed","response":{"usage":{"output_tokens":83}}}\n\n');
  const payload=Buffer.concat([...Array(1400).fill(unit),tail]);
  const {gateway}=await fixture(t,async(req,res)=>{
    await readRequest(req);res.writeHead(200,{'content-type':'text/event-stream'});
    for(let start=0;start<payload.length;start+=32761){if(!res.write(payload.subarray(start,start+32761)))await once(res,'drain');}res.end();
  },{engine});
  const result=await new Promise((resolve,reject)=>{
    const body=Buffer.from('{"model":"pressure-fixture"}');
    const req=http.request('http://'+gateway.address+'/test/v1/responses',{method:'POST',agent:false,headers:{authorization:'Bearer '+CLIENT_KEY,'content-type':'application/json','content-length':body.length}},res=>{
      const chunks=[];let paused=false;
      res.on('data',chunk=>{chunks.push(chunk);if(!paused){paused=true;res.pause();setTimeout(()=>res.resume(),150);}});
      res.once('error',reject);res.once('end',()=>resolve(Buffer.concat(chunks)));
    });req.once('error',reject);req.end(body);
  });
  assert.deepEqual(result,payload);
  await waitFor(()=>engine.calls.finish.length===1,'client/observer pressure should finish once');
  assert.equal(maximum,1);assert.equal(engine.calls.finish[0].observationPartial,false);
  assert.equal(engine.calls.finish[0].responseBytes,payload.length);
  assert.deepEqual(Buffer.concat(engine.calls.observe.flatMap(call=>call.segments.map(segment=>Buffer.from(segment.dataB64,'base64')))),payload);
});

test('client cancellation closes upstream and records one terminal result without retries', async t => {
  let requests = 0;
  let upstreamClosed = false;
  const { gateway, engine } = await fixture(t, async (req, res) => {
    requests += 1;
    await readRequest(req);
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.write('data: {"text":"partial"}\n\n');
    res.once('close', () => { upstreamClosed = true; });
  });
  await new Promise((resolve, reject) => {
    const req = http.request('http://' + gateway.address + '/test/v1/responses', {
      method: 'POST', agent: false, headers: { authorization: 'Bearer ' + CLIENT_KEY },
    }, res => {
      res.once('data', () => { res.destroy(); req.destroy(); resolve(); });
      res.on('error', () => {});
    });
    req.once('error', reject);
    req.end('{}');
  });
  await waitFor(() => upstreamClosed && engine.calls.finish.length === 1, 'cancellation should propagate');
  assert.equal(requests, 1);
  assert.equal(engine.calls.finish[0].status, 'client-aborted');
  assert.equal(engine.calls.finish[0].recordingPartial, true);
  await delay(20);
  assert.equal(engine.calls.finish.length, 1);
});

test('Host, Origin, route, absolute-target, Upgrade and authentication restrictions fail before upstream', async t => {
  let requests = 0;
  const { gateway, engine } = await fixture(t, (_req, res) => { requests += 1; res.end('{}'); });
  for (const options of [
    { headers: { host: 'localhost:' + gateway.address.split(':').at(-1) }, expected: 403 },
    { headers: { origin: 'null' }, expected: 403 },
    { headers: { origin: 'https://example.test' }, expected: 403 },
    { headers: { authorization: 'Bearer wrong-key' }, expected: 401 },
    { headers: { 'x-api-key': CLIENT_KEY }, expected: 401 },
    { path: '/unknown/v1/responses', expected: 404 },
    { path: '/test/v1/messages', expected: 404 },
    { path: '/test/v1/responses?upstream=https://example.test', expected: 404 },
    { path: 'http://example.test/test/v1/responses', expected: 400 },
    { method: 'GET', expected: 405 },
  ]) {
    const result = await send(gateway, options);
    assert.equal(result.status, options.expected);
  }
  const response = await raw(gateway, 'GET /test/v1/responses HTTP/1.1\r\nHost: ' + gateway.address + '\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n\r\n');
  assert.match(response, /^HTTP\/1\.1 426 /);
  assert.equal(requests, 0);
  assert.equal(engine.calls.prepare.length, 0);
});

test('both declared and streamed body limits reject before preparing or forwarding', async t => {
  let requests = 0;
  const { gateway, engine } = await fixture(t, (_req, res) => { requests += 1; res.end('{}'); }, { config: { maxRequestBytes: 8 } });
  const declared = await send(gateway, { body: Buffer.alloc(9), headers: { 'content-length': '9' } });
  assert.equal(declared.status, 413);
  const streamed = await send(gateway, { chunks: [Buffer.alloc(5), Buffer.alloc(5)] });
  assert.equal(streamed.status, 413);
  assert.equal(requests, 0);
  assert.equal(engine.calls.prepare.length, 0);
});

test('compressed bodies preserve bytes without rewriting rules and reject incompatible explicit rules', async t => {
  const bodies = [];
  const compressed = gzipSync('{"service_tier":"custom"}');
  const { gateway } = await fixture(t, async (req, res) => {
    bodies.push({ body: await readRequest(req), encoding: req.headers['content-encoding'] }); res.end('{}');
  });
  const result = await send(gateway, { body: compressed, headers: { 'content-encoding': 'gzip' } });
  assert.equal(result.status, 200);
  assert.equal(bodies[0].encoding, 'gzip');
  assert.deepEqual(bodies[0].body, compressed);
  let rewriteRequests = 0;
  const rewrite = await fixture(t, (_req, res) => { rewriteRequests += 1; res.end('{}'); }, {
    config: { rules: [{ id: 'tier', enabled: true, match: { model: 'unobservable' }, action: { type: 'override', value: 'priority' } }] },
  });
  assert.equal((await send(rewrite.gateway, { body: compressed, headers: { 'content-encoding': 'gzip' } })).status, 415);
  assert.equal((await send(rewrite.gateway, { body: Buffer.from('{}'), headers: { 'content-type': 'text/plain' } })).status, 415);
  assert.equal(rewriteRequests, 0);
  assert.equal(rewrite.engine.calls.prepare.length, 0);
});

test('Anthropic route replaces x-api-key, preserves payload and ignores tier-rewrite transport restrictions', async t => {
  let received;
  const setup = await fixture(t, async (req, res) => {
    received = { headers: req.headers, body: await readRequest(req), url: req.url };
    res.end('{}');
  });
  const gateway = await createGateway({
    config: {
      ...setup.config,
      routes: [{ ...setup.config.routes[0], protocol: 'anthropic' }],
      rules: [{ id: 'tier', enabled: true, match: {}, action: { type: 'override', value: 'priority' } }],
    },
    routeSecrets: [{ routeId: 'test', clientKey: CLIENT_KEY, upstreamKey: UPSTREAM_KEY }],
    engine: setup.engine, drainTimeoutMs: 50,
  });
  t.after(() => gateway.stop());
  const body = Buffer.from('{"model":"claude-fixture","service_tier":"original"}');
  const result = await send(gateway, {
    path: '/test/v1/messages', body,
    headers: { authorization: undefined, 'x-api-key': CLIENT_KEY, 'anthropic-version': '2023-06-01', 'content-type': 'text/plain' },
  });
  assert.equal(result.status, 200);
  assert.deepEqual(received.body, body);
  assert.equal(received.url, '/v1/messages');
  assert.equal(received.headers['x-api-key'], UPSTREAM_KEY);
  assert.equal(received.headers.authorization, undefined);
  assert.equal(received.headers['anthropic-version'], '2023-06-01');
});

test('concurrency limit counts streams until finish and graceful stop aborts after deadline', async t => {
  let requests = 0;
  const { gateway, engine } = await fixture(t, async (req, res) => {
    requests += 1;
    await readRequest(req);
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.write('data: waiting\n\n');
  }, { config: { maxConcurrency: 1 }, drainTimeoutMs: 50 });
  let response;
  const stream = new Promise((resolve, reject) => {
    const req = http.request('http://' + gateway.address + '/test/v1/responses', {
      method: 'POST', agent: false, headers: { authorization: 'Bearer ' + CLIENT_KEY },
    }, res => { response = res; res.on('error', () => {}); res.once('data', resolve); });
    req.on('error', reject);
    req.end('{}');
  });
  await stream;
  const blocked = await send(gateway);
  assert.equal(blocked.status, 429);
  assert.equal(requests, 1);
  const started = Date.now();
  await gateway.stop();
  assert.ok(Date.now() - started < 1500);
  assert.equal(engine.calls.finish.length, 1);
  assert.equal(engine.calls.finish[0].status, 'execution-unknown');
  assert.equal(engine.calls.finish[0].errorCode, 'gateway-stopping');
  response.destroy();
  await gateway.stop();
});

test('redirect is returned without following and engine failures expose no request details', async t => {
  let requests = 0;
  const { gateway } = await fixture(t, async (req, res) => {
    requests += 1; await readRequest(req); res.writeHead(302, { location: 'http://127.0.0.1:1/unreachable' }); res.end('redirect');
  });
  assert.equal((await send(gateway)).status, 302);
  assert.equal(requests, 1);
  const rejected = await fixture(t, (_req, res) => { requests += 1; res.end('{}'); }, {
    engine: fakeEngine(() => { throw { code: 'invalid-json', status: 400, message: 'secret-body-contents' }; }),
  });
  const result = await send(rejected.gateway, { body: Buffer.from('secret-body-contents') });
  assert.equal(result.status, 400);
  assert.deepEqual(JSON.parse(result.body), { error: { code: 'invalid-json' } });
  assert.equal(requests, 1);
  const failingEngine = fakeEngine();
  const original = failingEngine.request;
  failingEngine.request = async (method, input) => {
    if (method === 'finish') throw new Error('private database error');
    return original(method, input);
  };
  const incomplete = await fixture(t, async (req, res) => { await readRequest(req); res.end('ok'); }, { engine: failingEngine });
  assert.equal((await send(incomplete.gateway)).body.toString(), 'ok');
  await waitFor(() => incomplete.gateway.metrics.recordingFailures === 1, 'recording failure metric');
});

test('unsafe listen, remote HTTP upstream and short route credentials are refused', async () => {
  const base = {
    config: { schemaVersion: 1, listen: '0.0.0.0:0', routes: [{ id: 'test', client: 'codex', upstream: 'https://example.test', protocol: 'openai' }] },
    routeSecrets: [{ routeId: 'test', clientKey: CLIENT_KEY, upstreamKey: UPSTREAM_KEY }], engine: fakeEngine(),
  };
  await assert.rejects(createGateway(base), { code: 'invalid-listen' });
  await assert.rejects(createGateway({ ...base, config: { ...base.config, listen: '127.0.0.1:0', routes: [{ ...base.config.routes[0], upstream: 'http://example.test' }] } }), { code: 'invalid-upstream' });
  await assert.rejects(createGateway({ ...base, config: { ...base.config, listen: '127.0.0.1:0' }, routeSecrets: [{ routeId: 'test', clientKey: 'short', upstreamKey: UPSTREAM_KEY }] }), { code: 'invalid-route-secret' });
});


test('a modified engine result cannot bypass content-encoding validation', async t => {
  let requests = 0;
  const engine = fakeEngine(input => ({ bodyB64: input.bodyB64, modified: true }));
  const { gateway } = await fixture(t, (_req, res) => { requests += 1; res.end('{}'); }, { engine });
  const result = await send(gateway, { body: gzipSync('{}'), headers: { 'content-encoding': 'gzip' } });
  assert.equal(result.status, 415);
  assert.equal(requests, 0);
  await waitFor(() => engine.calls.finish.length === 1, 'rejected prepared request should have one finish');
  assert.equal(engine.calls.finish[0].status, 'gateway-rejected');
});

test('upstream disconnect is execution-unknown and is never retried', async t => {
  let requests = 0;
  const { gateway, engine } = await fixture(t, async (req, res) => {
    requests += 1;
    await readRequest(req);
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.write('data: partial\n\n');
    setTimeout(() => res.destroy(), 10);
  });
  await assert.rejects(send(gateway));
  await waitFor(() => engine.calls.finish.length === 1, 'interrupted upstream should finish once');
  assert.equal(requests, 1);
  assert.equal(engine.calls.finish[0].status, 'execution-unknown');
  assert.equal(engine.calls.finish[0].recordingPartial, true);
});

test('stopping remains bounded when the policy engine stalls and later finishes once if it recovers', async t => {
  let releasePrepare;
  const stalled = new Promise(resolve => { releasePrepare = resolve; });
  const engine = fakeEngine(async input => { await stalled; return { bodyB64: input.bodyB64, modified: false }; });
  let requests = 0;
  const { gateway } = await fixture(t, (_req, res) => { requests += 1; res.end('{}'); }, { engine, drainTimeoutMs: 10 });
  const pending = send(gateway).catch(error => error);
  await waitFor(() => engine.calls.prepare.length === 1, 'prepare should be pending');
  const started = Date.now();
  await gateway.stop();
  assert.ok(Date.now() - started < 1800);
  assert.equal(gateway.metrics.recordingFailures, 1);
  releasePrepare();
  await pending;
  await waitFor(() => engine.calls.finish.length === 1, 'recovered engine should finish once');
  assert.equal(engine.calls.finish[0].status, 'gateway-rejected');
  assert.equal(requests, 0);
});


test('runtime rule replacement refreshes rewrite restrictions without changing forwarding routes', async t => {
 let requests=0;
 const {gateway,config}=await fixture(t,async(req,res)=>{requests++;await readRequest(req);res.end('{}');});
 const next={...config,rules:[{id:'tier',enabled:true,match:{},action:{type:'override',value:'priority'}}]};
 gateway.updateConfig(next);next.rules.length=0; // Caller mutation must not alter the owned snapshot.
 assert.equal((await send(gateway,{headers:{'content-type':'text/plain'}})).status,415);assert.equal(requests,0);
 gateway.updateConfig({...config,rules:[]});assert.equal((await send(gateway,{headers:{'content-type':'text/plain'}})).status,200);assert.equal(requests,1);
 for(const changed of [
  {...config,listen:'127.0.0.1:1'}, {...config,maxConcurrency:1}, {...config,maxRequestBytes:10},
  {...config,routes:[{...config.routes[0],upstream:'http://127.0.0.1:1'}]},
 ])assert.throws(()=>gateway.updateConfig(changed),{code:'gateway-restart-required'});
});

test('requests freeze entry rules while a concurrent config replacement still validates actual modified results', async t => {
 let requests=0;
 const {gateway,config}=await fixture(t,async(req,res)=>{requests++;await readRequest(req);res.end('{}');});
 let responseReady;
 const ready=new Promise(resolve=>{responseReady=resolve;});
 const pending=new Promise((resolve,reject)=>{
  const request=http.request('http://'+gateway.address+'/test/v1/responses',{method:'POST',agent:false,headers:{authorization:'Bearer '+CLIENT_KEY,'content-type':'text/plain','content-length':2}},response=>{
   const chunks=[];response.on('data',chunk=>chunks.push(chunk));response.on('error',reject);response.on('end',()=>resolve({status:response.statusCode,body:Buffer.concat(chunks)}));});
  request.on('error',reject);request.write('{');responseReady(request);
 });
 const request=await ready;await delay(30);
 gateway.updateConfig({...config,rules:[{id:'tier',enabled:true,match:{},action:{type:'override',value:'priority'}}]});request.end('}');
 assert.equal((await pending).status,200);assert.equal(requests,1);
 assert.equal((await send(gateway,{headers:{'content-type':'text/plain'}})).status,415);
 const changedEngine=fakeEngine(input=>({bodyB64:input.bodyB64,modified:true}));
 const changed=await fixture(t,(_req,res)=>{requests++;res.end('{}');},{engine:changedEngine});
 assert.equal((await send(changed.gateway,{headers:{'content-type':'text/plain'}})).status,415);assert.equal(requests,1);
});

test('an explicit serviceTier=false route preserves incompatible bodies under tier rules',async t=>{
 const initial=await fixture(t,(_req,res)=>res.end('{}'));
 let body;
 const upstream=http.createServer(async(req,res)=>{body=await readRequest(req);res.end('{}');});upstream.listen(0,'127.0.0.1');await once(upstream,'listening');
 const gateway=await createGateway({config:{...initial.config,routes:[{...initial.config.routes[0],upstream:'http://127.0.0.1:'+upstream.address().port,serviceTier:false}],rules:[{id:'tier',match:{},action:{type:'override',value:'priority'}}]},routeSecrets:[{routeId:'test',clientKey:CLIENT_KEY,upstreamKey:UPSTREAM_KEY}],engine:fakeEngine(),drainTimeoutMs:10});
 t.after(async()=>{await gateway.stop();upstream.closeAllConnections();await new Promise(resolve=>upstream.close(resolve));});
 const compressed=gzipSync('{}');assert.equal((await send(gateway,{body:compressed,headers:{'content-encoding':'gzip','content-type':'text/plain'}})).status,200);assert.deepEqual(body,compressed);
});

test('cancel stop skips drain and can immediately escalate a pending drain',async t=>{
 for(const escalate of [false,true]){
  const {gateway,engine}=await fixture(t,async(req,res)=>{await readRequest(req);res.writeHead(200,{'content-type':'text/event-stream'});res.write('data: waiting\n\n');},{drainTimeoutMs:5000});
  let response;
  await new Promise((resolve,reject)=>{
   const request=http.request('http://'+gateway.address+'/test/v1/responses',{method:'POST',agent:false,headers:{authorization:'Bearer '+CLIENT_KEY}},res=>{response=res;res.on('error',()=>{});res.once('data',resolve);});request.on('error',reject);request.end('{}');
  });
  assert.throws(()=>gateway.stop({mode:'invalid'}),{code:'invalid-stop-mode'});
  const started=Date.now();const draining=escalate?gateway.stop({mode:'drain'}):undefined;
  await gateway.stop({mode:'cancel'});if(draining)await draining;
  assert.ok(Date.now()-started<1500);assert.equal(engine.calls.finish.length,1);assert.equal(engine.calls.finish[0].errorCode,'gateway-stopping');response.destroy();
 }
});
