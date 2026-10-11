// Embedded HTTP adapter. Rust owns policy evaluation, observations, and storage.
// No caller-controlled URL or authentication header is forwarded to an upstream.
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import {isDeepStrictEqual} from 'node:util';
import dns from 'node:dns';
import { randomUUID, timingSafeEqual } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import {convertJsonResponse,createStreamConverter,conversionError} from './protocol.mjs';
import {createOutputRateTracker,emptyOutputRateWindow} from './live-metrics.mjs';

const RESPONSE_CAPTURE_BYTES = 1024 * 1024;
const RESPONSE_CAPTURE_SEGMENTS = 4096;
const OBSERVATION_BATCH_BYTES = 64 * 1024;
const OBSERVATION_QUEUE_BYTES = 256 * 1024;
const OBSERVATION_QUEUE_SEGMENTS = 128;
const OBSERVATION_TIMEOUT_MS = 1000;
const BODY_TIMEOUT_MS = 30_000;
const UPSTREAM_TIMEOUT_MS = 120_000;
const DNS_TIMEOUT_MS = 10_000;
const REQUEST_HEADERS = new Set([
  'content-type', 'content-encoding', 'accept', 'accept-encoding',
  'anthropic-version', 'anthropic-beta', 'openai-beta', 'user-agent',
  'x-request-id', 'x-client-request-id',
]);
const RESPONSE_HEADERS = new Set([
  'content-type', 'content-encoding', 'content-length', 'cache-control',
  'expires', 'etag', 'last-modified', 'retry-after', 'x-request-id',
  'request-id', 'openai-processing-ms',
]);
const HOP_HEADERS = new Set([
  'connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization',
  'te', 'trailer', 'transfer-encoding', 'upgrade', 'proxy-connection',
]);
const CATALOG_MAX_BYTES = 128 * 1024;
const CATALOG_MAX_MODELS = 500;
const CATALOG_ERROR_CODES = new Set([
  'models-invalid-input', 'models-invalid-upstream', 'models-dns-failed', 'models-address-changed',
  'models-timeout', 'models-cancelled', 'models-redirect-not-allowed', 'models-auth-failed',
  'models-endpoint-unavailable', 'models-rate-limited', 'models-http-failed', 'models-response-invalid',
  'models-response-too-large', 'models-response-interrupted', 'models-connection-failed',
  'models-credentials-reflected', 'models-pagination-invalid', 'models-result-too-large', 'models-route-changed',
]);
const ENGINE_ERROR_CODES = new Set([
  'invalid-json', 'root-not-object', 'duplicate-key', 'invalid-tier-value',
  'invalid-rule-id', 'duplicate-rule-id', 'unsupported-endpoint',
  'request-too-large', 'unsupported-content-type', 'unsupported-content-encoding',
  'invalid-json-or-policy', 'invalid-input', 'invalid-body', 'body-too-large',
  'unsupported-endpoint', 'unknown-route', 'invalid-request-id', 'config-conflict', 'model-not-configured','invalid-anthropic-tier',
  'invalid-rectifier-json','rectifier-parent-not-object','rectifier-field-conflict','rectifier-value-not-number',
  'conversion-invalid-input','conversion-invalid-tool-arguments','conversion-content-unsupported','conversion-tool-error-unsupported',
  'conversion-role-unsupported','conversion-image-detail-unsupported','conversion-image-unsupported','conversion-tool-unsupported',
  'conversion-tool-strict-unsupported','conversion-tool-strict-mapping-required','conversion-tool-choice-unsupported','conversion-format-unsupported','conversion-protocol-unsupported',
  'conversion-field-unsupported','conversion-state-unsupported','conversion-reasoning-mapping-required','conversion-metadata-unsupported',
  'conversion-stop-unsupported','conversion-max-tokens-required',
]);

function elapsed(item) { return Math.max(0, Math.round(performance.now() - item.startedAtTick)); }

// The private core observes all response bytes in bounded batches, independently of
// optional body capture. Brief upstream backpressure bounds memory; a stalled observer
// is abandoned so forwarding can continue, and final fields then remain unknown.
function responseObservation(engine, item, changed) {
  const queue = [];
  let queuedBytes = 0, inFlightBytes = 0, offsetBytes = 0, running = false, failed = false;
  let completed;
  const waiting = new Promise(resolve => { completed = resolve; });
  let finishing = false;
  function finishIfIdle() { if (finishing && (!running || failed)) completed(); }
  function abandon() {
    if (failed) return;
    failed = true;
    item.observationPartial = true;
    queue.length = 0;
    queuedBytes = 0;
    changed();
    finishIfIdle();
  }
  async function pump() {
    if (running || failed) return;
    running = true;
    try {
      while (queue.length && !failed) {
        const batch = [];
        let bytes = 0;
        while (queue.length && batch.length < 256 && bytes + queue[0].bytes.length <= OBSERVATION_BATCH_BYTES) {
          const segment = queue.shift();
          queuedBytes -= segment.bytes.length;
          bytes += segment.bytes.length;
          batch.push({ dataB64: segment.bytes.toString('base64'), elapsedMs: segment.elapsedMs });
        }
        inFlightBytes = bytes;
        changed();
        let timer;
        try {
          const result = await Promise.race([
            engine.request('observe', { requestId: item.requestId, responseIsSse: item.responseIsSse, offsetBytes, segments: batch }),
            new Promise((_, reject) => { timer = setTimeout(() => reject(fault('observation-timeout')), OBSERVATION_TIMEOUT_MS); timer.unref?.(); }),
          ]);
          if (!Number.isSafeInteger(result?.observedBytes) || result.observedBytes !== offsetBytes + bytes) {
            throw fault('invalid-observation-result');
          }
          offsetBytes = result.observedBytes;
        } finally { clearTimeout(timer); }
        inFlightBytes = 0;
        changed();
      }
    } catch { abandon(); }
    finally { running = false; inFlightBytes = 0; changed(); finishIfIdle(); }
  }
  return {
    blocked() { return !failed && (queuedBytes + inFlightBytes >= OBSERVATION_QUEUE_BYTES / 2 || queue.length >= OBSERVATION_QUEUE_SEGMENTS / 2); },
    push(chunk, elapsedMs) {
      if (failed || !chunk.length) return;
      const count = Math.ceil(chunk.length / OBSERVATION_BATCH_BYTES);
      if (queuedBytes + inFlightBytes + chunk.length > OBSERVATION_QUEUE_BYTES || queue.length + count > OBSERVATION_QUEUE_SEGMENTS) { abandon(); return; }
      for (let start = 0; start < chunk.length; start += OBSERVATION_BATCH_BYTES) {
        const bytes = Buffer.from(chunk.subarray(start, start + OBSERVATION_BATCH_BYTES));
        queue.push({ bytes, elapsedMs });
        queuedBytes += bytes.length;
      }
      changed();
      void pump();
    },
    async flush() { finishing = true; finishIfIdle(); await waiting; },
  };
}
function fault(code, status = 502) {
  return Object.assign(new Error(code), { code, status });
}
function loopback(host) {
  return net.isIP(host) === 4 ? host.split('.')[0] === '127' : host === '::1';
}

/** Conservative global-address allowlist; no DNS answer may reach a local or special-use network. */
export function isPublicAddress(address) {
  if (typeof address !== 'string' || address.includes('%')) return false;
  const family = net.isIP(address);
  if (family === 4) {
    const [a, b, c] = address.split('.').map(Number);
    return !(a === 0 || a === 10 || a === 127 || a >= 224
      || a === 100 && b >= 64 && b <= 127
      || a === 169 && b === 254 || a === 172 && b >= 16 && b <= 31
      || a === 192 && (b === 168 || b === 0 && (c === 0 || c === 2) || b === 88 && c === 99)
      || a === 198 && (b === 18 || b === 19 || b === 51 && c === 100)
      || a === 203 && b === 0 && c === 113);
  }
  if (family !== 6 || address.includes('.')) return false;
  const halves = address.toLowerCase().split('::');
  const head = halves[0] ? halves[0].split(':').map(value => parseInt(value, 16)) : [];
  const tail = halves.length === 2 && halves[1] ? halves[1].split(':').map(value => parseInt(value, 16)) : [];
  const words = halves.length === 2 ? [...head, ...Array(8 - head.length - tail.length).fill(0), ...tail] : head;
  // Only global unicast 2000::/3. This also excludes mapped IPv4, NAT64, ULA, link-local and multicast.
  if (words[0] < 0x2000 || words[0] >= 0x4000) return false;
  return !(words[0] === 0x2001 && (words[1] < 0x0200 || words[1] === 0x0db8)
    || words[0] === 0x2002 // Deprecated 6to4 can embed a private IPv4 destination.
    || words[0] === 0x3fff && words[1] < 0x1000); // Documentation prefix 3fff::/20.
}
function publicHost(host) {
  if (typeof host !== 'string' || !host || host.length > 253 || host !== host.trim()) throw fault('invalid-upstream', 400);
  host = host.toLowerCase();
  if (net.isIP(host)) {
    if (!isPublicAddress(host)) throw fault('invalid-upstream', 400);
    return host;
  }
  if (host.endsWith('.') || host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local')
    || !host.split('.').every(part => /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(part))) throw fault('invalid-upstream', 400);
  return host;
}
function publicUpstream(url) {
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash) throw fault('invalid-upstream', 400);
  return publicHost(url.hostname.replace(/^\[|\]$/g, ''));
}
/** Resolve afresh, validate every answer and return copied addresses for one fixed connection. */
export async function resolvePublicAddresses(host, lookup = dns.lookup, signal) {
  host = publicHost(host);
  if (signal?.aborted) throw fault('upstream-dns-cancelled', 499);
  const literalFamily = net.isIP(host);
  if (literalFamily) return [{ address: host, family: literalFamily }];
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (error, addresses) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener('abort', abort);
      if (error) reject(error); else resolve(addresses);
    };
    const abort = () => finish(fault('upstream-dns-cancelled', 499));
    const timer = setTimeout(() => finish(fault('upstream-dns-timeout', 504)), DNS_TIMEOUT_MS);
    timer.unref?.();
    signal?.addEventListener('abort', abort, { once: true });
    if (signal?.aborted) { abort(); return; }
    try {
      lookup(host, { all: true, verbatim: true }, (error, addresses) => {
        if (settled) return;
        if (error) { finish(fault('upstream-dns-error', 502)); return; }
        if (!Array.isArray(addresses) || addresses.length === 0 || addresses.length > 64
          || addresses.some(value => !value || ![4, 6].includes(value.family)
            || net.isIP(value.address) !== value.family || !isPublicAddress(value.address))) {
          finish(fault('upstream-dns-not-public', 502)); return;
        }
        finish(undefined, addresses.map(({ address, family }) => ({ address, family })));
      });
    } catch { finish(fault('upstream-dns-error', 502)); }
  });
}

function parseListen(value) {
  if (typeof value !== 'string') throw fault('invalid-listen', 400);
  const match = /^(?:\[([^\]]+)\]|([^:]+)):(\d+)$/.exec(value);
  const host = match?.[1] ?? match?.[2];
  const port = Number(match?.[3]);
  if (!host || !loopback(host) || !Number.isInteger(port) || port < 0 || port > 65535) {
    throw fault('invalid-listen', 400);
  }
  return { host, port };
}
function authority(address) {
  return (net.isIP(address.address) === 6 ? '[' + address.address + ']' : address.address) + ':' + address.port;
}
function headerCount(req, name) {
  let count = 0;
  for (let i = 0; i < req.rawHeaders.length; i += 2) {
    if (req.rawHeaders[i].toLowerCase() === name) count += 1;
  }
  return count;
}
function sameSecret(actual, expected) {
  if (typeof actual !== 'string') return false;
  const a = Buffer.from(actual, 'utf8');
  const b = Buffer.from(expected, 'utf8');
  return a.length === b.length && timingSafeEqual(a, b);
}
function authenticated(req, secret, protocol) {
  if (headerCount(req, 'authorization') > 1 || headerCount(req, 'x-api-key') > 1) return false;
  const authorization = req.headers.authorization;
  const apiKey = req.headers['x-api-key'];
  if (authorization !== undefined && apiKey !== undefined) {
    const bearerMatches = typeof authorization === 'string' && authorization.startsWith('Bearer ')
      && sameSecret(authorization.slice(7), secret);
    const apiKeyMatches = sameSecret(apiKey, secret);
    return bearerMatches && apiKeyMatches;
  }
  if (protocol === 'anthropic' && apiKey !== undefined) return sameSecret(apiKey, secret);
  return typeof authorization === 'string' && authorization.startsWith('Bearer ')
    && sameSecret(authorization.slice(7), secret);
}
function connectionHeaders(headers) {
  const tokens = typeof headers.connection === 'string'
    ? headers.connection.split(',').map(value => value.trim().toLowerCase()) : [];
  return new Set([...HOP_HEADERS, ...tokens]);
}
function outgoingHeaders(req, protocol, upstreamKey, bodyLength) {
  const denied = connectionHeaders(req.headers);
  const headers = {};
  for (const [name, value] of Object.entries(req.headers)) {
    if (REQUEST_HEADERS.has(name) && !denied.has(name) && typeof value === 'string') headers[name] = value;
  }
  headers['content-length'] = String(bodyLength);
  if (protocol === 'anthropic') headers['x-api-key'] = upstreamKey;
  else headers.authorization = 'Bearer ' + upstreamKey;
  return headers;
}
function incomingHeaders(headers) {
  const denied = connectionHeaders(headers);
  const result = {};
  for (const [name, value] of Object.entries(headers)) {
    if (value !== undefined && !denied.has(name)
      && (RESPONSE_HEADERS.has(name) || name.startsWith('x-ratelimit-') || name.startsWith('anthropic-ratelimit-'))) {
      result[name] = value;
    }
  }
  return result;
}
export function targetUrl(base, endpoint) {
  const target = new URL(base);
  const prefix = target.pathname.replace(/\/+$/, '');
  target.pathname = prefix.endsWith('/v1') ? prefix + endpoint.slice(3) : prefix + endpoint;
  return target;
}
function compatibleJson(req) {
  const type = (req.headers['content-type'] ?? '').split(';', 1)[0].trim().toLowerCase();
  return type === 'application/json' || /^application\/[a-z0-9!#$&^_.+-]+\+json$/.test(type);
}
function potentialRewrite(config, route, endpoint) {
  if ((config.rectifiers??[]).some(r=>r.enabled!==false)||route.upstreamEndpoint||route.models?.length)return true;
  if (route.protocol === 'anthropic' || route.serviceTier === false) return false;
  return (config.rules ?? []).some(rule => {
    if (rule.enabled === false || rule.action?.type === 'preserve') return false;
    const scope = rule.match ?? {};
    return (!scope.routeId || scope.routeId === route.id)
      && (!scope.client || scope.client === route.client)
      && (!scope.endpoint || scope.endpoint === endpoint);
  });
}
function safeEngineError(error, config) {
  return (ENGINE_ERROR_CODES.has(error?.code) || config?.rectifiers?.some(r=>r.enabled && r.action?.type==='reject' && r.action.code===error?.code))
    ? fault(error.code, error.status === 415 ? 415 : 400)
    : fault('engine-unavailable', 502);
}
function safeCatalogError(error) {
  const code = CATALOG_ERROR_CODES.has(error?.code) ? error.code : 'models-unavailable';
  const status = code === 'models-timeout' ? 504 : code === 'models-cancelled' ? 499
    : code === 'models-route-changed' ? 409 : code === 'models-rate-limited' ? 429
      : code === 'models-endpoint-unavailable' ? 404 : code === 'models-invalid-input' ? 400 : 502;
  return fault(code, status);
}
function catalogResponse(result, routeId, configVersion, privateValues) {
  if (!result || result.routeId !== routeId || result.configVersion !== configVersion || result.source !== 'catalog'
    || typeof result.truncated !== 'boolean' || !Array.isArray(result.models) || result.models.length > CATALOG_MAX_MODELS) {
    throw fault('models-response-invalid');
  }
  const data = [], ids = new Set();
  let truncated = result.truncated;
  let bytes = Buffer.byteLength(JSON.stringify({ object: 'list', data: [], lumi_truncated: false }));
  for (const model of result.models) {
    const id = model?.id;
    if (typeof id !== 'string' || !id.trim().length || id !== id.toWellFormed() || Buffer.byteLength(id) > 256
      || /[\u0000-\u001f\u007f-\u009f]/.test(id)) throw fault('models-response-invalid');
    if (privateValues.some(value => id.includes(value))) throw fault('models-credentials-reflected');
    if (ids.has(id)) continue;
    ids.add(id);
    const row = { id, object: 'model' }, rowBytes = Buffer.byteLength(JSON.stringify(row)) + (data.length ? 1 : 0);
    if (bytes + rowBytes > CATALOG_MAX_BYTES) { truncated = true; continue; }
    data.push(row); bytes += rowBytes;
  }
  const body = Buffer.from(JSON.stringify({ object: 'list', data, lumi_truncated: truncated }));
  if (body.length > CATALOG_MAX_BYTES) throw fault('models-result-too-large');
  return { body, truncated };
}
function respondError(res, error) {
  if (res.destroyed || res.writableEnded) return;
  if (res.headersSent) { res.destroy(); return; }
  const code = error?.code ?? 'gateway-error';
  const status = Number.isInteger(error?.status) ? error.status : 502;
  const payload = Buffer.from(JSON.stringify({ error: { code } }));
  res.shouldKeepAlive = false;
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': String(payload.length),
    'cache-control': 'no-store',
    connection: 'close',
  });
  res.end(payload);
}
function readBody(req, maxBytes, item) {
  return new Promise((resolve, reject) => {
    let bytes = 0;
    const chunks = [];
    const timer = setTimeout(() => finish(fault('request-timeout', 408)), BODY_TIMEOUT_MS);
    timer.unref?.();
    function cleanup() {
      clearTimeout(timer);
      req.off('data', onData);
      req.off('end', onEnd);
      req.off('aborted', onAborted);
      req.off('error', onError);
      item.cancelRead = undefined;
    }
    function finish(error) {
      cleanup();
      if (error) { req.resume(); reject(error); }
      else resolve(Buffer.concat(chunks, bytes));
    }
    function onData(chunk) {
      bytes += chunk.length;
      if (bytes > maxBytes) { finish(fault('request-too-large', 413)); return; }
      chunks.push(chunk);
    }
    function onEnd() { finish(); }
    function onAborted() { finish(fault('client-aborted', 499)); }
    function onError() { finish(fault('client-aborted', 499)); }
    item.cancelRead = () => finish(fault(item.abortCode ?? 'client-aborted', 499));
    req.on('data', onData);
    req.once('end', onEnd);
    req.once('aborted', onAborted);
    req.once('error', onError);
  });
}

async function forward(req, res, route, secret, body, item, publicUpstreams, engine) {
  const target = targetUrl(route.upstream, item.upstreamEndpoint ?? item.endpoint);
  item.rateTracker=createOutputRateTracker(item.upstreamEndpoint??item.endpoint,{elapsed:()=>elapsed(item)});
  let selected;
  if (publicUpstreams) {
    const host = publicUpstream(target);
    const controller = new AbortController();
    item.cancelForward = () => controller.abort();
    try { [selected] = await resolvePublicAddresses(host, dns.lookup, controller.signal); }
    finally { item.cancelForward = undefined; }
    if (item.abortCode || res.destroyed) throw fault(item.abortCode ?? 'client-aborted', 499);
  }
  return new Promise((resolve, reject) => {
    let settled = false;
    let upstreamResponse;
    let timer;
    function finish(error) {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      item.cancelForward = undefined;
      if (error) reject(error); else resolve();
    }
    const transport = target.protocol === 'https:' ? https : http;
    const upstream = transport.request(target, {
      method: 'POST',
      agent: false,
      headers: {...outgoingHeaders(req, route.protocol, secret.upstreamKey, body.length),
        ...(item.converted ? {'content-type':'application/json','accept-encoding':'identity'} : {}),
        ...(route.protocol==='anthropic'&&!req.headers['anthropic-version']?{'anthropic-version':'2023-06-01'}:{}),
      },
      // Keep the original URL hostname for standard TLS identity checks; only socket lookup is pinned.
      ...(selected ? {
        family: selected.family, autoSelectFamily: false,
        lookup: (host, options, callback) => {
          if (host.toLowerCase() !== target.hostname.replace(/^\[|\]$/g, '').toLowerCase()) {
            callback(fault('upstream-address-changed', 502)); return;
          }
          if (options?.all) callback(null, [{ ...selected }]);
          else callback(null, selected.address, selected.family);
        },
      } : {}),
      // TLS uses Node's default certificate/hostname verification. No redirects or retries.
    });
    item.attempted = true;
    item.emitTrace?.('upstream');
    item.cancelForward = () => {
      const error = fault(item.abortCode ?? 'client-aborted', 499);
      upstreamResponse?.destroy();
      upstream.destroy();
      finish(error);
    };
    timer = setTimeout(() => {
      item.abortCode = 'upstream-timeout';
      upstreamResponse?.destroy();
      upstream.destroy();
      finish(fault('upstream-timeout', 504));
    }, UPSTREAM_TIMEOUT_MS);
    timer.unref?.();
    upstream.once('error', () => finish(fault(item.abortCode ?? 'upstream-connection-error', 502)));
    upstream.once('response', response => {
      upstreamResponse = response;
      item.httpStatus = response.statusCode ?? 502;
      item.responseIsSse = /^text\/event-stream(?:\s*;|$)/i.test(response.headers['content-type'] ?? '');
      item.rateTracker.begin({sse:item.responseIsSse,json:/^application\/(?:json|[a-z0-9!#$&^_.+-]+\+json)(?:\s*;|$)/i.test(response.headers['content-type']??''),encoded:Boolean(response.headers['content-encoding']&&response.headers['content-encoding']!=='identity'),successful:item.httpStatus>=200&&item.httpStatus<300});
      let clientWaiting = false;
      function updateReadState() {
        if (response.destroyed || response.readableEnded) return;
        if (clientWaiting || item.responseObservation.blocked()) response.pause();
        else response.resume();
      }
      item.responseObservation = responseObservation(engine, item, updateReadState);
      if (res.destroyed) { item.cancelForward?.(); return; }
      // Error responses do not have successful completion events. Preserve the upstream
      // status, headers and bytes instead of masking a 404/429 with an SSE conversion error.
      const convert=item.converted && item.httpStatus>=200 && item.httpStatus<300;
      const converter=convert && item.responseIsSse?createStreamConverter(item.upstreamEndpoint,item.endpoint,{model:item.chain?.upstreamModel,requestId:item.requestId}):null;
      const jsonChunks=[];let jsonBytes=0;
      const headers=incomingHeaders(response.headers);
      if(convert){delete headers['content-length'];delete headers['content-encoding'];headers['content-type']=item.responseIsSse?'text/event-stream; charset=utf-8':'application/json; charset=utf-8';}
      if(!convert || item.responseIsSse)res.writeHead(item.httpStatus,headers);
      function write(chunks){
        for(const chunk of chunks){
          if(chunk.length)item.clientFirstResponseMs??=elapsed(item);
          if(!res.write(chunk)){clientWaiting=true;response.pause();res.once('drain',()=>{clientWaiting=false;updateReadState();});}
        }
      }
      function conversionFailed(error){
        const safe=error?.code?error:fault('conversion-failed');
        if(res.headersSent&&!res.destroyed){item.errorDelivered=true;const payload=conversionError(safe,item.endpoint);res.end(Buffer.from('event: error\ndata: '+JSON.stringify(payload)+'\n\n'));}
        response.destroy();upstream.destroy();finish(safe);
      }
      response.on('data', chunk => {
        try{
          const observedAt = elapsed(item);
          if (chunk.length > 0) {item.firstResponseMs ??= observedAt;if(!item.sawResponse){item.sawResponse=true;item.emitTrace?.('streaming');}}
          item.responseBytes += chunk.length;
          item.responseObservation.push(chunk, observedAt);
          item.rateTracker.push(chunk);
          if (item.capturedBytes < RESPONSE_CAPTURE_BYTES && item.segments.length < RESPONSE_CAPTURE_SEGMENTS) {
            const captured = chunk.subarray(0, RESPONSE_CAPTURE_BYTES - item.capturedBytes);
            item.segments.push({ dataB64: captured.toString('base64'), elapsedMs: elapsed(item) });
            item.capturedBytes += captured.length;
            if (captured.length < chunk.length) item.recordingPartial = true;
          } else item.recordingPartial = true;
          if (res.destroyed) { item.cancelForward?.(); return; }
          if(convert && response.headers['content-encoding'] && response.headers['content-encoding']!=='identity')throw fault('conversion-content-encoding-unsupported');
          if(converter)write(converter.push(chunk));
          else if(convert){jsonBytes+=chunk.length;if(jsonBytes>8*1024*1024)throw fault('conversion-response-too-large');jsonChunks.push(chunk);}
          else write([chunk]);
        }catch(error){conversionFailed(error);}
      });
      response.once('end', () => {
        item.rateTracker.finish();
        try{
          if(!res.destroyed){if(converter)write(converter.finish());else if(convert){
            const converted=convertJsonResponse(Buffer.concat(jsonChunks),item.upstreamEndpoint,item.endpoint,item.chain?.upstreamModel);
            res.writeHead(item.httpStatus,headers);write([converted]);
          }res.end();}
          finish();
        }catch(error){conversionFailed(error);}
      });
      response.once('aborted', () => finish(fault(item.abortCode ?? 'upstream-disconnected', 502)));
      response.once('error', () => finish(fault(item.abortCode ?? 'upstream-disconnected', 502)));
    });
    upstream.end(body);
  });
}

async function gatewayState(config, routeSecrets, publicUpstreams, catalogPrivateValues, allowBareModelsAlias, drainTimeoutMs) {
  config = structuredClone(config);
  const listen = parseListen(config.listen);
  const maxRequestBytes = config.maxRequestBytes ?? 2 * 1024 * 1024;
  const maxConcurrency = config.maxConcurrency ?? 32;
  if (!Number.isSafeInteger(maxRequestBytes) || maxRequestBytes < 1 || maxRequestBytes > 4 * 1024 * 1024
    || !Number.isSafeInteger(maxConcurrency) || maxConcurrency < 1 || maxConcurrency > 128
    || !Number.isSafeInteger(drainTimeoutMs) || drainTimeoutMs < 0 || drainTimeoutMs > 15_000
    || !Array.isArray(config.routes) || config.routes.length < 1 || config.routes.length > 32) {
    throw fault('invalid-gateway-config', 400);
  }
  const routes = new Map();
  const secrets = new Map();
  for (const secret of routeSecrets ?? []) {
    if (secrets.has(secret.routeId) || typeof secret.clientKey !== 'string' || Buffer.byteLength(secret.clientKey) < 16
      || typeof secret.upstreamKey !== 'string' || secret.upstreamKey.length === 0
      || /[\r\n\x00]/.test(secret.clientKey + secret.upstreamKey)) throw fault('invalid-route-secret', 400);
    secrets.set(secret.routeId, { ...secret });
  }
  for (const rawRoute of config.routes) {
    if (!rawRoute || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(rawRoute.id)
      || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(rawRoute.client)
      || routes.has(rawRoute.id) || !secrets.has(rawRoute.id)) throw fault('invalid-route-config', 400);
    const route = { ...rawRoute, protocol: rawRoute.protocol ?? 'openai' };
    if (!['openai', 'anthropic'].includes(route.protocol)) throw fault('invalid-route-config', 400);
    let url;
    try { url = new URL(route.upstream); } catch { throw fault('invalid-upstream', 400); }
    const host = url.hostname.replace(/^\[|\]$/g, '');
    if ((url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback(host)))
      || url.username || url.password || url.search || url.hash) throw fault('invalid-upstream', 400);
    if (publicUpstreams) await resolvePublicAddresses(publicUpstream(url));
    routes.set(route.id, route);
  }
  const bareModelsAlias = (allowBareModelsAlias ?? config.routes.length === 1) && config.routes.length === 1;
  const privateCatalogValues = [...new Set([...catalogPrivateValues, ...[...secrets.values()].flatMap(value => [value.clientKey, value.upstreamKey])].filter(value => value.length > 0))];
  return {config,listen,routes,secrets,maxRequestBytes,maxConcurrency,bareModelsAlias,privateCatalogValues};
}

/** Start the development loopback data plane. Secrets never enter config or logs. */
export async function createGateway({ config, routeSecrets, engine, drainTimeoutMs = 15_000, publicUpstreams = false, modelCatalog, catalogPrivateValues = [], allowBareModelsAlias, onTrace }) {
  if (!config || config.schemaVersion !== 1 || !engine || typeof engine.request !== 'function' || typeof publicUpstreams !== 'boolean') {
    throw fault('invalid-gateway-config', 400);
  }
  if(onTrace!==undefined && typeof onTrace!=='function')throw fault('invalid-gateway-config',400);
  const trace=(item,phase,extra={})=>{try{onTrace?.({id:item.requestId,startedAtMs:item.startedAtMs,providerId:item.routeId,agentId:item.clientAlias,entryEndpoint:item.endpoint,requestedModel:item.requestedModel??null,phase,elapsedMs:elapsed(item),rateWindow:item.rateTracker?.snapshot()??emptyOutputRateWindow(elapsed(item)),httpStatus:item.httpStatus,errorCode:item.abortCode??null,...(item.chain?{chain:item.chain}:{}),...(item.clientFirstResponseMs===undefined?{}:{clientFirstResponseMs:item.clientFirstResponseMs}),...extra});}catch{metrics.recordingFailures++;}};
  if (modelCatalog !== undefined && typeof modelCatalog?.detect !== 'function'
    || !Array.isArray(catalogPrivateValues) || catalogPrivateValues.length > 64
    || catalogPrivateValues.some(value => typeof value !== 'string' || value.length > 16384)
    || allowBareModelsAlias !== undefined && typeof allowBareModelsAlias !== 'boolean') throw fault('invalid-gateway-config', 400);
  // Load only after this module has initialized, avoiding a static catalog/transport cycle.
  const catalog = modelCatalog ?? (await import('./catalog.mjs')).createModelCatalog();
  let state=await gatewayState(config,routeSecrets,publicUpstreams,catalogPrivateValues,allowBareModelsAlias,drainTimeoutMs);
  let address;
  let stopping = false;
  let stopPromise;
  let cancelStop;
  const active = new Set();
  const sockets = new Set();
  const metrics = { recordingFailures: 0 };
  const listeners=new Set();
  function newListener() {
  const listener={server:null,address:null,enabled:false};
  const server = http.createServer({ maxHeaderSize: 16 * 1024 }, (req, res) => { void handle(req, res, listener); });
  listener.server=server;
  server.headersTimeout = 15_000;
  server.requestTimeout = BODY_TIMEOUT_MS;
  server.keepAliveTimeout = 5000;
  server.maxHeadersCount = 64;
  server.on('connection', socket => { sockets.add(socket); socket.once('close', () => sockets.delete(socket)); });
  server.on('clientError', (_error, socket) => {
    if (socket.bytesWritten > 0) socket.destroy();
    else if (socket.writable) socket.end('HTTP/1.1 400 Bad Request\r\nConnection: close\r\nContent-Length: 0\r\n\r\n');
  });
  server.on('upgrade', (_req, socket) => {
    socket.end('HTTP/1.1 426 Upgrade Required\r\nConnection: close\r\nContent-Length: 0\r\n\r\n');
  });

  listeners.add(listener);return listener;
  }
  async function bindListener(listen) {
    const listener=newListener();
    try {
      await new Promise((resolve,reject)=>{listener.server.once('error',reject);listener.server.listen(listen.port,listen.host,()=>{listener.server.off('error',reject);resolve();});});
      listener.address=authority(listener.server.address());return listener;
    } catch(error) {listeners.delete(listener);listener.server.close();throw fault('listener-port-unavailable',409);}
  }
  function retire(listener) {
    listener.enabled=false;
    listener.server.close(()=>listeners.delete(listener));listener.server.closeIdleConnections?.();
  }
  async function handle(req, res, listener) {
    // Configuration replacement creates a new snapshot; one request keeps its entry rules.
    const requestState=state;
    const {config:requestConfig,routes,secrets,maxRequestBytes,maxConcurrency,bareModelsAlias,privateCatalogValues}=requestState;
    let item;
    let prepared = false;
    let terminalError;
    const startedAtMs = Date.now();
    try {
      if (stopping || !listener.enabled) throw fault('gateway-stopping', 503);
      if (headerCount(req, 'host') !== 1 || req.headers.host !== listener.address) throw fault('invalid-host', 403);
      if (headerCount(req, 'origin') > 0) throw fault('origin-not-allowed', 403);
      if (typeof req.url !== 'string' || !req.url.startsWith('/') || req.url.startsWith('//')) throw fault('invalid-target', 400);
      if (req.headers.upgrade !== undefined || /(?:^|,)\s*upgrade\s*(?:,|$)/i.test(req.headers.connection ?? '')) {
        throw fault('upgrade-not-supported', 426);
      }
      const isCatalog = req.method === 'GET';
      if (!isCatalog && req.method !== 'POST') throw fault('method-not-allowed', 405);
      let path;
      if (isCatalog) {
        if (/^\/([A-Za-z0-9][A-Za-z0-9._-]{0,63})\/v1\/(?:responses|chat\/completions|messages)$/.test(req.url)) throw fault('method-not-allowed', 405);
        path = /^\/([A-Za-z0-9][A-Za-z0-9._-]{0,63})(\/v1\/models)$/.exec(req.url);
        if (!path && req.url === '/v1/models' && bareModelsAlias) path = ['', [...routes.keys()][0], '/v1/models'];
      } else {
        path = /^\/([A-Za-z0-9][A-Za-z0-9._-]{0,63})(\/v1\/(?:responses|chat\/completions|messages))$/.exec(req.url);
        if (!path && /^\/(?:[A-Za-z0-9][A-Za-z0-9._-]{0,63}\/)?v1\/models$/.test(req.url)) throw fault('method-not-allowed', 405);
      }
      let shared=false;
      if(!path && (requestConfig.agents??[]).length){const match=/^\/v1\/(responses|chat\/completions|messages|models)$/.exec(req.url);if(match){shared=true;path=['','', '/v1/'+match[1]];}}
      if (!path) throw fault('route-not-found', 404);
      let route = routes.get(path[1]);
      const endpoint = path[2];
      let agent;
      if((requestConfig.agents??[]).length){
        const matches=requestConfig.agents.filter(a=>a.enabled && secrets.has(a.credentialRef) && authenticated(req,secrets.get(a.credentialRef).clientKey,'anthropic'));
        if(matches.length!==1)throw fault('unauthorized',401);agent=matches[0];
        if(route&&!agent.providerIds.includes(route.id))throw fault('agent-provider-denied',403);
      }
      if(!shared && (!route || route.enabled === false || !isCatalog && !(route.entryEndpoints?.length?route.entryEndpoints.includes(endpoint):(route.protocol==='anthropic'?endpoint==='/v1/messages':endpoint!=='/v1/messages'))))throw fault('route-not-found',404);
      let secret=route?secrets.get(route.id):null;
      if(!agent && !authenticated(req,secret.clientKey,route.entryEndpoints?.includes('/v1/messages')?'anthropic':route.protocol))throw fault('unauthorized',401);
      if(shared && isCatalog){
        const ids=new Set();for(const r of routes.values())if(r.enabled!==false&&agent.providerIds.includes(r.id))for(const m of r.models??[])if(m.enabled)ids.add(m.id);
        if(active.size>=maxConcurrency)throw fault('too-many-requests',429);if(req.headers['transfer-encoding']!==undefined||req.headers['content-length']!==undefined&&String(req.headers['content-length'])!=='0')throw fault('models-body-not-allowed',400);
        const result=catalogResponse({routeId:'agent',configVersion:requestConfig.configVersion,source:'catalog',models:[...ids].slice(0,CATALOG_MAX_MODELS).map(id=>({id})),truncated:ids.size>CATALOG_MAX_MODELS},'agent',requestConfig.configVersion,privateCatalogValues);
        res.writeHead(200,{'content-type':'application/json','cache-control':'no-store','x-lumi-models-truncated':String(result.truncated)});res.end(result.body);return;
      }
      if (active.size >= maxConcurrency) throw fault('too-many-requests', 429);
      const declaredLength = req.headers['content-length'];
      if (declaredLength !== undefined && Number(declaredLength) > maxRequestBytes) throw fault('request-too-large', 413);
      if (isCatalog && (req.headers['transfer-encoding'] !== undefined || declaredLength !== undefined && (!/^\d+$/.test(String(declaredLength)) || Number(declaredLength) !== 0))) throw fault('models-body-not-allowed', 400);
      if (!isCatalog && (shared || potentialRewrite(requestConfig, route, endpoint))) {
        const encoding = (req.headers['content-encoding'] ?? 'identity').trim().toLowerCase();
        if (encoding !== 'identity') throw fault('unsupported-content-encoding', 415);
        if (!compatibleJson(req)) throw fault('unsupported-content-type', 415);
      }
      item = {
        kind: isCatalog ? 'catalog' : 'inference', requestId: randomUUID(), endpoint, startedAtMs, startedAtTick: performance.now(), segments: [], capturedBytes: 0,
        observationPartial: false,
        responseBytes: 0, responseIsSse: false, recordingPartial: false, attempted: false,
        httpStatus: null, firstResponseMs: null, abortCode: null,routeId:route?.id??agent.credentialRef,clientAlias:agent?.id??route.client,
      };
      active.add(item);
      res.once('close', () => {
        if (!res.writableFinished) {
          item.abortCode ??= 'client-aborted';
          item.cancelRead?.();
          item.cancelForward?.();
        }
      });
      if (isCatalog) {
        const configVersion = requestConfig.configVersion;
        if (!Number.isSafeInteger(configVersion) || configVersion < 1 || configVersion > 2147483647) throw fault('models-invalid-input', 400);
        const controller = new AbortController();
        item.cancelForward = () => controller.abort();
        const assertFresh = () => {
          if (item.abortCode || res.destroyed || controller.signal.aborted) throw fault('models-cancelled', 499);
          if (state !== requestState) throw fault('models-route-changed', 409);
          return true;
        };
        try {
          assertFresh();
          const result = await catalog.detect({ route: { ...route }, upstreamKey: secret.upstreamKey, configVersion,
            signal: controller.signal, assertFresh, privateValues: privateCatalogValues });
          assertFresh();
          const output = catalogResponse(result, route.id, configVersion, privateCatalogValues);
          if (!res.destroyed) {
            res.shouldKeepAlive = false;
            res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'content-length': String(output.body.length),
              'cache-control': 'no-store', 'x-lumi-models-truncated': String(output.truncated), connection: 'close' });
            res.end(output.body);
          }
          return;
        } catch (error) { throw safeCatalogError(error); }
        finally { item.cancelForward = undefined; req.resume(); }
      }
      const body = await readBody(req, maxRequestBytes, item);
      if(shared){
        const inspected=await engine.request('request.model',{bodyB64:body.toString('base64'),...(Number.isSafeInteger(requestConfig.configVersion)?{configSnapshot:requestConfig}:{})});item.requestedModel=inspected.model;
        const candidates=[...routes.values()].filter(r=>r.enabled!==false && agent.providerIds.includes(r.id)
          && (r.entryEndpoints?.length?r.entryEndpoints.includes(endpoint):(r.protocol==='anthropic'?endpoint==='/v1/messages':endpoint!=='/v1/messages'))
          && (r.models??[]).some(m=>m.enabled && (m.id===inspected.model||m.upstreamModel===inspected.model)));
        if(candidates.length!==1)throw fault(candidates.length?'ambiguous-model':'model-not-configured',400);
        route=candidates[0];secret=secrets.get(route.id);item.routeId=route.id;
      }
      item.emitTrace=(phase,extra)=>trace(item,phase,extra);item.emitTrace('received');
      let result;
      try {
        result = await engine.request('prepare', {
          routeId: route.id, endpoint, bodyB64: body.toString('base64'), startedAtMs, requestId: item.requestId,
          ...(agent?{clientAlias:agent.id}:{}),...(shared?{routeReason:'model-match'}:{}),
          ...(Number.isSafeInteger(requestConfig.configVersion)?{expectedConfigVersion:requestConfig.configVersion,configSnapshot:requestConfig}:{}),
        });
      } catch (error) {
        const safe = safeEngineError(error,requestConfig);
        if (safe.code === 'engine-unavailable') metrics.recordingFailures += 1;
        throw safe;
      }
      prepared = true;
      if (result?.recordingOk === false) metrics.recordingFailures += 1;
      if (result?.modified) {
        const encoding = (req.headers['content-encoding'] ?? 'identity').trim().toLowerCase();
        if (encoding !== 'identity') throw fault('unsupported-content-encoding', 415);
        if (!compatibleJson(req)) throw fault('unsupported-content-type', 415);
      }
      if (item.abortCode || stopping || res.destroyed) throw fault(item.abortCode ?? 'gateway-stopping', 499);
      if (typeof result?.bodyB64 !== 'string' || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(result.bodyB64)) {
        throw fault('invalid-engine-result', 502);
      }
      const outgoingBody = Buffer.from(result.bodyB64, 'base64');
      if (outgoingBody.length > maxRequestBytes + 16*1024) throw fault('invalid-engine-result', 502);
      item.chain=result.chain;item.requestedModel=result.chain?.requestedModel??result.model??null;item.upstreamEndpoint=result.chain?.upstreamEndpoint??endpoint;item.converted=item.upstreamEndpoint!==endpoint;
      item.emitTrace('prepared');
      await forward(req, res, route, secret, outgoingBody, item, publicUpstreams, engine);
    } catch (error) {
      terminalError = error?.code ? error : fault('gateway-error', 502);
      if (item?.abortCode === 'client-aborted' || terminalError.code === 'client-aborted') {
        if (!res.destroyed) res.destroy();
      } else {if(item&&!res.headersSent&&!res.destroyed)item.errorDelivered=true;respondError(res, terminalError);}
    } finally {
      item?.rateTracker?.finish();
      if (prepared) {
        const code = item.abortCode ?? terminalError?.code ?? null;
        const status = code === 'client-aborted' ? 'client-aborted'
          : code ? (item.attempted ? 'execution-unknown' : 'gateway-rejected')
            : (item.httpStatus >= 400 ? 'upstream-error' : 'completed');
        try {
          await item.responseObservation?.flush();
          const finished = await engine.request('finish', {
            requestId: item.requestId, status, httpStatus: item.httpStatus,
            durationMs: elapsed(item), firstResponseMs: item.firstResponseMs,
            responseBytes: item.responseBytes, responseIsSse: item.responseIsSse,
            recordingPartial: item.recordingPartial || Boolean(code), errorCode: code, segments: item.segments,
            streamingObservation: true, observationPartial: item.observationPartial,
          });
          if (finished?.recordingOk === false) metrics.recordingFailures += 1;
          item.emitTrace?.('finished',{errorCode:code,record:finished.record,errorDelivered:Boolean(item.errorDelivered||!code&&item.httpStatus>=400)});
        } catch { metrics.recordingFailures += 1;item.emitTrace?.('finished',{errorCode:code??'recording-failed',errorDelivered:Boolean(item.errorDelivered)}); }
      }else if(item?.kind==='inference'){item.emitTrace?.('finished',{errorCode:terminalError?.code??item.abortCode??'gateway-rejected',errorDelivered:Boolean(item.errorDelivered)});}
      if (item) { active.delete(item); item.resolveDone?.(); }
    }
  }

  let currentListener=await bindListener(state.listen);
  currentListener.enabled=true;address=currentListener.address;
  return {
    get address(){return address;},
    metrics,
    activeRequests() { return active.size; },
    liveMetrics(){return [...active].filter(item=>item.kind==='inference').map(item=>({id:item.requestId,elapsedMs:elapsed(item),rateWindow:item.rateTracker?.snapshot()??emptyOutputRateWindow(elapsed(item))}));},
    async prepareConfig(nextConfig,nextSecrets=[...state.secrets.values()]) {
      if(stopping)throw fault('gateway-stopping',503);
      const before=state;
      const next=await gatewayState(nextConfig,nextSecrets,publicUpstreams,catalogPrivateValues,allowBareModelsAlias,drainTimeoutMs);
      let prepared;
      if(next.config.listen!==before.config.listen)prepared=await bindListener(next.listen);
      let settled=false;
      return {
        assertFresh(){if(stopping||state!==before)throw fault('config-conflict',409);},
        activate(){
          if(settled)return;settled=true;state=next;
          if(prepared){const old=currentListener;currentListener=prepared;address=prepared.address;prepared.enabled=true;retire(old);}
        },
        async cancel(){if(settled)return;settled=true;if(prepared){prepared.server.closeAllConnections?.();await new Promise(resolve=>prepared.server.close(resolve));listeners.delete(prepared);}}
      };
    },
    // Compatibility for existing rule/recording-only callers; full changes use prepareConfig.
    updateConfig(nextConfig) {
      if(nextConfig.listen!==state.config.listen||!isDeepStrictEqual(nextConfig.routes,state.config.routes)||(nextConfig.maxRequestBytes??2*1024*1024)!==state.maxRequestBytes||(nextConfig.maxConcurrency??32)!==state.maxConcurrency)throw fault('gateway-restart-required',409);
      const next=structuredClone(nextConfig);state={...state,config:next,maxRequestBytes:next.maxRequestBytes??2*1024*1024,maxConcurrency:next.maxConcurrency??32};
    },
    stop({ mode = 'drain' } = {}) {
      if (!['drain', 'cancel'].includes(mode)) throw fault('invalid-stop-mode', 400);
      if (stopPromise) { if (mode === 'cancel') cancelStop?.(); return stopPromise; }
      stopping = true;
      stopPromise = (async () => {
        const closingListeners=[...listeners];
        const closed=Promise.all(closingListeners.map(listener=>new Promise(resolve=>{listener.enabled=false;listener.server.close(()=>{listeners.delete(listener);resolve();});listener.server.closeIdleConnections?.();})));
        const pending = [...active].map(item => new Promise(resolve => { item.resolveDone = resolve; }));
        let timer;
        const cancelled = new Promise(resolve => { cancelStop = resolve; });
        if (mode === 'drain') {
          await Promise.race([
            Promise.allSettled(pending), cancelled,
            new Promise(resolve => { timer = setTimeout(resolve, drainTimeoutMs); timer.unref?.(); }),
          ]);
          clearTimeout(timer);
        }
        for (const item of active) {
          item.abortCode ??= 'gateway-stopping';
          item.cancelRead?.();
          item.cancelForward?.();
        }
        for (const socket of sockets) socket.destroy();
        // A failed engine must not indefinitely hold a stopped listener open.
        // Pending handlers still attempt their single finish if the engine recovers.
        let flushTimer;
        await Promise.race([
          Promise.allSettled(pending),
          new Promise(resolve => { flushTimer = setTimeout(resolve, 1000); flushTimer.unref?.(); }),
        ]);
        clearTimeout(flushTimer);
        metrics.recordingFailures += [...active].filter(item => item.kind !== 'catalog').length;
        await closed;
      })();
      return stopPromise;
    },
  };
}
