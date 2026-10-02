import test,{type TestContext} from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {mkdir,mkdtemp,rm} from 'node:fs/promises';
import path from 'node:path';
import {usageQuota,type UsagePriceFacts} from '../shared/usage-pricing';
import type {ModelInfo,ModelCatalog,SiteStatus,ToolBinding} from '../shared/types';
import {localWidgetPricing,type WidgetPricingContext} from '../electron/services/local-widget-pricing';
import {SettingsStore} from '../electron/services/store';
import {NewApiClient} from '../electron/services/new-api';

const status:SiteStatus={system_name:'Isolated pricing fixture',quota_per_unit:500000};
const at=(iso:string)=>Date.parse(iso)/1000;
const model=(patch:Partial<ModelInfo>={}):ModelInfo=>({model_name:'priced-fixture',quota_type:0,model_ratio:.25,model_price:0,
  completion_ratio:4,cache_ratio:.1,create_cache_ratio:1.25,enable_groups:['standard','premium','free','unknown','auto'],supported_endpoint_types:[],...patch});
const expression=(billing_expr:string,patch:Partial<ModelInfo>={})=>model({billing_mode:'tiered_expr',billing_expr,...patch});
const facts=(patch:Partial<UsagePriceFacts>={}):UsagePriceFacts=>({inputTokens:800000,outputTokens:100000,cacheReadTokens:200000,
  cacheWriteTokens:40000,contextTokens:1040000,createdAt:at('2026-10-02T01:00:00Z'),requests:1,...patch});
const noTokens=()=>facts({inputTokens:0,outputTokens:0,cacheReadTokens:0,cacheWriteTokens:0,contextTokens:0});
function quota(actual:number|null,expected:number,label='quota'){
  assert.notEqual(actual,null,label);assert.ok(Math.abs(actual!-expected)<=Math.max(1e-8,Math.abs(expected)*1e-12),`${label}: expected ${expected}, got ${actual}`);
}
function context(priced=model()):WidgetPricingContext {
  const catalog:ModelCatalog={models:[priced],groupRatio:{standard:1,premium:.5,free:0},
    usableGroups:{standard:'Standard',premium:'Premium',free:'Free',unknown:'Unpublished',auto:'Auto',blocked:'Blocked'},autoGroups:['premium'],vendors:[]};
  return {siteId:'isolated-site',siteName:'Isolated site',status,balance:5000000,loggedIn:true,catalog,userGroup:'standard'};
}
const binding=(group:string,patch:Partial<ToolBinding>={}):ToolBinding=>({siteId:'isolated-site',tool:'codex',group,model:'',tokenName:'fixture',...patch});

test('legacy actual usage prices uncached input, output, reads and writes once in account quota units',()=>{
  const priced=model(),usage=facts(),before=structuredClone({priced,status,usage});
  // .25 quota/input; 1 quota/output; .025 quota/read; .3125 quota/write, then the .75 channel rate.
  quota(usageQuota(priced,status,usage,.75),238125);
  quota(usageQuota(priced,{...status,quota_per_unit:1000000},usage,.75),238125,'legacy quota is independent of display unit');
  assert.deepEqual({priced,status,usage},before);
});

test('legacy per-call and expression fixed rates charge a recorded call without adding token costs',()=>{
  quota(usageQuota(model({quota_type:1,model_price:.03}),status,facts(),2),30000);
  quota(usageQuota(expression('fixed((2+3)/100)'),status,facts(),.4),10000);
});

test('free prices and free channels return known zero while unavailable prices remain null',()=>{
  for(const priced of [model({model_ratio:0}),model({quota_type:1,model_price:0}),expression('fixed(0)'),expression('p*0+c*0+cr*0+cc*0')]){
    quota(usageQuota(priced,status,facts(),1),0);
  }
  quota(usageQuota(expression('p*3+c*15+cr*.3+cc*3.75'),status,facts(),0),0);
  quota(usageQuota(model({cache_ratio:undefined,create_cache_ratio:undefined}),status,noTokens(),1),0);
  assert.equal(usageQuota(model({cache_ratio:undefined}),status,facts(),1),null);
});

test('legacy missing category prices are required only when actual usage consumes that category',()=>{
  const priced=model({cache_ratio:undefined,create_cache_ratio:undefined});
  quota(usageQuota(priced,status,facts({cacheReadTokens:0,cacheWriteTokens:0}),1),300000);
  assert.equal(usageQuota(priced,status,facts({cacheWriteTokens:0}),1),null,'missing cache-read rate');
  assert.equal(usageQuota(priced,status,facts({cacheReadTokens:0}),1),null,'missing cache-write rate');
  assert.equal(usageQuota(model({model_ratio:NaN}),status,facts(),1),null,'unavailable input price');
});

test('missing multimodal/request facts and custom usage schemas never fabricate an actual quote',()=>{
  for(const rule of ['p*3+img*2','image_count*.01','p*param("rate")','header("beta") == "fast" ? p*6 : p*3','u("unknown")']){
    assert.equal(usageQuota(expression(rule),status,facts(),1),null,rule);
  }
  assert.equal(usageQuota(expression('p*3',{billing_usage_schema:{duration:{type:'number',unit:'seconds'}}}),status,facts(),1),null);
  quota(usageQuota(expression('len <= 272000 ? p*3 : img*2'),status,facts({contextTokens:272000}),1),1200000);
  assert.equal(usageQuota(expression('len <= 272000 ? p*3 : img*2'),status,facts({contextTokens:272001}),1),null);
});

test('unknown/invalid core facts, conversion units, multipliers and expression results stay unknown',()=>{
  const priced=expression('p*3+c*15+cr*.3+cc*3.75');
  for(const field of ['inputTokens','outputTokens','cacheReadTokens','cacheWriteTokens','contextTokens','createdAt'] as const){
    for(const value of [undefined,null,-1,NaN,Infinity,'10'])assert.equal(usageQuota(priced,status,{...facts(),[field]:value} as unknown as UsagePriceFacts,1),null,field+': '+String(value));
  }
  for(const quota_per_unit of [undefined,0,-1,NaN,Infinity])assert.equal(usageQuota(priced,{...status,quota_per_unit} as SiteStatus,facts(),1),null);
  for(const multiplier of [-1,NaN,Infinity])assert.equal(usageQuota(priced,status,facts(),multiplier),null);
  for(const rule of ['p/(2-2)','p*(2**9999)','-p','true','p+','unsupported(p)'])assert.equal(usageQuota(expression(rule),status,facts(),1),null,rule);
});

const tierRule='(len <= 272000 ? tier("short",p*.1+c*.5+cr*.02+cc*.125) : tier("long",p*.2+c*.75+cr*.04+cc*.25)) * (hour("Asia/Shanghai") >= 9 && hour("Asia/Shanghai") < 23 ? 2 : 1)';
test('actual 272K boundary, recorded Shanghai time and channel multiplier combine without using the wall clock',(t)=>{
  t.mock.timers.enable({apis:['Date'],now:Date.parse('2030-01-01T00:00:00Z')});
  const times:[string,number][]=[['2026-10-02T00:59:59Z',1],['2026-10-02T01:00:00Z',2],['2026-10-02T14:59:59Z',2],['2026-10-02T15:00:00Z',1]];
  for(const [iso,timeRate] of times)for(const [contextTokens,base] of [[271999,11900],[272000,11900],[272001,21300]] as const){
    const recorded=facts({inputTokens:120000,outputTokens:20000,cacheReadTokens:40000,cacheWriteTokens:8000,contextTokens,createdAt:at(iso)});
    quota(usageQuota(expression(tierRule),status,recorded,.5),base*timeRate*.5,iso+' / '+contextTokens);
  }
});

test('timezone calendar conditions follow Shanghai midnight and the repeated New York DST hour',()=>{
  const weekend=expression('fixed(.01)*(weekday("Asia/Shanghai") == 0 || weekday("Asia/Shanghai") == 6 ? 2 : 1)');
  for(const [iso,expected] of [['2026-10-02T15:59:59Z',5000],['2026-10-02T16:00:00Z',10000],['2026-10-04T15:59:59Z',10000],['2026-10-04T16:00:00Z',5000]] as const){
    quota(usageQuota(weekend,status,facts({createdAt:at(iso)}),1),expected,iso);
  }
  const dst=expression('fixed(.01)*(hour("America/New_York") == 1 ? 2 : 1)');
  for(const [iso,expected] of [['2026-11-01T05:30:00Z',10000],['2026-11-01T06:30:00Z',10000],['2026-11-01T07:30:00Z',5000]] as const){
    quota(usageQuota(dst,status,facts({createdAt:at(iso)}),1),expected,iso);
  }
});

test('explicit 5-minute and 1-hour cache creation TTLs use separate rates without charging total writes again',()=>{
  const priced=expression('p*3+c*15+cr*.3+cc*3.75+cc1h*6');
  const usage=facts({inputTokens:50000,outputTokens:10000,cacheReadTokens:20000,cacheWriteTokens:100000,
    cacheWriteShortTokens:40000,cacheWriteLongTokens:60000,contextTokens:170000});
  quota(usageQuota(priced,status,usage,1),408000);
  quota(usageQuota(priced,status,{...usage,cacheWriteShortTokens:0,cacheWriteLongTokens:100000},1),453000);
  assert.equal(usageQuota(priced,status,{...usage,cacheWriteShortTokens:100000,cacheWriteLongTokens:undefined},1),null,'required 1h count is unknown');
  quota(usageQuota(priced,status,noTokens(),1),0,'zero writes imply zero for both TTLs');
  quota(usageQuota(expression('cc*3.75'),status,facts({cacheWriteTokens:100000}),1),187500,'single write category needs no TTL split');
});

test('a formula without cc1h prices all cache creation even when the session reports both TTL counters',()=>{
  const usage={...noTokens(),cacheWriteTokens:100000,cacheWriteShortTokens:40000,cacheWriteLongTokens:60000,contextTokens:100000};
  quota(usageQuota(expression('cc*3.75'),status,usage,1),187500,'cc is the total creation category without cc1h');
});

test('a missing short TTL split is derived from total minus known 1h writes and never charges either TTL twice',()=>{
  for(const [cacheWriteLongTokens,expected] of [[100000,300000],[60000,255000]] as const){
    const actual=usageQuota(expression('cc*3.75+cc1h*6'),status,{...noTokens(),cacheWriteTokens:100000,cacheWriteLongTokens,contextTokens:100000},1);
    quota(actual,expected,'known 1h writes: '+cacheWriteLongTokens);
  }
});

test('negative optional cache TTL counters cannot produce a discounted but apparently valid quote',()=>{
  for(const field of ['cacheWriteShortTokens','cacheWriteLongTokens'] as const){
    const usage=facts({cacheWriteTokens:40000,cacheWriteShortTokens:20000,cacheWriteLongTokens:20000,[field]:-1});
    assert.equal(usageQuota(expression('p*3+cc*3.75+cc1h*6'),status,usage,1),null,field);
  }
});

test('nonfinite optional TTL counters and inconsistent creation totals remain unknown',()=>{
  const priced=expression('p*3+cc*3.75+cc1h*6'),recorded=facts({cacheWriteTokens:40000,cacheWriteShortTokens:20000,cacheWriteLongTokens:20000});
  for(const field of ['cacheWriteShortTokens','cacheWriteLongTokens'] as const){
    for(const value of [NaN,Infinity])assert.equal(usageQuota(priced,status,{...recorded,[field]:value},1),null,field+': '+value);
  }
  for(const split of [{cacheWriteShortTokens:10000,cacheWriteLongTokens:20000},{cacheWriteShortTokens:30000,cacheWriteLongTokens:20000},
    {cacheWriteShortTokens:undefined,cacheWriteLongTokens:40001}]){
    assert.equal(usageQuota(priced,status,{...recorded,...split},1),null,JSON.stringify(split));
  }
});

test('the default plugin rule is used only when the model has no primary rule and ratio mode is not active',()=>{
  const variants=[{plugin_key:'first',plugin_name:'First',billing_expr:'p*2'},{plugin_key:'second',plugin_name:'Second',billing_expr:'p*99'}];
  quota(usageQuota(model({billing_plugin_variants:variants}),status,facts(),1),800000);
  quota(usageQuota(expression('p*3',{billing_plugin_variants:variants}),status,facts(),1),1200000);
  quota(usageQuota(model({billing_mode:'ratio',billing_plugin_variants:variants}),status,facts(),1),317500);
});

test('local quoting applies only active-site bindings, model-specific channel overrides and zero-priced channels',()=>{
  const ctx=context(expression('p*2',{group_ratio:{premium:.25}})),bindings=[binding('premium'),binding('free',{tool:'claude'}),binding('standard',{siteId:'other-site'})];
  const pricing=localWidgetPricing(ctx,bindings);
  quota(pricing.quote!('codex','priced-fixture',facts()),200000,'model override precedes catalog .5');
  quota(pricing.quote!('claude','priced-fixture',facts()),0,'reachable free channel');
  quota(localWidgetPricing(ctx,[binding('premium',{siteId:'other-site'})]).quote!('codex','priced-fixture',facts()),800000,'account channel fallback');
  for(const group of ['unknown','auto','blocked'])assert.equal(localWidgetPricing(ctx,[binding(group)]).quote!('codex','priced-fixture',facts()),null,group);
  assert.equal(pricing.quote!('codex','missing-model',facts()),null);
  assert.equal(localWidgetPricing({...ctx,catalog:null},[]).quote!('codex','priced-fixture',facts()),null);
});

test('pricing revisions change for actual rates and channels but not for balance-only updates',()=>{
  const original=context(expression('p*2')),base=localWidgetPricing(original,[]);
  const changed=context(expression('p*4'));
  assert.notEqual(localWidgetPricing(changed,[]).revision,base.revision);
  assert.notEqual(localWidgetPricing(original,[binding('premium')]).revision,base.revision);
  assert.notEqual(localWidgetPricing({...original,userGroup:'premium'},[]).revision,base.revision);
  assert.equal(localWidgetPricing({...original,balance:42},[]).revision,base.revision);
  quota(base.quote!('codex','priced-fixture',facts()),800000);
  quota(localWidgetPricing(changed,[]).quote!('codex','priced-fixture',facts()),1600000);
});

async function pricingApi(t:TestContext){
  const parent=path.resolve('.test-data');await mkdir(parent,{recursive:true});const root=await mkdtemp(path.join(parent,'usage-pricing-api-'));
  let rate=2,reads=0;
  const server=createServer((req,res)=>{
    const url=new URL(req.url!,'http://127.0.0.1');res.setHeader('Content-Type','application/json');
    if(url.pathname==='/api/status')return res.end(JSON.stringify({success:true,data:status}));
    if(url.pathname==='/api/user/self')return res.end(JSON.stringify({success:true,data:{id:42,quota:5000000,group:'standard'}}));
    if(url.pathname==='/api/pricing'){reads++;return res.end(JSON.stringify({success:true,data:[expression('p*'+rate)],group_ratio:{standard:1},usable_group:{standard:'Standard'}}));}
    res.statusCode=404;res.end('{}');
  });
  t.after(async()=>{await new Promise<void>((resolve,reject)=>server.close(error=>error ? reject(error) : resolve()));assert.equal(path.dirname(root),parent);await rm(root,{recursive:true,force:true});});
  await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));
  const store=new SettingsStore(root,{available:()=>true,encrypt:s=>s,decrypt:s=>s});await store.load();
  await store.saveSite({id:store.activeSite().id,name:'Pricing fixture',url:'http://127.0.0.1:'+(server.address() as {port:number}).port,allowHttp:true,userId:42,accessToken:'fixture-account'});
  return {api:new NewApiClient(store),setRate:(next:number)=>{rate=next;},reads:()=>reads};
}

test('the online pricing cache shares concurrent reads and expires exactly after five minutes',async(t)=>{
  t.mock.timers.enable({apis:['Date'],now:Date.parse('2026-10-02T04:00:00Z')});
  const fixture=await pricingApi(t),[first,duplicate]=await Promise.all([fixture.api.widgetPricing(),fixture.api.widgetPricing()]);
  assert.equal(fixture.reads(),1);assert.deepEqual(first,duplicate);
  quota(localWidgetPricing(first,[]).quote!('codex','priced-fixture',facts()),800000);
  fixture.setRate(4);t.mock.timers.tick(299999);
  const cached=await fixture.api.widgetPricing();assert.equal(fixture.reads(),1);
  quota(localWidgetPricing(cached,[]).quote!('codex','priced-fixture',facts()),800000);
  t.mock.timers.tick(1);const refreshed=await fixture.api.widgetPricing();assert.equal(fixture.reads(),2);
  quota(localWidgetPricing(refreshed,[]).quote!('codex','priced-fixture',facts()),1600000);
  assert.notEqual(localWidgetPricing(refreshed,[]).revision,localWidgetPricing(first,[]).revision);
});
