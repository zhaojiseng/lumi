import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import {mkdir,mkdtemp,readFile,stat,rm} from 'node:fs/promises';
import path from 'node:path';
import {GatewayLocalService} from '../electron/services/gateway-local';
import {gatewayPairingTlsOptions,type GatewayPairing} from '../electron/services/gateway-pairing';

const binaryPath=path.resolve(process.env.LUMI_GATEWAY_TEST_BINARY??'dist-native/lumi-gateway-runtime'+(process.platform==='win32'?'.exe':''));
const built=await stat(binaryPath).then(value=>value.isFile()).catch(()=>false);
const skip=process.platform!=='win32'?'本测试验证 Windows DPAPI；macOS Keychain 须在 macOS 主机单独验证。':!built?'尚未构建固定 Rust 网关核心。':false;
const pluginId='extension.lumi.gateway';
const hostId='fixture-host';
async function listen(server:net.Server){await new Promise<void>((resolve,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',()=>{server.off('error',reject);resolve();});});return (server.address() as net.AddressInfo).port;}
async function unusedPort(){const server=net.createServer(),port=await listen(server);await new Promise<void>(resolve=>server.close(()=>resolve()));return port;}
async function close(server:http.Server){server.closeAllConnections();await new Promise<void>(resolve=>server.close(()=>resolve()));}
async function management(pairing:GatewayPairing,method:string,input:unknown={}){
 const body=Buffer.from(JSON.stringify({protocolVersion:1,instanceId:pairing.instanceId,owner:{hostId,pluginId},input}));
 return new Promise<any>((resolve,reject)=>{
  const request=https.request({host:'127.0.0.1',port:pairing.port,path:'/management/v1/'+method,method:'POST',agent:false,
   ...gatewayPairingTlsOptions(pairing),headers:{host:'127.0.0.1:'+pairing.port,authorization:'Bearer '+pairing.token,'content-type':'application/json','content-length':body.length}},response=>{
   const chunks:Buffer[]=[];response.on('data',chunk=>chunks.push(Buffer.from(chunk)));response.on('error',reject);
   response.on('end',()=>{try{const value=JSON.parse(Buffer.concat(chunks).toString('utf8'));if(response.statusCode!==200)return reject(new Error(value.error?.code??'fixture-management-failed'));resolve(value.result);}catch(error){reject(error);}});
  });request.on('error',reject);request.end(body);
 });
}
async function data(port:number,routeId:string,endpoint:string,token:string,body:Buffer){
 return new Promise<{status:number;body:Buffer}>((resolve,reject)=>{
  const request=http.request({host:'127.0.0.1',port,path:'/'+routeId+endpoint,method:'POST',agent:false,
   headers:{authorization:'Bearer '+token,'content-type':'application/json','content-length':body.length}},response=>{
   const chunks:Buffer[]=[];response.on('data',chunk=>chunks.push(Buffer.from(chunk)));response.on('error',reject);
   response.on('end',()=>resolve({status:response.statusCode!,body:Buffer.concat(chunks)}));
  });request.on('error',reject);request.end(body);
 });
}

test('embedded host service preserves real Rust/TLS/DPAPI with GUI-only route credentials', {skip},async t=>{
 const parent=path.resolve('.test-data/gateway-local-runtime');await mkdir(parent,{recursive:true});const directory=await mkdtemp(path.join(parent,'runtime-'));
 const forwarded:Array<{url:string;authorization:string|undefined;body:Buffer}>=[];
 const response=Buffer.from('{"service_tier":"default","usage":{"input_tokens":11,"output_tokens":5},"output_text":"fixture"}');
 const upstream=http.createServer((request,result)=>{void (async()=>{
  const chunks:Buffer[]=[];for await(const chunk of request)chunks.push(Buffer.from(chunk));
  forwarded.push({url:request.url!,authorization:request.headers.authorization,body:Buffer.concat(chunks)});
  result.writeHead(200,{'content-type':'application/json','content-length':response.length});result.end(response);
 })().catch(()=>result.destroy());});
 const upstreamPort=await listen(upstream),listenPort=await unusedPort(),managementPort=await unusedPort();
 const service=new GatewayLocalService({dataDir:directory,binaryPath,allowFixtureUpstream:true});
 const services=[service];
 t.after(async()=>{for(const current of services)await current.shutdown();await close(upstream);
  const relative=path.relative(parent,directory);assert.ok(relative&&!relative.startsWith('..')&&!path.isAbsolute(relative));await rm(directory,{recursive:true,force:true});});
 const credentials={clientApiKey:'fixture-client-key-0123456789',upstreamApiKey:'fixture-upstream-key-9876543210'};
 const route={id:'primary',clientAlias:'codex',protocol:'openai' as const,upstreamBase:'http://127.0.0.1:'+upstreamPort+'/v1',capabilities:{serviceTier:true},enabled:true};
 const initial=await service.setup(pluginId,{alias:'本机真实核心夹具',listenPort,managementPort,route,credentials});
 assert.equal(initial.configVersion,1);const first=initial.pairing;
 assert.deepEqual(await management(first,'routes.config.get'),{configVersion:1,routes:[{...route,credentialRef:'primary',credentialPresent:true}]});
 const listener=await management(first,'listener.start');assert.equal(listener.state,'listening');assert.equal(listener.address,'127.0.0.1:'+listenPort);
 await assert.rejects(service.configure(pluginId,{expectedVersion:0,alias:'stale',listenPort,managementPort}),/invalid-local-input/);
 const request=Buffer.from(' {"model":"fixture","input":"hello", "service_tier":"default"}\n');
 const reply=await data(listenPort,'primary','/v1/responses',credentials.clientApiKey,request);
 assert.equal(reply.status,200);assert.deepEqual(reply.body,response);assert.deepEqual(forwarded[0].body,request);assert.equal(forwarded[0].authorization,'Bearer '+credentials.upstreamApiKey);
 await management(first,'listener.stop',{mode:'drain'});
 const changedRules=await management(first,'rules.replace',{expectedVersion:1,rules:[{id:'preserve',enabled:true,priority:0,match:{},action:{type:'preserve'}}]});
 assert.deepEqual(changedRules,{policyVersion:2});
 const configFile=path.join(directory,'gateway',pluginId,'config.json');assert.equal(JSON.parse(await readFile(configFile,'utf8')).configVersion,2);
 const nextPort=await unusedPort();
 const configured=await service.configure(pluginId,{expectedVersion:2,alias:'配置直接更新',listenPort,managementPort:nextPort});
 assert.equal(configured.configVersion,3);assert.equal(configured.pairing.port,nextPort);assert.equal(configured.pairing.token,first.token);assert.equal(configured.pairing.fingerprintSha256,first.fingerprintSha256);
 const second={...route,id:'second',clientAlias:'other'};
 const added=await service.saveRoute(pluginId,{expectedVersion:3,route:second,credentials:{clientApiKey:'fixture-other-client-key-0123456789',upstreamApiKey:'fixture-other-upstream-key-9876543210'}});
 assert.equal(added.configVersion,4);
 const rotated=await service.saveRoute(pluginId,{expectedVersion:4,route:second,credentials:{upstreamApiKey:'fixture-rotated-key'}});assert.equal(rotated.configVersion,5);
 await management(rotated.pairing,'listener.start');
 const secondReply=await data(listenPort,'second','/v1/responses','fixture-other-client-key-0123456789',request);assert.equal(secondReply.status,200);assert.equal(forwarded.at(-1)?.authorization,'Bearer fixture-rotated-key');
 await management(rotated.pairing,'listener.stop',{mode:'drain'});
 const deleted=await service.deleteRoute(pluginId,{expectedVersion:5,routeId:'second'});assert.equal(deleted.configVersion,6);
 const rows=await management(deleted.pairing,'records.list',{limit:10});assert.equal(rows.records.length,2);assert.ok(rows.records.every((record:any)=>record.inputTokens===11&&record.outputTokens===5&&record.reported.value==='default'));
 const publicStatus=await service.status(pluginId);assert.equal(publicStatus.configVersion,6);assert.equal(JSON.stringify(publicStatus).includes(first.token),false);
 for(const file of ['secrets.bin','management.bin']){
  const bytes=await readFile(path.join(directory,'gateway',pluginId,file));assert.equal(bytes.includes(Buffer.from(credentials.clientApiKey)),false);assert.equal(bytes.includes(Buffer.from(credentials.upstreamApiKey)),false);assert.equal(bytes.includes(Buffer.from(first.token)),false);
 }
 await service.shutdown();
 const restarted=new GatewayLocalService({dataDir:directory,binaryPath,allowFixtureUpstream:true});services.push(restarted);
 assert.deepEqual(await restarted.status(pluginId),{configured:true,running:false,alias:'配置直接更新',listenPort,managementPort:nextPort,configVersion:6,maxRequestBytes:2*1024*1024,maxConcurrency:32});
 const restored=await restarted.ensureStarted(pluginId);assert.ok(restored);assert.equal(restored.id,first.id);assert.equal(restored.token,first.token);assert.equal(restored.fingerprintSha256,first.fingerprintSha256);
 assert.equal((await management(restored,'routes.config.get')).configVersion,6);
 assert.equal((await management(restored,'records.list',{limit:10})).records.length,2);
});

test('GUI configuration repairs occupied management ports after committed setup or update',{skip},async t=>{
 const parent=path.resolve('.test-data/gateway-local-runtime');await mkdir(parent,{recursive:true});const directory=await mkdtemp(path.join(parent,'ports-'));
 const blocker=net.createServer(socket=>socket.destroy()),occupiedPort=await listen(blocker),listenPort=await unusedPort();
 const service=new GatewayLocalService({dataDir:directory,binaryPath,allowFixtureUpstream:true});
 t.after(async()=>{await service.shutdown();await new Promise<void>(resolve=>blocker.close(()=>resolve()));
  const relative=path.relative(parent,directory);assert.ok(relative&&!relative.startsWith('..')&&!path.isAbsolute(relative));await rm(directory,{recursive:true,force:true});});
 const route={id:'primary',clientAlias:'codex',protocol:'openai' as const,upstreamBase:'http://127.0.0.1:18001/v1',capabilities:{serviceTier:true},enabled:true};
 await assert.rejects(service.setup(pluginId,{alias:'端口占用夹具',listenPort,managementPort:occupiedPort,route,
  credentials:{clientApiKey:'fixture-client-key-0123456789',upstreamApiKey:'fixture-upstream-key-9876543210'}}),/management-port-unavailable/);
 assert.deepEqual(await service.status(pluginId),{configured:true,running:false,alias:'端口占用夹具',listenPort,managementPort:occupiedPort,configVersion:1,maxRequestBytes:2*1024*1024,maxConcurrency:32,errorCode:'management-port-unavailable'});
 const repaired=await service.configure(pluginId,{expectedVersion:1,alias:'界面修复端口',listenPort,managementPort:await unusedPort()});
 assert.equal(repaired.configVersion,2);assert.equal((await management(repaired.pairing,'routes.config.get')).configVersion,2);
 await assert.rejects(service.configure(pluginId,{expectedVersion:2,alias:'再次占用',listenPort,managementPort:occupiedPort}),/management-port-unavailable/);
 assert.equal((await service.status(pluginId)).configVersion,2);assert.equal((await service.status(pluginId)).running,true);
 const again=await service.configure(pluginId,{expectedVersion:2,alias:'再次从界面修复',listenPort,managementPort:await unusedPort()});
 assert.equal(again.configVersion,3);assert.equal(again.pairing.token,repaired.pairing.token);assert.equal(again.pairing.fingerprintSha256,repaired.pairing.fingerprintSha256);
 assert.equal((await management(again.pairing,'listener.start')).state,'listening');
 assert.equal((await management(again.pairing,'listener.stop',{mode:'drain'})).state,'stopped');
});
