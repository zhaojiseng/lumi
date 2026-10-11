import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import {createHash,randomBytes,createCipheriv,createDecipheriv} from 'node:crypto';
import {GatewayManagementService} from '../electron/services/gateway-management';
import {mkdir,mkdtemp,readFile,rm,stat} from 'node:fs/promises';
import path from 'node:path';
import {GatewayLocalService} from '../electron/services/gateway-local';
import {startEngine} from '../electron/services/gateway-runtime/engine.mjs';
import {createManagementGateway} from '../electron/services/gateway-runtime/management.mjs';
import {createModelCatalog} from '../electron/services/gateway-runtime/catalog.mjs';
import {createTlsIdentity} from '../electron/services/gateway-runtime/tls-identity.mjs';
import {gatewayPairingTlsOptions,type GatewayPairing} from '../electron/services/gateway-pairing';
import type {CoreConfig} from '../electron/services/gateway-runtime/types.mjs';

const binaryPath=path.resolve(process.env.LUMI_GATEWAY_TEST_BINARY??'dist-native/lumi-gateway-runtime'+(process.platform==='win32'?'.exe':''));
const built=await stat(binaryPath).then(value=>value.isFile()).catch(()=>false);
const skip=process.platform!=='win32'?'DPAPI 须在 Windows 验证。':!built?'尚未构建固定网关核心。':false;
const pluginId='extension.lumi.gateway',oldClient='fixture-old-client-key-0123456789',newClient='fixture-new-client-key-9876543210';
async function listen(server:net.Server){await new Promise<void>((resolve,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',()=>{server.off('error',reject);resolve();});});return (server.address() as net.AddressInfo).port;}
const issuedPorts=new Set<number>();
async function unusedPort(){let candidate=0;do{const server=net.createServer(),port=await listen(server);await new Promise<void>(resolve=>server.close(()=>resolve()));candidate=port;}while(issuedPorts.has(candidate));issuedPorts.add(candidate);return candidate;}
async function close(server:http.Server|net.Server){(server as http.Server).closeAllConnections?.();await new Promise<void>(resolve=>server.close(()=>resolve()));}
async function until(predicate:()=>boolean|Promise<boolean>,label:string){const limit=Date.now()+5000;while(!await predicate()){if(Date.now()>limit)throw new Error(label);await new Promise(resolve=>setTimeout(resolve,5));}}
function deferred(){let resolve!:()=>void;const promise=new Promise<void>(done=>{resolve=done;});return {promise,resolve};}
function data(port:number,token:string,body:unknown,{routeId='primary',slow=false}={}){
 const bytes=Buffer.from(JSON.stringify(body));let request!:http.ClientRequest;
 const promise=new Promise<{status:number;body:string}>((resolve,reject)=>{
  request=http.request({host:'127.0.0.1',port,path:(routeId?'/'+routeId:'')+'/v1/responses',method:'POST',agent:false,
   headers:{authorization:'Bearer '+token,'content-type':'application/json','content-length':bytes.length}},response=>{
   const chunks:Buffer[]=[];response.on('data',chunk=>chunks.push(Buffer.from(chunk)));response.on('error',reject);
   response.on('end',()=>resolve({status:response.statusCode!,body:Buffer.concat(chunks).toString('utf8')}));
  });request.on('error',reject);request.setTimeout(10000,()=>request.destroy(new Error('fixture-request-timeout')));
  if(slow){request.flushHeaders();request.write(bytes.subarray(0,12));}else request.end(bytes);
 });
 // Capture failures immediately while the test deliberately holds the request body/stream.
 promise.catch(()=>{});
 return {promise,finishBody:()=>request.end(bytes.subarray(12)),cancel:()=>request.destroy()};
}
async function management(pairing:GatewayPairing,method:string,input:unknown={}){
 const body=Buffer.from(JSON.stringify({protocolVersion:1,instanceId:pairing.instanceId,owner:{hostId:'hot-config-fixture-host',pluginId},input}));
 return new Promise<any>((resolve,reject)=>{const request=https.request({host:'127.0.0.1',port:pairing.port,path:'/management/v1/'+method,method:'POST',agent:false,...gatewayPairingTlsOptions(pairing),headers:{host:'127.0.0.1:'+pairing.port,authorization:'Bearer '+pairing.token,'content-type':'application/json','content-length':body.length}},response=>{
  const chunks:Buffer[]=[];response.on('data',chunk=>chunks.push(Buffer.from(chunk)));response.on('error',reject);response.on('end',()=>{try{const value=JSON.parse(Buffer.concat(chunks).toString('utf8'));if(response.statusCode!==200){reject(Object.assign(new Error(value.error?.code??'fixture-management-error'),{code:value.error?.code}));return;}resolve(value.result);}catch(error){reject(error);}});
 });request.on('error',reject);request.end(body);});
}
async function fixture(t:test.TestContext){
 const parent=path.resolve('.test-data/gateway-hot-configuration');await mkdir(parent,{recursive:true});const directory=await mkdtemp(path.join(parent,'runtime-'));
 const forwarded:Array<{path:string;headers:http.IncomingHttpHeaders;body:any}>=[],catalogs:Array<{path:string;headers:http.IncomingHttpHeaders}>=[];
 const auxiliaryServers=new Set<net.Server>();
 const gates=new Map<string,ReturnType<typeof deferred>>(),tls=createTlsIdentity();let catalogMode='normal',failCommit=false,starts=0;
 const handle=(request:http.IncomingMessage,response:http.ServerResponse)=>{void(async()=>{
  const chunks:Buffer[]=[];for await(const chunk of request)chunks.push(Buffer.from(chunk));
  if(request.method==='GET'){
   catalogs.push({path:request.url!,headers:request.headers});const mode=catalogMode;
   if(mode==='hold'){const gate=deferred();gates.set('catalog-'+catalogs.length,gate);await gate.promise;}
   if(response.destroyed)return;
   if(mode==='auth'){response.writeHead(401,{'content-type':'application/json'});response.end('{}');return;}
   if(mode==='redirect'){response.writeHead(302,{location:'https://must-not-contact.invalid/v1/models'});response.end();return;}
   const key=String(request.headers['x-api-key']??request.headers.authorization?.replace(/^Bearer /,''));
   response.writeHead(200,{'content-type':'application/json'});response.end(JSON.stringify({data:[{id:mode==='reflect'?key:'catalog-model'}],has_more:false}));return;
  }
  const body=JSON.parse(Buffer.concat(chunks).toString());forwarded.push({path:request.url!,headers:request.headers,body});
  const tag=String(body.input??'');
  if(tag==='hold-sse'){
   const gate=deferred();gates.set(tag,gate);response.writeHead(200,{'content-type':'text/event-stream'});
   response.write('event: response.created\ndata: {"type":"response.created","response":{"id":"held","model":"old-stream","status":"in_progress"}}\n\n');
   await gate.promise;if(!response.destroyed)response.end('event: response.completed\ndata: {"type":"response.completed","response":{"id":"held","model":"old-stream","status":"completed","service_tier":"default","usage":{"input_tokens":3,"output_tokens":2}}}\n\n');return;
  }
  if(tag==='hold-json'){const gate=deferred();gates.set(tag,gate);await gate.promise;}
  if(response.destroyed)return;
  const value=request.url==='/v1/messages'?{id:'anthropic-fixture',type:'message',role:'assistant',model:body.model,content:[{type:'text',text:'new-provider'}],stop_reason:'end_turn',usage:{input_tokens:3,output_tokens:2}}:{id:'response-fixture',object:'response',status:'completed',model:body.model,output:[],output_text:'fixture-complete',service_tier:'default',usage:{input_tokens:3,output_tokens:2}};
  response.writeHead(200,{'content-type':'application/json'});response.end(JSON.stringify(value));
 })().catch(()=>response.destroy());};
 const upstream=http.createServer(handle),catalogue=https.createServer({key:tls.privateKeyPem,cert:tls.certificatePem},handle);
 const upstreamPort=await listen(upstream),cataloguePort=await listen(catalogue);
 const catalog=createModelCatalog({lookup:(hostname:any,_options:any,callback:any)=>hostname==='catalog.example'?callback(null,[{address:'93.184.216.34',family:4}]):callback(new Error('fixed-fixture-host-only')),
  request:(target:any,options:any,callback:any)=>https.request(new URL('https://127.0.0.1:'+cataloguePort+target.pathname+target.search),{...options,servername:'',ca:tls.certificatePem,rejectUnauthorized:true},callback)});
 const service=new GatewayLocalService({dataDir:directory,binaryPath,allowFixtureUpstream:true,factories:{startEngine:async options=>{
  starts++;const engine=await startEngine(options),request=engine.request.bind(engine);return {...engine,request:async(method:string,input?:unknown)=>{if(failCommit&&method==='configuration.commit')throw Object.assign(new Error('private fixture diagnostic must stay private'),{code:'state-write-failed'});return request(method,input);}};
 },createManagementGateway:options=>createManagementGateway({...options,modelCatalog:catalog})}});
 const route={id:'primary',name:'旧供应商',clientAlias:'local',protocol:'openai' as const,upstreamBase:'http://127.0.0.1:'+upstreamPort+'/v1',enabled:true,capabilities:{serviceTier:true},models:[{id:'alias',upstreamModel:'old-model',enabled:true}],entryEndpoints:['/v1/responses' as const],upstreamEndpoint:'/v1/responses' as const};
 const listenPort=await unusedPort(),managementPort=await unusedPort();const initial=await service.setup(pluginId,{alias:'热配置夹具',listenPort,managementPort,route,credentials:{clientApiKey:oldClient,upstreamApiKey:'fixture-old-upstream'}});
 let pairing=initial.pairing,version=initial.configVersion;
 t.after(async()=>{for(const gate of gates.values())gate.resolve();await service.shutdown();await close(upstream);await close(catalogue);for(const server of auxiliaryServers)await close(server);const relative=path.relative(parent,directory);assert.ok(relative&&!relative.startsWith('..')&&!path.isAbsolute(relative));await rm(directory,{recursive:true,force:true,maxRetries:8,retryDelay:50});});
 return {directory,trackServer(server:net.Server){auxiliaryServers.add(server);},service,route,listenPort,managementPort,upstreamPort,forwarded,catalogs,gates,get pairing(){return pairing;},get version(){return version;},get starts(){return starts;},setCatalogMode(mode:string){catalogMode=mode;},setCommitFailure(value:boolean){failCommit=value;},
  async config(){return management(pairing,'routes.config.get');},
  async save(next:any,credentials?:any){const result=await service.saveRoute(pluginId,{expectedVersion:version,route:next,...(credentials?{credentials}:{})});version=result.configVersion;pairing=result.pairing;return result;},
  async write(method:string,input:any){const result=await management(pairing,method,{expectedVersion:version,...input});version=result.configVersion??result.policyVersion;return result;},
  async configure(input:any){const result=await service.configure(pluginId,{expectedVersion:version,alias:pairing.alias,listenPort,managementPort:pairing.port,...input});version=result.configVersion;pairing=result.pairing;return result;},
  async hashes(){const result:Record<string,string>={};for(const name of ['config.json','secrets.bin','management.bin'])result[name]=createHash('sha256').update(await readFile(path.join(directory,'gateway',pluginId,name))).digest('hex');return result;},
 };
}
const recording=(bodies:boolean,version:number)=>({bodies,retentionDays:7,maxRecords:10000,maxBytes:1024**3,captureBytes:1048576,policyVersion:version});

test('slow accepted body keeps original key, model, rectifier, size limit and recording across real live commits',{skip,timeout:15000},async t=>{
 const f=await fixture(t);
 await f.write('recording.config.set',{recording:recording(true,f.version)});
 await f.write('rules.replace',{rules:[{id:'old-tier',enabled:true,priority:0,match:{},action:{type:'override',value:'flex'}}]});
 await management(f.pairing,'listener.start');const snapshotVersion=f.version;
 const old=data(f.listenPort,oldClient,{model:'alias',input:'accepted-old-body-'+'.'.repeat(2048)},{slow:true});
 await until(async()=>((await management(f.pairing,'listener.status')).activeRequests===1),'slow body was not accepted');
 await f.save({...f.route,name:'新供应商',models:[{id:'alias',upstreamModel:'new-model',enabled:true}]},{clientApiKey:newClient,upstreamApiKey:'fixture-new-upstream'});
 await f.write('rules.replace',{rules:[{id:'new-tier',enabled:true,priority:0,match:{},action:{type:'override',value:'priority'}}]});
 await f.write('recording.config.set',{recording:recording(false,f.version)});
 await f.configure({maxRequestBytes:1024,maxConcurrency:1});
 old.finishBody();assert.equal((await old.promise).status,200);
 assert.equal(f.forwarded[0].body.model,'old-model');assert.equal(f.forwarded[0].body.service_tier,'flex');assert.equal(f.forwarded[0].headers.authorization,'Bearer fixture-old-upstream');
 await until(async()=>((await management(f.pairing,'listener.status')).activeRequests===0),'old finish did not drain');
 const denied=await data(f.listenPort,oldClient,{model:'alias',input:'old-key'}).promise;assert.equal(denied.status,401);assert.equal(f.forwarded.length,1);
 const current=await data(f.listenPort,newClient,{model:'alias',input:'new-key'}).promise;assert.equal(current.status,200);assert.equal(f.forwarded[1].body.model,'new-model');assert.equal(f.forwarded[1].body.service_tier,'priority');assert.equal(f.forwarded[1].headers.authorization,'Bearer fixture-new-upstream');
 // The response body can arrive before asynchronous native recording releases the admission slot.
 await until(async()=>((await management(f.pairing,'listener.status')).activeRequests===0),'current finish did not drain');
 const oversized=await data(f.listenPort,newClient,{model:'alias',input:'new-oversized-'+'.'.repeat(2048)}).promise;assert.equal(oversized.status,413);assert.equal(f.forwarded.length,2);
 await f.write('recording.config.set',{recording:recording(true,f.version)});
 const records=(await management(f.pairing,'records.list',{limit:10})).records;const prior=records.find((r:any)=>r.model==='old-model'),next=records.find((r:any)=>r.model==='new-model');
 assert.equal(prior.chain.configVersion,snapshotVersion);assert.equal(prior.chain.providerName,'旧供应商');assert.equal(prior.effective.value,'flex');
 assert.ok((await management(f.pairing,'records.get',{recordId:prior.id,includeBody:true})).body.text.includes('accepted-old-body'));
 assert.equal((await management(f.pairing,'records.get',{recordId:next.id,includeBody:true})).body,null);
 assert.equal(f.starts,1,'hot commits restarted the core');
});

test('data and management ports prebind, old JSON/SSE drain, and new protocol/agent/provider changes use new snapshots',{skip,timeout:15000},async t=>{
 const f=await fixture(t);await management(f.pairing,'listener.start');
 const json=data(f.listenPort,oldClient,{model:'alias',input:'hold-json'}),sse=data(f.listenPort,oldClient,{model:'alias',input:'hold-sse'});
 await until(()=>f.gates.has('hold-json')&&f.gates.has('hold-sse'),'held upstream requests did not start');const original=f.pairing;
 const nextPort=await unusedPort(),nextManagement=await unusedPort();await f.configure({listenPort:nextPort,managementPort:nextManagement,maxConcurrency:8});
 assert.equal(f.pairing.token,original.token);assert.equal(f.pairing.fingerprintSha256,original.fingerprintSha256);assert.equal((await management(f.pairing,'listener.status')).activeRequests,2);
 await assert.rejects(data(f.listenPort,oldClient,{model:'alias',input:'retired-port'}).promise);
 await f.save({...f.route,protocol:'anthropic',capabilities:{serviceTier:false},models:[{id:'alias',upstreamModel:'claude-new',enabled:true}],upstreamEndpoint:'/v1/messages'}, {clientApiKey:newClient,upstreamApiKey:'fixture-anthropic-upstream'});
 const second={...f.route,id:'secondary',clientAlias:'second',models:[{id:'second-alias',upstreamModel:'second-model',enabled:true}]};
 await f.save(second,{clientApiKey:'fixture-secondary-client-key-0123456789',upstreamApiKey:'fixture-secondary-upstream'});
 await f.write('agents.replace',{agents:[{id:'agent',name:'Agent',credentialRef:'primary',providerIds:['primary','secondary'],enabled:true}]});
 const reply=await data(nextPort,newClient,{model:'alias',input:'new-protocol',max_output_tokens:128},{routeId:''}).promise;
 assert.equal(reply.status,200);assert.equal(f.forwarded.at(-1)?.path,'/v1/messages');assert.equal(f.forwarded.at(-1)?.headers['x-api-key'],'fixture-anthropic-upstream');assert.equal(f.forwarded.at(-1)?.body.model,'claude-new');
 await assert.rejects(f.service.deleteRoute(pluginId,{expectedVersion:f.version,routeId:'secondary'}),/provider-in-use/);
 await f.write('agents.replace',{agents:[{id:'agent',name:'Agent',credentialRef:'primary',providerIds:['primary'],enabled:true}]});
 const removed=await f.service.deleteRoute(pluginId,{expectedVersion:f.version,routeId:'secondary'});assert.equal(removed.configVersion,f.version+1);
 f.gates.get('hold-json')!.resolve();f.gates.get('hold-sse')!.resolve();
 assert.equal((await json.promise).status,200);const streamed=await sse.promise;assert.equal(streamed.status,200);assert.ok(streamed.body.includes('response.created')&&streamed.body.includes('response.completed'));
 await until(async()=>((await management(f.pairing,'listener.status')).activeRequests===0),'retired request finish did not settle');
 const records=(await management(f.pairing,'records.list',{limit:10})).records;assert.equal(records.length,3);assert.ok(records.every((r:any)=>r.status==='completed'));assert.equal(f.starts,1);
});

test('busy data/management ports, failed disk commit and conflicting writers preserve healthy listener, credentials and version',{skip,timeout:15000},async t=>{
 const f=await fixture(t);await management(f.pairing,'listener.start');const before=await f.hashes(),version=f.version;
 const blocker=net.createServer(socket=>socket.destroy()),occupied=await listen(blocker);f.trackServer(blocker);
 for(const ports of [{listenPort:occupied},{managementPort:occupied}]){
  await assert.rejects(f.configure(ports),/(listener|management)-port-unavailable/);assert.deepEqual(await f.hashes(),before);assert.equal((await f.config()).configVersion,version);
  assert.equal((await data(f.listenPort,oldClient,{model:'alias',input:'still-healthy'}).promise).status,200);
 }
 const stagedPort=await unusedPort(),stagedManagement=await unusedPort();f.setCommitFailure(true);
 await assert.rejects(f.configure({listenPort:stagedPort,managementPort:stagedManagement,alias:'must-not-commit'}),/private-configuration-failed/);f.setCommitFailure(false);
 assert.deepEqual(await f.hashes(),before);assert.equal((await f.config()).configVersion,version);assert.equal((await management(f.pairing,'listener.status')).address,'127.0.0.1:'+f.listenPort);
 for(const port of [stagedPort,stagedManagement]){const probe=net.createServer(socket=>socket.destroy());f.trackServer(probe);await new Promise<void>((resolve,reject)=>{probe.once('error',reject);probe.listen(port,'127.0.0.1',resolve);});await close(probe);}
 const outcomes=await Promise.allSettled([f.service.configure(pluginId,{expectedVersion:version,alias:'one',listenPort:f.listenPort,managementPort:f.pairing.port}),f.service.configure(pluginId,{expectedVersion:version,alias:'two',listenPort:f.listenPort,managementPort:f.pairing.port})]);
 assert.equal(outcomes.filter(r=>r.status==='fulfilled').length,1);assert.match((outcomes.find(r=>r.status==='rejected') as PromiseRejectedResult).reason.message,/config-conflict/);assert.equal(f.starts,1);
});

test('draft OpenAI/Anthropic catalogs remain memory-only and reject reflected keys, redirects, stale versions and excess parallelism',{skip,timeout:15000},async t=>{
 const f=await fixture(t),before=await f.hashes(),version=f.version;const snapshot=await management(f.pairing,'listener.status');
 const input={routeId:'unsaved-provider',expectedVersion:version,upstreamBase:'https://catalog.example/v1',upstreamApiKey:'fixture-draft-key-0123456789'};
 for(const protocol of ['openai','anthropic']){const result=await management(f.pairing,'routes.models.preview',{...input,protocol});assert.equal(result.routeId,input.routeId);assert.equal(result.configVersion,version);assert.deepEqual(result.models,[{id:'catalog-model'}]);const headers=f.catalogs.at(-1)!.headers;assert.equal(protocol==='openai'?headers.authorization:headers['x-api-key'],protocol==='openai'?'Bearer '+input.upstreamApiKey:input.upstreamApiKey);}
 for(const [mode,code]of [['reflect','models-credentials-reflected'],['redirect','models-redirect-not-allowed'],['auth','models-auth-failed']]){f.setCatalogMode(mode);await assert.rejects(management(f.pairing,'routes.models.preview',{...input,protocol:'openai'}),error=>(error as Error).message===code);}
 assert.deepEqual(await f.hashes(),before);assert.deepEqual(await management(f.pairing,'listener.status'),snapshot);assert.equal((await f.config()).routes.length,1);assert.equal((await management(f.pairing,'records.list',{limit:10})).records.length,0);
 f.setCatalogMode('hold');const first=management(f.pairing,'routes.models.preview',{...input,protocol:'openai'}),second=management(f.pairing,'routes.models.preview',{...input,protocol:'anthropic'});first.catch(()=>{});second.catch(()=>{});
 await until(()=>f.catalogs.length===7,'two pending catalogs not accepted');await assert.rejects(management(f.pairing,'routes.models.preview',{...input,protocol:'openai'}),/models-busy/);
 await f.write('rules.replace',{rules:[]});await assert.rejects(first,/models-cancelled|config-conflict/);await assert.rejects(second,/models-cancelled|config-conflict/);
 await assert.rejects(management(f.pairing,'routes.models.preview',{...input,protocol:'openai'}),/config-conflict/);
});


test('encrypted pairing write failures and native failures roll back before port activation; success reconnects to the same core',{skip,timeout:15000},async t=>{
 const f=await fixture(t),key=randomBytes(32);let failVault=false;
 const cipher={available:()=>true,encrypt(text:string){const nonce=randomBytes(12),cipher=createCipheriv('aes-256-gcm',key,nonce),bytes=Buffer.concat([cipher.update(text,'utf8'),cipher.final()]);return Buffer.concat([nonce,cipher.getAuthTag(),bytes]).toString('base64');},decrypt(text:string){const bytes=Buffer.from(text,'base64'),cipher=createDecipheriv('aes-256-gcm',key,bytes.subarray(0,12));cipher.setAuthTag(bytes.subarray(12,28));return Buffer.concat([cipher.update(bytes.subarray(28)),cipher.final()]).toString('utf8');}};
 const {writeFile}=await import('node:fs/promises');
 const gateway=new GatewayManagementService({directory:f.directory,cipher,local:f.service,pair:async()=>null,emit:()=>{},chooseExport:async()=>null,writeExport:async()=>{},atomicWrite:async(file,content)=>{if(failVault)throw new Error('private pairing write fixture diagnostic');await writeFile(file,content);}});
 t.after(()=>gateway.close());const owner={id:pluginId,generation:1,view:'gateway',signal:new AbortController().signal};
 const connected=await gateway.request('gateway.connect',{},owner) as {sessionId:string};const session={sessionId:connected.sessionId};await gateway.request('gateway.listener.start',session,owner);
 const before=await f.hashes(),vault=async()=>JSON.parse(cipher.decrypt(JSON.parse(await readFile(path.join(f.directory,'gateway-pairings.json'),'utf8')).vault));
 const oldVault=await vault(),dataPort=await unusedPort(),controlPort=await unusedPort();
 const input={expectedVersion:1,alias:'新端口',listenPort:dataPort,managementPort:controlPort};
 failVault=true;await assert.rejects(gateway.request('gateway.local.configure',input,owner),/private-configuration-failed/);failVault=false;
 assert.deepEqual(await f.hashes(),before);assert.deepEqual(await vault(),oldVault);assert.equal((await gateway.request('gateway.rules.list',session,owner) as any).policyVersion,1);
 assert.equal((await data(f.listenPort,oldClient,{model:'alias',input:'vault-failure-keeps-listener'}).promise).status,200);
 f.setCommitFailure(true);await assert.rejects(gateway.request('gateway.local.configure',input,owner),/private-configuration-failed/);f.setCommitFailure(false);
 assert.deepEqual(await f.hashes(),before);assert.deepEqual(await vault(),oldVault);assert.equal((await gateway.request('gateway.status',{},owner) as any).pairings[0].connected,true);
 assert.deepEqual(await gateway.request('gateway.local.configure',input,owner),{configVersion:2});
 await assert.rejects(gateway.request('gateway.rules.list',session,owner),/gateway-session-revoked/);
 const freshConnected=await gateway.request('gateway.connect',{},owner) as {sessionId:string};const fresh={sessionId:freshConnected.sessionId};
 assert.equal((await gateway.request('gateway.rules.list',fresh,owner) as any).policyVersion,2);
 assert.equal((await gateway.request('gateway.listener.start',fresh,owner) as any).address,'127.0.0.1:'+dataPort);
 assert.equal((await vault()).pairings[0].pairing.port,controlPort);assert.equal((await data(dataPort,oldClient,{model:'alias',input:'reconnected'}).promise).status,200);assert.equal(f.starts,1);
});
