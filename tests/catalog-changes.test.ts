import test from 'node:test';
import assert from 'node:assert/strict';
import {
  CATALOG_CHANGES_KEY,CATALOG_CHANGES_EVENT,acknowledgeCatalogChanges,advanceCatalogChanges,catalogChangesStorageKey,
  createCatalogSnapshot,diffCatalogSnapshots,getCatalogChanges,markCatalogChangesRead,observeCatalogChanges,
  readCatalogChanges,subscribeCatalogChanges,writeCatalogChanges,type CatalogChangeStorage,
} from '../shared/catalog-changes';
import {pricingChoices} from '../shared/pricing';
import type {ModelCatalog,ModelInfo,SiteStatus} from '../shared/types';

const status:SiteStatus={system_name:'Fixture',quota_per_unit:500000};
const model:ModelInfo={model_name:'model-1',quota_type:0,model_ratio:1,model_price:0,completion_ratio:2,
  enable_groups:['standard','premium'],supported_endpoint_types:[],cache_ratio:.1,create_cache_ratio:1.25};
function catalog(models:ModelInfo[]=[model]):ModelCatalog {
  return {models,groupRatio:{standard:1,premium:.5},usableGroups:{standard:'标准',premium:'优选'},autoGroups:['standard','premium'],vendors:[]};
}
function snapshot(models:ModelInfo[]=[model]) {return createCatalogSnapshot(catalog(models),status);}
class MemoryStorage implements CatalogChangeStorage {
  values=new Map<string,string>();writes=0;failRead=false;failWrite=false;
  getItem(key:string):string|null {if(this.failRead)throw new Error('Denied');return this.values.get(key) ?? null;}
  setItem(key:string,value:string):void {if(this.failWrite)throw new Error('QuotaExceededError');this.writes++;this.values.set(key,value);}
}

test('first observation establishes a quiet baseline, and the same rules never produce another event',()=>{
  const storage=new MemoryStorage(),site={id:'baseline',url:'https://fixture.invalid'};
  assert.equal(getCatalogChanges(site,{storage}).state,null);
  const initial=observeCatalogChanges(site,catalog(),status,{storage,detectedAt:1000});
  assert.equal(initial.pendingCount,0);assert.deepEqual(initial.state?.events,[]);assert.equal(storage.writes,1);
  const repeated=observeCatalogChanges(site,catalog(),{...status,version:'different',announcements:[]},{storage,detectedAt:2000});
  assert.deepEqual(repeated.state,initial.state);assert.equal(storage.writes,1);
  assert.deepEqual(readCatalogChanges(storage,initial.key),initial.state);
});

test('model additions, removals and a valid empty catalog yield concise named changes',()=>{
  const before=snapshot([model,{...model,model_name:'model-2'}]);
  const after=snapshot([{...model,model_name:'model-3'},model]);
  assert.deepEqual(diffCatalogSnapshots(before,after),[
    {kind:'added',modelName:'model-3',fields:[]},{kind:'removed',modelName:'model-2',fields:[]},
  ]);
  assert.deepEqual(diffCatalogSnapshots(snapshot(),snapshot([])),[{kind:'removed',modelName:'model-1',fields:[]}]);
});

test('all published calculation, quota and ratio fields are compared, including plugin and schema rules',()=>{
  const updates:Partial<ModelInfo>={
    quota_type:1,model_price:.2,model_ratio:3,completion_ratio:4,cache_ratio:.3,create_cache_ratio:2,
    image_ratio:2,audio_ratio:3,audio_completion_ratio:4,billing_mode:'tiered_expr',billing_expr:'p*2+c*8',
    billing_usage_schema:{seconds:{type:'number',unit:'seconds',enum:['short','long']}},
    billing_plugin_variants:[{plugin_key:'v1',plugin_name:'展示名称',billing_expr:'fixed(.2)'}],
    enable_groups:['premium'],group_ratio:{premium:.25},
  };
  for(const [field,value] of Object.entries(updates)) {
    const changes=diffCatalogSnapshots(snapshot(),snapshot([{...model,[field]:value}]));
    assert.deepEqual(changes,[{kind:'pricing',modelName:model.model_name,fields:[field]}],field);
  }
  const plugin={...model,billing_plugin_variants:updates.billing_plugin_variants};
  assert.deepEqual(diffCatalogSnapshots(snapshot([plugin]),snapshot([{...plugin,billing_plugin_variants:[{plugin_key:'v1',plugin_name:'展示名称',billing_expr:'fixed(.3)'}]}]))[0].fields,['billing_plugin_variants']);
});

test('groupRatio, route membership, quota units and effective currency settings produce site changes',()=>{
  const original=catalog(),baseline=createCatalogSnapshot(original,status);
  for(const [field,value] of Object.entries({groupRatio:{standard:2,premium:.5},usableGroups:{standard:'标准'},autoGroups:['premium']})) {
    assert.deepEqual(diffCatalogSnapshots(baseline,createCatalogSnapshot({...original,[field]:value},status)),[{kind:'catalog',fields:[field]}]);
  }
  assert.deepEqual(diffCatalogSnapshots(baseline,createCatalogSnapshot(original,{...status,quota_per_unit:1000000})),[{kind:'catalog',fields:['quota_per_unit']}]);
  assert.deepEqual(diffCatalogSnapshots(baseline,createCatalogSnapshot(original,{...status,quota_display_type:'CNY',usd_exchange_rate:7})),[{kind:'catalog',fields:['currency']}]);
  const custom={...status,quota_display_type:'CUSTOM',custom_currency_symbol:'积分',custom_currency_exchange_rate:2};
  assert.deepEqual(diffCatalogSnapshots(createCatalogSnapshot(original,custom),createCatalogSnapshot(original,{...custom,custom_currency_symbol:'点数'})),[{kind:'catalog',fields:['currency']}]);
  assert.deepEqual(diffCatalogSnapshots(baseline,createCatalogSnapshot(original,{...status,usd_exchange_rate:9,custom_currency_symbol:'unused'})),[]);
});

test('sorting, health, labels, descriptions, examples and unrelated metadata cannot affect fingerprints',()=>{
  const first:ModelInfo={...model,group_ratio:{standard:1,premium:.5},billing_usage_schema:{task:{type:'number',unit:'s',enum:['a','b'],description:'旧介绍',unitLabel:'秒'}},
    billing_plugin_variants:[{plugin_key:'a',plugin_name:'旧名称',billing_expr:'p*2'},{plugin_key:'b',plugin_name:'B',billing_expr:'p*3'}]};
  const renamed:ModelInfo={...first,description:'新介绍',vendor:'展示提供商',tags:'new',health:{success_rate:100},access_token:'fixture-token',
    enable_groups:['premium','standard','standard'],group_ratio:{premium:.5,standard:1},supported_endpoint_types:['new endpoint'],
    billing_usage_schema:{task:{type:'number',unit:'s',enum:['b','a'],description:'新介绍',unitLabel:'Seconds',enumLabels:{a:'A'}}},
    billing_usage_examples:[{label:'新示例',facts:{task:100}}],
    billing_plugin_variants:[{plugin_key:'b',plugin_name:'改名称',billing_expr:'p*3'},{plugin_key:'a',plugin_name:'重命名',billing_expr:'p*2',billing_usage_examples:[{label:'示例',facts:{p:100}}]}]};
  const before=createCatalogSnapshot(catalog([first,{...model,model_name:'model-2'}]),status);
  const after=createCatalogSnapshot({...catalog([{...model,model_name:'model-2'},renamed]),groupRatio:{premium:.5,standard:1},usableGroups:{premium:'新名称',standard:'标准'},autoGroups:['premium','standard'],vendors:[{id:1,name:'新的提供商'}]},
    {...status,system_name:'新站点名',quota:12,used_quota:900,fetchedAt:9999});
  assert.deepEqual(after,before);
  const alias={...model,create_cache_ratio:undefined,cache_creation_ratio:model.create_cache_ratio};
  assert.deepEqual(snapshot([alias]),snapshot());
});

test('actual clock-driven price changes do not notify, but editing the time-pricing rule does',()=>{
  const timed={...model,billing_mode:'tiered_expr',billing_expr:'p*2*(hour("Asia/Shanghai") >= 9 && hour("Asia/Shanghai") < 18 ? 2 : 1)'};
  const day=pricingChoices(timed,status,new Date('2026-10-02T02:00:00Z')),night=pricingChoices(timed,status,new Date('2026-10-02T12:00:00Z'));
  assert.notEqual(day[0].section?.rows[0].usd,night[0].section?.rows[0].usd);
  const state=advanceCatalogChanges(null,snapshot([timed]),1000);
  assert.strictEqual(advanceCatalogChanges(state,snapshot([timed]),2000),state);
  const updated=advanceCatalogChanges(state,snapshot([{...timed,billing_expr:timed.billing_expr.replace('< 18','< 20')}]),3000);
  assert.deepEqual(updated.events[0].changes,[{kind:'pricing',modelName:model.model_name,fields:['billing_expr']}]);
});

test('failed catalog requests preserve the baseline; a recovered or valid empty response is observed',()=>{
  const storage=new MemoryStorage(),site={id:'request-failures',url:'https://fixture.invalid'};
  assert.equal(observeCatalogChanges(site,catalog([]),status,{storage,warnings:['模型广场：超时']}).state,null);
  assert.equal(storage.writes,0);
  const baseline=observeCatalogChanges(site,catalog(),status,{storage});
  for(const warning of ['模型广场：超时','模型广场: unavailable','模型广场暂不可用']) {
    const failed=observeCatalogChanges(site,catalog([]),status,{storage,warnings:[warning]});
    assert.deepEqual(failed.state,baseline.state);assert.equal(failed.pendingCount,0);
  }
  assert.equal(storage.writes,1);
  assert.equal(observeCatalogChanges(site,catalog(),status,{storage,warnings:['健康度暂不可用']}).pendingCount,0);
  const emptied=observeCatalogChanges(site,catalog([]),status,{storage});
  assert.deepEqual(emptied.state?.events[0].changes,[{kind:'removed',modelName:model.model_name,fields:[]}]);
});

test('site ID and URL isolate records, read status survives reload and refresh does not recreate it',()=>{
  const storage=new MemoryStorage(),a={id:'scope-a',url:'https://fixture.invalid/api'},b={...a,id:'scope-b'},c={...a,url:'https://fixture.invalid/other'};
  const keys=[a,b,c].map(catalogChangesStorageKey);assert.equal(new Set(keys).size,3);
  assert.equal(catalogChangesStorageKey({...a,url:a.url+'/'}),keys[0]);
  for(const site of [a,b,c])observeCatalogChanges(site,catalog(),status,{storage});
  const changed=observeCatalogChanges(a,catalog([{...model,model_ratio:2}]),status,{storage,detectedAt:1000});
  assert.equal(changed.pendingCount,1);assert.equal(getCatalogChanges(b,{storage}).pendingCount,0);assert.equal(getCatalogChanges(c,{storage}).pendingCount,0);
  const read=acknowledgeCatalogChanges(a,undefined,{storage});assert.equal(read.pendingCount,0);
  const reloaded=readCatalogChanges(storage,keys[0])!;
  assert.equal(reloaded.events[0].read,true);
  assert.strictEqual(advanceCatalogChanges(reloaded,snapshot([{...model,model_ratio:2}]),2000),reloaded);
  assert.equal(observeCatalogChanges(a,catalog([{...model,model_ratio:2}]),status,{storage}).pendingCount,0);
  assert.ok(changed.key.startsWith(CATALOG_CHANGES_KEY+':'));
});

test('new changes after read remain unread, and a repeated A/B transition still creates a fresh event',()=>{
  let state=advanceCatalogChanges(null,snapshot(),1000);
  state=advanceCatalogChanges(state,snapshot([{...model,model_ratio:2}]),2000);
  const firstId=state.events[0].id;
  state=markCatalogChangesRead(state);
  state=advanceCatalogChanges(state,snapshot(),3000);
  state=advanceCatalogChanges(state,snapshot([{...model,model_ratio:2}]),4000);
  assert.notEqual(state.events[0].id,firstId);assert.equal(state.events[0].read,false);assert.equal(state.events[2].read,true);
  const partlyRead=markCatalogChangesRead(state,[state.events[1].id]);
  assert.equal(partlyRead.events[0].read,false);assert.equal(partlyRead.events[1].read,true);
  for(let i=0;i<25;i++)state=advanceCatalogChanges(state,snapshot([{...model,model_ratio:i+3}]),5000+i);
  assert.equal(state.events.length,20);assert.equal(new Set(state.events.map(event=>event.id)).size,20);
});

test('malformed, mismatched and poisoned persisted data are ignored without creating notifications',()=>{
  const storage=new MemoryStorage(),key='corrupt-fixture',initial=advanceCatalogChanges(null,snapshot(),1000);
  const changed=advanceCatalogChanges(initial,snapshot([{...model,model_ratio:2}]),2000);
  const malformed:unknown[]=[null,{},[],{...initial,version:99},{...initial,revision:-1},
    {...initial,baseline:{...initial.baseline,fingerprint:'0000000000000000'}},
    {...initial,baseline:{...initial.baseline,models:[...initial.baseline.models,...initial.baseline.models]}},
    {...initial,baseline:{...initial.baseline,fields:{groupRatio:'not a fingerprint'}}},
    {...changed,events:[{...changed.events[0],read:'true'}]},
    {...changed,events:[{...changed.events[0],detectedAt:1e99}]},
    {...changed,events:[{...changed.events[0],changes:[{kind:'pricing',modelName:'model-1',fields:['access_token']}]}]},
    {...changed,events:[{...changed.events[0],changes:[{kind:'removed',modelName:'model-1',fields:['billing_expr']}]}]},
  ];
  for(const value of malformed) {
    storage.values.set(key,JSON.stringify(value));assert.equal(readCatalogChanges(storage,key),null);
    assert.deepEqual(advanceCatalogChanges(readCatalogChanges(storage,key),snapshot(),3000).events,[]);
  }
  storage.values.set(key,'{truncated');assert.equal(readCatalogChanges(storage,key),null);
  storage.values.set(key,' '.repeat(8*1024*1024+1));assert.equal(readCatalogChanges(storage,key),null);
  storage.failRead=true;assert.equal(readCatalogChanges(storage,key),null);
  storage.failWrite=true;assert.equal(writeCatalogChanges(storage,key,initial),false);
  assert.equal(writeCatalogChanges(null,key,initial),false);
});

test('only names, field fingerprints and concise diffs are persisted; arbitrary sensitive data is dropped',()=>{
  const storage=new MemoryStorage(),secret='fixture-sensitive-value-do-not-store',site={id:'privacy',url:'https://user:'+secret+'@fixture.invalid/?token='+secret};
  const privateModel={...model,access_token:secret,api_key:secret,description:secret,billing_expr:'p*2 /* '+secret+' */',
    billing_plugin_variants:[{plugin_key:'v1',plugin_name:secret,billing_expr:'p*3',accessToken:secret}]};
  const initial=observeCatalogChanges(site,catalog([privateModel]),{...status,token:secret},{storage});
  const changed=observeCatalogChanges(site,catalog([{...privateModel,billing_expr:'p*4 /* '+secret+' */'}]),status,{storage});
  assert.equal(changed.pendingCount,1);
  const poisoned={...changed.state!,token:secret,baseline:{...changed.state!.baseline,apiKey:secret},events:changed.state!.events.map(e=>({...e,rawRule:secret}))};
  assert.equal(writeCatalogChanges(storage,initial.key,poisoned),true);
  const text=storage.values.get(initial.key)!;
  assert.ok(!text.includes(secret));assert.ok(!text.includes('p*4'));assert.ok(!initial.key.includes(secret));assert.ok(!initial.key.includes('fixture.invalid'));
  assert.deepEqual(readCatalogChanges(storage,initial.key),changed.state);
});

test('blocked or full localStorage falls back to session state and recovers without duplicate changes',()=>{
  const storage=new MemoryStorage(),site={id:'session-fallback',url:'https://fixture.invalid'};storage.failRead=true;storage.failWrite=true;
  assert.equal(observeCatalogChanges(site,catalog(),status,{storage}).persisted,false);
  const changed=observeCatalogChanges(site,catalog([{...model,model_ratio:2}]),status,{storage});
  assert.equal(changed.pendingCount,1);assert.equal(changed.persisted,false);
  assert.equal(observeCatalogChanges(site,catalog([{...model,model_ratio:2}]),status,{storage}).state?.events.length,1);
  assert.equal(acknowledgeCatalogChanges(site,undefined,{storage}).pendingCount,0);
  storage.failRead=false;storage.failWrite=false;
  const recovered=observeCatalogChanges(site,catalog([{...model,model_ratio:2}]),status,{storage});
  assert.equal(recovered.persisted,true);assert.equal(recovered.pendingCount,0);assert.equal(recovered.state?.events.length,1);
  assert.deepEqual(readCatalogChanges(storage,recovered.key),recovered.state);
});

test('shared observers notify matching consumers, remain quiet on refresh, and receive cross-window storage updates',t=>{
  const storage=new MemoryStorage(),surface=Object.assign(new EventTarget(),{localStorage:storage});
  const previous=Object.getOwnPropertyDescriptor(globalThis,'window');
  Object.defineProperty(globalThis,'window',{value:surface,configurable:true});
  t.after(()=>{if(previous)Object.defineProperty(globalThis,'window',previous);else Reflect.deleteProperty(globalThis,'window');});
  const site={id:'events',url:'https://fixture.invalid'},other={...site,id:'other-events'};
  let notifications=0;
  const unsubscribe=subscribeCatalogChanges(site,()=>notifications++);
  observeCatalogChanges(site,catalog(),status);assert.equal(notifications,1);assert.equal(getCatalogChanges(site).pendingCount,0);
  observeCatalogChanges(site,catalog(),status);assert.equal(notifications,1);
  observeCatalogChanges(other,catalog(),status);assert.equal(notifications,1);
  const changed=observeCatalogChanges(site,catalog([{...model,model_ratio:2}]),status);assert.equal(notifications,2);assert.equal(changed.pendingCount,1);
  acknowledgeCatalogChanges(site);assert.equal(notifications,3);assert.equal(getCatalogChanges(site).pendingCount,0);
  const external=advanceCatalogChanges(readCatalogChanges(storage,changed.key)!,snapshot([{...model,model_ratio:3}]),5000);
  writeCatalogChanges(storage,changed.key,external);
  surface.dispatchEvent(Object.assign(new Event('storage'),{key:changed.key,storageArea:storage}));
  assert.equal(notifications,4);assert.equal(getCatalogChanges(site).pendingCount,1);
  unsubscribe();surface.dispatchEvent(new CustomEvent(CATALOG_CHANGES_EVENT,{detail:{key:changed.key}}));assert.equal(notifications,4);
});
