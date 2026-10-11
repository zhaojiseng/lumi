import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import path from 'node:path';
import fs from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { once } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';
import { startEngine } from '../dev/engine.mjs';
import { createGateway } from '../dev/transport.mjs';

const repository = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const clientKey = 'fixture-client-key-0123456789';
const upstreamKey = 'fixture-upstream-key-9876543210';
const fixtureBinary = path.join(repository, '.cache', 'gateway-target', 'debug', 'examples',
  'fixture-engine' + (process.platform === 'win32' ? '.exe' : ''));

async function requestBody(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  return Buffer.concat(chunks);
}
function send(gateway, routeId, body, endpoint = '/v1/responses') {
  return new Promise((resolve, reject) => {
    const req = http.request('http://' + gateway.address + '/' + routeId + endpoint, {
      method: 'POST', agent: false,
      headers: { authorization: 'Bearer ' + clientKey, 'content-type': 'application/json', 'content-length': String(body.length) },
    }, res => {
      const chunks = [];
      res.on('data', chunk => chunks.push(chunk));
      res.once('error', reject);
      res.once('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }));
    });
    req.once('error', reject);
    req.end(body);
  });
}
async function recordsReady(engine, expectedCount) {
  const deadline = Date.now() + 3000;
  while (Date.now() < deadline) {
    const records = await engine.request('records', { limit: 20, before: null });
    if (records.length === expectedCount && records.every(record => record.status !== 'forwarding')) return records;
    await delay(10);
  }
  assert.fail('Rust recorder did not reach the expected terminal records');
}

test('HTTP → Rust policy → local upstream → Rust observations and SQLite records', async () => {
  await fs.access(fixtureBinary);
  const parent = path.join(repository, '.cache', 'gateway-e2e');
  await fs.mkdir(parent, { recursive: true });
  const dataDir = await fs.mkdtemp(path.join(parent, 'local-chain-'));
  const received = [];
  const upstream = http.createServer(async (req, res) => {
    const body = await requestBody(req);
    received.push({ path: req.url, headers: req.headers, body });
    if (req.url === '/reject/v1/responses') {
      res.writeHead(429, { 'content-type': 'application/json', 'retry-after': '3' });
      res.end('{"error":{"message":"fixture tier rejected"}}');
    } else if (req.url === '/empty/v1/responses') {
      res.writeHead(204);
      res.end();
    } else if (req.url === '/delayed/v1/responses') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.flushHeaders();
      setTimeout(() => res.end('{"service_tier":"default"}'), 45);
    } else {
      res.writeHead(200, { 'content-type': 'application/json', 'x-request-id': 'local-fixture-response' });
      res.end('{"service_tier":"default","output":[{"type":"message","content":[{"type":"output_text","text":"fixture reply"}]}],"usage":{"input_tokens":12,"output_tokens":4}}');
    }
  });
  let engine;
  let gateway;
  try {
    upstream.listen(0, '127.0.0.1');
    await once(upstream, 'listening');
    const origin = 'http://127.0.0.1:' + upstream.address().port;
    const config = {
      schemaVersion: 1, listen: '127.0.0.1:0', maxRequestBytes: 2097152, maxConcurrency: 8,
      recording: { bodies: true, retentionDays: 7, maxRecords: 100 },
      routes: ['rewrite', 'preserve', 'reject', 'delayed', 'empty'].map(id => ({
        id, client: 'fixture-cli', upstream: origin + '/' + id + '/v1', protocol: 'openai',
      })),
      rules: ['rewrite', 'reject'].map(id => ({
        id: 'tier-' + id, enabled: true, priority: 10, match: { routeId: id },
        action: { type: 'override', value: 'priority' },
      })),
    };
    const configText = JSON.stringify(config, null, 2);
    assert.ok(!configText.includes(clientKey));
    assert.ok(!configText.includes(upstreamKey));
    await fs.writeFile(path.join(dataDir, 'config.json'), configText, { mode: 0o600 });
    engine = await startEngine({ dataDir, testBinary: fixtureBinary, timeoutMs: 5000 });
    assert.equal(engine.bootstrap.protocolVersion, 1);
    gateway = await createGateway({
      config: engine.bootstrap.config, routeSecrets: engine.bootstrap.routeSecrets, engine, drainTimeoutMs: 50,
    });

    const original = Buffer.from(' {"model":"fixture-model","service_tier":"old","n":12345678901234567890123456789012345678901234567890,"tools":[{"args":{"service_tier":"nested-old","x":1.2300e+009}}]}\n');
    const rewritten = await send(gateway, 'rewrite', original);
    assert.equal(rewritten.status, 200);
    assert.equal(rewritten.headers['x-request-id'], 'local-fixture-response');
    assert.equal(received.length, 1);
    assert.deepEqual(received[0].body, Buffer.from(original.toString().replace('"service_tier":"old"', '"service_tier":"priority"')));
    assert.equal(received[0].headers.authorization, 'Bearer ' + upstreamKey);
    assert.ok(!JSON.stringify(received[0].headers).includes(clientKey));
    let records = await recordsReady(engine, 1);
    const rewriteRecord = records.find(record => record.route_id === 'rewrite');
    assert.deepEqual(rewriteRecord.original, { state: 'string', value: 'old' });
    assert.deepEqual(rewriteRecord.effective, { state: 'string', value: 'priority' });
    assert.deepEqual(rewriteRecord.reported, { state: 'string', value: 'default' });
    assert.equal(rewriteRecord.rule_id, 'tier-rewrite');
    assert.equal(rewriteRecord.input_tokens, 12);
    assert.equal(rewriteRecord.output_tokens, 4);
    assert.equal(rewriteRecord.status, 'completed');
    assert.equal(rewriteRecord.recording_partial, false);

    const preservedBody = Buffer.from('\n { "model": "fixture-model", "service_tier" : "custom", "n": 99999999999999999999999999999999999999, "nested": {"service_tier":"nested-keep"} }\t');
    assert.equal((await send(gateway, 'preserve', preservedBody)).status, 200);
    assert.deepEqual(received.find(item => item.path === '/preserve/v1/responses').body, preservedBody);
    records = await recordsReady(engine, 2);
    const preserveRecord = records.find(record => record.route_id === 'preserve');
    assert.deepEqual(preserveRecord.original, { state: 'string', value: 'custom' });
    assert.deepEqual(preserveRecord.effective, { state: 'string', value: 'custom' });
    assert.equal(preserveRecord.rule_id, null);

    const rejected = await send(gateway, 'reject', Buffer.from('{"model":"fixture-model","service_tier":"old"}'));
    assert.equal(rejected.status, 429);
    assert.equal(rejected.headers['retry-after'], '3');
    assert.equal(received.filter(item => item.path === '/reject/v1/responses').length, 1);
    assert.equal(JSON.parse(received.find(item => item.path === '/reject/v1/responses').body).service_tier, 'priority');
    records = await recordsReady(engine, 3);
    const rejectRecord = records.find(record => record.route_id === 'reject');
    assert.equal(rejectRecord.status, 'upstream-error');
    assert.equal(rejectRecord.http_status, 429);
    assert.deepEqual(rejectRecord.effective, { state: 'string', value: 'priority' });
    assert.deepEqual(rejectRecord.reported, { state: 'missing' });

    const delayed = await send(gateway, 'delayed', Buffer.from('{"model":"fixture-model"}'));
    assert.equal(delayed.status, 200);
    records = await recordsReady(engine, 4);
    const delayedRecord = records.find(record => record.route_id === 'delayed');
    assert.ok(delayedRecord.first_response_ms >= 30, 'first-response duration must observe body bytes after headers');

    assert.equal((await send(gateway, 'empty', Buffer.from('{"model":"fixture-model"}'))).status, 204);
    records = await recordsReady(engine, 5);
    assert.equal(records.find(record => record.route_id === 'empty').first_response_ms, null);
    assert.equal(gateway.metrics.recordingFailures, 0);
    assert.ok((await fs.stat(path.join(dataDir, 'records.sqlite'))).size > 0);
  } finally {
    await gateway?.stop();
    await engine?.close();
    upstream.closeAllConnections();
    await new Promise(resolve => upstream.close(resolve));
    const canonicalParent = await fs.realpath(parent);
    const canonicalDirectory = await fs.realpath(dataDir);
    assert.equal(path.dirname(canonicalDirectory), canonicalParent);
    await fs.rm(canonicalDirectory, { recursive: true, force: true });
  }
});

test('multi-MiB SSE retains exact client bytes and observes real Responses, Chat and Anthropic tail usage', async () => {
  await fs.access(fixtureBinary);
  const parent=path.join(repository,'.cache','gateway-e2e');await fs.mkdir(parent,{recursive:true});
  const dataDir=await fs.mkdtemp(path.join(parent,'long-stream-'));
  const event=value=>Buffer.from('data: '+JSON.stringify(value)+'\n\n');
  const text='长流🙂'.repeat(900);
  const responseDelta=event({type:'response.output_text.delta',delta:text});
  const chatDelta=event({choices:[{delta:{content:text}}]});
  const anthropicDelta=event({type:'content_block_delta',delta:{type:'text_delta',text}});
  const payloads={
    responses:Buffer.concat([...Array(300).fill(responseDelta),event({type:'response.completed',response:{service_tier:'flex',usage:{input_tokens:31,output_tokens:73,input_tokens_details:{cached_tokens:8}}}})]),
    chat:Buffer.concat([...Array(300).fill(chatDelta),event({choices:[],service_tier:'priority',usage:{prompt_tokens:41,completion_tokens:83,prompt_tokens_details:{cached_tokens:9}}}),Buffer.from('data: [DONE]\n\n')]),
    anthropic:Buffer.concat([event({type:'message_start',message:{usage:{input_tokens:51,cache_read_input_tokens:10,cache_creation_input_tokens:2}}}),...Array(300).fill(anthropicDelta),event({type:'message_delta',usage:{output_tokens:93}}),event({type:'message_stop'})]),
  };
  for(const payload of Object.values(payloads))assert.ok(payload.length>2*1024*1024);
  const upstream=http.createServer((req,res)=>{void(async()=>{
    await requestBody(req);const id=req.url.split('/')[1];res.writeHead(200,{'content-type':'text/event-stream'});
    const payload=payloads[id];for(let offset=0;offset<payload.length;offset+=16381){if(!res.write(payload.subarray(offset,offset+16381)))await once(res,'drain');}res.end();
  })().catch(()=>res.destroy());});
  let engine,gateway;
  try{
    upstream.listen(0,'127.0.0.1');await once(upstream,'listening');
    const origin='http://127.0.0.1:'+upstream.address().port;
    const config={schemaVersion:1,listen:'127.0.0.1:0',recording:{bodies:true,retentionDays:7,maxRecords:100},rules:[],routes:Object.keys(payloads).map(id=>({id,client:'fixture-cli',protocol:id==='anthropic'?'anthropic':'openai',upstream:origin+'/'+id+'/v1'}))};
    await fs.writeFile(path.join(dataDir,'config.json'),JSON.stringify(config));
    engine=await startEngine({dataDir,testBinary:fixtureBinary,timeoutMs:5000});
    gateway=await createGateway({config:engine.bootstrap.config,routeSecrets:engine.bootstrap.routeSecrets,engine});
    for(const [id,endpoint,input,output,tier,cached] of [
      ['responses','/v1/responses',31,73,{state:'string',value:'flex'},8],
      ['chat','/v1/chat/completions',41,83,{state:'string',value:'priority'},9],
      ['anthropic','/v1/messages',51,93,{state:'missing'},10],
    ]){
      const result=await send(gateway,id,Buffer.from('{"model":"fixture-long"}'),endpoint);
      assert.equal(result.status,200);assert.deepEqual(result.body,payloads[id]);
      const records=await recordsReady(engine,Object.keys(payloads).indexOf(id)+1);
      const record=records.find(record=>record.route_id===id);
      assert.equal(record.response_bytes,payloads[id].length);assert.deepEqual(record.reported,tier);
      assert.equal(record.input_tokens,input);assert.equal(record.output_tokens,output);assert.equal(record.cache_read_tokens,cached);
      assert.ok(record.first_content_ms!==null);assert.equal(record.status,'completed');assert.equal(record.recording_partial,true);
      const detail=await engine.request('records.get',{recordId:record.id,includeBody:true});
      assert.ok(detail.body===null||detail.body.truncated,'capture limit must remain visible');
    }
    assert.equal(gateway.metrics.recordingFailures,0);
  }finally{
    await gateway?.stop();await engine?.close();upstream.closeAllConnections();await new Promise(resolve=>upstream.close(resolve));
    const checkedParent=await fs.realpath(parent),checkedDir=await fs.realpath(dataDir);assert.equal(path.dirname(checkedDir),checkedParent);await fs.rm(checkedDir,{recursive:true,force:true});
  }
});
