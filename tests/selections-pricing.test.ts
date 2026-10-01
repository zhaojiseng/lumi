import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,readFile,writeFile} from 'node:fs/promises';
import path from 'node:path';
import {compilePrice,publishedPriceSections,pricingChoices,defaultPricingChoice,defaultPricingModel} from '../shared/pricing';
import {sortModels,defaultModelGroup} from '../shared/catalog';
import {SettingsStore} from '../electron/services/store';
import {selectionValue,modelSelectionKey,normalizeSelections} from '../shared/selections';
import {DEFAULT_PREFERENCES,type ModelInfo,type DashboardQuery} from '../shared/types';
const status={system_name:'Fixture',quota_per_unit:500000};
const model:ModelInfo={model_name:'gpt-6-luna',quota_type:0,model_ratio:1,model_price:0,completion_ratio:1,enable_groups:['standard','premium'],supported_endpoint_types:[],billing_mode:'tiered_expr'};
const condition='((((weekday("Asia/Shanghai") == 0) 或 (weekday("Asia/Shanghai") == 6)) 或 ((hour("Asia/Shanghai") ≥ 9) 且 (hour("Asia/Shanghai") < 12))) 或 ((hour("Asia/Shanghai") ≥ 14) 且 (hour("Asia/Shanghai") < 18)))';
const formula='(len <= 272000 ? tier("0_272k", p*.1+c*.5+cr*.02+cc*.125) : tier("272k_plus",p*.2+c*.75+cr*.04+cc*.25)) * ('+condition+' ? 2 : 1)';

test('Chinese logical operators and Unicode comparisons are parsed only as operators, preserving quoted strings',()=>{
  assert.doesNotThrow(()=>compilePrice(condition));
  assert.doesNotThrow(()=>compilePrice('非 (weekday("Asia/Shanghai") ≠ 0) 或 hour("Asia/Shanghai") ≤ 18'));
  const sections=publishedPriceSections({...model,billing_expr:'tier("或且≥",p*.1)'},status);
  assert.equal(sections[0].label,'或且≥');assert.equal(sections[0].rows[0].usd,.1);
  assert.throws(()=>compilePrice('hour("Asia/Shanghai") ≥ globalThis.fetch("evil")'));
});
test('weekend and split office-hour multipliers follow Shanghai weekday and inclusive/exclusive boundaries',()=>{
  const cases:[string,boolean][]=[
    ['2026-10-02T00:59:59Z',false],['2026-10-02T01:00:00Z',true],['2026-10-02T03:59:59Z',true],['2026-10-02T04:00:00Z',false],
    ['2026-10-02T05:59:59Z',false],['2026-10-02T06:00:00Z',true],['2026-10-02T09:59:59Z',true],['2026-10-02T10:00:00Z',false],
    ['2026-10-02T15:59:59Z',false],['2026-10-02T16:00:00Z',true],['2026-10-04T15:59:59Z',true],['2026-10-04T16:00:00Z',false],
  ];
  for(const [at,high] of cases){
    const choices=pricingChoices({...model,billing_expr:formula},status,new Date(at));
    assert.deepEqual(choices.map(c=>c.label),['≤ 272K','> 272K'],at);
    assert.deepEqual(choices[0].section?.rows.map(r=>r.usd),high ? [.2,1,.04,.25] : [.1,.5,.02,.125],at);
    assert.equal(choices[0].timeRates.find(r=>r.current)?.multiplier,high ? 2 : 1,at);
    assert.match(choices[0].timeRates[0].condition,/上海时间.*周末.*09:00–12:00.*14:00–18:00/);
  }
});
test('default price is the short context at the current time; button keys stay stable when the schedule changes',()=>{
  const timed={...model,billing_expr:formula};
  const day=pricingChoices(timed,status,new Date('2026-10-02T02:00:00Z')),night=pricingChoices(timed,status,new Date('2026-10-02T12:00:00Z'));
  assert.equal(defaultPricingChoice(day)?.label,'≤ 272K');assert.deepEqual(day.map(c=>c.key),night.map(c=>c.key));
  assert.equal(night.find(c=>c.key===day[1].key)?.section?.rows[0].usd,.2);
  const sources=pricingChoices({...timed,billing_plugin_variants:[{plugin_key:'other',plugin_name:'另一规则',billing_expr:'p*3+c*15'}]},status);
  assert.equal(new Set(sources.map(c=>c.key)).size,3);assert.equal(sources[2].sourceName,'另一规则');
  assert.equal(defaultPricingModel({...timed,billing_plugin_variants:[{plugin_key:'other',plugin_name:'另一规则',billing_expr:'p*9'}]}).billing_expr,formula);
  assert.equal(pricingChoices({...model,billing_expr:'p*len'},status)[0].section,undefined);
});
test('all model lists sort by natural name with favorites pinned without mutating the source',()=>{
  const names=['gpt-10','claude-z','gpt-2','alpha'],models=names.map(model_name=>({...model,model_name}));
  assert.deepEqual(sortModels(models).map(m=>m.model_name),['alpha','claude-z','gpt-2','gpt-10']);
  assert.deepEqual(sortModels(models,['gpt-10','gpt-2']).map(m=>m.model_name),['gpt-2','gpt-10','alpha','claude-z']);
  assert.deepEqual(models.map(m=>m.model_name),names);
  const catalog={models,groupRatio:{standard:1,premium:.5},usableGroups:{standard:'标准',premium:'优选'},autoGroups:[],vendors:[]};
  assert.equal(defaultModelGroup(model,catalog),'premium');assert.equal(defaultModelGroup(model,catalog,'standard'),'standard');
});
test('site selections merge concurrent unrelated updates, survive reload, support custom dates and migrate old settings',async()=>{
  const root=await mkdtemp(path.resolve('.test-data/selections-')),cipher={available:()=>true,encrypt:(s:string)=>s,decrypt:(s:string)=>s};
  await writeFile(path.join(root,'settings.json'),JSON.stringify({preferences:{...DEFAULT_PREFERENCES,viewSelections:undefined}}));
  const store=new SettingsStore(root,cipher);await store.load();assert.deepEqual(store.preferences.viewSelections,{});
  const siteId=store.activeSite().id,key=modelSelectionKey('gpt/6-luna','group');
  await Promise.all([
    store.update({selection:{siteId,values:{'overview.range':1,[key]:'standard'}}}),
    store.update({selection:{siteId,values:{'codex.context':1000000,'usage.tab':'logs'}}}),
  ]);
  const reload=new SettingsStore(root,cipher);await reload.load();
  assert.equal(selectionValue(reload.preferences,'overview.range',7),1);assert.equal(selectionValue(reload.preferences,key,''),'standard');
  assert.equal(selectionValue(reload.preferences,'codex.context',272000),1000000);assert.equal(selectionValue(reload.preferences,'usage.tab','billing'),'logs');
  const range={startDate:'2026-09-01',endDate:'2026-09-02'};await reload.update({selection:{siteId,values:{'overview.range':range}}});
  assert.deepEqual(selectionValue<import('../shared/types').RangeQuery>(reload.preferences,'overview.range',7,v=>typeof v==='object'),range);
  const other=await reload.saveSite({name:'Other',url:'https://other.invalid',allowHttp:false});
  assert.equal(selectionValue(other,key,''),'');await reload.update({selection:{siteId:other.activeSiteId,values:{[key]:'premium'}}});
  await reload.update({activeSiteId:siteId});assert.equal(selectionValue(reload.preferences,key,''),'standard');
  const raw=JSON.parse(await readFile(path.join(root,'settings.json'),'utf8'));assert.ok(!('selection' in raw.preferences));
  await assert.rejects(reload.update({selection:{siteId:'missing',values:{a:1}}}),/站点/);
  assert.deepEqual(normalizeSelections(JSON.parse('{"__proto__":{"x":1},"valid":{"constructor":1,"x":"yes"}}')),{valid:{x:'yes'}});
});
