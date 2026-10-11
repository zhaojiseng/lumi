import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdir,mkdtemp,writeFile,readFile,rm,symlink} from 'node:fs/promises';
import path from 'node:path';
import {GatewayLocalService,type GatewayLocalFactories,type GatewayPrivateInput} from '../electron/services/gateway-local';
import type {CoreConfig,ManagementIdentity,RouteSecret} from '../electron/services/gateway-runtime/types.mjs';
import {gatewayTestCertificate} from './fixtures/gateway-certificate';

const pluginId='extension.lumi.gateway';
const clientApiKey='fixture-client-key-0123456789';
const upstreamApiKey='fixture-upstream-key-9876543210';
const certificate=gatewayTestCertificate();
const route={id:'primary',clientAlias:'codex',protocol:'openai' as const,upstreamBase:'http://127.0.0.1:18001/v1',capabilities:{serviceTier:true},enabled:true};
const setup={alias:'本机测试网关',listenPort:18002,managementPort:18003,route,credentials:{clientApiKey,upstreamApiKey}};
type Stored={config:CoreConfig;management:ManagementIdentity;routeSecrets:RouteSecret[]};
function clone<T>(value:T):T{return structuredClone(value);}
function deferred(){let resolve!:()=>void;const promise=new Promise<void>(done=>{resolve=done;});return {promise,resolve};}
async function fixture(t:test.TestContext){
 const parent=path.resolve('.test-data/gateway-local');await mkdir(parent,{recursive:true});
 const directory=await mkdtemp(path.join(parent,'local-'));
 const binaryPath=path.join(directory,'fixed-runtime'+(process.platform==='win32'?'.exe':''));
 const states=new Map<string,Stored>();
 const commands:Array<{file:string;directory:string;operation:string;payload:Buffer}>=[];
 const messages:string[]=[],lifecycle:string[]=[],payloads:Buffer[]=[];
 let listening=false,pending=0,failCommand=false,failStart=false,closeGate:Promise<void>|undefined;
 const factories:GatewayLocalFactories={
  createTlsIdentity:()=>({certificatePem:certificate.pem,privateKeyPem:certificate.key.toString(),fingerprintSha256:certificate.fingerprint}),
  async runPrivate(value:GatewayPrivateInput){
   commands.push({file:value.binaryPath,directory:value.dataDir,operation:value.operation,payload:Buffer.from(value.input)});
   payloads.push(value.input);if(failCommand)throw new Error(upstreamApiKey);
   const input=JSON.parse(value.input.toString('utf8'));
   const before=states.get(value.dataDir);
   if(value.operation==='initialize-private'){
    assert.equal(before,undefined);await mkdir(value.dataDir);
    states.set(value.dataDir,clone({config:input.config,management:input.management,routeSecrets:input.routeSecrets}));
   }else{
    assert.ok(before);assert.equal(before.config.configVersion,input.expectedVersion);
    const next=clone(before);next.config={...input.config,configVersion:input.expectedVersion+1};
    next.routeSecrets=next.routeSecrets.filter(item=>next.config.routes.some(itemRoute=>itemRoute.id===item.routeId));
    for(const change of input.credentials??[]){
     const index=next.routeSecrets.findIndex(item=>item.routeId===change.routeId);
     if(index<0)next.routeSecrets.push(change);else next.routeSecrets[index]={...next.routeSecrets[index],...change};
    }
    if(input.management)next.management={...next.management,...input.management};
    states.set(value.dataDir,next);
   }
   const current=states.get(value.dataDir)!;await writeFile(path.join(value.dataDir,'config.json'),JSON.stringify(current.config));
   return {configVersion:current.config.configVersion};
  },
  async startEngine(input){
   if(failStart)throw new Error(upstreamApiKey);assert.equal(input.testBinary,binaryPath);
   const state=states.get(input.dataDir)!;assert.ok(state);lifecycle.push('engine-start');
   const boot={protocolVersion:1 as const,...clone(state)};
   return {bootstrap:boot,async request(method){messages.push(method);
    if(method==='status')return {pending};
    if(method==='config.get')return {config:clone(state.config),configVersion:state.config.configVersion};
    throw new Error(clientApiKey);
   },async close(){lifecycle.push('engine-close');}};
  },
  async createManagementGateway(input){
   assert.equal(input.allowFixtureUpstream,true);assert.ok(input.identity.privateKeyPem);assert.equal(input.routeSecrets[0].clientKey,states.get(input.dataDir)!.routeSecrets[0].clientKey);
   lifecycle.push('management-start');
   return {port:input.identity.port,metrics:()=>({recordingFailures:0}),async configure(expectedVersion,update){
    const stored=states.get(input.dataDir)!;
    if(stored.config.configVersion!==expectedVersion)throw Object.assign(new Error('fixture'),{code:'config-conflict'});
    if(failCommand)throw new Error(upstreamApiKey);
    const next=clone(stored);next.config={...clone(update.config),configVersion:expectedVersion+1};
    next.routeSecrets=next.routeSecrets.filter(secret=>next.config.routes.some(route=>route.id===secret.routeId));
    for(const change of update.credentials as any[]??[]){const index=next.routeSecrets.findIndex(secret=>secret.routeId===change.routeId);if(index<0)next.routeSecrets.push(change);else next.routeSecrets[index]={...next.routeSecrets[index],...change};}
    if(update.management)next.management={...next.management,...update.management};
    await writeFile(path.join(input.dataDir,'config.json'),JSON.stringify(next.config));Object.assign(stored,next);
    lifecycle.push('configuration-commit');return {configVersion:next.config.configVersion,management:{alias:next.management.alias,port:next.management.port}};
   },async prepareConfiguration(expectedVersion){
    if(listening)throw Object.assign(new Error('fixture'),{code:'stop-listener-before-changing-routes'});
    if(pending)throw Object.assign(new Error('fixture'),{code:'active-requests'});
    const current=states.get(input.dataDir)!;
    if(current.config.configVersion!==expectedVersion)throw Object.assign(new Error('fixture'),{code:'config-conflict'});
    return {config:clone(current.config),configVersion:expectedVersion};
   },async close(){lifecycle.push('management-drain');if(closeGate)await closeGate;lifecycle.push('management-close');}};
  },
 };
 const services:GatewayLocalService[]=[];
 const make=()=>{const service=new GatewayLocalService({dataDir:directory,binaryPath,allowFixtureUpstream:true,factories});services.push(service);return service;};
 const service=make();
 t.after(async()=>{closeGate=undefined;for(const current of services)await current.shutdown();
  const relative=path.relative(parent,directory);assert.ok(relative&&!relative.startsWith('..')&&!path.isAbsolute(relative));await rm(directory,{recursive:true,force:true});});
 return {directory,binaryPath,service,make,commands,messages,lifecycle,payloads,states,
  setListening(value:boolean){listening=value;},setPending(value:number){pending=value;},setCommandFailure(value:boolean){failCommand=value;},setStartFailure(value:boolean){failStart=value;},
  setCloseGate(value:Promise<void>|undefined){closeGate=value;},
  current:(owner=pluginId)=>states.get(path.join(directory,'gateway',owner))!};
}
async function safeReject(promise:Promise<unknown>,code?:string){
 await assert.rejects(promise,error=>{assert.ok(error instanceof Error);assert.equal(error.message.includes(clientApiKey),false);assert.equal(error.message.includes(upstreamApiKey),false);
  if(code)assert.equal((error as Error&{code:string}).code,code);return true;});
}

test('GUI setup uses a fixed owner directory and private input, then returns only internal protected pairing',async t=>{
 const f=await fixture(t);
 assert.deepEqual(await f.service.status(pluginId),{configured:false,running:false,alias:null,listenPort:null,managementPort:null,configVersion:null});
 assert.equal(await f.service.ensureStarted(pluginId),null);
 const result=await f.service.setup(pluginId,setup);
 assert.equal(result.configVersion,1);assert.match(result.pairing.id,/^local-/);assert.equal(result.pairing.alias,setup.alias);
 assert.equal(f.commands.length,1);assert.equal(f.commands[0].file,f.binaryPath);
 assert.equal(f.commands[0].directory,path.join(f.directory,'gateway',pluginId));assert.equal(f.commands[0].operation,'initialize-private');
 assert.ok(f.payloads.every(payload=>payload.every(byte=>byte===0)));
 const status=await f.service.status(pluginId);
 assert.deepEqual(status,{configured:true,running:true,alias:setup.alias,listenPort:setup.listenPort,managementPort:setup.managementPort,configVersion:1,maxRequestBytes:2*1024*1024,maxConcurrency:32});
 assert.equal(JSON.stringify(status).includes(clientApiKey),false);assert.equal(JSON.stringify(status).includes(result.pairing.token),false);
 const config=await readFile(path.join(f.commands[0].directory,'config.json'),'utf8');assert.equal(config.includes(clientApiKey),false);assert.equal(config.includes(upstreamApiKey),false);
 await safeReject(f.service.setup(pluginId,setup),'local-already-configured');assert.equal(f.commands.length,1);
});

test('route add, edit, credential rotation and deletion are versioned and keep unrelated private state',async t=>{
 const f=await fixture(t);const initial=await f.service.setup(pluginId,setup),identity=clone(f.current().management);
 await safeReject(f.service.saveRoute(pluginId,{expectedVersion:1,route:{...route,id:'second'}}),'missing-route-credentials');
 const added=await f.service.saveRoute(pluginId,{expectedVersion:1,route:{...route,id:'second',clientAlias:'other'},credentials:{clientApiKey,upstreamApiKey}});
 assert.equal(added.configVersion,2);assert.equal(f.current().config.routes.length,2);assert.deepEqual(f.current().management,identity);
 const edited=await f.service.saveRoute(pluginId,{expectedVersion:2,route:{...route,enabled:false},credentials:{upstreamApiKey:'rotated-fixture-key'}});
 assert.equal(edited.configVersion,3);assert.equal(f.current().routeSecrets[0].clientKey,clientApiKey);assert.equal(f.current().routeSecrets[0].upstreamKey,'rotated-fixture-key');
 assert.equal(edited.pairing.fingerprintSha256,initial.pairing.fingerprintSha256);
 await safeReject(f.service.saveRoute(pluginId,{expectedVersion:1,route}),'config-conflict');
 const removed=await f.service.deleteRoute(pluginId,{expectedVersion:3,routeId:'second'});
 assert.equal(removed.configVersion,4);assert.equal(f.current().routeSecrets.length,1);
 await safeReject(f.service.deleteRoute(pluginId,{expectedVersion:4,routeId:'primary'}),'local-last-route');
 await safeReject(f.service.deleteRoute(pluginId,{expectedVersion:4,routeId:'unknown'}),'unknown-route');
 assert.ok(f.payloads.every(payload=>payload.every(byte=>byte===0)));
});

test('live port and alias changes preserve core, pending work and protected identity',async t=>{
 const f=await fixture(t);const initial=await f.service.setup(pluginId,setup),before=[...f.lifecycle];
 f.setListening(true);f.setPending(1);
 const input={expectedVersion:1,alias:'修改后的网关',listenPort:18004,managementPort:18005};
 const updated=await f.service.configure(pluginId,input);
 assert.equal(updated.configVersion,2);assert.equal(updated.pairing.port,18005);assert.equal(updated.pairing.alias,input.alias);
 assert.equal(updated.pairing.token,initial.pairing.token);assert.equal(updated.pairing.fingerprintSha256,initial.pairing.fingerprintSha256);
 assert.equal(f.current().config.listen,'127.0.0.1:18004');assert.equal(f.commands.length,1);
 assert.deepEqual(f.lifecycle,[...before,'configuration-commit']);assert.equal((await f.service.status(pluginId)).running,true);
});

test('private transaction failure retains previous running configuration and exposes no diagnostic secrets',async t=>{
 const f=await fixture(t);const first=await f.service.setup(pluginId,setup);f.setCommandFailure(true);
 await safeReject(f.service.configure(pluginId,{expectedVersion:1,alias:'new',listenPort:18004,managementPort:18005}),'private-configuration-failed');
 assert.equal((await f.service.status(pluginId)).running,true);assert.equal(f.current().config.configVersion,1);
 assert.equal((await f.service.ensureStarted(pluginId))?.token,first.pairing.token);
 assert.ok(f.payloads.every(payload=>payload.every(byte=>byte===0)));
});

test('failed management startup leaves committed setup recoverable without replacing protected identity',async t=>{
 const f=await fixture(t);f.setStartFailure(true);await safeReject(f.service.setup(pluginId,setup),'local-runtime-unavailable');
 const identity=clone(f.current().management),status=await f.service.status(pluginId);
 assert.equal(status.configured,true);assert.equal(status.running,false);assert.equal(status.configVersion,1);
 f.setStartFailure(false);const pairing=await f.service.ensureStarted(pluginId);assert.equal(pairing?.token,identity.token);assert.equal(f.commands.length,1);
});

test('offline configuration repairs failed startup without requiring a management session',async t=>{
 const f=await fixture(t);f.setStartFailure(true);await safeReject(f.service.setup(pluginId,setup),'local-runtime-unavailable');
 const identity=clone(f.current().management);f.setStartFailure(false);
 const repaired=await f.service.configure(pluginId,{expectedVersion:1,alias:'界面修复',listenPort:18004,managementPort:18005});
 assert.equal(repaired.configVersion,2);assert.equal(repaired.pairing.port,18005);assert.equal(repaired.pairing.token,identity.token);
 assert.equal(f.commands.at(-1)?.operation,'configure-private');assert.equal((await f.service.status(pluginId)).running,true);
 await f.service.stop(pluginId);
 const rotated=await f.service.saveRoute(pluginId,{expectedVersion:2,route,credentials:{upstreamApiKey:'offline-rotated-fixture'}});
 assert.equal(rotated.configVersion,3);assert.equal(f.current().routeSecrets[0].upstreamKey,'offline-rotated-fixture');
});

test('cold offline status reads protected alias and ports without binding management and closes its core',async t=>{
 const f=await fixture(t);await f.service.setup(pluginId,setup);await f.service.stop(pluginId);
 const restarted=f.make(),before=f.lifecycle.length;
 assert.deepEqual(await restarted.status(pluginId),{configured:true,running:false,alias:setup.alias,listenPort:setup.listenPort,managementPort:setup.managementPort,configVersion:1,maxRequestBytes:2*1024*1024,maxConcurrency:32});
 assert.deepEqual(f.lifecycle.slice(before),['engine-start','engine-close']);
 const again=f.lifecycle.length;await restarted.status(pluginId);assert.equal(f.lifecycle.length,again);
 const recovered=await restarted.configure(pluginId,{expectedVersion:1,alias:setup.alias,listenPort:18004,managementPort:18005});assert.equal(recovered.configVersion,2);
});

test('concurrent owner mutations serialize, stale versions fail, and plugin directories stay isolated',async t=>{
 const f=await fixture(t);await f.service.setup(pluginId,setup);
 const changes=await Promise.allSettled([
  f.service.saveRoute(pluginId,{expectedVersion:1,route:{...route,clientAlias:'one'}}),
  f.service.saveRoute(pluginId,{expectedVersion:1,route:{...route,clientAlias:'two'}}),
 ]);
 assert.equal(changes.filter(item=>item.status==='fulfilled').length,1);assert.equal(f.current().config.configVersion,2);
 const other='extension.other.gateway';await f.service.setup(other,{...setup,alias:'第二个网关',listenPort:18010,managementPort:18011});
 assert.notEqual(f.current(other).management.token,f.current().management.token);assert.equal(f.current(other).config.configVersion,1);
 await f.service.stop(pluginId);assert.equal((await f.service.status(other)).running,true);assert.equal((await f.service.status(pluginId)).running,false);
});

test('shutdown waits for listener drain before core exit and prevents subsequent startup',async t=>{
 const f=await fixture(t);await f.service.setup(pluginId,setup);const gate=deferred();f.setCloseGate(gate.promise);
 let completed=false;const shutdown=f.service.shutdown().then(()=>{completed=true;});
 await new Promise(resolve=>setTimeout(resolve,10));assert.equal(completed,false);assert.equal(f.lifecycle.at(-1),'management-drain');
 await safeReject(f.service.ensureStarted(pluginId),'local-runtime-closed');
 gate.resolve();await shutdown;assert.deepEqual(f.lifecycle.slice(-2),['management-close','engine-close']);
});

test('untrusted settings cannot select paths, commands, management identity or malformed credentials',async t=>{
 const f=await fixture(t);
 for(const input of [
  {...setup,path:f.directory},{...setup,binaryPath:f.binaryPath},{...setup,managementPort:setup.listenPort},
  {...setup,listenPort:0},{...setup,token:clientApiKey},{...setup,credentials:{...setup.credentials,clientApiKey:'short'}},
  {...setup,route:{...route,credentialRef:'owned-ref'}},{...setup,route:{...route,protocol:'anthropic',capabilities:{serviceTier:true}}},
 ])await safeReject(f.service.setup(pluginId,input as any),'invalid-local-input');
 await safeReject(f.service.setup('../outside',setup),'invalid-local-owner');
 await safeReject(f.service.setup(pluginId,{...setup,route:{...route,upstreamBase:('http://'+'10.0.0.1/v1')}}),'invalid-upstream');
 assert.equal(f.commands.length,0);
});

test('request and concurrency limits are bounded GUI settings and omitted updates preserve configured values',async t=>{
 const f=await fixture(t);await f.service.setup(pluginId,{...setup,maxRequestBytes:1024,maxConcurrency:2});
 let status=await f.service.status(pluginId);assert.equal(status.maxRequestBytes,1024);assert.equal(status.maxConcurrency,2);
 await f.service.configure(pluginId,{expectedVersion:1,alias:setup.alias,listenPort:setup.listenPort,managementPort:setup.managementPort});
 assert.equal(f.current().config.maxRequestBytes,1024);assert.equal(f.current().config.maxConcurrency,2);
 await f.service.configure(pluginId,{expectedVersion:2,alias:setup.alias,listenPort:setup.listenPort,managementPort:setup.managementPort,maxRequestBytes:4*1024*1024,maxConcurrency:128});
 status=await f.service.status(pluginId);assert.equal(status.maxRequestBytes,4*1024*1024);assert.equal(status.maxConcurrency,128);
 const count=f.commands.length;
 for(const limits of [{maxRequestBytes:0},{maxRequestBytes:4*1024*1024+1},{maxConcurrency:0},{maxConcurrency:129},{maxConcurrency:1.5}]){
  await safeReject(f.service.configure(pluginId,{expectedVersion:3,alias:setup.alias,listenPort:setup.listenPort,managementPort:setup.managementPort,...limits}),'invalid-local-input');
 }
 assert.equal(f.commands.length,count);
});

test('gateway root symlinks are rejected and never followed for private initialization',async t=>{
 const f=await fixture(t);const elsewhere=path.join(f.directory,'elsewhere');await mkdir(elsewhere);
 await symlink(elsewhere,path.join(f.directory,'gateway'),process.platform==='win32'?'junction':'dir');
 await safeReject(f.service.setup(pluginId,setup),'invalid-local-directory');assert.equal(f.commands.length,0);
 // Remove only the link before the normal bounded fixture cleanup.
 await rm(path.join(f.directory,'gateway'),{force:true});
});
