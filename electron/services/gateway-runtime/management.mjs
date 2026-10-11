// Dedicated TLS management adapter. No plugin-controlled URL, command or file path.
import https from 'node:https';
import {timingSafeEqual,X509Certificate,createHash,randomUUID} from 'node:crypto';
import {writeFile,rename,unlink} from 'node:fs/promises';
import path from 'node:path';
import {createGateway,resolvePublicAddresses} from './transport.mjs';
import {createModelCatalog} from './catalog.mjs';
import {createTraceHistory} from './live-metrics.mjs';

const MAX_BYTES=256*1024;
const OWNER_ID=/^extension\.[a-z][a-z0-9-]{0,39}\.[a-z][a-z0-9-]{0,39}$/;
const ID=/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const METHODS=new Set(['hello','listener.status','listener.start','listener.stop','routes.config.get','routes.config.set','routes.models.detect','routes.models.preview','rules.list','rules.preview','rules.replace','recording.config.get','recording.config.set','records.list','records.get','records.delete','agents.get','agents.replace','rectifiers.list','rectifiers.replace','rectifiers.preview','chain.snapshot','cli.target']);
function failure(code,status=400){return Object.assign(new Error(code),{code,status});}
function strict(value,required=[],optional=[]){
 if(!value || typeof value!=='object' || Array.isArray(value) || required.some(key=>!Object.hasOwn(value,key)) || Object.keys(value).some(key=>!required.includes(key)&&!optional.includes(key)))throw failure('invalid-input');
 return value;
}
function integer(value,min,max){if(!Number.isSafeInteger(value) || value<min || value>max)throw failure('invalid-input');return value;}
function identifier(value){if(typeof value!=='string' || !ID.test(value))throw failure('invalid-input');return value;}
function equalSecret(actual,expected){if(typeof actual!=='string')return false;const a=Buffer.from(actual),b=Buffer.from(expected);return a.length===b.length && timingSafeEqual(a,b);}
function headerCount(req,name){let n=0;for(let i=0;i<req.rawHeaders.length;i+=2)if(req.rawHeaders[i].toLowerCase()===name)n++;return n;}
function secretField(value){return value?.state==='string' && (typeof value.value!=='string' || Buffer.byteLength(value.value)>64 || /[\x00-\x1f\x7f]/.test(value.value))?{state:'invalid'}:value;}
function recordDto(record){
 return {id:record.id,startedAtMs:record.started_at_ms,routeId:record.route_id,clientAlias:record.client,endpoint:record.endpoint,model:record.model,
  status:record.status,httpStatus:record.http_status,original:secretField(record.original),effective:secretField(record.effective),reported:secretField(record.reported),ruleId:record.rule_id,
  requestBytes:record.request_bytes,responseBytes:record.response_bytes,durationMs:record.duration_ms,firstResponseMs:record.first_response_ms,firstContentMs:record.first_content_ms,
  inputTokens:record.input_tokens,outputTokens:record.output_tokens,cacheReadTokens:record.cache_read_tokens,cacheWriteTokens:record.cache_write_tokens,recordingPartial:record.recording_partial,errorCode:record.error_code,...(record.chain?{chain:record.chain}:{})};
}
export async function validatePublicUpstream(value){
 if(typeof value!=='string' || value.length>2048)throw failure('invalid-upstream');
 let url;try{url=new URL(value);}catch{throw failure('invalid-upstream');}
 if(url.protocol!=='https:'||url.username||url.password||url.search||url.hash)throw failure('invalid-upstream');
 try{await resolvePublicAddresses(url.hostname.replace(/^\[|\]$/g,''));}catch{throw failure('invalid-upstream');}
 return url.toString();
}
function ruleCore(rule){strict(rule,['id','enabled','priority','match','action']);strict(rule.match,[],['routeId','clientAlias','endpoint','model']);return {...rule,match:{...rule.match,client:rule.match.clientAlias,...(rule.match.clientAlias===undefined?{}:{client:rule.match.clientAlias})}};}
function ruleDto(rule){const {client,...scope}=rule.match??{};return {id:rule.id,enabled:rule.enabled??true,priority:rule.priority??0,match:{...scope,...(client===undefined?{}:{clientAlias:client})},action:rule.action};}
function toCoreRules(rules){if(!Array.isArray(rules)||rules.length>128)throw failure('invalid-input');return rules.map(raw=>{const value=ruleCore(raw);delete value.match.clientAlias;if(value.match.client===undefined)delete value.match.client;return value;});}
function recordingDto(config,version){const raw=config.recording;return {bodies:raw.bodies,retentionDays:raw.retentionDays,maxBytes:raw.maxBytes??1024**3,maxRecords:raw.maxRecords,captureBytes:raw.captureBytes??1024**2,policyVersion:version};}
async function atomicConfig(file,config){const tmp=file+'.'+randomUUID()+'.tmp';try{await writeFile(tmp,JSON.stringify(config,null,2),{flag:'wx',mode:0o600});await rename(tmp,file);}finally{await unlink(tmp).catch(()=>{});}}
async function readRequest(req){
 const chunks=[];let count=0;
 for await(const chunk of req){count+=chunk.length;if(count>MAX_BYTES)throw failure('management-message-too-large',413);chunks.push(chunk);}
 try{return JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(Buffer.concat(chunks)));}catch{throw failure('invalid-input');}
}
function jsonResponse(res,status,value){const body=Buffer.from(JSON.stringify(value));if(body.length>MAX_BYTES){res.writeHead(500,{'content-type':'application/json'});res.end('{"error":{"code":"management-message-too-large"}}');return;}res.writeHead(status,{'content-type':'application/json; charset=utf-8','content-length':body.length,'cache-control':'no-store','connection':'close'});res.end(body);}

/** Start the authenticated management listener; data traffic stays on its own loopback port. */
export async function createManagementGateway({dataDir,engine,identity,routeSecrets,allowFixtureUpstream=false,startData=false,modelCatalog=createModelCatalog()}={}){
 if(!path.isAbsolute(dataDir??'') || !engine || typeof engine.request!=='function')throw failure('invalid-runtime-config');
 strict(identity,['instanceId','alias','port','certificatePem','privateKeyPem','fingerprintSha256','token']);
 identifier(identity.instanceId);integer(identity.port,1,65535);
 if(typeof identity.token!=='string'||identity.token.length<32||identity.token.length>8192||!/^[A-Za-z0-9._~-]+$/.test(identity.token))throw failure('invalid-management-identity');
 const certificate=new X509Certificate(identity.certificatePem);
 if(certificate.fingerprint256.replaceAll(':','').toLowerCase()!==identity.fingerprintSha256 || !certificate.checkIP('127.0.0.1') || !certificate.verify(certificate.publicKey))throw failure('invalid-management-identity');
 const privateKey=identity.privateKeyPem;
 // https.createServer also rejects a mismatched private key. No key is written here.
 let dataGateway=null,listenerOwner=null,stopping=false,active=0;
 let queue=Promise.resolve();
 const serial=job=>{const result=queue.catch(()=>{}).then(job);queue=result;return result;};
 const catalogControllers=new Set();
 let secrets=new Map((routeSecrets??[]).map(value=>[value.routeId,{...value}]));
 const configPath=path.join(dataDir,'config.json');
 const traceHistory=createTraceHistory({recordDto,liveMetrics:()=>dataGateway?.liveMetrics?.()??[]});
 const onTrace=traceHistory.receive,chainSnapshot=traceHistory.snapshot;
 async function config(){return engine.request('config.get');}
 async function listener(){const state=await engine.request('status');return {state:dataGateway?'listening':'stopped',address:dataGateway?.address??null,owned:!!listenerOwner,activeRequests:dataGateway?dataGateway.activeRequests():state.pending};}
 function ownerKey(owner){return owner.hostId+':'+owner.pluginId;}
 function assertOwner(owner){if(listenerOwner && listenerOwner!==ownerKey(owner))throw failure('listener-owned-by-another-host',403);}
 async function detectModels(input,owner,signal,preview=false){
  strict(input,preview?['routeId','expectedVersion','protocol','upstreamBase','upstreamApiKey']:['routeId','expectedVersion']);identifier(input.routeId);integer(input.expectedVersion,0,2147483647);
  if(preview && (!['openai','anthropic'].includes(input.protocol) || typeof input.upstreamBase!=='string'||input.upstreamBase.length>2048 || typeof input.upstreamApiKey!=='string'||input.upstreamApiKey.length>8192||!/^[\x21-\x7e]+$/.test(input.upstreamApiKey)))throw failure('models-invalid-input');
  if(catalogControllers.size>=2)throw failure('models-busy',429);
  const controller=new AbortController();catalogControllers.add(controller);
  const combined=AbortSignal.any([signal,controller.signal]);
  let route,secret;
  const assertFresh=async()=>{
   if(stopping || combined.aborted)throw failure('models-cancelled',499);
   assertOwner(owner);
   const current=await config();
   if(current.configVersion!==input.expectedVersion)throw failure('config-conflict',409);
   if(preview)return {route:{id:input.routeId,protocol:input.protocol,upstream:input.upstreamBase,client:'model-preview',enabled:true},secret:{upstreamKey:input.upstreamApiKey}};
   const latest=current.config.routes.find(value=>value.id===input.routeId);
   const latestSecret=secrets.get(input.routeId);
   if(!latest||!latestSecret)throw failure('unknown-route',404);
   if(route && (JSON.stringify(latest)!==JSON.stringify(route)||latestSecret!==secret))throw failure('config-conflict',409);
   return {route:latest,secret:latestSecret};
  };
  try{
   ({route,secret}=await serial(assertFresh));
   const output=await modelCatalog.detect({route:{...route},upstreamKey:secret.upstreamKey,configVersion:input.expectedVersion,signal:combined,
    assertFresh:()=>serial(assertFresh),privateValues:[identity.token,...(preview?[input.upstreamApiKey]:[]),...[...secrets.values()].flatMap(value=>[value.upstreamKey,value.clientKey])]});
   await serial(assertFresh);
   return output;
  }finally{catalogControllers.delete(controller);}
 }
 async function start(owner){
  assertOwner(owner);if(dataGateway)return listener();
  const {config:current}=await config();
  const enabled=current.routes.filter(route=>route.enabled!==false);
  if(!enabled.length)throw failure('no-enabled-routes');
  dataGateway=await createGateway({config:current,routeSecrets:[...secrets.values()],engine,publicUpstreams:!allowFixtureUpstream,
   modelCatalog,catalogPrivateValues:[identity.token],onTrace});
  listenerOwner=ownerKey(owner);return listener();
 }
 async function stop(owner,mode){
  assertOwner(owner);if(!['drain','cancel'].includes(mode))throw failure('invalid-input');
  if(dataGateway){const previous=dataGateway;dataGateway=null;await previous.stop({mode});}
  listenerOwner=null;return listener();
 }
 async function applyConfiguration(expectedVersion,update,prepareHostCommit) {
  if(stopping)throw failure('gateway-stopping',503);
  const before=await config();if(before.configVersion!==expectedVersion)throw failure('config-conflict',409);
  let plan,dataStage,managementStage,hostStage;
  try {
   plan=await engine.request('configuration.prepare',{expectedVersion,...update,config:{...update.config,configVersion:expectedVersion}});
   if(plan.configVersion!==expectedVersion+1 || plan.config?.configVersion!==plan.configVersion || !Array.isArray(plan.routeSecrets) || typeof plan.transactionId!=='string' || !plan.management || plan.management.instanceId!==identity.instanceId || plan.management.fingerprintSha256!==identity.fingerprintSha256)throw failure('invalid-runtime-config');
   const nextSecrets=new Map(plan.routeSecrets.map(value=>[value.routeId,{...value}]));
   if(dataGateway)dataStage=await dataGateway.prepareConfig(plan.config,plan.routeSecrets);
   if(plan.management.port!==identity.port)managementStage=await bindManagement(plan.management.port);
   if(prepareHostCommit)hostStage=await prepareHostCommit({alias:plan.management.alias,port:plan.management.port});
   dataStage?.assertFresh();hostStage?.assertFresh();
   if(stopping)throw failure('gateway-stopping',503);
   const result=await engine.request('configuration.commit',{transactionId:plan.transactionId});
   // Everything after the native commit is a synchronous assignment to prepared state.
   dataStage?.activate();secrets=nextSecrets;
   identity={...identity,alias:plan.management.alias,port:plan.management.port};
   if(managementStage){const old=currentManagement;currentManagement=managementStage;managementStage.enabled=true;retireManagement(old);}
   for(const controller of catalogControllers)controller.abort();hostStage?.commit();
   return {...result,management:{alias:identity.alias,port:identity.port}};
  }catch(error){
   await hostStage?.rollback().catch(()=>{});
   await dataStage?.cancel().catch(()=>{});
   if(managementStage){managementStage.server.closeAllConnections();await new Promise(resolve=>managementStage.server.close(resolve));managementListeners.delete(managementStage);}
   if(plan?.transactionId)await engine.request('configuration.cancel',{transactionId:plan.transactionId}).catch(()=>{});
   throw error;
  }finally{
   for(const value of plan?.routeSecrets??[]){value.clientKey='';value.upstreamKey='';}
   if(plan?.management){plan.management.token='';plan.management.privateKeyPem='';}
  }
 }
 async function replace(expectedVersion,next){const result=await applyConfiguration(expectedVersion,{config:next});return {configVersion:result.configVersion};}
 async function dispatch(method,input,owner){
  if(stopping)throw failure('gateway-stopping',503);
  if(method==='hello'){strict(input);return {protocolVersion:1};}
  if(method==='listener.status'){strict(input);const value=await listener();return {...value,owned:listenerOwner===ownerKey(owner)};}
  if(method==='listener.start'){strict(input);return start(owner);}
  if(method==='listener.stop'){strict(input,['mode']);return stop(owner,input.mode);}
  if(method==='routes.config.get'){
   strict(input);const {config:current,configVersion}=await config();
   return {configVersion,routes:current.routes.map(route=>({id:route.id,clientAlias:route.client,protocol:route.protocol??'openai',upstreamBase:route.upstream,credentialRef:route.id,credentialPresent:secrets.has(route.id),capabilities:{serviceTier:route.serviceTier??((route.protocol??'openai')==='openai')},enabled:route.enabled!==false,...(route.name===undefined?{}:{name:route.name}),...(route.models?.length?{models:route.models}:{}),...(route.entryEndpoints?.length?{entryEndpoints:route.entryEndpoints}:{}),...(route.upstreamEndpoint===undefined?{}:{upstreamEndpoint:route.upstreamEndpoint})}))};
  }
  if(method==='routes.config.set'){assertOwner(owner);
   strict(input,['expectedVersion','routes']);integer(input.expectedVersion,0,2147483647);
   const current=await config();
   if(!Array.isArray(input.routes)||input.routes.length!==current.config.routes.length)throw failure('credential-route-change-requires-local-setup');
   const seen=new Set();const next=[];
   for(const route of input.routes){
    strict(route,['id','clientAlias','protocol','upstreamBase','credentialRef','capabilities','enabled'],['credentialPresent','name','models','entryEndpoints','upstreamEndpoint']);strict(route.capabilities,['serviceTier']);
    identifier(route.id);identifier(route.clientAlias);identifier(route.credentialRef);
    if(route.id!==route.credentialRef || !secrets.has(route.id)||seen.has(route.id)||!['openai','anthropic'].includes(route.protocol)||typeof route.enabled!=='boolean'||typeof route.capabilities.serviceTier!=='boolean'||route.protocol==='anthropic'&&route.capabilities.serviceTier)throw failure('invalid-route');
    seen.add(route.id);
    const upstream=allowFixtureUpstream?route.upstreamBase:await validatePublicUpstream(route.upstreamBase);
    next.push({id:route.id,client:route.clientAlias,protocol:route.protocol,upstream,enabled:route.enabled,serviceTier:route.capabilities.serviceTier,...(route.name===undefined?{}:{name:route.name}),...(route.models===undefined?{}:{models:route.models}),...(route.entryEndpoints===undefined?{}:{entryEndpoints:route.entryEndpoints}),...(route.upstreamEndpoint===undefined?{}:{upstreamEndpoint:route.upstreamEndpoint})});
   }
   return replace(input.expectedVersion,{...current.config,routes:next});
  }
  if(method==='chain.snapshot'){strict(input);return chainSnapshot();}
  if(method==='agents.get'){strict(input);const current=await config();return {configVersion:current.configVersion,agents:current.config.agents??[]};}
  if(method==='agents.replace'){
   assertOwner(owner);strict(input,['expectedVersion','agents']);integer(input.expectedVersion,0,2147483647);
   const seenKeys=new Set();if(!Array.isArray(input.agents))throw failure('invalid-input');for(const a of input.agents.filter(a=>a.enabled)){const key=secrets.get(a.credentialRef)?.clientKey;if(!key)throw failure('invalid-agent-credentials');if(seenKeys.has(key))throw failure('ambiguous-agent-credentials');seenKeys.add(key);}
   const current=await config();return replace(input.expectedVersion,{...current.config,agents:input.agents});
  }
  if(method==='rectifiers.list'){strict(input);const current=await config();return {configVersion:current.configVersion,rectifiers:(current.config.rectifiers??[]).map(r=>({...r,match:ruleDto(r).match}))};}
  if(method==='rectifiers.replace'){
   assertOwner(owner);strict(input,['expectedVersion','rectifiers']);integer(input.expectedVersion,0,2147483647);
   if(!Array.isArray(input.rectifiers)||input.rectifiers.length>128)throw failure('invalid-input');
   const rules=input.rectifiers.map(r=>{strict(r,['id','enabled','priority','stage','field','match','action']);const {clientAlias,...match}=r.match;strict(r.match,[],['routeId','clientAlias','endpoint','model']);return {...r,match:{...match,...(clientAlias===undefined?{}:{client:clientAlias})}};});
   const current=await config();return replace(input.expectedVersion,{...current.config,rectifiers:rules});
  }
  if(method==='rectifiers.preview'){strict(input,['routeId','endpoint','body'],['clientAlias']);return engine.request('rectifiers.preview',input);}
  if(method==='rules.list'){strict(input);const {config:current,configVersion}=await config();return {policyVersion:configVersion,rules:current.rules.map(ruleDto)};}
  if(method==='rules.preview'){
   strict(input,['routeId','endpoint','originalTier'],['model']);const value=await engine.request('rules.preview',input);return {...value,original:secretField(value.original),effective:secretField(value.effective)};
  }
  if(method==='rules.replace'){assertOwner(owner);
   strict(input,['expectedVersion','rules']);integer(input.expectedVersion,0,2147483647);const current=await config();const result=await replace(input.expectedVersion,{...current.config,rules:toCoreRules(input.rules)});return {policyVersion:result.configVersion};
  }
  if(method==='recording.config.get'){strict(input);const {config:current,configVersion}=await config();return {configVersion,recording:recordingDto(current,configVersion),encryptionAvailable:true};}
  if(method==='recording.config.set'){assertOwner(owner);
   strict(input,['expectedVersion','recording']);integer(input.expectedVersion,0,2147483647);
   strict(input.recording,['bodies','retentionDays','maxBytes','maxRecords','captureBytes','policyVersion']);
   const current=await config();const {policyVersion:_version,...recording}=input.recording;
   const result=await replace(input.expectedVersion,{...current.config,recording});return {configVersion:result.configVersion,encryptionAvailable:true};
  }
  if(method==='records.list'){strict(input,['limit'],['filter','cursor']);const value=await engine.request('records.list.filtered',input);return {records:value.records.map(recordDto),nextCursor:value.nextCursor};}
  if(method==='records.get'){strict(input,['recordId'],['includeBody','bodyCursor']);const value=await engine.request('records.get',input);return {record:recordDto(value.record),body:value.body};}
  if(method==='records.delete'){assertOwner(owner);strict(input,['selection']);return engine.request('records.delete.selection',input);}
  if(method==='cli.target'){
   strict(input,['tool','routeId']);identifier(input.routeId);const {config:current,configVersion}=await config();const route=current.routes.find(route=>route.id===input.routeId&&route.enabled!==false);const secret=secrets.get(input.routeId);
   if(!route||!secret||!['codex','claude-code'].includes(input.tool)||!(route.entryEndpoints?.length?route.entryEndpoints.includes(input.tool==='codex'?'/v1/responses':'/v1/messages'):((input.tool==='codex')===((route.protocol??'openai')==='openai'))))throw failure('incompatible-cli-route');
   const state=await listener();if(state.state!=='listening')throw failure('start-listener-before-cli-setup',409);assertOwner(owner);
   let authToken=secret.clientKey;if(current.agents?.length){const candidates=current.agents.filter(a=>a.enabled&&a.providerIds.includes(route.id));const preferred=candidates.filter(a=>a.credentialRef===route.id);const agent=preferred.length===1?preferred[0]:candidates.length===1?candidates[0]:null;if(!agent||!secrets.has(agent.credentialRef))throw failure('cli-agent-ambiguous');authToken=secrets.get(agent.credentialRef).clientKey;}
   const baseUrl='http://'+state.address+'/'+route.id+(input.tool==='codex'?'/v1':'');
   return {baseUrl,authToken,protocol:input.tool==='codex'?'openai':'anthropic',sessionFingerprint:createHash('sha256').update(JSON.stringify([identity.instanceId,configVersion,baseUrl,authToken])).digest('hex')};
  }
  throw failure('unsupported-method');
 }
 const managementListeners=new Set();
 function newManagement(port){
 const entry={server:null,port,enabled:false};
 const server=https.createServer({key:privateKey,cert:identity.certificatePem,minVersion:'TLSv1.2',maxHeaderSize:16384},(req,res)=>{void (async()=>{
  ++active;
  const requestController=new AbortController();
  const cancel=()=>requestController.abort();
  req.once('aborted',cancel);res.once('close',cancel);
  try{
   if(stopping||!entry.enabled)throw failure('gateway-stopping',503);
   if(active>64)throw failure('gateway-busy',429);
   if(headerCount(req,'host')!==1||req.headers.host!=='127.0.0.1:'+entry.port||headerCount(req,'origin')>0)throw failure('invalid-host-or-origin',403);
   if(req.method!=='POST'||typeof req.url!=='string'||!req.url.startsWith('/management/v1/')||req.url.includes('?')||req.url.includes('#'))throw failure('unsupported-method',404);
   const method=req.url.slice('/management/v1/'.length);if(!METHODS.has(method))throw failure('unsupported-method',404);
   if(headerCount(req,'authorization')!==1||!equalSecret(req.headers.authorization,'Bearer '+identity.token))throw failure('unauthorized',401);
   if(!/^application\/json(?:\s*;|$)/i.test(req.headers['content-type']??'')||req.headers['content-encoding']&&req.headers['content-encoding']!=='identity')throw failure('invalid-content-type',415);
   const raw=strict(await readRequest(req),['protocolVersion','instanceId','owner','input']);
   if(raw.protocolVersion!==1||raw.instanceId!==identity.instanceId)throw failure('instance-or-protocol-mismatch',409);
   strict(raw.owner,['hostId','pluginId']);identifier(raw.owner.hostId);if(typeof raw.owner.pluginId!=='string'||!OWNER_ID.test(raw.owner.pluginId))throw failure('invalid-owner');
   const output=method==='routes.models.detect'||method==='routes.models.preview'
    ?await detectModels(raw.input,raw.owner,requestController.signal,method==='routes.models.preview')
    :await serial(()=>dispatch(method,raw.input,raw.owner));
   if(!res.destroyed)jsonResponse(res,200,{protocolVersion:1,instanceId:identity.instanceId,result:output});
  }catch(error){
   const code=typeof error?.code==='string'&&/^[a-z0-9-]{1,64}$/.test(error.code)?error.code:'management-failed';
   const status=error?.status??(code==='config-conflict'||code==='models-route-changed'?409:code==='unknown-route'?404:code==='models-cancelled'?499:code==='models-timeout'?504:code.startsWith('models-')&&!['models-invalid-input','models-invalid-upstream'].includes(code)?502:400);
   if(!res.destroyed)jsonResponse(res,status,{error:{code}});
  }
  finally{--active;req.off('aborted',cancel);res.off('close',cancel);req.resume();}
 })();});
 server.headersTimeout=15000;server.requestTimeout=15000;server.keepAliveTimeout=1000;server.maxHeadersCount=32;
 server.on('upgrade',(_req,socket)=>socket.destroy());server.on('clientError',(_err,socket)=>socket.destroy());
 entry.server=server;managementListeners.add(entry);return entry;
 }
 async function bindManagement(port){const entry=newManagement(port);try{await new Promise((resolve,reject)=>{entry.server.once('error',reject);entry.server.listen(port,'127.0.0.1',()=>{entry.server.off('error',reject);resolve();});});return entry;}catch{managementListeners.delete(entry);entry.server.close();throw failure('management-port-unavailable',409);}}
 function retireManagement(entry){entry.enabled=false;entry.server.close(()=>managementListeners.delete(entry));entry.server.closeIdleConnections();}
 let currentManagement=await bindManagement(identity.port);currentManagement.enabled=true;
 if(startData){const localOwner={hostId:'local-'+identity.instanceId,pluginId:'extension.lumi.gateway'};try{await start(localOwner);}catch(error){currentManagement.server.closeAllConnections();await new Promise(resolve=>currentManagement.server.close(resolve));throw error;}}
 let closePromise;
 return {get port(){return identity.port;},metrics:()=>dataGateway?.metrics??{recordingFailures:0},
  // Host-only transaction shares the same serial queue with HTTPS writes and start/stop.
  configure(expectedVersion,update,prepareHostCommit){return serial(()=>applyConfiguration(expectedVersion,update,prepareHostCommit));},
  prepareConfiguration(expectedVersion){return serial(async()=>{const current=await config();if(stopping)throw failure('gateway-stopping',503);if(current.configVersion!==expectedVersion)throw failure('config-conflict',409);return current;});},
  close(){if(closePromise)return closePromise;stopping=true;for(const controller of catalogControllers)controller.abort();closePromise=(async()=>{await Promise.all([...managementListeners].map(entry=>new Promise(resolve=>{entry.enabled=false;entry.server.closeAllConnections();entry.server.close(resolve);})));await queue.catch(()=>{});if(dataGateway){await dataGateway.stop();dataGateway=null;}listenerOwner=null;})();return closePromise;}
 };
}
