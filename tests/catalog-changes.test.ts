import test from 'node:test';
import assert from 'node:assert/strict';
import {
  CATALOG_CHANGES_KEY,CATALOG_CHANGES_EVENT,acknowledgeCatalogChanges,advanceCatalogChanges,catalogChangesStorageKey,
  createCatalogSnapshot,diffCatalogSnapshots,getCatalogChanges,markCatalogChangesRead,observeCatalogChanges,
  readCatalogChanges,subscribeCatalogChanges,writeCatalogChanges,type CatalogChange,type CatalogChangeStorage,
} from '../shared/catalog-changes';
import {pricingChoices} from '../shared/pricing';
import {publicModelPricing} from '../shared/catalog-change-details';
import type {ModelCatalog,ModelInfo,SiteStatus} from '../shared/types';

const status:SiteStatus={system_name:'Fixture',quota_per_unit:500000};
const model:ModelInfo={model_name:'model-1',quota_type:0,model_ratio:1,model_price:0,completion_ratio:2,
  enable_groups:['standard','premium'],supported_endpoint_types:[],cache_ratio:.1,create_cache_ratio:1.25};
function catalog(models:ModelInfo[]=[model]):ModelCatalog {
  return {models,groupRatio:{standard:1,premium:.5},usableGroups:{standard:'标准',premium:'优选'},autoGroups:['standard','premium'],vendors:[]};
}
function snapshot(models:ModelInfo[]=[model]) {return createCatalogSnapshot(catalog(models),status);}
function summary(changes:CatalogChange[]) {return changes.map(({details,detailsHash,...change})=>change);}
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
    assert.deepEqual(summary(changes),[{kind:'pricing',modelName:model.model_name,fields:[field]}],field);
    assert.ok(changes[0].details?.length,field+' has readable details');
  }
  const plugin={...model,billing_plugin_variants:updates.billing_plugin_variants};
  assert.deepEqual(diffCatalogSnapshots(snapshot([plugin]),snapshot([{...plugin,billing_plugin_variants:[{plugin_key:'v1',plugin_name:'展示名称',billing_expr:'fixed(.3)'}]}]))[0].fields,['billing_plugin_variants']);
});

test('groupRatio, route membership, quota units and effective currency settings produce site changes',()=>{
  const original=catalog(),baseline=createCatalogSnapshot(original,status);
  for(const [field,value] of Object.entries({groupRatio:{standard:2,premium:.5},usableGroups:{standard:'标准'},autoGroups:['premium']})) {
    assert.deepEqual(summary(diffCatalogSnapshots(baseline,createCatalogSnapshot({...original,[field]:value},status))),[{kind:'catalog',fields:[field]}]);
  }
  assert.deepEqual(summary(diffCatalogSnapshots(baseline,createCatalogSnapshot(original,{...status,quota_per_unit:1000000}))),[{kind:'catalog',fields:['quota_per_unit']}]);
  assert.deepEqual(summary(diffCatalogSnapshots(baseline,createCatalogSnapshot(original,{...status,quota_display_type:'CNY',usd_exchange_rate:7}))),[{kind:'catalog',fields:['currency']}]);
  const custom={...status,quota_display_type:'CUSTOM',custom_currency_symbol:'积分',custom_currency_exchange_rate:2};
  assert.deepEqual(summary(diffCatalogSnapshots(createCatalogSnapshot(original,custom),createCatalogSnapshot(original,{...custom,custom_currency_symbol:'点数'}))),[{kind:'catalog',fields:['currency']}]);
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
  assert.deepEqual(summary(updated.events[0].changes),[{kind:'pricing',modelName:model.model_name,fields:['billing_expr']}]);
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

test('only bounded public pricing and concise diffs are persisted; arbitrary sensitive data is dropped',()=>{
  const storage=new MemoryStorage(),secret='fixture-sensitive-value-do-not-store',site={id:'privacy',url:'https://user:'+secret+'@fixture.invalid/?token='+secret};
  const privateModel={...model,access_token:secret,api_key:secret,description:secret,billing_expr:'p*2 /* '+secret+' */',
    billing_plugin_variants:[{plugin_key:'v1',plugin_name:secret,billing_expr:'p*3',accessToken:secret}]};
  const initial=observeCatalogChanges(site,catalog([privateModel]),{...status,token:secret},{storage});
  const changed=observeCatalogChanges(site,catalog([{...privateModel,billing_expr:'p*4 /* '+secret+' */'}]),status,{storage});
  assert.equal(changed.pendingCount,1);
  const poisoned={...changed.state!,token:secret,baseline:{...changed.state!.baseline,apiKey:secret},events:changed.state!.events.map(e=>({...e,rawRule:secret}))};
  assert.equal(writeCatalogChanges(storage,initial.key,poisoned),true);
  const text=storage.values.get(initial.key)!;
  assert.ok(!text.includes(secret));assert.ok(text.includes('p * 4'));assert.ok(!initial.key.includes(secret));assert.ok(!initial.key.includes('fixture.invalid'));
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

test('legacy input/output/cache prices and effective channel multipliers preserve both published values',()=>{
  const changes=diffCatalogSnapshots(snapshot(),snapshot([{...model,model_ratio:2,completion_ratio:3,group_ratio:{standard:2}}]),1000);
  const details=changes[0].details!;
  for(const [label,before,after] of [['输入价格','$2 / 1M Tokens','$4 / 1M Tokens'],['输出价格','$4 / 1M Tokens','$12 / 1M Tokens'],['缓存读取价格','$0.2 / 1M Tokens','$0.4 / 1M Tokens'],['缓存写入价格','$2.5 / 1M Tokens','$5 / 1M Tokens'],['模型渠道「standard」倍率','×1（沿用站点）','×2']]) {
    const detail=details.find(d=>d.label===label)!;
    assert.equal(detail.before,before,label);assert.equal(detail.after,after,label);
  }
  const site=diffCatalogSnapshots(snapshot(),createCatalogSnapshot({...catalog(),groupRatio:{standard:2,premium:.5}},status),1000)[0].details!;
  assert.equal(site[0].before,'×1');assert.equal(site[0].after,'×2');
  const perCall={...model,quota_type:1,model_price:.02};
  const call=diffCatalogSnapshots(snapshot([perCall]),snapshot([{...perCall,model_price:.03}]),1000)[0].details!.find(d=>d.label==='每次调用价格')!;
  assert.equal(call.before,'$0.02 / 次');assert.equal(call.after,'$0.03 / 次');
});

test('272K branches use the restricted parser to report all token tiers and threshold changes',()=>{
  const expression='tier("rate",p*(len<=272000 ? 1.2/2 : 1.2)+c*(len<=272000 ? 4+2 : 12)+cr*(len<=272000 ? .06 : .12))';
  const old={...model,billing_mode:'tiered_expr',billing_expr:expression};
  const next={...old,billing_expr:expression.replace('1.2/2','1.6/2').replace(': 1.2',': 1.6').replace('4+2','4+4').replace(': 12',': 16').replace('.06 : .12','.08 : .16')};
  const details=diffCatalogSnapshots(snapshot([old]),snapshot([next]),1000)[0].details!;
  assert.deepEqual(details.filter(d=>d.label.endsWith('普通输入价格')).map(d=>[d.label,d.before,d.after]),[
    ['≤ 272K · 普通输入价格','$0.6 / 1M Tokens','$0.8 / 1M Tokens'],['> 272K · 普通输入价格','$1.2 / 1M Tokens','$1.6 / 1M Tokens'],
  ]);
  assert.equal(details.filter(d=>d.label.endsWith('缓存读取价格')).length,2);
  assert.ok(!details.some(d=>d.formula),'linear tiers should not require expanded formulas');
  const conditions=diffCatalogSnapshots(snapshot([old]),snapshot([{...old,billing_expr:expression.replaceAll('272000','128000')}]),1000)[0].details!;
  assert.ok(conditions.some(d=>d.before==='≤ 272K' && d.after==='≤ 128K'));
  assert.ok(conditions.some(d=>d.before==='> 272K' && d.after==='> 128K'));
});

test('time coefficients are compared at the same detection instant, including inactive rules',()=>{
  const old={...model,billing_mode:'tiered_expr',billing_expr:'p*2*(hour("Asia/Shanghai") >= 9 && hour("Asia/Shanghai") < 18 ? 2 : 1)'};
  const next={...old,billing_expr:old.billing_expr.replace('? 2 : 1','? 3 : 1')};
  const daytime=Date.parse('2026-10-02T02:00:00Z'),night=Date.parse('2026-10-02T12:00:00Z');
  const day=diffCatalogSnapshots(snapshot([old]),snapshot([next]),daytime)[0].details!;
  const input=day.find(d=>d.label==='普通输入价格')!;
  assert.equal(input.before,'$4 / 1M Tokens');assert.equal(input.after,'$6 / 1M Tokens');
  const offHours=diffCatalogSnapshots(snapshot([old]),snapshot([next]),night)[0].details!;
  assert.ok(!offHours.some(d=>d.label==='普通输入价格'),'do not compare the old daytime price to the new nighttime price');
  const rule=offHours.find(d=>d.label==='时间规则')!;
  assert.equal(rule.before,'上海时间：09:00–18:00 ×2');assert.equal(rule.after,'上海时间：09:00–18:00 ×3');
  const initial=advanceCatalogChanges(null,snapshot([old]),daytime);
  assert.strictEqual(advanceCatalogChanges(initial,snapshot([old]),night),initial,'clock movement never changes rule fingerprints');
  const body={...old,billing_expr:'hour("Asia/Shanghai") >= 9 ? p*2 : p*3'};
  const complex=diffCatalogSnapshots(snapshot([body]),snapshot([{...body,billing_expr:'hour("Asia/Shanghai") >= 9 ? p*4 : p*5'}]),daytime)[0].details!;
  assert.ok(complex.some(d=>d.formula),'non-literal time branches retain their complete readable rule');
});

test('plugin prices are matched by public keys and nonlinear plugins retain their own readable formula',()=>{
  const old={...model,billing_mode:'tiered_expr',billing_plugin_variants:[
    {plugin_key:'fast',plugin_name:'Fast display name',billing_expr:'fixed(.1)'},
    {plugin_key:'custom',plugin_name:'Private display metadata',billing_expr:'p*p*2'},
  ]};
  const next={...old,billing_plugin_variants:[
    {plugin_key:'custom',plugin_name:'Renamed metadata',billing_expr:'p*p*3'},
    {plugin_key:'fast',plugin_name:'Fast renamed',billing_expr:'fixed(.2)'},
  ]};
  const details=diffCatalogSnapshots(snapshot([old]),snapshot([next]),1000)[0].details!;
  const call=details.find(d=>d.label==='插件「fast」 · 每次调用价格')!;
  assert.equal(call.before,'$0.1 / 次');assert.equal(call.after,'$0.2 / 次');
  const formula=details.find(d=>d.label==='插件「custom」公式')!.formula!;
  assert.match(formula.before!,/输入 Tokens.*× 2/);assert.match(formula.after!,/输入 Tokens.*× 3/);
  assert.ok(!JSON.stringify(details).includes('Private display metadata'));
});

test('nonlinear, schema-based, unsupported and overlong rules never invent a fixed unit price',()=>{
  const old={...model,billing_mode:'tiered_expr',billing_expr:'p*p*2'};
  const nonlinear=diffCatalogSnapshots(snapshot([old]),snapshot([{...old,billing_expr:'p*p*3'}]),1000)[0].details!;
  assert.ok(nonlinear.every(d=>!d.label.endsWith('价格')));
  assert.match(nonlinear[0].formula!.before!,/输入 Tokens/);assert.match(nonlinear[0].formula!.after!,/× 3/);
  const usage:ModelInfo={...old,billing_expr:'u("seconds")*2',billing_usage_schema:{seconds:{type:'number',unit:'seconds'}}};
  const changed=diffCatalogSnapshots(snapshot([usage]),snapshot([{...usage,billing_expr:'u("seconds")*3',billing_usage_schema:{seconds:{type:'number',unit:'minutes'}}}]),1000)[0].details!;
  assert.ok(changed.some(d=>d.formula?.after?.includes('用量(「seconds」)')));
  assert.ok(changed.some(d=>d.before==='类型 number；单位 seconds' && d.after==='类型 number；单位 minutes'));
  const bad={...old,billing_expr:'vendorPrice(p,2)'};
  const unsupported=diffCatalogSnapshots(snapshot([bad]),snapshot([{...bad,billing_expr:'vendorPrice(p,3)'}]),1000)[0].details!;
  assert.ok(unsupported.some(d=>d.formula?.before?.includes('无法通过受限解析')));
  assert.ok(!JSON.stringify(snapshot([bad])).includes('vendorPrice'));
  const long={...old,billing_expr:'p*2+'+'p+'.repeat(16000)+'0'};
  const limited=diffCatalogSnapshots(snapshot([long]),snapshot([{...long,billing_expr:long.billing_expr.replace('p*2','p*3')}]),1000)[0].details!;
  assert.ok(limited.some(d=>d.formula?.after?.includes('长度上限')));
  assert.ok(JSON.stringify(snapshot([long])).length<5000);
});

test('v1 upgrades stay quiet only for unchanged hashes and preserve confirmed changes without inventing old values',()=>{
  const old=advanceCatalogChanges(advanceCatalogChanges(null,snapshot(),1000),snapshot([{...model,model_ratio:2}]),2000);
  const {pricing,pricingHash,...base}=old.baseline;
  const legacy={...old,version:1 as const,baseline:{...base,models:base.models.map(({pricing,pricingHash,...m})=>m)},events:old.events.map(e=>({...e,changes:summary(e.changes)}))};
  const storage=new MemoryStorage(),key='v1-upgrade';
  assert.equal(writeCatalogChanges(storage,key,legacy),true);
  const loaded=readCatalogChanges(storage,key)!;assert.equal(loaded.version,1);
  const quiet=advanceCatalogChanges(loaded,snapshot([{...model,model_ratio:2}]),3000);
  assert.equal(quiet.version,2);assert.equal(quiet.revision,old.revision);assert.deepEqual(quiet.events,loaded.events);
  assert.ok(quiet.baseline.models[0].pricing);
  const upgraded=advanceCatalogChanges(loaded,snapshot([{...model,model_ratio:9}]),3000);
  assert.equal(upgraded.version,2);assert.equal(upgraded.revision,old.revision+1);
  assert.equal(upgraded.events.length,loaded.events.length+1);
  assert.deepEqual(upgraded.events[0].changes,[{kind:'pricing',modelName:model.model_name,fields:['model_ratio']}]);
  assert.deepEqual(upgraded.events.slice(1),loaded.events);
  assert.equal(upgraded.events[0].read,false);assert.equal(upgraded.events[0].changes[0].details,undefined);
  assert.equal(writeCatalogChanges(storage,key,upgraded),true);
  const next=advanceCatalogChanges(readCatalogChanges(storage,key),snapshot([{...model,model_ratio:10}]),4000);
  const price=next.events[0].changes[0].details!.find(d=>d.label==='输入价格')!;
  assert.equal(price.before,'$18 / 1M Tokens');assert.equal(price.after,'$20 / 1M Tokens');
});

test('public values and event detail checksums reject corruption and whitelist nested persisted properties',()=>{
  const storage=new MemoryStorage(),key='public-corruption';
  const state=advanceCatalogChanges(advanceCatalogChanges(null,snapshot(),1000),snapshot([{...model,model_ratio:2}]),2000);
  const baseline=structuredClone(state);
  baseline.baseline.models[0].pricing!.numbers.model_ratio=999;
  const event=structuredClone(state);event.events[0].changes[0].details![0].before='forged';
  const oversized=structuredClone(state);oversized.events[0].changes[0].details![0].label='x'.repeat(241);
  for(const damaged of [baseline,event,oversized]){storage.values.set(key,JSON.stringify(damaged));assert.equal(readCatalogChanges(storage,key),null);}
  const poisoned=structuredClone(state) as any;
  poisoned.baseline.pricing.account='do-not-store';poisoned.baseline.models[0].pricing.apiKey='do-not-store';
  poisoned.events[0].changes[0].details[0].token='do-not-store';
  assert.equal(writeCatalogChanges(storage,key,poisoned),true);
  assert.ok(!storage.values.get(key)!.includes('do-not-store'));assert.deepEqual(readCatalogChanges(storage,key),state);
  const injected={...model,billing_expr:'p*2*(header("Authorization") has "Bearer secret" ? 2 : 1)',billing_mode:'tiered_expr'};
  const publicData=publicModelPricing(injected);
  assert.equal(publicData.expression.state,'unsupported');assert.ok(!JSON.stringify(publicData).includes('Bearer'));
});

test('UTF-8 storage budget and detail caps apply even when character counts are small',()=>{
  const storage=new MemoryStorage(),key='byte-budget';
  storage.values.set(key,'界'.repeat(3*1024*1024));assert.equal(readCatalogChanges(storage,key),null);
  const models=Array.from({length:4000},(_,i)=>({...model,model_name:'界'.repeat(470)+'-'+i}));
  const state=advanceCatalogChanges(null,snapshot(models),1000),raw=JSON.stringify(state);
  assert.ok(raw.length<8*1024*1024);assert.ok(new TextEncoder().encode(raw).byteLength>8*1024*1024);
  assert.equal(writeCatalogChanges(storage,key,state),false);
  const many={...model,billing_mode:'tiered_expr',billing_expr:'p*2',billing_plugin_variants:Array.from({length:20},(_,i)=>({plugin_key:'v'+i,plugin_name:'v'+i,billing_expr:'p*2'}))};
  const pricing=publicModelPricing(many);assert.equal(pricing.variants.length,12);assert.equal(pricing.limited,true);
  const rates='p+c+cr+cc+cc1h+img+img_cr+img_o+ai+ao';
  const original={...model,billing_mode:'tiered_expr',billing_plugin_variants:Array.from({length:12},(_,i)=>({plugin_key:'v'+i,plugin_name:'v'+i,billing_expr:rates}))};
  const next={...original,billing_plugin_variants:original.billing_plugin_variants.map(v=>({...v,billing_expr:'('+rates+')*2'}))};
  const details=diffCatalogSnapshots(snapshot([original]),snapshot([next]),1000)[0].details!;
  assert.equal(details.length,96);assert.equal(details.at(-1)!.label,'更多变化');
});

test('gpt-6-luna p*.1 to p*.15 and cr*.02 to cr*.03 retain readable prices without conflating model and site ratios',()=>{
  const old={...model,model_name:'gpt-6-luna',billing_mode:'tiered_expr',billing_expr:'p*.1+cr*.02',group_ratio:{standard:.75}};
  const next={...old,billing_expr:'p*.15+cr*.03',group_ratio:{standard:1.5}};
  const changes=diffCatalogSnapshots(snapshot([old]),snapshot([next]),Date.parse('2026-10-02T02:00:00Z'));
  const details=changes[0].details!;
  const input=details.find(d=>d.label==='普通输入价格')!,cache=details.find(d=>d.label==='缓存读取价格')!;
  assert.equal(input.before,'$0.1 / 1M Tokens');assert.equal(input.after,'$0.15 / 1M Tokens');
  assert.equal(cache.before,'$0.02 / 1M Tokens');assert.equal(cache.after,'$0.03 / 1M Tokens');
  const route=details.find(d=>d.label==='模型渠道「standard」倍率')!;
  assert.equal(route.before,'×0.75');assert.equal(route.after,'×1.5');
  assert.ok(!details.some(d=>d.label.startsWith('站点渠道')));
  assert.equal(changes.length,1);assert.deepEqual(catalog([old]).groupRatio,catalog([next]).groupRatio);
  const storage=new MemoryStorage(),key='gpt-6-luna-readable';
  const state=advanceCatalogChanges(advanceCatalogChanges(null,snapshot([old]),1000),snapshot([next]),2000);
  assert.equal(writeCatalogChanges(storage,key,state),true);
  assert.deepEqual(readCatalogChanges(storage,key)!.events[0].changes[0].details,details);
});
