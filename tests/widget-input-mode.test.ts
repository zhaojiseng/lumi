import test,{type TestContext} from 'node:test';
import assert from 'node:assert/strict';
import {appendFile,mkdir,mkdtemp,rm,utimes,writeFile} from 'node:fs/promises';
import path from 'node:path';
import {formattedWidget,previousMinute,widgetMinute,type WidgetModel,type WidgetModelUsage,type WidgetState,type WidgetUsage} from '../shared/widget';
import {usageQuota,type UsagePriceFacts} from '../shared/usage-pricing';
import type {ModelInfo,SiteStatus,UsageLog,WidgetInputMode} from '../shared/types';
import {LocalUsageService} from '../electron/services/local-usage';
import {combineLocalWidget,localWidgetPricing,type WidgetPricingContext} from '../electron/services/local-widget-pricing';

const now=Date.parse('2026-10-02T04:34:30Z'),window=previousMinute(now),status:SiteStatus={system_name:'Widget input fixture',quota_per_unit:500000};
const view={enabled:true,viewKey:'isolated-widget-account',theme:'light' as const};
const rule='p*3+c*15+cr*.3+cc*3.75';
const pricedModel=(name:string,billing_expr=rule):ModelInfo=>({model_name:name,quota_type:0,model_ratio:1,model_price:0,completion_ratio:1,
  billing_mode:'tiered_expr',billing_expr,enable_groups:['standard'],supported_endpoint_types:[]});
function pricing(billing_expr=rule):WidgetPricingContext {
  return {siteId:'fixture-site',siteName:'Fixture site',status,balance:5000000,loggedIn:true,userGroup:'standard',
    catalog:{models:[pricedModel('codex-priced',billing_expr),pricedModel('claude-priced',billing_expr)],groupRatio:{standard:1},usableGroups:{standard:'Standard'},autoGroups:[],vendors:[]}};
}
const priceFacts=(createdAt:number):UsagePriceFacts=>({inputTokens:800,outputTokens:120,cacheReadTokens:200,cacheWriteTokens:30,contextTokens:1030,createdAt,requests:1});
function row(id:number,name:string,patch:Partial<UsageLog>={}):UsageLog {
  const recorded=priceFacts(window.start_timestamp+id*10),quota=usageQuota(pricedModel(name),status,recorded,1);assert.notEqual(quota,null);
  return {id,created_at:recorded.createdAt,type:2,model_name:name,token_name:'isolated',prompt_tokens:1000,completion_tokens:120,
    quota:quota!,use_time:2,is_stream:false,group:'standard',other:JSON.stringify({cache_tokens:200,cache_creation_tokens:30}),...patch};
}
function apiUsage(rows=[row(1,'codex-priced'),row(2,'claude-priced')]):WidgetUsage {
  return {siteId:'fixture-site',siteName:'Fixture site',status,balance:5000000,loggedIn:true,minute:widgetMinute(rows,window.start_timestamp),
    source:'api',historical:false,fetchedAt:now,warnings:[]};
}
const render=(data:WidgetUsage,inputMode?:WidgetInputMode)=>formattedWidget('ready',data,{...view,...(inputMode ? {inputMode} : {})});
const nonInputModel=(model:WidgetModel)=>({name:model.name,cost:model.cost,requests:model.requests,output:model.output,cacheRead:model.cacheRead,cacheWrite:model.cacheWrite});
const billingDisplay=(state:WidgetState)=>({cost:state.cost,balance:state.balance,models:state.models.map(nonInputModel),latestModel:state.latestModel && nonInputModel(state.latestModel)});
function oneModel(source:'api'|'local',patch:Partial<WidgetModelUsage>={}):WidgetUsage {
  const model:WidgetModelUsage={name:'fixture',quota:2186.25,requests:1,inputTokens:1000,outputTokens:120,cacheReadTokens:200,cacheWriteTokens:30,...patch};
  return {...apiUsage(),source,minute:{start:window.start_timestamp,end:window.end_timestamp,quota:model.quota,quotaKnown:model.quotaKnown,requests:1,models:[model],latestModel:{...model}}};
}
function close(actual:number,expected:number){assert.ok(Math.abs(actual-expected)<1e-8,`expected ${expected}, got ${actual}`);}

test('total is the default and uncached subtracts reads for every API model and the latest call without changing recorded bills',()=>{
  const data=apiUsage(),before=structuredClone(data),total=render(data,'total'),uncached=render(data,'uncached'),implicit=render(data);
  assert.equal(total.models.length,2);assert.ok(total.models.every(model=>model.input==='1.0K'));
  assert.ok(uncached.models.every(model=>model.input==='800'));assert.equal(total.latestModel?.input,'1.0K');assert.equal(uncached.latestModel?.input,'800');
  assert.deepEqual(implicit.models,total.models);assert.deepEqual(implicit.latestModel,total.latestModel);
  assert.deepEqual(billingDisplay(total),billingDisplay(uncached));assert.equal(total.cost,'$0.0087');assert.equal(total.balance,'$10.00');
  assert.notEqual(total.dataKey,uncached.dataKey,'the display change must have its own refresh identity');assert.deepEqual(data,before);
});

test('API cache creation is neither added to total input nor subtracted from uncached input',()=>{
  for(const cache_creation_tokens of [0,30,5000]){
    const data=apiUsage([row(1,'codex-priced',{other:JSON.stringify({cache_tokens:200,cache_creation_tokens})})]);
    assert.equal(data.minute?.models[0].inputTokens,1000);assert.equal(data.minute?.models[0].cacheWriteTokens,cache_creation_tokens);
    assert.equal(render(data,'total').models[0].input,'1.0K');assert.equal(render(data,'uncached').models[0].input,'800');
    assert.deepEqual(billingDisplay(render(data,'total')),billingDisplay(render(data,'uncached')));
  }
});

test('unknown input or cache reads remain unknown, while missing write counts do not affect input display',()=>{
  for(const source of ['api','local'] as const){
    const unknownRead=oneModel(source,{cacheReadTokens:null});
    assert.equal(render(unknownRead,'total').models[0].input,'1.0K');assert.equal(render(unknownRead,'uncached').models[0].input,'—');
    assert.equal(render(unknownRead,'uncached').latestModel?.input,'—');
    for(const inputMode of ['total','uncached'] as const){
      const unknownInput=render(oneModel(source,{inputTokens:null}),inputMode);
      assert.equal(unknownInput.models[0].input,'—');assert.equal(unknownInput.latestModel?.input,'—');
    }
    const unknownWrite=oneModel(source,{cacheWriteTokens:null});
    assert.equal(render(unknownWrite,'total').models[0].input,'1.0K');assert.equal(render(unknownWrite,'uncached').models[0].input,'800');
    assert.deepEqual(billingDisplay(render(unknownWrite,'total')),billingDisplay(render(unknownWrite,'uncached')));
  }
});

test('uncached display clamps an over-reported read count to zero and preserves known free consumption',()=>{
  for(const source of ['api','local'] as const){
    const data=oneModel(source,{inputTokens:100,cacheReadTokens:120,cacheWriteTokens:9000,quota:0,quotaKnown:true});
    assert.equal(render(data,'total').models[0].input,'100');assert.equal(render(data,'uncached').models[0].input,'0');
    for(const inputMode of ['total','uncached'] as const){const displayed=render(data,inputMode);assert.equal(displayed.cost,'$0.00');assert.equal(displayed.latestModel?.cost,'$0.00');}
  }
});

test('unknown model/range quotes stay unknown in both input modes instead of displaying stored partial zeroes',()=>{
  for(const source of ['api','local'] as const){
    const data=oneModel(source,{quota:0,quotaKnown:false});
    for(const inputMode of ['total','uncached'] as const){
      const displayed=render(data,inputMode);assert.equal(displayed.cost,'—');assert.equal(displayed.models[0].cost,'—');assert.equal(displayed.latestModel?.cost,'—');
      assert.equal(displayed.models[0].input,inputMode==='total' ? '1.0K' : '800');assert.equal(displayed.balance,'$10.00');
    }
  }
});

async function localFixture(t:TestContext,ctx=pricing()){
  const parent=path.resolve('.test-data');await mkdir(parent,{recursive:true});const home=await mkdtemp(path.join(parent,'widget-input-mode-'));
  t.after(async()=>{assert.equal(path.dirname(home),parent);await rm(home,{recursive:true,force:true});});
  const codexFile=path.join(home,'.codex','sessions','fixture.jsonl'),claudeFile=path.join(home,'.claude','projects','fixture','fixture.jsonl');
  await mkdir(path.dirname(codexFile),{recursive:true});await mkdir(path.dirname(claudeFile),{recursive:true});
  const claude=(output=120)=>({type:'assistant',timestamp:new Date((window.start_timestamp+20)*1000).toISOString(),sessionId:'isolated-claude-session',
    message:{id:'isolated-message',model:'claude-priced',usage:{input_tokens:800,output_tokens:output,cache_read_input_tokens:200,cache_creation_input_tokens:30}}});
  await writeFile(codexFile,[{type:'session_meta',payload:{id:'isolated-codex-session'}},{type:'turn_context',payload:{model:'codex-priced'}},
    {type:'event_msg',timestamp:new Date((window.start_timestamp+10)*1000).toISOString(),payload:{type:'token_count',info:{
      total_token_usage:{input_tokens:1000,output_tokens:120,cached_input_tokens:200,cache_creation_input_tokens:30},
      last_token_usage:{input_tokens:1000,output_tokens:120,cached_input_tokens:200,cache_creation_input_tokens:30}}}}].map(event=>JSON.stringify(event)).join('\n')+'\n');
  await writeFile(claudeFile,JSON.stringify(claude())+'\n');
  await Promise.all([utimes(codexFile,new Date(now),new Date(now)),utimes(claudeFile,new Date(now),new Date(now))]);
  const quotes:{tool:string;model:string;facts:UsagePriceFacts}[]=[],options=localWidgetPricing(ctx,[]),service=new LocalUsageService(home);
  const quoted={...options,quote:(tool:'codex'|'claude',name:string,facts:UsagePriceFacts)=>{quotes.push({tool,model:name,facts:structuredClone(facts)});return options.quote!(tool,name,facts);}};
  const load=async(period:60|2592000|'latest'=60)=>combineLocalWidget(await service.widgetUsage(now,{...quoted,period}),ctx,period);
  return {service,quotes,load,ctx,appendClaude:async(output:number)=>{await appendFile(claudeFile,JSON.stringify(claude(output))+'\n');await utimes(claudeFile,new Date(now),new Date(now));}};
}

test('real Codex/Claude JSONL inputs become the same total/uncached widget counts and quotes as API calls',async(t)=>{
  const fixture=await localFixture(t),local=await fixture.load(),api=apiUsage(),before=structuredClone(local);
  assert.equal(local.minute?.requests,2);assert.equal(fixture.quotes.length,2);close(local.minute!.quota,4372.5);
  for(const quoted of fixture.quotes){assert.equal(quoted.facts.inputTokens,800);assert.equal(quoted.facts.cacheReadTokens,200);assert.equal(quoted.facts.cacheWriteTokens,30);}
  assert.ok(local.minute!.models.every(model=>model.inputTokens===1000 && model.cacheReadTokens===200 && model.cacheWriteTokens===30));
  assert.equal(local.minute?.latestModel?.name,'claude-priced');assert.equal(local.minute?.latestModel?.inputTokens,1000);
  for(const inputMode of ['total','uncached'] as const){
    const localDisplay=render(local,inputMode),apiDisplay=render(api,inputMode);
    assert.deepEqual(localDisplay.models,apiDisplay.models);assert.deepEqual(localDisplay.latestModel,apiDisplay.latestModel);
    assert.deepEqual(billingDisplay(localDisplay),billingDisplay(apiDisplay));
  }
  assert.deepEqual(billingDisplay(render(local,'total')),billingDisplay(render(local,'uncached')));assert.deepEqual(local,before);
  assert.equal(fixture.quotes.length,2,'changing display mode must not invoke pricing again');
});

test('repeated local polls and a 30-day range reuse never add cached reads a second time or recompute unchanged quotes',async(t)=>{
  const fixture=await localFixture(t),first=await fixture.load(),second=await fixture.load(),long=await fixture.load(2592000),again=await fixture.load();
  for(const data of [second,long,again]){
    assert.deepEqual(data.minute?.models,first.minute?.models);assert.deepEqual(data.minute?.latestModel,first.minute?.latestModel);
    close(data.minute!.quota,first.minute!.quota);assert.ok(render(data,'total').models.every(model=>model.input==='1.0K'));
    assert.ok(render(data,'uncached').models.every(model=>model.input==='800'));
  }
  assert.equal(fixture.quotes.length,2);
});

test('the latest local call agrees with API latest-call input and cost rather than the model aggregate',async(t)=>{
  const fixture=await localFixture(t),local=await fixture.load('latest'),api=apiUsage([row(2,'claude-priced')]);
  assert.equal(local.minute?.requests,1);assert.equal(local.minute?.models.length,1);close(local.minute!.quota,2186.25);
  for(const inputMode of ['total','uncached'] as const){
    assert.deepEqual(render(local,inputMode).models,render(api,inputMode).models);assert.deepEqual(render(local,inputMode).latestModel,render(api,inputMode).latestModel);
  }
});

test('a Claude streaming update replaces the earlier call quote and preserves total/uncached input',async(t)=>{
  const fixture=await localFixture(t);await fixture.load();await fixture.appendClaude(200);const local=await fixture.load();
  const model=local.minute!.models.find(model=>model.name==='claude-priced')!;
  assert.equal(local.minute?.requests,2);assert.equal(model.requests,1);assert.equal(model.inputTokens,1000);assert.equal(model.outputTokens,200);
  close(model.quota,2786.25);close(local.minute!.quota,4972.5);assert.equal(fixture.quotes.length,3);
  assert.equal(render(local,'total').latestModel?.input,'1.0K');assert.equal(render(local,'uncached').latestModel?.input,'800');
  assert.deepEqual(billingDisplay(render(local,'total')),billingDisplay(render(local,'uncached')));
});

test('refreshed online prices reprice local read cursors without changing their input/cache categories',async(t)=>{
  const fixture=await localFixture(t),initial=await fixture.load(),changed=pricing('p*6+c*30+cr*.6+cc*7.5'),options=localWidgetPricing(changed,[]);
  const repriced=combineLocalWidget(await fixture.service.widgetUsage(now,{...options,period:60}),changed,60);
  close(repriced.minute!.quota,initial.minute!.quota*2);
  assert.deepEqual(repriced.minute!.models.map(model=>[model.name,model.inputTokens,model.cacheReadTokens,model.cacheWriteTokens]),initial.minute!.models.map(model=>[model.name,model.inputTokens,model.cacheReadTokens,model.cacheWriteTokens]));
  assert.ok(render(repriced,'total').models.every(model=>model.input==='1.0K'));assert.ok(render(repriced,'uncached').models.every(model=>model.input==='800'));
  assert.deepEqual(billingDisplay(render(repriced,'total')),billingDisplay(render(repriced,'uncached')));
});

test('a partially unavailable local model quote keeps counts but marks the whole range cost as incomplete',async(t)=>{
  const ctx=pricing();ctx.catalog!.models=ctx.catalog!.models.filter(model=>model.model_name==='codex-priced');
  const fixture=await localFixture(t,ctx),local=await fixture.load();assert.equal(local.minute?.quotaKnown,false);
  close(local.minute!.quota,2186.25);assert.equal(local.minute?.requests,2);
  for(const inputMode of ['total','uncached'] as const){
    const displayed=render(local,inputMode);assert.equal(displayed.cost,'—');assert.equal(displayed.balance,'$10.00');
    assert.notEqual(displayed.models.find(model=>model.name==='codex-priced')?.cost,'—');assert.equal(displayed.models.find(model=>model.name==='claude-priced')?.cost,'—');
    assert.ok(displayed.models.every(model=>model.input===(inputMode==='total' ? '1.0K' : '800')));
  }
});
