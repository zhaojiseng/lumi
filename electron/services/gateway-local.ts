import {spawn} from 'node:child_process';
import {randomBytes,randomUUID} from 'node:crypto';
import {lstat,mkdir,readFile} from 'node:fs/promises';
import path from 'node:path';
import {z} from 'zod';
import {gatewayModelSchema,gatewayAgentSchema} from '../../shared/gateway-validation';
import type {GatewayInputMap,GatewayLocalStatusDto} from '../../shared/contracts/gateway';
import {validateGatewayPairing,type GatewayPairing} from './gateway-pairing';
import {startEngine} from './gateway-runtime/engine.mjs';
import {createManagementGateway,validatePublicUpstream} from './gateway-runtime/management.mjs';
import {createTlsIdentity} from './gateway-runtime/tls-identity.mjs';
import type {CoreConfig,CoreRoute,Engine,ManagementGateway,ManagementIdentity,GatewayHostCommitStage} from './gateway-runtime/types.mjs';

const MAX_BYTES=256*1024;
const ownerId=z.string().regex(/^extension\.[a-z][a-z0-9-]{0,39}\.[a-z][a-z0-9-]{0,39}$/);
const id=z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/);
const version=z.number().int().min(1).max(2147483647);
const port=z.number().int().min(1024).max(65535);
const alias=z.string().min(1).max(100).refine(value=>!/[\u0000-\u001f\u007f]/.test(value));
const secret=z.string().min(1).max(8192).regex(/^[\x21-\x7e]+$/);
const credentials=z.object({upstreamApiKey:secret.optional(),clientApiKey:secret.min(16).optional()}).strict()
 .refine(value=>value.upstreamApiKey!==undefined || value.clientApiKey!==undefined);
const route=z.object({id,clientAlias:id,protocol:z.enum(['openai','anthropic']),upstreamBase:z.string().min(1).max(2048),
 capabilities:z.object({serviceTier:z.boolean()}).strict(),enabled:z.boolean(),
 name:alias.optional(),models:z.array(gatewayModelSchema).max(128).optional(),entryEndpoints:z.array(z.enum(['/v1/responses','/v1/chat/completions','/v1/messages'])).max(3).optional(),upstreamEndpoint:z.enum(['/v1/responses','/v1/chat/completions','/v1/messages']).optional()}).strict()
 .refine(value=>(value.protocol!=='anthropic'||!value.capabilities.serviceTier) && (value.upstreamEndpoint===undefined || (value.upstreamEndpoint==='/v1/messages')===(value.protocol==='anthropic')));
const ports={alias,listenPort:port,managementPort:port,maxRequestBytes:z.number().int().min(1).max(4*1024*1024).optional(),maxConcurrency:z.number().int().min(1).max(128).optional()};
const portsDiffer=(value:{listenPort:number;managementPort:number})=>value.listenPort!==value.managementPort;
const setupSchema=z.object({...ports,route,credentials:z.object({upstreamApiKey:secret,clientApiKey:secret.min(16)}).strict()}).strict().refine(portsDiffer);
const configureSchema=z.object({...ports,expectedVersion:version}).strict().refine(portsDiffer);
const saveRouteSchema=z.object({expectedVersion:version,route,credentials:credentials.optional()}).strict();
const deleteRouteSchema=z.object({expectedVersion:version,routeId:id}).strict();
const coreRouteSchema=z.object({id,client:id,protocol:z.enum(['openai','anthropic']).default('openai'),upstream:z.string().max(2048),
 serviceTier:z.boolean().optional(),enabled:z.boolean().default(true),name:alias.optional(),models:z.array(gatewayModelSchema).max(128).optional(),entryEndpoints:z.array(z.enum(['/v1/responses','/v1/chat/completions','/v1/messages'])).max(3).optional(),upstreamEndpoint:z.enum(['/v1/responses','/v1/chat/completions','/v1/messages']).optional()}).strict();
const configSchema=z.object({schemaVersion:z.literal(1),configVersion:version.default(1),
 listen:z.string().regex(/^127\.0\.0\.1:(\d{1,5})$/).refine(value=>port.safeParse(Number(value.slice(value.lastIndexOf(':')+1))).success),
 routes:z.array(coreRouteSchema).min(1).max(32),rules:z.array(z.unknown()).max(128).default([]),
 agents:z.array(gatewayAgentSchema).max(32).optional(),rectifiers:z.array(z.unknown()).max(128).optional(),
 recording:z.object({bodies:z.boolean(),retentionDays:z.number().int().min(1).max(365),maxRecords:z.number().int().min(1).max(100000),
  maxBytes:z.number().int().min(1048576).max(10*1024**3),captureBytes:z.number().int().min(1).max(1048576)}).strict(),
 maxRequestBytes:z.number().int().min(1).max(4*1024*1024),maxConcurrency:z.number().int().min(1).max(128)}).strict();
const configurationSchema=z.object({config:configSchema,configVersion:version}).strict();
const SAFE_CODES=new Set(['invalid-local-input','invalid-local-owner','invalid-local-directory','invalid-runtime-binary','local-runtime-closed',
 'local-not-configured','local-already-configured','local-directory-unavailable','local-runtime-unavailable','local-config-unavailable',
 'private-configuration-failed','private-message-too-large','invalid-upstream','config-conflict','stop-listener-before-changing-routes',
 'active-requests','gateway-stopping','listener-port-unavailable','management-port-unavailable','configuration-busy','invalid-route-credentials','invalid-agent-credentials','ambiguous-agent-credentials','missing-route-credentials','route-limit','unknown-route','local-last-route','provider-in-use','local-shutdown-failed','private-shutdown-failed']);
function failure(code:string){return Object.assign(new Error('本机网关操作失败（'+code+'）。'),{code});}
function safe(error:unknown,fallback='local-runtime-unavailable'){
 const code=(error as {code?:unknown})?.code;
 return failure(typeof code==='string'&&SAFE_CODES.has(code)?code:fallback);
}
function parsed<T>(schema:z.ZodType<T>,input:unknown):T{const value=schema.safeParse(input);if(!value.success)throw failure('invalid-local-input');return value.data;}
function coreConfig(input:unknown):CoreConfig{
 const current=parsed(configSchema,input);
 return {...current,routes:current.routes.map(value=>({...value,serviceTier:value.serviceTier??value.protocol==='openai'}))};
}
export interface GatewayPrivateInput {binaryPath:string;dataDir:string;operation:'initialize-private'|'configure-private';input:Buffer;}
export interface GatewayLocalFactories {
 startEngine:typeof startEngine;createManagementGateway:typeof createManagementGateway;createTlsIdentity:typeof createTlsIdentity;
 runPrivate(input:GatewayPrivateInput):Promise<{configVersion:number}>;
}
export interface GatewayLocalOptions {
 /** Application-owned userData root. The service appends gateway/<plugin ID>. */
 dataDir:string;
 /** Fixed bundled native executable; never supplied through IPC. */
 binaryPath:string;
 /** Constructor-only hooks for isolated fixtures, never renderer options. */
 allowFixtureUpstream?:boolean;factories?:Partial<GatewayLocalFactories>;
}
export type GatewayPairingPreparation=(pairing:GatewayPairing)=>Promise<GatewayHostCommitStage>;
export interface GatewayLocalMutation {configVersion:number;pairing:GatewayPairing;}
type Runtime={engine:Engine;management:ManagementGateway;pairing:GatewayPairing};
type Slot={runtime?:Runtime;orphaned?:{engine:Engine;management?:ManagementGateway};pairing?:GatewayPairing;
 metadata?:{alias:string;managementPort:number};errorCode?:string;privateShutdownUnknown?:boolean};

/** Fixed binary + fixed arguments; credentials travel only through a bounded private stdin pipe. */
async function runPrivate({binaryPath,dataDir,operation,input}:GatewayPrivateInput):Promise<{configVersion:number}>{
 if(input.length>MAX_BYTES)throw failure('private-message-too-large');
 return new Promise((resolve,reject)=>{
  const child=spawn(binaryPath,[operation,dataDir],{stdio:['pipe','pipe','pipe'],windowsHide:true,shell:false});
  let settled=false,failed=false,bytes=0;let killTimer:ReturnType<typeof setTimeout>|undefined;const chunks:Buffer[]=[];
  const fail=()=>{if(settled||failed)return;failed=true;clearTimeout(timer);child.kill();
   killTimer=setTimeout(()=>{if(settled)return;settled=true;reject(failure('private-shutdown-failed'));},2000);
  };
  const timer=setTimeout(fail,30000);
  child.on('error',fail);child.stdin.on('error',fail);child.stdout.on('error',fail);child.stderr.on('error',fail);
  // Never forward core diagnostics: they must not reflect secret pipe contents.
  child.stderr.resume();child.stdout.on('data',(chunk:Buffer)=>{bytes+=chunk.length;if(bytes>4096){fail();return;}chunks.push(chunk);});
  child.on('close',code=>{
   if(settled)return;
   clearTimeout(timer);clearTimeout(killTimer);
   if(failed||code!==0){settled=true;reject(failure('private-configuration-failed'));return;}
   try{
    const result=z.object({configVersion:version}).strict().parse(JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(Buffer.concat(chunks))));
    settled=true;clearTimeout(timer);resolve(result);
   }catch{settled=true;reject(failure('private-configuration-failed'));}
  });
  child.stdin.end(input);
 });
}

/** App-owned gateway lifecycle. No arbitrary path, executable, URL or pairing export is exposed to extensions. */
export class GatewayLocalService {
 private slots=new Map<string,Slot>();
 private queues=new Map<string,Promise<unknown>>();
 private closed=false;
 private factories:GatewayLocalFactories;
 constructor(private options:GatewayLocalOptions){
  if(!path.isAbsolute(options.dataDir))throw failure('invalid-local-directory');
  if(!path.isAbsolute(options.binaryPath))throw failure('invalid-runtime-binary');
  this.factories={startEngine,createManagementGateway,createTlsIdentity,runPrivate,...options.factories};
 }
 private directory(pluginId:string){
  if(!ownerId.safeParse(pluginId).success)throw failure('invalid-local-owner');
  return path.join(this.options.dataDir,'gateway',pluginId);
 }
 private serial<T>(pluginId:string,job:()=>Promise<T>,closing=false):Promise<T>{
  this.directory(pluginId);if(this.closed&&!closing)return Promise.reject(failure('local-runtime-closed'));
  const pending=(this.queues.get(pluginId)??Promise.resolve()).catch(()=>{}).then(async()=>{
   if(this.closed&&!closing)throw failure('local-runtime-closed');
   try{return await job();}catch(error){throw safe(error);}
  });
  this.queues.set(pluginId,pending);return pending;
 }
 private slot(pluginId:string){let slot=this.slots.get(pluginId);if(!slot){slot={};this.slots.set(pluginId,slot);}return slot;}
 private async parent(create=false){
  const gateway=path.join(this.options.dataDir,'gateway');
  if(create)await mkdir(gateway,{recursive:true,mode:0o700});
  try{const value=await lstat(gateway);if(!value.isDirectory()||value.isSymbolicLink())throw failure('invalid-local-directory');}
  catch(error:any){if(error?.code==='ENOENT'&&!create)return false;throw safe(error,'invalid-local-directory');}
  return true;
 }
 private async configured(pluginId:string){
  if(!await this.parent())return false;
  const directory=this.directory(pluginId);
  try{
   const value=await lstat(directory);if(!value.isDirectory()||value.isSymbolicLink())throw failure('invalid-local-directory');
   const file=await lstat(path.join(directory,'config.json'));
   if(!file.isFile()||file.isSymbolicLink()||file.size>MAX_BYTES)throw failure('local-config-unavailable');
   return true;
  }catch(error:any){if(error?.code==='ENOENT')return false;throw safe(error,'local-config-unavailable');}
 }
 private async diskConfig(pluginId:string){
  try{return coreConfig(JSON.parse(await readFile(path.join(this.directory(pluginId),'config.json'),'utf8')));}
  catch{throw failure('local-config-unavailable');}
 }
 private async current(runtime:Runtime){
  const value=parsed(configurationSchema,await runtime.engine.request('config.get'));
  if(value.config.configVersion!==value.configVersion)throw failure('local-config-unavailable');
  return {config:coreConfig(value.config),configVersion:value.configVersion};
 }
 private wipeBootstrap(engine:Engine){
  const boot=engine.bootstrap;
  for(const value of boot.routeSecrets){value.clientKey='';value.upstreamKey='';}
  boot.routeSecrets=[];
  if(boot.management){boot.management.privateKeyPem='';boot.management.token='';boot.management=null;}
 }
 private async readMetadata(pluginId:string){
  const slot=this.slot(pluginId);if(slot.metadata)return;
  if(slot.privateShutdownUnknown||slot.orphaned)throw failure('local-shutdown-failed');
  let engine:Engine|undefined;
  try{
   // Reading protected metadata does not bind either listener. This keeps the
   // configuration page usable when an old management port is occupied.
   engine=await this.factories.startEngine({dataDir:this.directory(pluginId),testBinary:this.options.binaryPath});
   const identity=engine.bootstrap.management;
   if(engine.bootstrap.protocolVersion!==1||!identity)throw failure('local-runtime-unavailable');
   const {privateKeyPem:_key,...fields}=identity;
   const pairing=validateGatewayPairing({...fields,id:'local-'+identity.instanceId});
   slot.pairing=pairing;slot.metadata={alias:pairing.alias,managementPort:pairing.port};
  }catch(error){
   if((error as {code?:string})?.code==='engine-shutdown-failed'){slot.privateShutdownUnknown=true;slot.errorCode='local-shutdown-failed';throw failure('local-shutdown-failed');}
   slot.errorCode=safe(error).code;throw safe(error);
  }
  finally{
   if(engine){this.wipeBootstrap(engine);
    try{await engine.close();}catch{slot.orphaned={engine};slot.errorCode='local-shutdown-failed';throw failure('local-shutdown-failed');}
   }
  }
 }
 private async start(pluginId:string):Promise<GatewayPairing|null>{
  const slot=this.slot(pluginId);if(slot.privateShutdownUnknown||slot.orphaned)throw failure('local-shutdown-failed');
  if(slot.runtime){if(slot.errorCode==='local-shutdown-failed')throw failure('local-shutdown-failed');return slot.runtime.pairing;}
  if(!await this.configured(pluginId))return null;
  let engine:Engine|undefined,management:ManagementGateway|undefined;
  try{
   engine=await this.factories.startEngine({dataDir:this.directory(pluginId),testBinary:this.options.binaryPath});
   const boot=engine.bootstrap,identity=boot.management;
   if(boot.protocolVersion!==1||!identity)throw failure('local-runtime-unavailable');
   coreConfig(boot.config);
   const {privateKeyPem:_key,...fields}=identity;
   const pairing=validateGatewayPairing({...fields,id:'local-'+identity.instanceId});
   // The adapter retains its own private copies; remove bootstrap references
   // once transferred so no host status DTO can accidentally enumerate them.
   management=await this.factories.createManagementGateway({dataDir:this.directory(pluginId),engine,
    identity:{...identity},routeSecrets:boot.routeSecrets.map(value=>({...value})),allowFixtureUpstream:this.options.allowFixtureUpstream??false});
   this.wipeBootstrap(engine);
   slot.runtime={engine,management,pairing};slot.pairing=pairing;slot.metadata={alias:pairing.alias,managementPort:pairing.port};delete slot.errorCode;return pairing;
  }catch(error){
   if((error as {code?:string})?.code==='engine-shutdown-failed'){slot.privateShutdownUnknown=true;slot.errorCode='local-shutdown-failed';throw failure('local-shutdown-failed');}
   let shutdownFailed=false;
   if(engine)this.wipeBootstrap(engine);
   try{await management?.close();}catch{shutdownFailed=true;}
   try{await engine?.close();}catch{shutdownFailed=true;}
   if(shutdownFailed&&engine){slot.orphaned={engine,management};slot.errorCode='local-shutdown-failed';throw failure('local-shutdown-failed');}
   slot.errorCode=safe(error).code;throw safe(error);
  }
 }
 private async closeSlot(pluginId:string){
  const slot=this.slot(pluginId),runtime=slot.runtime??slot.orphaned;if(!runtime)return;
  let failed=false;
  try{await runtime.management?.close();}catch{failed=true;}
  try{await runtime.engine.close();}catch{failed=true;}
  if(failed){slot.errorCode='local-shutdown-failed';throw failure('local-shutdown-failed');}
  delete slot.runtime;delete slot.orphaned;
 }
 private async upstream(value:string){
  if(!this.options.allowFixtureUpstream){try{return await validatePublicUpstream(value);}catch{throw failure('invalid-upstream');}}
  try{
   const url=new URL(value);if(url.username||url.password||url.search||url.hash||url.protocol!=='https:'&&!(url.protocol==='http:'&&url.hostname==='127.0.0.1'))throw new Error();
   return url.toString();
  }catch{throw failure('invalid-upstream');}
 }
 private async routeCore(input:z.infer<typeof route>):Promise<CoreRoute>{
  return {id:input.id,client:input.clientAlias,protocol:input.protocol,upstream:await this.upstream(input.upstreamBase),serviceTier:input.capabilities.serviceTier,enabled:input.enabled,...(input.name===undefined?{}:{name:input.name}),...(input.models===undefined?{}:{models:input.models}),...(input.entryEndpoints===undefined?{}:{entryEndpoints:input.entryEndpoints}),...(input.upstreamEndpoint===undefined?{}:{upstreamEndpoint:input.upstreamEndpoint})};
 }
 private async command(pluginId:string,operation:GatewayPrivateInput['operation'],input:unknown){
  const payload=Buffer.from(JSON.stringify(input));
  try{
   if(payload.length>MAX_BYTES)throw failure('private-message-too-large');
   return parsed(z.object({configVersion:version}).strict(),await this.factories.runPrivate({binaryPath:this.options.binaryPath,dataDir:this.directory(pluginId),operation,input:payload}));
  }catch(error){if((error as {code?:string})?.code==='private-shutdown-failed')this.slot(pluginId).privateShutdownUnknown=true;
   throw safe(error,'private-configuration-failed');}finally{payload.fill(0);}
 }
 private async mutate(pluginId:string,expectedVersion:number,change:(config:CoreConfig)=>Promise<{config:CoreConfig;credentials?:unknown;management?:{alias:string;port:number}}>,preparePairing?:GatewayPairingPreparation){
  const slot=this.slot(pluginId);
  if(slot.privateShutdownUnknown||slot.orphaned||slot.errorCode==='local-shutdown-failed')throw failure('local-shutdown-failed');
  if(!await this.configured(pluginId))throw failure('local-not-configured');
  const runtime=slot.runtime;
  // Prepare inputs before the serialized live transaction rechecks the version
  // after any concurrent HTTPS configuration transaction has drained.
  const before=runtime?await this.current(runtime):{config:await this.diskConfig(pluginId),configVersion:0};
  if(!runtime)before.configVersion=before.config.configVersion;
  if(before.configVersion!==expectedVersion)throw failure('config-conflict');
  const update=await change(before.config);
  if(runtime){
   let result;try{result=await runtime.management.configure(expectedVersion,update,preparePairing?management=>preparePairing(validateGatewayPairing({...runtime.pairing,alias:management.alias,port:management.port})):undefined);}catch(error){throw safe(error,'private-configuration-failed');}
   const pairing=validateGatewayPairing({...runtime.pairing,alias:result.management.alias,port:result.management.port});
   runtime.pairing=pairing;slot.pairing=pairing;slot.metadata={alias:pairing.alias,managementPort:pairing.port};
   return {configVersion:result.configVersion,pairing};
  }
  let result:{configVersion:number};
  try{result=await this.command(pluginId,'configure-private',{expectedVersion,...update});}
  catch(error){await this.start(pluginId).catch(()=>{});throw error;}
  if(update.management){slot.metadata={alias:update.management.alias,managementPort:update.management.port};
   if(slot.pairing)slot.pairing={...slot.pairing,alias:update.management.alias,port:update.management.port};}
  const next=await this.start(pluginId);if(!next)throw failure('local-runtime-unavailable');
  return {configVersion:result.configVersion,pairing:next};
 }
 async status(pluginId:string):Promise<Omit<GatewayLocalStatusDto,'pairingId'>>{
  return this.serial(pluginId,async()=>{
   const slot=this.slot(pluginId),configured=await this.configured(pluginId);
   if(!configured)return {configured:false,running:false,alias:null,listenPort:null,managementPort:null,configVersion:null};
   if(!slot.metadata&&!slot.runtime)await this.readMetadata(pluginId);
   const current=slot.runtime?(await this.current(slot.runtime)).config:await this.diskConfig(pluginId);
   return {configured:true,running:!!slot.runtime,alias:slot.metadata?.alias??slot.pairing?.alias??null,listenPort:Number(current.listen.split(':').at(-1)),
    managementPort:slot.metadata?.managementPort??slot.pairing?.port??null,configVersion:current.configVersion,
    maxRequestBytes:current.maxRequestBytes,maxConcurrency:current.maxConcurrency,...(slot.errorCode?{errorCode:slot.errorCode}:{})};
  });
 }
 async ensureStarted(pluginId:string){return this.serial(pluginId,()=>this.start(pluginId));}
 async setup(pluginId:string,input:GatewayInputMap['gateway.local.setup']):Promise<GatewayLocalMutation>{
  return this.serial(pluginId,async()=>{
   const value=parsed(setupSchema,input);await this.parent(true);
   if(await this.configured(pluginId))throw failure('local-already-configured');
   try{await lstat(this.directory(pluginId));throw failure('local-directory-unavailable');}catch(error:any){if(error?.code!=='ENOENT')throw safe(error,'local-directory-unavailable');}
   const first=await this.routeCore(value.route);
   const identity:ManagementIdentity={instanceId:randomUUID(),alias:value.alias,port:value.managementPort,...this.factories.createTlsIdentity(),token:randomBytes(32).toString('base64url')};
   try{
    const config:CoreConfig={schemaVersion:1,configVersion:1,listen:'127.0.0.1:'+value.listenPort,routes:[first],rules:[],
     recording:{bodies:false,retentionDays:7,maxRecords:10000,maxBytes:1024**3,captureBytes:1024**2},maxConcurrency:value.maxConcurrency??32,maxRequestBytes:value.maxRequestBytes??2*1024*1024};
    const result=await this.command(pluginId,'initialize-private',{config,routeSecrets:[{routeId:first.id,clientKey:value.credentials.clientApiKey,upstreamKey:value.credentials.upstreamApiKey}],management:identity});
    const {privateKeyPem:_key,...fields}=identity;
    this.slot(pluginId).pairing=validateGatewayPairing({...fields,id:'local-'+identity.instanceId});
    this.slot(pluginId).metadata={alias:value.alias,managementPort:value.managementPort};
    const pairing=await this.start(pluginId);if(!pairing)throw failure('local-runtime-unavailable');
    return {configVersion:result.configVersion,pairing};
   }finally{identity.privateKeyPem='';identity.token='';}
  });
 }
 async configure(pluginId:string,input:GatewayInputMap['gateway.local.configure'],preparePairing?:GatewayPairingPreparation):Promise<GatewayLocalMutation>{
  return this.serial(pluginId,async()=>{const value=parsed(configureSchema,input);
   return this.mutate(pluginId,value.expectedVersion,async config=>({config:{...config,listen:'127.0.0.1:'+value.listenPort,
    maxRequestBytes:value.maxRequestBytes??config.maxRequestBytes,maxConcurrency:value.maxConcurrency??config.maxConcurrency},management:{alias:value.alias,port:value.managementPort}}),preparePairing);
  });
 }
 async saveRoute(pluginId:string,input:Omit<GatewayInputMap['gateway.routes.save'],'sessionId'>):Promise<GatewayLocalMutation>{
  return this.serial(pluginId,async()=>{const value=parsed(saveRouteSchema,input);
   return this.mutate(pluginId,value.expectedVersion,async config=>{
    const next=await this.routeCore(value.route),index=config.routes.findIndex(item=>item.id===next.id);
    if(index<0&&(!value.credentials?.clientApiKey||!value.credentials.upstreamApiKey))throw failure('missing-route-credentials');
    if(index<0&&config.routes.length>=32)throw failure('route-limit');
    const routes=[...config.routes];if(index<0)routes.push(next);else routes[index]=next;
    return {config:{...config,routes},...(value.credentials?{credentials:[{routeId:next.id,...(value.credentials.clientApiKey?{clientKey:value.credentials.clientApiKey}:{}),...(value.credentials.upstreamApiKey?{upstreamKey:value.credentials.upstreamApiKey}:{})}]}:{})};
   });
  });
 }
 async deleteRoute(pluginId:string,input:Omit<GatewayInputMap['gateway.routes.delete'],'sessionId'>):Promise<GatewayLocalMutation>{
  return this.serial(pluginId,async()=>{const value=parsed(deleteRouteSchema,input);
   return this.mutate(pluginId,value.expectedVersion,async config=>{
    if(!config.routes.some(item=>item.id===value.routeId))throw failure('unknown-route');
    if(config.routes.length===1)throw failure('local-last-route');
    if(config.agents?.some(a=>a.credentialRef===value.routeId||a.providerIds.includes(value.routeId)))throw failure('provider-in-use');
    return {config:{...config,routes:config.routes.filter(item=>item.id!==value.routeId)}};
   });
  });
 }
 async stop(pluginId:string){return this.serial(pluginId,()=>this.closeSlot(pluginId),true);}
 async shutdown(){
  if(this.closed)return;this.closed=true;
  const results=await Promise.allSettled([...new Set([...this.slots.keys(),...this.queues.keys()])].map(pluginId=>this.stop(pluginId)));
  if(results.some(result=>result.status==='rejected'))throw failure('local-shutdown-failed');
 }
}
