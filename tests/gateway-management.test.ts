import test from 'node:test';
import assert from 'node:assert/strict';
import https from 'node:https';
import {once} from 'node:events';
import {mkdir,mkdtemp,readFile,writeFile,rename,rm} from 'node:fs/promises';
import {randomBytes,randomUUID,createCipheriv,createDecipheriv} from 'node:crypto';
import path from 'node:path';
import {GatewayManagementService,type GatewayManagementOptions} from '../electron/services/gateway-management';
import {parseGatewayPairing} from '../electron/services/gateway-pairing';
import type {GatewayOwner} from '../shared/contracts/gateway';
import {gatewayTestCertificate} from './fixtures/gateway-certificate';

const certificate=gatewayTestCertificate();
const MANAGEMENT_TOKEN='fixture-management-token-0123456789';
const CLI_TOKEN='fixture-client-auth-token-0123456789';
const instanceId='fixture-instance';
const listener=(state:'listening'|'stopped'|'draining'='stopped')=>({state,address:state==='stopped'?null:'127.0.0.1:18080',owned:state!=='stopped',activeRequests:state==='draining'?1:0});
const route={id:'primary',clientAlias:'codex',protocol:'openai',upstreamBase:'https://upstream.example/v1',credentialRef:'credential-ref',credentialPresent:true,capabilities:{serviceTier:true},enabled:true};
function owner(generation=1,id='extension.author.gateway',view='main'){
 const controller=new AbortController();
 return {controller,value:{id,generation,view,signal:controller.signal} satisfies GatewayOwner};
}
function deferred(){let resolve!:()=>void;const promise=new Promise<void>(done=>{resolve=done;});return {promise,resolve};}
async function until(predicate:()=>boolean){const end=Date.now()+4000;while(!predicate()){if(Date.now()>end)throw new Error('fixture wait timed out');await new Promise(resolve=>setTimeout(resolve,10));}}
const cipher=()=>{const key=randomBytes(32);return {
 available:()=>true,
 encrypt(text:string){const iv=randomBytes(12),value=createCipheriv('aes-256-gcm',key,iv);const data=Buffer.concat([value.update(text,'utf8'),value.final()]);return Buffer.concat([iv,value.getAuthTag(),data]).toString('base64');},
 decrypt(text:string){const bytes=Buffer.from(text,'base64'),value=createDecipheriv('aes-256-gcm',key,bytes.subarray(0,12));value.setAuthTag(bytes.subarray(12,28));return Buffer.concat([value.update(bytes.subarray(28)),value.final()]).toString('utf8');}
};};
type RemoteRequest={method:string;input:any;owner:{hostId:string;pluginId:string};authorization:string|undefined;host:string|undefined;closed:boolean};
type Reply={result?:unknown;status?:number;envelope?:unknown;contentType?:string;wait?:Promise<void>;openBody?:boolean};
type Handler=(request:RemoteRequest)=>Reply|Promise<Reply>;
async function fixture(t:test.TestContext){
 const parent=process.env.LUMI_GATEWAY_STAGE_ROOT?path.resolve(process.env.LUMI_GATEWAY_STAGE_ROOT,'../gateway-management-tests'):path.resolve('.test-data/gateway-management');
 await mkdir(parent,{recursive:true});const directory=await mkdtemp(path.join(parent,'management-'));
 const calls:RemoteRequest[]=[],events:any[]=[],services:GatewayManagementService[]=[],exports:Array<{file:string;content:string}>=[];
 const vaultCipher=cipher();
 let handler:Handler=request=>({result:request.method==='hello'?{protocolVersion:1}:request.method==='routes.config.get'?{configVersion:1,routes:[route]}:
  request.method==='rules.list'?{policyVersion:1,rules:[]}:request.method==='cli.target'?{baseUrl:'http://127.0.0.1:18080/primary/v1',authToken:CLI_TOKEN,sessionFingerprint:'fixture-session',protocol:'openai'}:listener(request.method==='listener.start'?'listening':'stopped')});
 const server=https.createServer({key:certificate.key,cert:certificate.pem},async (request,response)=>{
  try{
   const chunks:Buffer[]=[];for await(const chunk of request)chunks.push(Buffer.from(chunk));
   const envelope=JSON.parse(Buffer.concat(chunks).toString('utf8'));
   const captured:RemoteRequest={method:(request.url??'').replace('/management/v1/',''),input:envelope.input,owner:envelope.owner,authorization:request.headers.authorization,host:request.headers.host,closed:false};
   response.on('close',()=>{captured.closed=true;});calls.push(captured);
   const reply=await handler(captured);if(reply.wait)await reply.wait;
   if(response.destroyed)return;
   response.writeHead(reply.status??200,{'content-type':reply.contentType??'application/json'});
   const responseBody=JSON.stringify(reply.envelope??{protocolVersion:1,instanceId,result:reply.result});
   if(reply.openBody)response.write(responseBody);else response.end(responseBody);
  }catch{if(!response.destroyed){response.writeHead(500);response.end();}}
 });
 server.listen(0,'127.0.0.1');await once(server,'listening');const port=(server.address() as {port:number}).port;
 const pairing=parseGatewayPairing({version:1,instanceId,alias:'隔离网关',port,certificatePem:certificate.pem,fingerprintSha256:certificate.fingerprint,token:MANAGEMENT_TOKEN});
 const options:GatewayManagementOptions={directory,cipher:vaultCipher,
  atomicWrite:async(file,content)=>{const tmp=file+'.'+randomUUID()+'.tmp';await writeFile(tmp,content,{mode:0o600});await rename(tmp,file);},
  pair:async()=>pairing,emit:event=>events.push(event),chooseExport:async()=>path.join(directory,'export.json'),writeExport:async(file,content)=>{exports.push({file,content});}};
 const makeService=()=>{const service=new GatewayManagementService(options);services.push(service);return service;};
 const service=makeService();
 t.after(async()=>{for(const current of services)current.close();server.closeAllConnections();await new Promise<void>(resolve=>server.close(()=>resolve()));
  const relative=path.relative(parent,directory);if(path.isAbsolute(relative)||relative.startsWith('..')||!path.basename(directory).startsWith('management-'))throw new Error('fixture cleanup boundary');await rm(directory,{recursive:true,force:true});});
 return {directory,calls,events,exports,options,service,server,pairing,vaultCipher,port,makeService,
  setHandler:(value:Handler)=>{handler=value;},
  pair:async(current=service,currentOwner=owner().value)=>current.request('gateway.pair',{},currentOwner) as Promise<{pairingId:string}>,
  connect:async(current=service,currentOwner=owner().value)=>current.request('gateway.connect',{pairingId:pairing.id},currentOwner) as Promise<{sessionId:string}>,
  vault:async()=>JSON.parse(vaultCipher.decrypt(JSON.parse(await readFile(path.join(directory,'gateway-pairings.json'),'utf8')).vault))};
}
async function rejectsSafe(promise:Promise<unknown>){await assert.rejects(promise,error=>{assert.ok(error instanceof Error);assert.equal(error.message.includes(MANAGEMENT_TOKEN),false);assert.equal(error.message.includes(CLI_TOKEN),false);return true;});}

test('model directory forwards only saved route identity, verifies scope, and preserves a finite safe error code',async t=>{
 const f=await fixture(t),o=owner();await f.pair(f.service,o.value);const session=await f.connect(f.service,o.value);
 const catalog={routeId:'primary',configVersion:1,checkedAtMs:1000,source:'catalog',models:[{id:'provider/model'}],truncated:false};
 const input={sessionId:session.sessionId,routeId:'primary',expectedVersion:1};
 f.setHandler(()=>({result:catalog}));
 assert.deepEqual(await f.service.request('gateway.routes.models.detect',input,o.value),catalog);
 assert.equal(f.calls.at(-1)?.method,'routes.models.detect');assert.deepEqual(f.calls.at(-1)?.input,{routeId:'primary',expectedVersion:1});
 f.setHandler(()=>({result:{...catalog,routeId:'other'}}));await rejectsSafe(f.service.request('gateway.routes.models.detect',input,o.value));
 f.setHandler(()=>({result:{...catalog,configVersion:2}}));await rejectsSafe(f.service.request('gateway.routes.models.detect',input,o.value));
 f.setHandler(()=>({status:401,envelope:{error:{code:'models-auth-failed'}}}));
 await assert.rejects(f.service.request('gateway.routes.models.detect',input,o.value),(error:any)=>error.code==='models-auth-failed' && !error.message.includes(CLI_TOKEN));
 f.setHandler(()=>({status:400,envelope:{error:{code:CLI_TOKEN}}}));
 await assert.rejects(f.service.request('gateway.routes.models.detect',input,o.value),(error:any)=>error.code==='management-response-invalid');
 f.setHandler(()=>({status:400,envelope:{error:{code:'models-auth-failed',body:CLI_TOKEN}}}));
 await assert.rejects(f.service.request('gateway.routes.models.detect',input,o.value),(error:any)=>error.code==='management-response-invalid');
 const before=f.calls.length;await rejectsSafe(f.service.request('gateway.routes.models.detect',input,owner(2).value));assert.equal(f.calls.length,before);
});

test('registered TLS peer uses standard trust plus pin and plugin results exclude host credentials',async t=>{
 const f=await fixture(t),o=owner();await f.pair(f.service,o.value);const session=await f.connect(f.service,o.value);
 const result=await f.service.request('gateway.routes.config.get',{sessionId:session.sessionId},o.value);
 assert.deepEqual(result,{configVersion:1,routes:[route]});
 assert.equal(JSON.stringify(result).includes(MANAGEMENT_TOKEN),false);
 assert.ok(f.calls.every(call=>call.authorization==='Bearer '+MANAGEMENT_TOKEN));
 assert.ok(f.calls.every(call=>call.host==='127.0.0.1:'+f.port && call.owner.pluginId===o.value.id));
 assert.equal(new Set(f.calls.map(call=>call.owner.hostId)).size,1);
 const encrypted=await readFile(path.join(f.directory,'gateway-pairings.json'),'utf8');assert.equal(encrypted.includes(MANAGEMENT_TOKEN),false);
 const restored=f.makeService();await restored.load();await f.connect(restored,o.value);
 assert.equal(new Set(f.calls.map(call=>call.owner.hostId)).size,1);
});

test('pairing and sessions remain isolated by plugin, generation and view; unsupported or extra input never reaches TLS',async t=>{
 const f=await fixture(t),o=owner(),other=owner(1,'extension.other.gateway');await f.pair(f.service,o.value);const session=await f.connect(f.service,o.value);
 assert.deepEqual(await f.service.request('gateway.status',{},other.value),{pairings:[]});
 await rejectsSafe(f.connect(f.service,other.value));
 for(const foreign of [other.value,owner(2).value,owner(1,o.value.id,'settings').value])await rejectsSafe(f.service.request('gateway.rules.list',{sessionId:session.sessionId},foreign));
 const before=f.calls.length;
 for(const [method,input] of [
  ['gateway.cli.target',{sessionId:session.sessionId}],['gateway.unknown',{}],
  ['gateway.rules.list',{sessionId:session.sessionId,url:'https://attacker.example'}],
  ['gateway.connect',{pairingId:f.pairing.id,port:1,token:MANAGEMENT_TOKEN}],
 ])await assert.rejects(f.service.request(method as any,input,o.value));
 assert.equal(f.calls.length,before);
});

test('concurrent connections are bounded and disconnect frees the owner session quota',async t=>{
 const f=await fixture(t),o=owner();await f.pair(f.service,o.value);
 const attempts=await Promise.allSettled(Array.from({length:8},()=>f.connect(f.service,o.value)));
 const accepted=attempts.filter((item):item is PromiseFulfilledResult<{sessionId:string}>=>item.status==='fulfilled');
 assert.equal(accepted.length,4);assert.equal(attempts.filter(item=>item.status==='rejected').length,4);
 for(const item of attempts)if(item.status==='rejected')assert.match(item.reason.message,/session-limit/);
 const before=f.calls.length;await assert.rejects(f.connect(f.service,o.value),/session-limit/);assert.equal(f.calls.length,before);
 await f.service.request('gateway.disconnect',{sessionId:accepted[0].value.sessionId},o.value);
 assert.ok((await f.connect(f.service,o.value)).sessionId);
});

test('replacement certificate on the registered port receives no management token',async t=>{
 const f=await fixture(t),o=owner();await f.pair(f.service,o.value);
 f.server.closeAllConnections();await new Promise<void>(resolve=>f.server.close(()=>resolve()));
 const replaced=gatewayTestCertificate();let authorization:string|undefined;
 const replacement=https.createServer({key:replaced.key,cert:replaced.pem},(request,response)=>{authorization=request.headers.authorization;response.end('{}');});
 replacement.on('tlsClientError',()=>{});replacement.listen(f.port,'127.0.0.1');await once(replacement,'listening');
 try{await rejectsSafe(f.connect(f.service,o.value));assert.equal(authorization,undefined);}finally{replacement.closeAllConnections();await new Promise<void>(resolve=>replacement.close(()=>resolve()));}
});

test('remote envelope and output keys are rejected with bounded fixed errors',async t=>{
 const f=await fixture(t),o=owner();await f.pair(f.service,o.value);const session=await f.connect(f.service,o.value);
 for(const reply of [
  {envelope:{protocolVersion:1,instanceId:'wrong-instance',result:{[MANAGEMENT_TOKEN]:CLI_TOKEN}}},
  {envelope:{protocolVersion:1,instanceId,result:{configVersion:1,routes:[route]},[CLI_TOKEN]:MANAGEMENT_TOKEN}},
  {result:{configVersion:1,routes:[route],[MANAGEMENT_TOKEN]:CLI_TOKEN}},
  {result:{configVersion:1,routes:[{...route,[CLI_TOKEN]:MANAGEMENT_TOKEN}]}},
 ]){f.setHandler(()=>reply);await rejectsSafe(f.service.request('gateway.routes.config.get',{sessionId:session.sessionId},o.value));}
});

test('malicious hello output is rejected without reflecting a secret key',async t=>{
 const f=await fixture(t),o=owner();f.setHandler(()=>({result:{protocolVersion:1,[MANAGEMENT_TOKEN]:CLI_TOKEN}}));
 await rejectsSafe(f.pair(f.service,o.value));assert.deepEqual(await f.service.request('gateway.status',{},o.value),{pairings:[]});
});

test('generation revoke aborts requests and late poll results do not reach the view',async t=>{
 const f=await fixture(t),o=owner();await f.pair(f.service,o.value);const session=await f.connect(f.service,o.value);
 const hold=deferred();f.setHandler(()=>({result:{policyVersion:1,rules:[]},wait:hold.promise}));
 const pending=f.service.request('gateway.rules.list',{sessionId:session.sessionId},o.value);const rejection=rejectsSafe(pending);
 await until(()=>f.calls.some(call=>call.method==='rules.list'));
 await f.service.revoke({id:o.value.id,generation:o.value.generation},'generation');await rejection;hold.resolve();
 f.setHandler(()=>({result:{protocolVersion:1}}));
 const refreshed=owner(2);const next=await f.connect(f.service,refreshed.value);
 const pollHold=deferred();f.setHandler(request=>request.method==='listener.status'?{result:listener('listening'),wait:pollHold.promise}:{result:{protocolVersion:1}});
 await f.service.request('gateway.events.subscribe',{sessionId:next.sessionId},refreshed.value);
 await until(()=>f.calls.some(call=>call.method==='listener.status'));
 await f.service.revoke({id:refreshed.value.id,generation:refreshed.value.generation},'generation');pollHold.resolve();await new Promise(resolve=>setTimeout(resolve,30));
 assert.deepEqual(f.events,[]);await rejectsSafe(f.service.request('gateway.rules.list',{sessionId:next.sessionId},refreshed.value));
});

test('control subscriptions emit status or fixed warnings and never request records or bodies',async t=>{
 const f=await fixture(t),o=owner();await f.pair(f.service,o.value);const session=await f.connect(f.service,o.value);
 f.setHandler(()=>({result:listener('listening')}));const subscription=await f.service.request('gateway.events.subscribe',{sessionId:session.sessionId},o.value) as {subscriptionId:string};
 await until(()=>f.events.length===1);
 assert.equal(f.events[0].payload.type,'status');assert.equal(f.events[0].payload.subscriptionId,subscription.subscriptionId);
 assert.equal(JSON.stringify(f.events).includes(MANAGEMENT_TOKEN),false);
 f.setHandler(()=>({result:{...listener('listening'),record:{body:CLI_TOKEN},[MANAGEMENT_TOKEN]:CLI_TOKEN}}));
 await until(()=>f.events.length===2);assert.deepEqual(f.events[1].payload,{subscriptionId:subscription.subscriptionId,sessionId:session.sessionId,type:'warning',code:'management-connection-failed'});
 assert.ok(f.calls.every(call=>!call.method.startsWith('records.')));assert.equal(JSON.stringify(f.events).includes(CLI_TOKEN),false);
 await f.service.request('gateway.events.unsubscribe',subscription,o.value);
});

test('failed disable persists revocation; next host connect stops before hello and retains host identity',async t=>{
 const f=await fixture(t),o=owner();await f.pair(f.service,o.value);const session=await f.connect(f.service,o.value);
 await f.service.request('gateway.listener.start',{sessionId:session.sessionId},o.value);
 const hostId=f.calls[0].owner.hostId;f.setHandler(request=>request.method==='listener.stop'?{status:503,result:{}}:{result:{protocolVersion:1}});
 await f.service.revoke({id:o.value.id},'disabled');assert.equal((await f.vault()).pairings[0].pendingRevocation,true);
 f.service.close();const restored=f.makeService();await restored.load();const before=f.calls.length;
 f.setHandler(request=>({result:request.method==='listener.stop'?listener():{protocolVersion:1}}));await f.connect(restored,owner(2).value);
 assert.deepEqual(f.calls.slice(before).map(call=>call.method),['listener.stop','hello']);
 assert.deepEqual(f.calls[before].input,{mode:'cancel'});assert.equal(f.calls[before].owner.hostId,hostId);
 assert.equal((await f.vault()).pairings[0].pendingRevocation,false);
});

test('draining or malicious stop cannot clear durable pending revocation',async t=>{
 const f=await fixture(t),o=owner();await f.pair(f.service,o.value);
 f.setHandler(request=>({result:request.method==='listener.stop'?listener('draining'):{protocolVersion:1}}));
 await f.service.revoke({id:o.value.id},'disabled');assert.equal((await f.vault()).pairings[0].pendingRevocation,true);
 for(const result of [listener('draining'),{...listener(),[MANAGEMENT_TOKEN]:CLI_TOKEN}]){
  f.setHandler(()=>({result}));const before=f.calls.length;await rejectsSafe(f.connect(f.service,owner(2).value));
  assert.deepEqual(f.calls.slice(before).map(call=>call.method),['listener.stop']);assert.equal((await f.vault()).pairings[0].pendingRevocation,true);
 }
});

test('host shutdown disconnects without stopping the independently owned listener',async t=>{
 const f=await fixture(t),o=owner();await f.pair(f.service,o.value);const session=await f.connect(f.service,o.value);
 await f.service.request('gateway.listener.start',{sessionId:session.sessionId},o.value);const before=f.calls.length;
 await f.service.revoke({id:o.value.id},'shutdown');f.service.close();await new Promise(resolve=>setTimeout(resolve,20));
 assert.equal(f.calls.length,before);await rejectsSafe(f.connect(f.service,o.value));
});

test('CLI target stays host private and plugin bridge returns only redacted transaction DTOs',async t=>{
 const f=await fixture(t),o=owner();await f.pair(f.service,o.value);const session=await f.connect(f.service,o.value);
 const input={sessionId:session.sessionId,routeId:'primary',tool:'codex' as const};
 let receivedToken='';f.service.setCliBridge({
  preview:async(request,currentOwner)=>{const target=await f.service.resolveCliTarget(request,currentOwner);receivedToken=target.authToken;return {transactionId:'fixture-transaction',fingerprint:'fixture-fingerprint',expiresAtMs:Date.now()+10000,tool:request.tool,differences:[{label:'authentication',before:'未设置',after:'本地认证（隐藏）'}],conflicts:[],recoverable:true};},
  apply:async()=>({transactionId:'fixture-transaction',fingerprint:'fixture-fingerprint',state:'applied',recoverable:true}),
  restore:async()=>({transactionId:'fixture-transaction',fingerprint:'fixture-fingerprint',state:'restored',recoverable:true}),
 });
 const result=await f.service.request('gateway.cliConfig.preview',input,o.value);assert.equal(receivedToken,CLI_TOKEN);assert.equal(JSON.stringify(result).includes(CLI_TOKEN),false);
 const before=f.calls.length;await assert.rejects(f.service.request('gateway.cli.target' as any,input,o.value));assert.equal(f.calls.length,before);
 f.setHandler(()=>({result:{baseUrl:'http://127.0.0.1:18080/primary/v1',authToken:CLI_TOKEN,sessionFingerprint:'fixture-session',protocol:'openai',[MANAGEMENT_TOKEN]:CLI_TOKEN}}));
 await rejectsSafe(f.service.resolveCliTarget(input,o.value));
});

test('pairing vault is revalidated on load and rejects unknown fields or invalid pairing content',async t=>{
 const f=await fixture(t),o=owner();await f.pair(f.service,o.value);const stored=await f.vault();
 for(const invalid of [
  {...stored,hostId:'../foreign'},
  {...stored,pairings:[{...stored.pairings[0],pairing:{...stored.pairings[0].pairing,fingerprintSha256:'0'.repeat(64)}}]},
  {...stored,pairings:[{...stored.pairings[0],[MANAGEMENT_TOKEN]:CLI_TOKEN}]},
 ]){await writeFile(path.join(f.directory,'gateway-pairings.json'),JSON.stringify({version:1,vault:f.vaultCipher.encrypt(JSON.stringify(invalid))}));await rejectsSafe(f.makeService().load());}
});


test('new and restored pairing status has unknown listener observation until an actual listener result',async t=>{
 const f=await fixture(t),o=owner();await f.pair(f.service,o.value);
 const paired=await f.service.request('gateway.status',{},o.value) as any;
 assert.equal(paired.pairings[0].listening,null);assert.equal(paired.pairings[0].activeRequests,null);assert.equal(paired.pairings[0].connected,false);
 const session=await f.connect(f.service,o.value);await f.service.request('gateway.listener.start',{sessionId:session.sessionId},o.value);
 const observed=await f.service.request('gateway.status',{},o.value) as any;
 assert.equal(observed.pairings[0].listening,true);assert.equal(observed.pairings[0].activeRequests,0);
 const restored=f.makeService();await restored.load();const status=await restored.request('gateway.status',{},o.value) as any;
 assert.equal(status.pairings[0].listening,null);assert.equal(status.pairings[0].activeRequests,null);assert.equal(status.pairings[0].connected,false);
});

test('late native pairing result and connect handshake are withdrawn after host signal abort',async t=>{
 const f=await fixture(t),o=owner();const dialog=deferred();f.options.pair=async()=>{await dialog.promise;return f.pairing;};
 const pending=f.pair(f.service,o.value);const rejected=rejectsSafe(pending);o.controller.abort();await f.service.revoke({id:o.value.id,generation:1},'generation');dialog.resolve();await rejected;
 assert.equal(f.calls.length,0);assert.deepEqual(await f.service.request('gateway.status',{},owner(2).value),{pairings:[]});
 f.options.pair=async()=>f.pairing;const refreshed=owner(2);await f.pair(f.service,refreshed.value);
 const handshake=deferred();f.setHandler(()=>({result:{protocolVersion:1},wait:handshake.promise}));
 const connecting=f.connect(f.service,refreshed.value);const withdrawn=rejectsSafe(connecting);
 await until(()=>f.calls.filter(call=>call.method==='hello').length===2);refreshed.controller.abort();await f.service.revoke({id:refreshed.value.id,generation:2},'generation');handshake.resolve();await withdrawn;
 const status=await f.service.request('gateway.status',{},owner(3).value) as any;assert.equal(status.pairings[0].connected,false);
});

test('pairing completion is withdrawn when the host owner aborts during vault persistence',async t=>{
 const f=await fixture(t),o=owner(),gate=deferred(),started=deferred();const original=f.options.atomicWrite;
 f.options.atomicWrite=async(file,content)=>{started.resolve();await gate.promise;await original(file,content);};
 const pending=f.pair(f.service,o.value);const withdrawn=rejectsSafe(pending);await started.promise;
 o.controller.abort();await f.service.revoke({id:o.value.id,generation:o.value.generation},'generation');gate.resolve();await withdrawn;
});

test('shutdown immediately aborts an in-flight pairing TLS request',async t=>{
 const f=await fixture(t),o=owner(),gate=deferred();f.setHandler(()=>({result:{protocolVersion:1},wait:gate.promise}));
 const pending=f.pair(f.service,o.value);const withdrawn=rejectsSafe(pending);await until(()=>f.calls.length===1);
 f.service.close();const cancelled=await Promise.race([withdrawn.then(()=>true),new Promise<boolean>(resolve=>setTimeout(()=>resolve(false),100))]);
 gate.resolve();await withdrawn;assert.equal(cancelled,true);
});

test('late CLI bridge results are withdrawn after owner abort',async t=>{
 const f=await fixture(t),o=owner();await f.pair(f.service,o.value);const session=await f.connect(f.service,o.value);const gate=deferred();
 f.service.setCliBridge({preview:async()=>{await gate.promise;return {transactionId:'fixture-transaction',fingerprint:'fixture-fingerprint',expiresAtMs:Date.now()+10000,tool:'codex',differences:[],conflicts:[],recoverable:true};},
  apply:async()=>({transactionId:'fixture-transaction',fingerprint:'fixture-fingerprint',state:'applied',recoverable:true}),restore:async()=>({transactionId:'fixture-transaction',fingerprint:'fixture-fingerprint',state:'restored',recoverable:true})});
 const pending=f.service.request('gateway.cliConfig.preview',{sessionId:session.sessionId,routeId:'primary',tool:'codex'},o.value);const withdrawn=rejectsSafe(pending);
 o.controller.abort();await f.service.revoke({id:o.value.id,generation:o.value.generation},'generation');gate.resolve();await withdrawn;
});


test('concurrent imports of one companion produce one durable pairing',async t=>{
 const f=await fixture(t),o=owner(),gate=deferred();f.options.pair=async()=>({...f.pairing,id:randomUUID()});
 f.setHandler(()=>({result:{protocolVersion:1},wait:gate.promise}));
 const first=f.pair(f.service,o.value),second=f.pair(f.service,o.value);
 await until(()=>f.calls.length===2);gate.resolve();const results=await Promise.all([first,second]);
 const status=await f.service.request('gateway.status',{},o.value) as any;
 assert.equal(status.pairings.length,1);assert.equal(results[0].pairingId,results[1].pairingId);assert.equal((await f.vault()).pairings.length,1);
});


test('rejected management response headers destroy the unread streaming connection',async t=>{
 const f=await fixture(t),o=owner();await f.pair(f.service,o.value);const session=await f.connect(f.service,o.value);
 for(const reply of [{status:503,result:{},openBody:true},{contentType:'text/plain',result:{},openBody:true}]){
  f.setHandler(()=>reply);await rejectsSafe(f.service.request('gateway.routes.config.get',{sessionId:session.sessionId},o.value));
  await new Promise(resolve=>setTimeout(resolve,80));assert.equal(f.calls.at(-1)!.closed,true);
 }
});

test('management responses over the bounded envelope size are aborted before schema exposure',async t=>{
 const f=await fixture(t),o=owner();await f.pair(f.service,o.value);const session=await f.connect(f.service,o.value);
 f.setHandler(()=>({result:{configVersion:1,routes:[{...route,clientAlias:'a'.repeat(256*1024)}]}}));
 await rejectsSafe(f.service.request('gateway.routes.config.get',{sessionId:session.sessionId},o.value));
});

test('GUI provisioning auto-registers a fixed local runtime without a native pairing file or leaking typed credentials',async t=>{
 const f=await fixture(t),o=owner();const localPairing={...f.pairing,id:'local-'+randomUUID()};
 let configured=false,nativePairs=0,routeWrites=0,stops=0;
 f.options.pair=async()=>{nativePairs++;return null;};
 const localStatus=()=>({configured,running:configured,alias:configured?'本机网关':null,listenPort:configured?18080:null,managementPort:configured?f.port:null,configVersion:configured?1:null});
 const saved={configVersion:2,pairing:localPairing};
 f.options.local={status:async()=>localStatus(),ensureStarted:async()=>configured?localPairing:null,
  setup:async(id,input)=>{assert.equal(id,o.value.id);assert.equal(input.credentials.upstreamApiKey,'fixture-upstream-secret');assert.equal(input.credentials.clientApiKey,'fixture-client-secret-1234');configured=true;return {configVersion:1,pairing:localPairing};},
  configure:async()=>saved,saveRoute:async(_id,input)=>{assert.equal(input.credentials?.upstreamApiKey,'fixture-replacement-secret');routeWrites++;return saved;},deleteRoute:async()=>saved,stop:async()=>{stops++;},shutdown:async()=>{stops++;}};
 assert.equal((await f.service.request('gateway.local.status',{},o.value) as any).configured,false);
 await assert.rejects(f.service.request('gateway.connect',{},o.value),/not-configured/);
 const setup=await f.service.request('gateway.local.setup',{alias:'本机网关',listenPort:18080,managementPort:f.port,route:{id:'primary',clientAlias:'codex',protocol:'openai',upstreamBase:'https://upstream.example/v1',enabled:true,capabilities:{serviceTier:true}},credentials:{upstreamApiKey:'fixture-upstream-secret',clientApiKey:'fixture-client-secret-1234'}},o.value);
 assert.deepEqual(setup,{pairingId:localPairing.id,configVersion:1});assert.equal(nativePairs,0);
 const session=await f.service.request('gateway.connect',{},o.value) as {sessionId:string};
 const input={sessionId:session.sessionId,expectedVersion:1,route:{id:'primary',clientAlias:'codex',protocol:'openai' as const,upstreamBase:'https://upstream.example/v1',enabled:true,capabilities:{serviceTier:true}},credentials:{upstreamApiKey:'fixture-replacement-secret'}};
 await rejectsSafe(f.service.request('gateway.routes.save',input,owner(2).value));assert.equal(routeWrites,0);
 assert.deepEqual(await f.service.request('gateway.routes.save',input,o.value),{configVersion:2});assert.equal(routeWrites,1);
 await f.service.request('gateway.routes.config.get',{sessionId:session.sessionId},o.value);
 const status=await f.service.request('gateway.local.status',{},o.value);assert.equal((status as any).pairingId,localPairing.id);
 const vault=await readFile(path.join(f.directory,'gateway-pairings.json'),'utf8');
 assert.equal(vault.includes('fixture-upstream-secret'),false);assert.equal(vault.includes('fixture-replacement-secret'),false);
 assert.equal(JSON.stringify([setup,status,f.calls.map(call=>call.input)]).includes('fixture-client-secret'),false);
 await f.service.request('gateway.local.configure',{expectedVersion:2,alias:'本机网关',listenPort:18082,managementPort:f.port},o.value);
 await rejectsSafe(f.service.request('gateway.routes.config.get',{sessionId:session.sessionId},o.value));
 await f.service.revoke({id:o.value.id},'disabled');assert.equal(stops,1);
 await f.service.shutdown();assert.equal(stops,2);
});


test('draft model preview requires exact scoped inputs, rejects returned key fragments and withdraws revoked results',async t=>{
 const f=await fixture(t),o=owner();await f.pair(f.service,o.value);const session=await f.connect(f.service,o.value);
 const input={sessionId:session.sessionId,routeId:'unsaved',expectedVersion:1,protocol:'anthropic' as const,upstreamBase:'https://draft.example/v1',upstreamApiKey:'fixture-draft-only-key'};
 const catalog={routeId:input.routeId,configVersion:1,checkedAtMs:1000,source:'catalog',models:[{id:'safe-model'}],truncated:false};
 f.setHandler(()=>({result:catalog}));assert.deepEqual(await f.service.request('gateway.routes.models.preview',input,o.value),catalog);
 assert.equal(f.calls.at(-1)!.method,'routes.models.preview');assert.equal(f.calls.at(-1)!.input.upstreamApiKey,input.upstreamApiKey);
 for(const changed of [{...input,upstreamBase:'http://127.0.0.1/v1'},{...input,upstreamApiKey:'fake\nkey'},{...input,path:'/arbitrary'},{...input,protocol:'unknown'}]){const before=f.calls.length;await rejectsSafe(f.service.request('gateway.routes.models.preview',changed as any,o.value));assert.equal(f.calls.length,before);}
 f.setHandler(()=>({result:{...catalog,models:[{id:'prefix-'+input.upstreamApiKey+'-suffix'}]}}));await rejectsSafe(f.service.request('gateway.routes.models.preview',input,o.value));
 f.setHandler(()=>({result:{...catalog,configVersion:2}}));await rejectsSafe(f.service.request('gateway.routes.models.preview',input,o.value));
 f.setHandler(()=>({status:401,envelope:{error:{code:'models-auth-failed'}}}));await assert.rejects(f.service.request('gateway.routes.models.preview',input,o.value),(error:any)=>error.code==='models-auth-failed');
 const gate=deferred();f.setHandler(()=>({result:catalog,wait:gate.promise}));const pending=f.service.request('gateway.routes.models.preview',input,o.value);const rejected=rejectsSafe(pending);
 await until(()=>f.calls.at(-1)?.method==='routes.models.preview');o.controller.abort();gate.resolve();await rejected;
});
