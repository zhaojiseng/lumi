import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdir,mkdtemp,readFile,writeFile,rm} from 'node:fs/promises';
import path from 'node:path';
import {runInNewContext} from 'node:vm';
import {ExtensionHost} from '../electron/extensions/host';
import {parseExtensionManifest} from '../shared/extension-manifest';
import {EXTENSION_API_VERSION,EXTENSION_METHODS,EXTENSION_PERMISSIONS} from '../shared/contracts/extensions';
import {GATEWAY_METHODS,GATEWAY_METHOD_PERMISSIONS,type GatewayBridge,type GatewayMethod} from '../shared/contracts/gateway';
import {gatewayPublicUpstream,parseGatewayInput,parseGatewayOutput,parseGatewayEvent} from '../shared/gateway-validation';

const stage=process.env.LUMI_GATEWAY_STAGE_ROOT;
const sourceRoot=stage || process.cwd();
const fixtureParent=stage ? path.resolve(stage,'../gateway-host-contract-tests') : path.resolve('.test-data/gateway-extension');
const pluginId='extension.lumi.gatewaytest';
const cipher={available:()=>true,encrypt:(value:string)=>Buffer.from(value).toString('base64'),decrypt:(value:string)=>Buffer.from(value,'base64').toString()};
const baseManifest={schemaVersion:1,hostApiVersion:1,id:pluginId,name:'网关测试',version:'1.0.0',description:'隔离测试',author:'fixture',license:'MIT',permissions:['gateway.control'],contributions:[{id:'page',slot:'sidebar',title:'网关',entry:'index.html',scope:'independent'}]};
async function fixture(t:test.TestContext,gateway:GatewayBridge,permissions:string[]=['gateway.control']){
  await mkdir(fixtureParent,{recursive:true});
  const root=await mkdtemp(path.join(fixtureParent,'host-'));
  const directory=path.join(root,'packages'),pkg=path.join(directory,pluginId);
  await mkdir(pkg,{recursive:true});
  await writeFile(path.join(pkg,'plugin.json'),JSON.stringify({...baseManifest,permissions}));
  await writeFile(path.join(pkg,'index.html'),'<!doctype html><script src="lumi-sdk.js"></script>');
  await writeFile(path.join(pkg,'LICENSE'),'MIT License\n\nCopyright (c) 2026 Test fixture\n\nPermission is hereby granted, free of charge, to any person obtaining a copy of this software and associated documentation files (the \"Software\"), to deal in the Software without restriction, including without limitation the rights to use, copy, modify, merge, publish, distribute, sublicense, and/or sell copies of the Software, and to permit persons to whom the Software is furnished to do so, subject to the following conditions:\n\nThe above copyright notice and this permission notice shall be included in all copies or substantial portions of the Software.\n\nTHE SOFTWARE IS PROVIDED \"AS IS\", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.\n');
  const host=new ExtensionHost({directory,settingsDirectory:path.join(root,'settings'),cipher,sdk:await readFile(path.join(sourceRoot,'public/lumi-extension-sdk.js')),hostVersion:'0.5.23',gateway,context:()=>({theme:'light',locale:'zh-CN',site:{id:'fixture',name:'fixture',url:'https://fixture.invalid'}}),scope:()=> 'fixture',read:async()=>null});
  await host.start();await host.setEnabled(pluginId,true);
  t.after(()=>{host.dispose();return rm(root,{recursive:true,force:true,maxRetries:5,retryDelay:100});});
  const request=(method:GatewayMethod,input?:unknown,generation=host.statuses()[0].generation!)=>host.request({id:pluginId,view:'page',generation,method,input});
  return {host,request,pkg};
}
const idleStatus={pairings:[]};

test('gateway extends optional API1 permissions and keeps old manifests compatible',()=>{
  assert.equal(EXTENSION_API_VERSION,1);
  assert.equal(parseExtensionManifest({...baseManifest,permissions:['storage']}).hostApiVersion,1);
  assert.equal(parseExtensionManifest({...baseManifest,minHostVersion:'0.5.23'}).minHostVersion,'0.5.23');
  for(const minHostVersion of ['latest','0.05.23','0.5.23-.','0.5.23-beta.01'])assert.throws(()=>parseExtensionManifest({...baseManifest,minHostVersion}));
  for(const method of GATEWAY_METHODS){assert.ok(EXTENSION_METHODS.includes(method));assert.ok(EXTENSION_PERMISSIONS.includes(GATEWAY_METHOD_PERMISSIONS[method]));}
});

test('all gateway input boundaries reject arbitrary paths, URLs, bodies, unknown properties and invalid IDs',()=>{
  assert.deepEqual(parseGatewayInput('gateway.pair',{}),{});
  assert.throws(()=>parseGatewayInput('gateway.pair',{url:'https://127.0.0.1',token:'fixture'}));
  assert.throws(()=>parseGatewayInput('gateway.connect',{pairingId:'../../secrets'}));
  assert.throws(()=>parseGatewayInput('gateway.connect',{pairingId:'pairing',certificatePath:'C:/secret'}));
  assert.throws(()=>parseGatewayInput('gateway.rules.preview',{sessionId:'session',routeId:'route',endpoint:'/v1/responses',originalTier:{state:'missing'},body:'private prompt'}));
  assert.throws(()=>parseGatewayInput('gateway.rules.preview',{sessionId:'session',routeId:'route',endpoint:'/v1/responses',originalTier:{state:'invalid',value:'private'}}));
  assert.throws(()=>parseGatewayInput('gateway.records.list',{sessionId:'session',limit:101}));
  assert.throws(()=>parseGatewayInput('gateway.records.list',{sessionId:'session',limit:1,sql:'SELECT *'}));
  assert.throws(()=>parseGatewayInput('gateway.records.get',{sessionId:'session',recordId:'request',bodyCursor:'cursor'}));
  assert.throws(()=>parseGatewayInput('gateway.records.export',{sessionId:'session',selection:{recordIds:['request']},format:'json',includeBody:true}));
  assert.throws(()=>parseGatewayInput('gateway.records.export',{sessionId:'session',selection:{recordIds:['request']},format:'json',includeBody:false,path:'C:/secret'}));
  assert.throws(()=>parseGatewayInput('gateway.records.delete',{sessionId:'session',selection:{recordIds:['request','request']}}));
  assert.throws(()=>parseGatewayInput('gateway.cliConfig.apply',{transactionId:'transaction',expectedFingerprint:'fingerprint',command:'arbitrary'}));
  assert.throws(()=>parseGatewayInput('gateway.cliConfig.preview',{sessionId:'session',tool:'codex',routeId:'route',service_tier:'priority'}));
});

test('route and rule schemas reject unsafe destinations and ambiguous changes',()=>{
  for(const address of ['http://example.com','https://127.0.0.1','https://localhost','https://[::1]',('https://'+'192.168.1.1'),'https://example.com?key=x',('https://user'+':pass@example.com'),'https://example.com/#fragment'])assert.equal(gatewayPublicUpstream(address),false);
  const route={id:'route',clientAlias:'client',protocol:'openai',upstreamBase:'https://api.example.com/v1',credentialRef:'credential',enabled:true,capabilities:{serviceTier:true}};
  assert.doesNotThrow(()=>parseGatewayInput('gateway.routes.config.set',{sessionId:'session',expectedVersion:0,routes:[route]}));
  assert.throws(()=>parseGatewayInput('gateway.routes.config.set',{sessionId:'session',expectedVersion:0,routes:[route,route]}));
  assert.throws(()=>parseGatewayInput('gateway.routes.config.set',{sessionId:'session',expectedVersion:0,routes:[{...route,upstreamKey:'secret'}]}));
  assert.throws(()=>parseGatewayInput('gateway.routes.config.set',{sessionId:'session',expectedVersion:0,routes:[{...route,protocol:'anthropic'}]}));
  assert.doesNotThrow(()=>parseGatewayInput('gateway.routes.config.set',{sessionId:'session',expectedVersion:0,routes:[{...route,protocol:'anthropic',capabilities:{serviceTier:false}}]}));
  assert.throws(()=>parseGatewayInput('gateway.routes.config.set',{sessionId:'session',expectedVersion:0,routes:[{...route,protocol:'anthropic',upstreamEndpoint:'/v1/responses'}]}));
  const rule={id:'tier',enabled:true,priority:0,match:{routeId:'route'},action:{type:'override',value:'priority'}};
  assert.doesNotThrow(()=>parseGatewayInput('gateway.rules.replace',{sessionId:'session',expectedVersion:0,rules:[rule]}));
  assert.throws(()=>parseGatewayInput('gateway.rules.replace',{sessionId:'session',expectedVersion:0,rules:[rule,rule]}));
  assert.throws(()=>parseGatewayInput('gateway.rules.replace',{sessionId:'session',expectedVersion:0,rules:[{...rule,action:{type:'preserve',value:'priority'}}]}));
  assert.throws(()=>parseGatewayInput('gateway.rules.replace',{sessionId:'session',expectedVersion:0,rules:[{...rule,action:{type:'override',value:'not valid'}}]}));
});

test('gateway outputs and pushed events cannot include credentials or raw body outside detail pages',()=>{
  assert.deepEqual(parseGatewayOutput('gateway.status',idleStatus),idleStatus);
  assert.throws(()=>parseGatewayOutput('gateway.status',{pairings:[],managementToken:'secret'}));
  assert.throws(()=>parseGatewayOutput('gateway.connect',{sessionId:'session',instanceId:'instance',protocolVersion:2}));
  assert.throws(()=>parseGatewayOutput('gateway.listener.start',{state:'listening',address:'0.0.0.0:18080',owned:true,activeRequests:0}));
  assert.throws(()=>parseGatewayEvent({subscriptionId:'sub',sessionId:'session',type:'warning',code:'warning',body:'private'}));
});

test('ExtensionHost enforces each gateway method permission before dispatch',async t=>{
  let calls=0;
  const gateway:GatewayBridge={request:async()=>{calls++;return idleStatus;},revoke:()=>{}};
  const f=await fixture(t,gateway,['storage']);
  await assert.rejects(f.request('gateway.status',{}),/权限/);
  await assert.rejects(f.request('gateway.records.list',{sessionId:'session',limit:1}),/权限/);
  await assert.rejects(f.request('gateway.cliConfig.preview',{sessionId:'session',tool:'codex',routeId:'route'}),/权限/);
  assert.equal(calls,0);
});

test('ExtensionHost rejects malformed input and unsafe output before exposure',async t=>{
  let calls=0;
  const gateway:GatewayBridge={request:async()=>{calls++;return {...idleStatus,token:'must-not-leak'};},revoke:()=>{}};
  const f=await fixture(t,gateway);
  await assert.rejects(f.request('gateway.status',{secret:'body'}),/参数/);
  assert.equal(calls,0);
  await assert.rejects(f.request('gateway.status',{}),/返回数据无效/);
  assert.equal(calls,1);
});

test('gateway requests carry view/generation ownership and old results are withdrawn on disable',async t=>{
  let resolve!:(value:unknown)=>void;
  const owners:unknown[]=[],revoked:{owner:{id:string;generation?:number;view?:string};reason:string}[]=[];
  const gateway:GatewayBridge={request:async(_method,_input,owner)=>{owners.push(owner);return new Promise(r=>{resolve=r;});},revoke:(owner,reason)=>{revoked.push({owner,reason});}};
  const f=await fixture(t,gateway),generation=f.host.statuses()[0].generation;
  const pending=f.request('gateway.status',{});
  const rejected=assert.rejects(pending,/停用/);
  await f.host.setEnabled(pluginId,false);
  resolve(idleStatus);await rejected;
  assert.deepEqual({...(owners[0] as object),signal:undefined},{id:pluginId,generation,view:'page',signal:undefined});
  assert.ok(revoked.some(item=>item.reason==='disabled' && item.owner.generation===generation));
  await assert.rejects(f.request('gateway.status',{},generation),/停用/);
});

test('minHostVersion blocks newer-only packages without affecting API1 packages',async t=>{
  const reasons:string[]=[];
  const f=await fixture(t,{request:async()=>idleStatus,revoke:(_owner,reason)=>{reasons.push(reason);}});
  const manifest=JSON.parse(await readFile(path.join(f.pkg,'plugin.json'),'utf8'));
  await writeFile(path.join(f.pkg,'plugin.json'),JSON.stringify({...manifest,minHostVersion:'999.0.0'}));
  await f.host.reload();
  assert.equal(f.host.statuses().length,0);
  assert.match(f.host.inventory().diagnostics[0].error,/更新/);
  assert.equal(reasons.at(-1),'disabled');
});

test('rescanning retains listener only for unchanged active plugins and disables changed or missing packages',async t=>{
  const reasons:string[]=[];
  const f=await fixture(t,{request:async()=>idleStatus,revoke:(_owner,reason)=>{reasons.push(reason);}});
  await f.host.reload();assert.equal(reasons.at(-1),'generation');assert.equal(f.host.statuses()[0].state,'active');
  await writeFile(path.join(f.pkg,'index.html'),'<!doctype html><p>changed</p>');
  await f.host.reload();assert.equal(reasons.at(-1),'disabled');assert.equal(f.host.statuses()[0].state,'disabled');
  await f.host.setEnabled(pluginId,true);
  await rm(f.pkg,{recursive:true});await f.host.reload();assert.equal(reasons.at(-1),'disabled');assert.equal(f.host.statuses().length,0);
});

test('SDK gateway dispatch stays fixed and event disposal removes subscription',async()=>{
  const code=await readFile(path.join(sourceRoot,'public/lumi-extension-sdk.js'),'utf8');
  const handlers=new Map<string,Function[]>(),sent:any[]=[],timers=new Set<unknown>();
  const win:any={addEventListener:(name:string,fn:Function)=>{const values=handlers.get(name)||[];values.push(fn);handlers.set(name,values);}};
  const parent={postMessage:(message:any)=>sent.push(message)};
  const document={readyState:'loading',querySelector:()=>null};
  runInNewContext(code,{window:win,parent,document,Map,Set,Promise,Object,Error,Number,Math,console,setTimeout:(fn:Function)=>{const token={fn};timers.add(token);return token;},clearTimeout:(token:unknown)=>timers.delete(token)});
  const message=(data:any)=>{for(const handler of handlers.get('message')||[])handler({source:parent,data:{protocol:'lumi-extension/1',...data}});};
  message({type:'init',nonce:'nonce',context:{theme:'light'},view:{id:'page',slot:'sidebar'}});
  const sdk=win.lumiExtension;
  assert.equal(sdk.apiVersion,1);assert.ok(Object.isFrozen(sdk.gateway));
  const paired=sdk.gateway.pair();await Promise.resolve();await Promise.resolve();
  const pairRequest=sent.findLast(message=>message.type==='request');
  assert.equal(pairRequest.method,'gateway.pair');assert.deepEqual(Object.keys(pairRequest.input),[]);
  message({type:'response',nonce:'nonce',id:pairRequest.id,ok:true,data:{pairingId:'pair'}});
  assert.equal((await paired).pairingId,'pair');
  const events:any[]=[];
  const subscription=sdk.gateway.events.subscribe({sessionId:'session'},(event:unknown)=>events.push(event));await Promise.resolve();await Promise.resolve();
  const subscribeRequest=sent.findLast(message=>message.type==='request');
  message({type:'response',nonce:'nonce',id:subscribeRequest.id,ok:true,data:{subscriptionId:'sub'}});
  const dispose=await subscription;
  message({type:'event',nonce:'nonce',topic:'gateway',payload:{subscriptionId:'other',type:'warning',code:'not-yours'}});
  message({type:'event',nonce:'nonce',topic:'gateway',payload:{subscriptionId:'sub',type:'warning',code:'your-event'}});
  assert.equal(events.length,1);
  dispose();dispose();await Promise.resolve();await Promise.resolve();
  assert.equal(sent.filter(message=>message.method==='gateway.events.unsubscribe').length,1);
  message({type:'event',nonce:'nonce',topic:'gateway',payload:{subscriptionId:'sub',type:'warning',code:'late'}});
  assert.equal(events.length,1);
});


test('revocation waits cannot admit another request using the aborted generation',async t=>{
  let release!:(value?:unknown)=>void,calls=0;
  const gateway:GatewayBridge={request:async()=>{calls++;return idleStatus;},revoke:async(_owner,reason)=>{if(reason==='disabled')await new Promise(resolve=>{release=resolve;});}};
  const f=await fixture(t,gateway),generation=f.host.statuses()[0].generation!;
  const disabled=f.host.setEnabled(pluginId,false);
  for(let attempt=0;!release && attempt<10;attempt++)await Promise.resolve();
  assert.equal(typeof release,'function');
  await assert.rejects(f.request('gateway.status',{},generation),/停用/);
  assert.equal(calls,0);
  release();await disabled;
});

test('record-management permission never grants reading record bodies',async t=>{
  let calls=0;
  const gateway:GatewayBridge={request:async()=>{calls++;return {deleted:1};},revoke:()=>{}};
  const f=await fixture(t,gateway,['gateway.records.manage']);
  await assert.rejects(f.request('gateway.records.get',{sessionId:'session',recordId:'request',includeBody:true}),/权限/);
  await assert.rejects(f.request('gateway.records.list',{sessionId:'session',limit:1}),/权限/);
  assert.deepEqual(await f.request('gateway.records.delete',{sessionId:'session',selection:{recordIds:['request']}}),{deleted:1});
  assert.equal(calls,1);
});


test('gateway pairing status preserves unknown listener observations without inventing zero activity',()=>{
 const unknown={pairingId:'pairing',alias:'本机网关',instanceId:'instance',protocolVersion:1,connected:false,listening:null,activeRequests:null,pendingRevocation:false};
 assert.deepEqual(parseGatewayOutput('gateway.status',{pairings:[unknown]}),{pairings:[unknown]});
 assert.deepEqual(parseGatewayOutput('gateway.status',{pairings:[{...unknown,connected:true,listening:true,activeRequests:2}]}).pairings[0].activeRequests,2);
 assert.throws(()=>parseGatewayOutput('gateway.status',{pairings:[{...unknown,activeRequests:129}]}));
 assert.throws(()=>parseGatewayOutput('gateway.status',{pairings:[{...unknown,activeRequests:-1}]}));
});

test('GUI setup and credential writes are typed, bounded and absent from all read outputs',()=>{
 const route={id:'default',clientAlias:'local-cli',protocol:'openai',upstreamBase:'https://api.example.com/v1',enabled:true,capabilities:{serviceTier:true}};
 const input={alias:'本机网关',listenPort:18080,managementPort:18081,route,credentials:{upstreamApiKey:'fixture-upstream-key',clientApiKey:'fixture-client-key-012345'}};
 assert.deepEqual(parseGatewayInput('gateway.local.setup',input),input);
 assert.deepEqual(parseGatewayInput('gateway.connect',{}),{});
 for(const bad of [{...input,managementPort:18080},{...input,dataDir:'C:/secret'},{...input,command:'run'},{...input,credentials:{...input.credentials,clientApiKey:'short'}},{...input,route:{...route,credentialRef:'arbitrary'}},{...input,route:{...route,upstreamBase:'https://127.0.0.1/v1'}},{...input,credentials:{...input.credentials,upstreamApiKey:'secret\nheader'}}])assert.throws(()=>parseGatewayInput('gateway.local.setup',bad));
 assert.doesNotThrow(()=>parseGatewayInput('gateway.routes.save',{sessionId:'session',expectedVersion:1,route,credentials:{upstreamApiKey:'replacement-key'}}));
 assert.throws(()=>parseGatewayInput('gateway.routes.save',{sessionId:'session',expectedVersion:1,route,credentials:{}}));
 const status={configured:true,running:true,pairingId:'local-id',alias:'本机网关',listenPort:18080,managementPort:18081,configVersion:1};
 assert.deepEqual(parseGatewayOutput('gateway.local.status',status),status);
 for(const method of ['gateway.local.status','gateway.local.setup','gateway.local.configure','gateway.routes.save','gateway.routes.delete'] as const)assert.throws(()=>parseGatewayOutput(method,{...status,upstreamApiKey:'must-not-leak'}));
});

test('saved-route model catalogs accept only a bounded, unique directory and require gateway config permission',async t=>{
 const input={sessionId:'session',routeId:'primary',expectedVersion:2};
 const catalog={routeId:'primary',configVersion:2,checkedAtMs:1000,source:'catalog',models:[{id:'provider/model-a'},{id:'自定义模型'}],truncated:false};
 assert.deepEqual(parseGatewayInput('gateway.routes.models.detect',input),input);
 for(const extra of [{url:'https://arbitrary.example/models'},{upstreamApiKey:'secret'},{headers:{authorization:'secret'}},{body:'private prompt'}])assert.throws(()=>parseGatewayInput('gateway.routes.models.detect',{...input,...extra}));
 assert.deepEqual(parseGatewayOutput('gateway.routes.models.detect',catalog),catalog);
 for(const models of [[{id:'\u0000bad'}],[{id:'\u0080bad'}],[{id:'\ud800'}],[{id:' '}],[{id:'中'.repeat(86)}],[{id:'same'},{id:'same'}],Array.from({length:501},(_,index)=>({id:'model-'+index})),[{id:'valid',key:'secret'}]])assert.throws(()=>parseGatewayOutput('gateway.routes.models.detect',{...catalog,models}));
 assert.throws(()=>parseGatewayOutput('gateway.routes.models.detect',{...catalog,upstreamApiKey:'secret'}));
 let calls=0;
 const f=await fixture(t,{request:async()=>{++calls;return catalog;},revoke:()=>{}},['gateway.control']);
 await assert.rejects(f.request('gateway.routes.models.detect',input),/权限/);assert.equal(calls,0);
});
