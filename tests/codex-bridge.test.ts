import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdir,mkdtemp,readFile,rm,writeFile} from 'node:fs/promises';
import path from 'node:path';
import {CodexBridgeService,CODEX_BRIDGE_METHODS,childTransport} from '../plugins/provider.codex-bridge/services/bridge';
import {createExtensionCodexBridge} from '../electron/extensions/codex-bridge';
import {runInNewContext} from 'node:vm';
import {spawnSync} from 'node:child_process';
import type {CodexBridgeMessage} from '../shared/contracts/codex-bridge';

async function fixture(t:{after(fn:()=>Promise<void>):void}){const base=path.resolve('.test-data');await mkdir(base,{recursive:true});const root=await mkdtemp(path.join(base,'codex-bridge-'));t.after(()=>rm(root,{recursive:true,force:true,maxRetries:5,retryDelay:100}));return root;}
const until=async(fn:()=>boolean,label:string)=>{const end=Date.now()+3000;while(!fn()){if(Date.now()>end)throw new Error('timeout: '+label);await new Promise(r=>setTimeout(r,10));}};

/** Minimal app-server stand-in: handshake reply, one notification, one approval request; records every answer. */
function mockScript(record:string){return `
const fs=require('node:fs'),readline=require('node:readline');
readline.createInterface({input:process.stdin}).on('line',line=>{
  const q=JSON.parse(line);fs.appendFileSync(${JSON.stringify(record)},JSON.stringify(q)+'\\n');
  if(q.method==='initialize'){process.stdout.write(JSON.stringify({id:q.id,result:{ok:true}})+'\\n');process.stdout.write(JSON.stringify({method:'thread/started',params:{thread:{id:'t1'}}})+'\\n');process.stdout.write(JSON.stringify({id:900,method:'item/commandExecution/requestApproval',params:{itemId:'i1',command:'ls'}})+'\\n');return;}
  if(q.method!==undefined){return;}
  process.stdout.write(JSON.stringify({method:'serverRequest/resolved',params:{requestId:q.id}})+'\\n');
});
setInterval(()=>{},1000);
`;}

test('bridge forwards allowlisted requests, notifies verbatim, relays approvals and rejects other methods',async t=>{
  const root=await fixture(t),script=path.join(root,'mock.cjs'),record=path.join(root,'received.jsonl');
  await writeFile(script,mockScript(record));
  const service=new CodexBridgeService({resolve:async()=>({file:process.execPath,args:[script],env:{...process.env,CODEX_HOME:root,OPENAI_API_KEY:'fake-only'}})});
  t.after(()=>service.close());
  const events:unknown[]=[];service.subscribe(message=>events.push(message));
  const interrupt=service.send({method:'process/spawn',params:{}});await assert.rejects(interrupt,/不支持/);
  const response=await service.send({method:'initialize',params:{clientInfo:{name:'fixture'}}});
  assert.deepEqual(response,{result:{ok:true}});
  await until(()=>events.some(e=>typeof (e as any).method==='string' && (e as any).method==='thread/started'),'thread/started');
  await until(()=>events.some(e=>(e as any).id===900 && (e as any).method==='item/commandExecution/requestApproval'),'approval');
  await service.send({method:'initialized',params:{},notify:true});
  await service.respond({id:900,result:{decision:'accept'}});
  await until(()=>events.some(e=>(e as any).method==='serverRequest/resolved'),'resolved');
  const received=(await readFile(record,'utf8')).trim().split('\n').map(line=>JSON.parse(line));
  assert.ok(received.some(m=>m.method==='initialized' && m.id===undefined),'notifications carry no id');
  assert.ok(received.some(m=>m.id===900 && m.result?.decision==='accept'),'approval answer written verbatim');
  assert.ok(!JSON.stringify(received).includes('fake-only'),'no secrets on the wire');
  const status=await service.status();assert.equal(status.installed,true);assert.equal(status.state,'ready');
});

test('an unanswered approval request is closed with an error so the server never hangs',async t=>{
  const root=await fixture(t),script=path.join(root,'mock.cjs'),record=path.join(root,'received.jsonl');
  await writeFile(script,mockScript(record));
  const service=new CodexBridgeService({resolve:async()=>({file:process.execPath,args:[script],env:{...process.env}}),approvalTimeout:60});
  t.after(()=>service.close());
  await service.send({method:'initialize',params:{}});
  const end=Date.now()+3000;let received:{id?:number;error?:{message?:string}}[]=[];
  while(Date.now()<end){received=((await readFile(record,'utf8')).trim().split('\n').filter(Boolean)).map(line=>JSON.parse(line));if(received.some(m=>m.id===900 && m.error))break;await new Promise(r=>setTimeout(r,10));}
  assert.ok(received.some(m=>m.id===900 && m.error?.message?.includes('approval timed out')));
});

test('unknown methods are rejected before any process is started and the allowlist stays conversation-only',async()=>{
  let resolved=0;
  const service=new CodexBridgeService({resolve:async()=>{resolved++;return undefined;}});
  await assert.rejects(service.send({method:'fs/writeFile',params:{}}),/不支持/);
  assert.equal(resolved,0);
  assert.ok(CODEX_BRIDGE_METHODS.includes('turn/start'));
  for(const blocked of ['process/spawn','command/exec','thread/shellCommand','fs/readFile','account/logout'])assert.ok(!CODEX_BRIDGE_METHODS.includes(blocked),blocked+' must stay blocked');
  service.close();
});

test('a disabled bridge rejects further calls and a missing CLI surfaces a clear message',async t=>{
  const root=await fixture(t);
  const missing=new CodexBridgeService({resolve:async()=>undefined});
  assert.equal((await missing.status()).installed,false);
  await assert.rejects(missing.send({method:'initialize',params:{}}),/未发现 Codex CLI/);
  const script=path.join(root,'mock.cjs');await writeFile(script,mockScript(path.join(root,'received.jsonl')));
  const service=new CodexBridgeService({resolve:async()=>({file:process.execPath,args:[script]})});
  await service.send({method:'initialize',params:{}});service.close();
  await assert.rejects(service.send({method:'model/list',params:{}}),/停用/);
});

test('transport output overflow terminates the actual child even after exit notification',async t=>{
  const root=await fixture(t),script=path.join(root,'overflow.cjs'),pidFile=path.join(root,'pid');
  await writeFile(script,`require('node:fs').writeFileSync(${JSON.stringify(pidFile)},String(process.pid));process.stdout.write('x'.repeat(9*1024*1024));setInterval(()=>{},1000);`);
  const transport=childTransport({file:process.execPath,args:[script]});let reported=false,pid=0;
  transport.onExit(()=>{reported=true;transport.close();});
  t.after(async()=>{transport.close();if(pid){try{if(process.platform==='win32')spawnSync('taskkill.exe',['/PID',String(pid),'/T','/F'],{windowsHide:true,stdio:'ignore'});else process.kill(pid,'SIGKILL');}catch{}}});
  await until(()=>reported,'overflow exit');pid=Number(await readFile(pidFile,'utf8'));
  await until(()=>{try{process.kill(pid,0);return false;}catch{return true;}},'child terminated');
});

test('extension clients isolate events and approvals, cancel withdrawn work and reconnect after provider replacement',async()=>{
  const connected:{service:CodexBridgeService;receive:(m:CodexBridgeMessage)=>void;writes:Record<string,unknown>[];closed:boolean}[]=[];
  const factory={create(){
    const state={service:undefined as unknown as CodexBridgeService,receive:(_m:CodexBridgeMessage)=>{},writes:[] as Record<string,unknown>[],closed:false};
    state.service=new CodexBridgeService({resolve:async()=>({file:'fixture',args:[]}),connect:()=>({write(m){state.writes.push(m as Record<string,unknown>);if((m as any).method==='initialize')queueMicrotask(()=>state.receive({id:(m as any).id,result:{ok:true}}));},onMessage(fn){state.receive=fn;},onExit(){},close(){state.closed=true;}})});
    connected.push(state);return state.service;
  },release(client:{close():void}){client.close();},close(){for(const client of connected)client.service.close();}};
  const events:any[]=[],router=createExtensionCodexBridge(()=>factory,event=>events.push(event));
  const a=new AbortController(),b=new AbortController(),owner=(signal:AbortSignal,view:string)=>({id:'extension.fixture.client',generation:1,view,signal});
  const first=owner(a.signal,'chat'),second=owner(b.signal,'other');
  for(const o of [first,second]){await router.call('codex.bridge.subscribe',{},o);await router.call('codex.bridge.send',{method:'initialize'},o);}
  connected[0].receive({id:900,method:'item/commandExecution/requestApproval'});
  assert.equal(events.length,1);assert.equal(events[0].view,'chat');
  await assert.rejects(router.call('codex.bridge.respond',{id:900,result:{decision:'accept'}},second),/不属于/);
  await router.call('codex.bridge.respond',{id:900,result:{decision:'decline'}},first);
  await assert.rejects(router.call('codex.bridge.respond',{id:900,result:{}},first),/已结束/);
  const pending=router.call('codex.bridge.send',{method:'model/list'},first);const rejected=assert.rejects(pending,/停用/);await new Promise(r=>setTimeout(r,0));a.abort();await rejected;
  assert.equal(connected[0].closed,true);assert.equal(connected[1].closed,false);
  router.drop();assert.equal(connected[1].closed,true);
  await router.call('codex.bridge.subscribe',{},second);await router.call('codex.bridge.send',{method:'initialize'},second);
  connected[2].receive({method:'thread/started'});assert.equal(events.at(-1).view,'other');
  router.drop();
});

test('SDK keeps a host subscription until its final listener is removed, including onEvent aliases',async()=>{
  const posted:any[]=[],handlers:Record<string,(event:any)=>void>={};
  const parent={postMessage(m:any){posted.push(m);}},window:any={addEventListener(name:string,fn:(event:any)=>void){handlers[name]=fn;}};
  runInNewContext(await readFile('public/lumi-extension-sdk.js','utf8'),{window,parent,setTimeout,clearTimeout});
  const respond=(id:number)=>handlers.message({source:parent,data:{protocol:'lumi-extension/1',nonce:'fixture',type:'response',id,ok:true,data:{}}});
  handlers.message({source:parent,data:{protocol:'lumi-extension/1',type:'init',nonce:'fixture',context:{},view:{}}});
  const offA=window.lumiExtension.codex.bridge.subscribe(()=>{}),offB=window.lumiExtension.onEvent('codex.bridge',()=>{});
  await new Promise(r=>setTimeout(r,0));assert.equal(posted.filter(m=>m.method==='codex.bridge.subscribe').length,1);
  respond(posted.find(m=>m.type==='request').id);offA();offA();await new Promise(r=>setTimeout(r,0));assert.ok(!posted.some(m=>m.method==='codex.bridge.unsubscribe'));
  offB();await new Promise(r=>setTimeout(r,0));const unsub=posted.filter(m=>m.method==='codex.bridge.unsubscribe');assert.equal(unsub.length,1);respond(unsub[0].id);
});
