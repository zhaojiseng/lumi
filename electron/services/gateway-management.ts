import https from 'node:https';
import {isDeepStrictEqual} from 'node:util';
import type {GatewayPairingPreparation} from './gateway-local';
import type {GatewayHostCommitStage} from './gateway-runtime/types.mjs';
import {randomUUID} from 'node:crypto';
import {readFile} from 'node:fs/promises';
import path from 'node:path';
import {z} from 'zod';
import type {Cipher} from './store';
import type {GatewayBridge,GatewayMethod,GatewayOwner,GatewayRevocationReason,GatewayInputMap,GatewayListenerDto,GatewayEventDto,GatewayLocalStatusDto} from '../../shared/contracts/gateway';
import {parseGatewayInput,parseGatewayOutput,parseGatewayEvent} from '../../shared/gateway-validation';
import {gatewayPairingTlsOptions,validateGatewayPairing,type GatewayPairing} from './gateway-pairing';

const MAX_BYTES=256*1024;
const REQUEST_TIMEOUT=15000;
const catalogErrorCodes=[
 'models-invalid-input','models-invalid-upstream','models-dns-failed','models-address-changed','models-timeout','models-cancelled',
 'models-redirect-not-allowed','models-auth-failed','models-endpoint-unavailable','models-rate-limited','models-http-failed',
 'models-response-invalid','models-response-too-large','models-response-interrupted','models-connection-failed',
 'models-credentials-reflected','models-pagination-invalid','models-result-too-large','models-route-changed','models-busy',
 'config-conflict','gateway-session-revoked','gateway-stopping','unknown-route','listener-owned-by-another-host',
] as const;
const catalogError=z.object({error:z.object({code:z.enum(catalogErrorCodes)}).strict()}).strict();
const opaque=z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/);
const internalTargetSchema=z.object({baseUrl:z.string().max(2048),authToken:z.string().min(16).max(8192),sessionFingerprint:opaque,protocol:z.enum(['openai','anthropic'])}).strict();
interface StoredPairing {pairing:GatewayPairing;pluginId:string;pendingRevocation:boolean;listener?:GatewayListenerDto;}
interface Session {id:string;pairingId:string;owner:GatewayOwner;controller:AbortController;}
interface Subscription {id:string;sessionId:string;owner:GatewayOwner;timer:ReturnType<typeof setTimeout>|null;busy:boolean;}
export interface GatewayCliConfigBridge {
 preview(input:GatewayInputMap['gateway.cliConfig.preview'],owner:GatewayOwner):Promise<unknown>;
 apply(input:GatewayInputMap['gateway.cliConfig.apply'],owner:GatewayOwner):Promise<unknown>;
 restore(input:GatewayInputMap['gateway.cliConfig.restore'],owner:GatewayOwner):Promise<unknown>;
}
export interface GatewayManagementOptions {
 directory:string;cipher:Cipher;
 atomicWrite(file:string,content:string):Promise<void>;
 pair(signal:AbortSignal):Promise<GatewayPairing|null>;
 emit(event:{id:string;generation:number;view:string;topic:'gateway';payload:GatewayEventDto}):void;
 chooseExport(format:'json'|'jsonl',signal:AbortSignal):Promise<string|null>;
 writeExport(file:string,content:string):Promise<void>;
 cli?:GatewayCliConfigBridge;
 local?:GatewayLocalBridge;
}
/** Fixed host resources only; this bridge is never exposed directly to the renderer. */
export interface GatewayLocalBridge {
 status(pluginId:string):Promise<Omit<GatewayLocalStatusDto,'pairingId'>>;
 ensureStarted(pluginId:string):Promise<GatewayPairing|null>;
 setup(pluginId:string,input:GatewayInputMap['gateway.local.setup']):Promise<{configVersion:number;pairing:GatewayPairing}>;
 configure(pluginId:string,input:GatewayInputMap['gateway.local.configure'],preparePairing?:GatewayPairingPreparation):Promise<{configVersion:number;pairing:GatewayPairing}>;
 saveRoute(pluginId:string,input:Omit<GatewayInputMap['gateway.routes.save'],'sessionId'>):Promise<{configVersion:number;pairing:GatewayPairing}>;
 deleteRoute(pluginId:string,input:Omit<GatewayInputMap['gateway.routes.delete'],'sessionId'>):Promise<{configVersion:number;pairing:GatewayPairing}>;
 stop(pluginId:string):Promise<void>;
 shutdown():Promise<void>;
}
function sameOwner(a:{id:string;generation?:number;view?:string},b:GatewayOwner){return a.id===b.id && (a.generation===undefined || a.generation===b.generation) && (a.view===undefined || a.view===b.view);}
function safeFailure(code='gateway-unavailable'){return Object.assign(new Error('网关操作失败（'+code+'）。请检查配对、监听状态和连接。'),{code});}
function fixedListener():GatewayListenerDto{return {state:'stopped',address:null,owned:false,activeRequests:0};}

/** Only registered TLS peers and named management methods can be reached. */
export class GatewayManagementService implements GatewayBridge {
 private pairings=new Map<string,StoredPairing>();
 private sessions=new Map<string,Session>();
 private subscriptions=new Map<string,Subscription>();
 private hostId:string=randomUUID();
 private closed=false;
 private pending=0;
 private vaultQueue:Promise<void>=Promise.resolve();
 private pairingQueue:Promise<unknown>=Promise.resolve();
 private controllers=new Set<AbortController>();
 private lifetime=new AbortController();
 constructor(private options:GatewayManagementOptions){}
 async load(){
  let text:string;
  try{text=await readFile(this.vaultFile(),'utf8');}catch(error:any){if(error.code==='ENOENT')return;throw safeFailure('pairing-store-unavailable');}
  if(Buffer.byteLength(text)>2*1024*1024 || !this.options.cipher.available())throw safeFailure('pairing-store-unavailable');
  try{
   const envelope=z.object({version:z.literal(1),vault:z.string().max(2*1024*1024)}).strict().parse(JSON.parse(text));
   const parsed=z.object({hostId:opaque,pairings:z.array(z.object({pairing:z.unknown(),pluginId:z.string().regex(/^extension\.[a-z][a-z0-9-]{0,39}\.[a-z][a-z0-9-]{0,39}$/),pendingRevocation:z.boolean()}).strict()).max(32)}).strict().parse(JSON.parse(this.options.cipher.decrypt(envelope.vault)));
   const restored=new Map<string,StoredPairing>();
   for(const row of parsed.pairings){const pairing=validateGatewayPairing(row.pairing);if(restored.has(pairing.id))throw new Error();restored.set(pairing.id,{pairing,pluginId:row.pluginId,pendingRevocation:row.pendingRevocation});}
   this.hostId=parsed.hostId;this.pairings=restored;
  }catch{throw safeFailure('pairing-store-unavailable');}
 }
 private vaultFile(){return path.join(this.options.directory,'gateway-pairings.json');}
 private persist(replacement?:{id:string;row?:StoredPairing}){
  const job=this.vaultQueue.catch(()=>{}).then(async()=>{
   if(!this.options.cipher.available())throw safeFailure('secure-storage-unavailable');
   const rows=new Map(this.pairings);if(replacement){if(replacement.row)rows.set(replacement.id,replacement.row);else rows.delete(replacement.id);}
   const plaintext=JSON.stringify({hostId:this.hostId,pairings:[...rows.values()].map(row=>({pairing:row.pairing,pluginId:row.pluginId,pendingRevocation:row.pendingRevocation}))});
   await this.options.atomicWrite(this.vaultFile(),JSON.stringify({version:1,vault:this.options.cipher.encrypt(plaintext)}));
  });this.vaultQueue=job;return job;
 }
 private ownerValid(owner:GatewayOwner){if(this.closed || owner.signal.aborted)throw safeFailure('gateway-session-revoked');}
 private checkSessionLimit(owner:GatewayOwner){if(this.sessions.size>=64 || [...this.sessions.values()].filter(session=>sameOwner(owner,session.owner)).length>=4)throw safeFailure('session-limit');}
 private session(id:string,owner:GatewayOwner){this.ownerValid(owner);const session=this.sessions.get(id);if(!session || !sameOwner(owner,session.owner) || session.controller.signal.aborted)throw safeFailure('gateway-session-revoked');return session;}
 private pairingFor(session:Session){const row=this.pairings.get(session.pairingId);if(!row || row.pluginId!==session.owner.id)throw safeFailure('unknown-pairing');return row;}
 private async managedPairing(pairing:GatewayPairing,owner:GatewayOwner){
  this.ownerValid(owner);pairing=validateGatewayPairing(pairing);
  const commit=this.pairingQueue.catch(()=>{}).then(async()=>{
   this.ownerValid(owner);const existing=this.pairings.get(pairing.id);
   if(existing && (existing.pluginId!==owner.id || existing.pairing.instanceId!==pairing.instanceId || existing.pairing.fingerprintSha256!==pairing.fingerprintSha256))throw safeFailure('pairing-identity-changed');
   if(!existing && this.pairings.size>=32)throw safeFailure('pairing-limit');
   if(existing&&isDeepStrictEqual(existing.pairing,pairing))return existing;
   const row:StoredPairing={pairing,pluginId:owner.id,pendingRevocation:existing?.pendingRevocation??false,...(existing?.listener?{listener:existing.listener}:{})};
   this.pairings.set(pairing.id,row);
   try{await this.persist();}catch(error){if(existing)this.pairings.set(pairing.id,existing);else this.pairings.delete(pairing.id);throw error;}
   this.ownerValid(owner);return row;
  });this.pairingQueue=commit;return commit;
 }
 /** Stage the encrypted pairing file before the native commit, while live sessions
  * keep their original port. A failed vault write cannot change the gateway. */
 private async prepareManagedPairing(pairing:GatewayPairing,owner:GatewayOwner):Promise<GatewayHostCommitStage>{
  this.ownerValid(owner);pairing=validateGatewayPairing(pairing);
  let release!:()=>void;const gate=new Promise<void>(resolve=>{release=resolve;});
  const prepared=this.pairingQueue.catch(()=>{}).then(async()=>{
   const existing=this.pairings.get(pairing.id);this.ownerValid(owner);
   if(existing&&(existing.pluginId!==owner.id||existing.pairing.instanceId!==pairing.instanceId||existing.pairing.fingerprintSha256!==pairing.fingerprintSha256))throw safeFailure('pairing-identity-changed');
   if(!existing&&this.pairings.size>=32)throw safeFailure('pairing-limit');
   const row:StoredPairing={pairing,pluginId:owner.id,pendingRevocation:existing?.pendingRevocation??false,...(existing?.listener?{listener:existing.listener}:{})};
   const changed=!existing||!isDeepStrictEqual(existing.pairing,pairing);let settled=false;
   try{if(changed)await this.persist({id:pairing.id,row});this.ownerValid(owner);}
   catch(error){if(changed)await this.persist({id:pairing.id,row:existing}).catch(()=>{});throw error;}
   return {assertFresh:()=>this.ownerValid(owner),commit:()=>{if(settled)return;settled=true;row.pendingRevocation=existing?.pendingRevocation??row.pendingRevocation;this.pairings.set(pairing.id,row);release();},
    rollback:async()=>{if(settled)return;settled=true;try{if(changed)await this.persist({id:pairing.id,row:existing});}finally{release();}}};
  });
  this.pairingQueue=prepared.then(()=>gate,error=>{release();throw error;});this.pairingQueue.catch(()=>{});
  return prepared;
 }
 private async remote(row:StoredPairing,method:string,input:unknown,signal:AbortSignal):Promise<unknown>{
  signal=AbortSignal.any([signal,this.lifetime.signal]);
  if(signal.aborted || this.closed)throw safeFailure('gateway-session-revoked');
  if(!/^[a-zA-Z][a-zA-Z0-9]*(?:\.[a-zA-Z][a-zA-Z0-9]*)*$/.test(method))throw safeFailure('unsupported-method');
  if(this.pending>=64)throw safeFailure('gateway-busy');
  const body=Buffer.from(JSON.stringify({protocolVersion:1,instanceId:row.pairing.instanceId,owner:{hostId:this.hostId,pluginId:row.pluginId},input}));
  if(body.length>MAX_BYTES)throw safeFailure('management-message-too-large');
  ++this.pending;
  try{
   return await new Promise((resolve,reject)=>{
    let done=false,bytes=0;const chunks:Buffer[]=[];
    const finish=(error?:Error,value?:unknown)=>{if(done)return;done=true;signal.removeEventListener('abort',abort);clearTimeout(timer);error?reject(error):resolve(value);};
    const request=https.request({host:'127.0.0.1',port:row.pairing.port,path:'/management/v1/'+method,method:'POST',agent:false,
     ...gatewayPairingTlsOptions(row.pairing),
     headers:{host:'127.0.0.1:'+row.pairing.port,authorization:'Bearer '+row.pairing.token,'content-type':'application/json','content-length':body.length,'connection':'close'}},response=>{
      const catalogFailure=(method==='routes.models.detect'||method==='routes.models.preview') && response.statusCode!==200 && (response.statusCode??0)>=400 && (response.statusCode??0)<=599;
      if(response.statusCode!==200 && !catalogFailure || !/^application\/json(?:\s*;|$)/i.test(String(response.headers['content-type']??''))){response.destroy();request.destroy();finish(safeFailure('management-response-invalid'));return;}
      response.on('data',(chunk:Buffer)=>{bytes+=chunk.length;if(bytes>(catalogFailure?8192:MAX_BYTES)){response.destroy();request.destroy();finish(safeFailure('management-message-too-large'));return;}chunks.push(chunk);});
      response.on('error',()=>finish(safeFailure()));response.on('aborted',()=>finish(safeFailure()));
      response.on('end',()=>{
       try{
        const decoded=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(Buffer.concat(chunks)));
        if(catalogFailure){finish(safeFailure(catalogError.parse(decoded).error.code));return;}
        const envelope=z.object({protocolVersion:z.literal(1),instanceId:z.literal(row.pairing.instanceId),result:z.unknown()}).strict().parse(decoded);
        finish(undefined,envelope.result);
       }catch{finish(safeFailure('management-response-invalid'));}
      });
     });
    const abort=()=>{request.destroy();finish(safeFailure('gateway-session-revoked'));};
    const timer=setTimeout(()=>{request.destroy();finish(safeFailure('management-timeout'));},REQUEST_TIMEOUT);
    request.on('error',()=>finish(safeFailure('management-tls-or-connection-failed')));
    signal.addEventListener('abort',abort,{once:true});if(signal.aborted){abort();return;}
    request.end(body);
   });
  }finally{--this.pending;}
 }
 private async call(session:Session,method:GatewayMethod,input:unknown){
  const row=this.pairingFor(session);
  const output=await this.remote(row,method.slice('gateway.'.length),input,AbortSignal.any([session.owner.signal,session.controller.signal]));
  this.ownerValid(session.owner);if(!this.sessions.has(session.id))throw safeFailure('gateway-session-revoked');
  let parsed:unknown;try{parsed=parseGatewayOutput(method,output);}catch{throw safeFailure('management-response-invalid');}
  if(method==='gateway.listener.start' || method==='gateway.listener.stop')row.listener=parsed as GatewayListenerDto;
  return parsed;
 }
 async request(method:GatewayMethod,input:unknown,owner:GatewayOwner):Promise<unknown>{
  this.ownerValid(owner);const parsed=parseGatewayInput(method,input);
  if(method==='gateway.local.status'){
   if(!this.options.local)throw safeFailure('local-gateway-unavailable');
   const status=await this.options.local.status(owner.id);this.ownerValid(owner);
   const pairing=[...this.pairings.values()].find(row=>row.pluginId===owner.id && row.pairing.id.startsWith('local-'));
   return parseGatewayOutput(method,{...status,pairingId:pairing?.pairing.id??null});
  }
  if(method==='gateway.local.setup' || method==='gateway.local.configure'){
   if(!this.options.local)throw safeFailure('local-gateway-unavailable');
   const result=method==='gateway.local.setup'
    ?await this.options.local.setup(owner.id,parsed as GatewayInputMap['gateway.local.setup'])
    :await this.options.local.configure(owner.id,parsed as GatewayInputMap['gateway.local.configure'],pairing=>this.prepareManagedPairing(pairing,owner));
   this.ownerValid(owner);
   if(method==='gateway.local.configure')for(const session of [...this.sessions.values()])if(session.owner.id===owner.id && session.pairingId===result.pairing.id)this.dropSession(session.id);
   const row=await this.managedPairing(result.pairing,owner);
   return parseGatewayOutput(method,method==='gateway.local.setup'?{pairingId:row.pairing.id,configVersion:result.configVersion}:{configVersion:result.configVersion});
  }
  if(method==='gateway.status')return parseGatewayOutput(method,{pairings:[...this.pairings.values()].filter(row=>row.pluginId===owner.id).map(row=>({pairingId:row.pairing.id,alias:row.pairing.alias,instanceId:row.pairing.instanceId,protocolVersion:1,connected:[...this.sessions.values()].some(session=>session.pairingId===row.pairing.id),listening:row.listener?row.listener.state==='listening':null,activeRequests:row.listener?.activeRequests??null,pendingRevocation:row.pendingRevocation}))});
  if(method==='gateway.pair'){
   const result=await this.options.pair(owner.signal);this.ownerValid(owner);if(!result)return null;
   const pairing=validateGatewayPairing(result);
   const existing=[...this.pairings.values()].find(row=>row.pluginId===owner.id && row.pairing.instanceId===pairing.instanceId);
   if(existing){if(existing.pairing.fingerprintSha256!==pairing.fingerprintSha256)throw safeFailure('pairing-identity-changed');return {pairingId:existing.pairing.id};}
   if(this.pairings.size>=32)throw safeFailure('pairing-limit');
   const row:StoredPairing={pairing,pluginId:owner.id,pendingRevocation:false};
   // Confirm identity/protocol before persisting any authorization.
   const response=await this.remote(row,'hello',{},owner.signal);
   try{z.object({protocolVersion:z.literal(1)}).strict().parse(response);}catch{throw safeFailure('management-response-invalid');}this.ownerValid(owner);
   const commit=this.pairingQueue.catch(()=>{}).then(async()=>{
    this.ownerValid(owner);
    const existing=[...this.pairings.values()].find(saved=>saved.pluginId===owner.id && saved.pairing.instanceId===pairing.instanceId);
    if(existing){if(existing.pairing.fingerprintSha256!==pairing.fingerprintSha256)throw safeFailure('pairing-identity-changed');return {pairingId:existing.pairing.id};}
    if(this.pairings.size>=32)throw safeFailure('pairing-limit');
    this.pairings.set(pairing.id,row);
    try{await this.persist();}catch(error){if(this.pairings.get(pairing.id)===row)this.pairings.delete(pairing.id);throw error;}
    this.ownerValid(owner);return {pairingId:pairing.id};
   });this.pairingQueue=commit;return commit;
  }
  if(method==='gateway.connect'){
   let {pairingId}=parsed as GatewayInputMap['gateway.connect'];
   if(!pairingId || pairingId.startsWith('local-')){
    if(!this.options.local)throw safeFailure('local-gateway-unavailable');
    const pairing=await this.options.local.ensureStarted(owner.id);this.ownerValid(owner);
    if(!pairing)throw safeFailure('local-gateway-not-configured');
    if(pairingId && pairingId!==pairing.id)throw safeFailure('unknown-pairing');
    pairingId=(await this.managedPairing(pairing,owner)).pairing.id;
   }
   const row=this.pairings.get(pairingId);
   if(!row || row.pluginId!==owner.id)throw safeFailure('unknown-pairing');
   this.checkSessionLimit(owner);
   if(row.pendingRevocation){
    let stopped:GatewayListenerDto;try{stopped=parseGatewayOutput('gateway.listener.stop',await this.remote(row,'listener.stop',{mode:'cancel'},owner.signal));}catch{throw safeFailure('pending-revocation-failed');}
    if(stopped.state!=='stopped' || stopped.activeRequests!==0)throw safeFailure('pending-revocation-failed');
    row.pendingRevocation=false;row.listener=stopped;await this.persist();
   }
   try{z.object({protocolVersion:z.literal(1)}).strict().parse(await this.remote(row,'hello',{},owner.signal));}catch{throw safeFailure('management-response-invalid');}this.ownerValid(owner);
   this.checkSessionLimit(owner);
   const session:Session={id:randomUUID(),pairingId,owner,controller:new AbortController()};
   this.sessions.set(session.id,session);return {sessionId:session.id,instanceId:row.pairing.instanceId,protocolVersion:1};
  }
  if(method==='gateway.events.unsubscribe'){
   const {subscriptionId}=parsed as GatewayInputMap['gateway.events.unsubscribe'];const sub=this.subscriptions.get(subscriptionId);
   if(sub && !sameOwner(owner,sub.owner))throw safeFailure('gateway-session-revoked');this.dropSubscription(subscriptionId);return {unsubscribed:true};
  }
  if(method==='gateway.cliConfig.apply' || method==='gateway.cliConfig.restore'){
   if(!this.options.cli)throw safeFailure('cli-config-unavailable');
   const result=method==='gateway.cliConfig.apply'?await this.options.cli.apply(parsed as GatewayInputMap['gateway.cliConfig.apply'],owner):await this.options.cli.restore(parsed as GatewayInputMap['gateway.cliConfig.restore'],owner);
   this.ownerValid(owner);return parseGatewayOutput(method,result);
  }
  const sessionId=(parsed as {sessionId:string}).sessionId;
  const session=this.session(sessionId,owner);
  if(method==='gateway.disconnect'){this.dropSession(session.id);return {disconnected:true};}
  if(method==='gateway.events.subscribe'){
   if(this.subscriptions.size>=64 || [...this.subscriptions.values()].filter(sub=>sameOwner(owner,sub.owner)).length>=4)throw safeFailure('subscription-limit');
   const id=randomUUID();const sub:Subscription={id,sessionId,owner,timer:null,busy:false};this.subscriptions.set(id,sub);this.schedule(sub);return {subscriptionId:id};
  }
  if(method==='gateway.cliConfig.preview'){
   if(!this.options.cli)throw safeFailure('cli-config-unavailable');
   const result=await this.options.cli.preview(parsed as GatewayInputMap['gateway.cliConfig.preview'],owner);
   this.session(session.id,owner);return parseGatewayOutput(method,result);
  }
  if(method==='gateway.records.export')return this.exportRecords(session,parsed as GatewayInputMap['gateway.records.export']);
  if(method==='gateway.routes.save' || method==='gateway.routes.delete'){
   if(!this.options.local || !session.pairingId.startsWith('local-'))throw safeFailure('local-gateway-unavailable');
   const {sessionId:_session,...routeInput}=parsed as GatewayInputMap['gateway.routes.save']|GatewayInputMap['gateway.routes.delete'];
   const result=method==='gateway.routes.save'
    ?await this.options.local.saveRoute(owner.id,routeInput as Omit<GatewayInputMap['gateway.routes.save'],'sessionId'>)
    :await this.options.local.deleteRoute(owner.id,routeInput as Omit<GatewayInputMap['gateway.routes.delete'],'sessionId'>);
   this.session(session.id,owner);await this.managedPairing(result.pairing,owner);
   return parseGatewayOutput(method,{configVersion:result.configVersion});
  }
  const {sessionId:_session,...remoteInput}=parsed as {sessionId:string;[key:string]:unknown};
  const output=await this.call(session,method,remoteInput);
  if(method==='gateway.routes.models.detect'||method==='gateway.routes.models.preview'){
   const input=parsed as GatewayInputMap['gateway.routes.models.detect'];
   const catalog=output as import('../../shared/contracts/gateway').GatewayModelCatalogDto;
   if(catalog.routeId!==input.routeId||catalog.configVersion!==input.expectedVersion||method==='gateway.routes.models.preview'&&catalog.models.some(model=>model.id.includes((parsed as GatewayInputMap['gateway.routes.models.preview']).upstreamApiKey)))throw safeFailure('management-response-invalid');
  }
  return output;
 }
 /** This private entry never appears in SDK and never returns credentials to an extension. */
 async resolveCliTarget(input:GatewayInputMap['gateway.cliConfig.preview'],owner:GatewayOwner){
  const session=this.session(input.sessionId,owner);const row=this.pairingFor(session);
  let result:z.infer<typeof internalTargetSchema>;try{result=internalTargetSchema.parse(await this.remote(row,'cli.target',{tool:input.tool,routeId:input.routeId},AbortSignal.any([owner.signal,session.controller.signal])));}catch{throw safeFailure('management-response-invalid');}
  this.session(input.sessionId,owner);return result;
 }
 async assertCliContext(input:{sessionId:string;routeId:string;tool:'codex'|'claude-code'},owner:GatewayOwner){this.session(input.sessionId,owner);}
 setCliBridge(cli:GatewayCliConfigBridge){this.options.cli=cli;}
 private schedule(sub:Subscription){
  sub.timer=setTimeout(()=>{void this.poll(sub);},1000);sub.timer.unref();
 }
 private async poll(sub:Subscription){
  if(sub.busy || !this.subscriptions.has(sub.id) || !this.sessions.has(sub.sessionId))return;
  sub.busy=true;
  try{
   const session=this.session(sub.sessionId,sub.owner),status=parseGatewayOutput('gateway.listener.start',await this.remote(this.pairingFor(session),'listener.status',{},AbortSignal.any([sub.owner.signal,session.controller.signal])));
   this.session(sub.sessionId,sub.owner);if(!this.subscriptions.has(sub.id))return;
   this.pairingFor(session).listener=status;
   this.options.emit({id:sub.owner.id,generation:sub.owner.generation,view:sub.owner.view,topic:'gateway',payload:parseGatewayEvent({subscriptionId:sub.id,sessionId:sub.sessionId,type:'status',status})});
  }catch{
   if(this.subscriptions.has(sub.id) && !sub.owner.signal.aborted)this.options.emit({id:sub.owner.id,generation:sub.owner.generation,view:sub.owner.view,topic:'gateway',payload:parseGatewayEvent({subscriptionId:sub.id,sessionId:sub.sessionId,type:'warning',code:'management-connection-failed'})});
  }finally{sub.busy=false;if(this.subscriptions.has(sub.id))this.schedule(sub);}
 }
 private dropSubscription(id:string){const sub=this.subscriptions.get(id);if(sub?.timer)clearTimeout(sub.timer);this.subscriptions.delete(id);}
 private dropSession(id:string){for(const sub of this.subscriptions.values())if(sub.sessionId===id)this.dropSubscription(sub.id);this.sessions.get(id)?.controller.abort();this.sessions.delete(id);}
 private async exportRecords(session:Session,input:GatewayInputMap['gateway.records.export']){
  const chosen=await this.options.chooseExport(input.format,session.owner.signal);this.session(session.id,session.owner);if(!chosen)return {exported:0,cancelled:true};
  const selection=input.selection;
  const rows:unknown[]=[];
  if('recordIds' in selection){
   for(const recordId of selection.recordIds){const detail=parseGatewayOutput('gateway.records.get',await this.call(session,'gateway.records.get',{recordId,includeBody:false}));rows.push(detail.record);}
  }else{
   let cursor:string|undefined;
   do{
    const page=parseGatewayOutput('gateway.records.list',await this.call(session,'gateway.records.list',{filter:{...selection.filter,toMs:Math.min(selection.filter.toMs??selection.throughMs,selection.throughMs)},limit:100,...(cursor?{cursor}:{})}));
    rows.push(...page.records);if(rows.length>10000)throw safeFailure('export-limit');cursor=page.nextCursor??undefined;
   }while(cursor);
  }
  this.session(session.id,session.owner);
  const content=input.format==='json'?JSON.stringify(rows,null,2):rows.map(row=>JSON.stringify(row)).join('\n')+'\n';
  if(Buffer.byteLength(content)>16*1024*1024)throw safeFailure('export-limit');
  await this.options.writeExport(chosen,content);this.session(session.id,session.owner);return {exported:rows.length,cancelled:false};
 }
 async revoke(owner:{id:string;generation?:number;view?:string},reason:GatewayRevocationReason){
  for(const session of [...this.sessions.values()])if(sameOwner(owner,session.owner))this.dropSession(session.id);
  if(reason!=='disabled')return;
  const rows=[...this.pairings.values()].filter(row=>row.pluginId===owner.id);
  if(!rows.length){await this.options.local?.stop(owner.id);return;}
  for(const row of rows)row.pendingRevocation=true;
  await this.persist();
  for(const row of rows){
   const controller=new AbortController();this.controllers.add(controller);
   try{
    const stopped=parseGatewayOutput('gateway.listener.stop',await this.remote(row,'listener.stop',{mode:'drain'},controller.signal));
    if(stopped.state==='stopped' && stopped.activeRequests===0){row.pendingRevocation=false;row.listener=stopped;await this.persist();}
   }catch{/* The persisted revocation runs before the next connect. */}
   finally{this.controllers.delete(controller);}
  }
  await this.options.local?.stop(owner.id);
 }
 close(){this.closed=true;this.lifetime.abort();for(const id of [...this.sessions.keys()])this.dropSession(id);for(const controller of this.controllers)controller.abort();this.controllers.clear();}
 async shutdown(){this.close();await this.options.local?.shutdown();}
}
