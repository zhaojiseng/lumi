import test from 'node:test';
import assert from 'node:assert/strict';
import {createPluginHost,PluginInactiveError} from '../shared/plugin-host';
import type {PluginContext,PluginManifest,TrustedBuiltinPlugin} from '../shared/contracts/plugins';

interface Capabilities {read:{value():number|Promise<number>}}
const ref=(sourceId:string)=>({sourceId,capability:'read' as const});
function manifest(id:string,patch:Partial<PluginManifest<'read'>>={}):PluginManifest<'read'>{
  return {id,version:'1.0.0',hostApiVersion:1,configurable:true,requires:[],optional:[],provides:[],...patch};
}
function plugin(id:string,activate:TrustedBuiltinPlugin<Capabilities>['activate'],patch:Partial<PluginManifest<'read'>>={}):TrustedBuiltinPlugin<Capabilities>{return {manifest:manifest(id,patch),activate};}
const hostFor=(plugins:TrustedBuiltinPlugin<Capabilities>[])=>createPluginHost<Capabilities>({plugins,capabilityIds:['read']});
const provider=(id:string,events:string[])=>plugin(id,ctx=>{events.push('start '+id);ctx.provide('read',Object.freeze({value:()=>1}));return()=>{events.push('stop '+id);};},{provides:['read']});
function deferred<T>(){let resolve!:(value:T)=>void,reject!:(error:Error)=>void;const promise=new Promise<T>((yes,no)=>{resolve=yes;reject=no;});return {promise,resolve,reject};}

test('plugin registry rejects duplicate identities, missing capabilities, cycles and incompatible host contracts',()=>{
  const p=provider('p',[]);
  assert.throws(()=>hostFor([p,p]),/Duplicate plugin id/);
  assert.throws(()=>hostFor([plugin('c',()=>{},{requires:[ref('missing')]})]),/Missing required/);
  assert.throws(()=>hostFor([plugin('p',()=>{},{provides:['read','read']})]),/Duplicate scoped capability/);
  assert.throws(()=>hostFor([plugin('p',()=>{},{hostApiVersion:2 as 1})]),/Unsupported host API/);
  assert.throws(()=>hostFor([plugin('a',()=>{},{provides:['read'],requires:[ref('b')]}),plugin('b',()=>{},{provides:['read'],requires:[ref('a')]})]),/cycle/);
});

test('settings declarations are validated and snapshotted with the capability graph',async t=>{
  const settings={title:'Source',description:'',order:1,views:[{id:'history',title:'History',defaultEnabled:false}]};
  const host=hostFor([plugin('p',()=>{},{settings,defaultEnabled:false})]);t.after(()=>host.dispose());settings.views[0].title='Mutated';
  assert.equal(host.getStatuses()[0].manifest.defaultEnabled,false);
  assert.throws(()=>hostFor([plugin('p',()=>{},{defaultEnabled:'false' as unknown as boolean})]),/Invalid default enabled flag/);
  assert.equal(host.getStatuses()[0].manifest.settings?.views[0].title,'History');
  assert.throws(()=>hostFor([plugin('p',()=>{},{settings:{...settings,views:[settings.views[0],settings.views[0]]}})]),/Invalid settings view/);
  assert.throws(()=>hostFor([plugin('p',()=>{},{settings:{...settings,views:[{id:'../path',title:'Invalid'}]}})]),/Invalid settings view/);
});

test('required plugins activate once, optional sources remain lazy and disabling cascades only to required consumers',async t=>{
  const events:string[]=[];
  const host=hostFor([provider('p',events),provider('other',events),
    plugin('required',ctx=>{events.push('start required');assert.equal(ctx.requireCapability('p','read').value(),1);return()=>{events.push('stop required');};},{requires:[ref('p')]}),
    plugin('optional',ctx=>{assert.equal(ctx.getCapability('other','read'),undefined);return()=>{events.push('stop optional');};},{optional:[ref('p'),ref('other')]})]);
  t.after(()=>host.dispose());
  await host.enable('required');await host.enable('required');await host.enable('optional');
  assert.deepEqual(events,['start p','start required']);assert.equal(host.isEnabled('other'),false);
  await host.enable('other');assert.deepEqual(host.listProviders('read'),['p','other']);
  await host.disable('p');assert.equal(host.isEnabled('required'),false);assert.equal(host.isEnabled('optional'),true);assert.equal(host.isEnabled('other'),true);
  assert.deepEqual(events.slice(-2),['stop required','stop p']);
  await host.disable('p');assert.deepEqual(events.slice(-2),['stop required','stop p']);
});

test('activation failure releases partial resources and rolls back only newly activated dependencies',async t=>{
  const events:string[]=[];
  const host=hostFor([provider('existing',events),provider('new',events),plugin('failure',ctx=>{
    ctx.onDispose(()=>{events.push('cleanup first');});ctx.onDispose(()=>{events.push('cleanup second');});throw new Error('activation failed');
  },{requires:[ref('existing'),ref('new')]})]);t.after(()=>host.dispose());
  await host.enable('existing');await assert.rejects(host.enable('failure'),/activation failed/);
  assert.equal(host.isEnabled('existing'),true);assert.equal(host.isEnabled('new'),false);
  assert.equal(host.getStatuses().find(s=>s.manifest.id==='failure')?.state,'failed');
  assert.deepEqual(events,['start existing','start new','cleanup second','cleanup first','stop new']);
});

test('capabilities must be declared, provided and consumed through declared dependencies',async t=>{
  const host=hostFor([provider('p',[]),plugin('undeclared',ctx=>ctx.provide('read',{value:()=>1})),
    plugin('missing',()=>{},{provides:['read']}),plugin('consumer',ctx=>{ctx.requireCapability('p','read');})]);t.after(()=>host.dispose());
  await host.enable('p');await assert.rejects(host.enable('undeclared'),/Undeclared capability/);
  await assert.rejects(host.enable('missing'),/did not provide/);await assert.rejects(host.enable('consumer'),/Undeclared dependency/);
});

test('retained capability handles reject calls and late successes/errors across provider disable and re-enable',async t=>{
  let waiting=deferred<number>();
  const host=hostFor([plugin('p',ctx=>ctx.provide('read',Object.freeze({value:()=>waiting.promise})),{provides:['read']})]);t.after(()=>host.dispose());
  await host.enable('p');const old=host.requireCapability('p','read'),first=old.value();const rejected=assert.rejects(Promise.resolve(first),PluginInactiveError);
  await host.disable('p');await host.enable('p');waiting.resolve(1);await rejected;assert.throws(()=>old.value(),PluginInactiveError);
  waiting=deferred<number>();const next=host.requireCapability('p','read').value(),lateError=assert.rejects(Promise.resolve(next),PluginInactiveError);
  await host.disable('p');waiting.reject(new Error('late request failed'));await lateError;
});

test('consumer capability handles are revoked even when an optional provider remains active',async t=>{
  const waiting=deferred<number>();let handle!:Capabilities['read'];
  const host=hostFor([plugin('p',ctx=>ctx.provide('read',{value:()=>waiting.promise}),{provides:['read']}),
    plugin('consumer',ctx=>{handle=ctx.requireCapability('p','read');},{optional:[ref('p')]})]);t.after(()=>host.dispose());
  await host.enable('p');await host.enable('consumer');const result=handle.value();const rejected=assert.rejects(Promise.resolve(result),PluginInactiveError);
  await host.disable('consumer');assert.equal(host.isEnabled('p'),true);waiting.resolve(7);await rejected;
  assert.throws(()=>handle.value(),PluginInactiveError);
});

test('lifecycle queue survives failures and disposal cleans every plugin in reverse activation order',async()=>{
  const events:string[]=[],started=deferred<void>(),finish=deferred<void>();
  const host=hostFor([plugin('a',async ctx=>{events.push('start a');started.resolve();await finish.promise;
    ctx.onDispose(()=>{events.push('cleanup a');throw new Error('cleanup failed');});}),plugin('b',()=>{events.push('start b');return()=>{events.push('cleanup b');};})]);
  const a=host.enable('a');await started.promise;const b=host.enable('b');assert.deepEqual(events,['start a']);finish.resolve();await Promise.all([a,b]);
  const disposing=host.dispose();assert.equal(host.dispose(),disposing);await assert.rejects(host.enable('b'),/disposed/);
  await assert.rejects(disposing,/cleanup failed/i);assert.deepEqual(events,['start a','start b','cleanup b','cleanup a']);
  assert.ok(host.getStatuses().every(s=>s.state==='disabled'));
});

test('disposal stops new capability calls before asynchronous cleanup has finished',async()=>{
  const cleanup=deferred<void>();
  const host=hostFor([plugin('p',ctx=>{ctx.provide('read',{value:()=>3});return()=>cleanup.promise;},{provides:['read']})]);
  await host.enable('p');const handle=host.requireCapability('p','read'),disposing=host.dispose();
  try{assert.equal(host.getCapability('p','read'),undefined);assert.throws(()=>handle.value(),PluginInactiveError);}
  finally{cleanup.resolve();await disposing;}
});

test('capability class receivers and captured contexts remain correctly scoped to activation',async t=>{
  class Counter{#value=0;value(){return ++this.#value;}}
  let context!:PluginContext<Capabilities>;
  const host=hostFor([plugin('p',ctx=>{context=ctx;ctx.provide('read',new Counter());},{provides:['read']})]);t.after(()=>host.dispose());
  await host.enable('p');assert.equal(host.requireCapability('p','read').value(),1);
  assert.throws(()=>context.provide('read',new Counter()),/closed/);await host.disable('p');assert.throws(()=>context.onDispose(()=>{}),PluginInactiveError);
});
