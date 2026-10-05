import test from 'node:test';
import assert from 'node:assert/strict';
import {displayPricingChoices,publishedRequestPricing,requestPricingOptions} from '../shared/pricing';
import {requestBilling} from '../shared/request-billing';
import type {ModelInfo,UsageLog} from '../shared/types';

const status={system_name:'Fixture',quota_per_unit:500000};

test('display merges equivalent Fast/Priority aliases while retaining persisted conditions and different prices',()=>{
  const rules=[{condition:'fast',label:'Fast',multiplier:2},{condition:'priority',label:'Fast（Priority）',multiplier:2},{condition:'header',label:'Fast（fast-mode）',multiplier:6}];
  const options=requestPricingOptions(rules);
  assert.equal(options.length,2);assert.equal(options[0].label,'Fast');assert.deepEqual(options[0].conditions,['fast','priority']);
  assert.equal(options.find(option=>option.conditions.includes('priority'))?.multiplier,2);
  assert.equal(rules.length,3,'published settlement rules stay intact');
  const different=requestPricingOptions([rules[0],{...rules[1],multiplier:3}]);
  assert.deepEqual(different.map(option=>option.multiplier),[2,3],'different prices cannot be silently collapsed');
});
const base='len <= 272000 ? tier("0_272k",p*2+c*10+cr*.2+cc*2.5) : tier("272k_plus",p*4+c*15+cr*.4+cc*5)';
const expression='('+base+')|||when(param("service_tier") == "fast") * 2|||when(param("service_tier") == "priority") * 2';
const model:ModelInfo={model_name:'arbitrary-model',quota_type:0,model_ratio:1,model_price:0,completion_ratio:1,enable_groups:[],supported_endpoint_types:[],billing_mode:'tiered_expr',billing_expr:expression};
const log:UsageLog={id:1,created_at:1791187200,type:2,model_name:model.model_name,token_name:'Fixture',prompt_tokens:118158,completion_tokens:304,quota:8769,use_time:10,is_stream:true,group:'fixture'};
const snapshot=(extra:Record<string,unknown>={})=>({...log,other:JSON.stringify({billing_mode:'tiered_expr',expr_b64:Buffer.from(expression).toString('base64'),matched_tier:'0_272k',group_ratio:.3,...extra})});
const traces=[{cond:'param("service_tier") == "fast"',multiplier:2,matched:false},{cond:'param("service_tier") == "priority"',multiplier:2,matched:true}];

test('context tiers and request conditions are independent, preserving published coefficients and provider variants',()=>{
  const pricing=publishedRequestPricing(model);
  assert.deepEqual(pricing.rules.map(rule=>[rule.label,rule.multiplier]),[['Fast',2],['Fast（Priority）',2]]);
  const choices=displayPricingChoices(model,status);
  assert.deepEqual(choices.map(choice=>choice.label),['≤ 272K','> 272K']);
  assert.deepEqual(choices.map(choice=>choice.section!.rows.map(row=>row.usd)),[[2,10,.2,2.5],[4,15,.4,5]]);
  const variants=displayPricingChoices({...model,billing_expr:undefined,billing_plugin_variants:[{plugin_key:'provider',plugin_name:'Provider',billing_mode:'tiered_expr',billing_expr:expression}]},status);
  assert.equal(variants.length,2);assert.equal(variants[0].sourceKey,'plugin:provider');
});
test('actual rule traces are authoritative, preserve unmatched conditions, and never alter the recorded charge',()=>{
  const result=requestBilling(snapshot({request_rules:traces}),status);
  assert.equal(result.ratio,.3);assert.equal(result.requestMultiplier,2);
  assert.equal(result.selected?.label,'0_272k');assert.deepEqual(result.selected?.rows.map(row=>row.usd),[2,10,.2,2.5]);
  assert.deepEqual(result.rules.map(rule=>rule.matched),[false,true]);
  assert.equal(requestBilling(snapshot({request_rules:[{cond:'header("custom") == "special"',multiplier:3,matched:true}]}),status).requestMultiplier,3);
  assert.equal(snapshot().quota,8769);
});
test('unknown traces, damaged snapshots and invalid multipliers never imply a fast rate or a default group discount',()=>{
  assert.equal(requestBilling(snapshot(),status).requestMultiplier,undefined);
  assert.equal(requestBilling(snapshot({request_rules:[{...traces[0],matched:undefined}]}),status).requestMultiplier,undefined);
  assert.equal(requestBilling(snapshot({request_rules:[{cond:'bad',multiplier:-1,matched:true}]}),status).requestMultiplier,undefined);
  assert.equal(requestBilling(snapshot({request_rules:'invalid'}),status).requestMultiplier,undefined);
  assert.equal(requestBilling(snapshot({request_rules:Array(33).fill(traces[0])}),status).requestMultiplier,undefined);
  assert.equal(requestBilling(snapshot({group_ratio:undefined,user_group_ratio:-1}),status).ratio,undefined);
  assert.equal(requestBilling(snapshot({group_ratio:1,user_group_ratio:0,request_rules:[]}),status).ratio,0);
  for(const expr_b64 of ['invalid!',Buffer.from('p*unknown()').toString('base64'),'a'.repeat(40001)])assert.equal(requestBilling(snapshot({expr_b64}),status).selected,undefined);
  assert.equal(requestBilling({...log,other:'not-json'},status).sections.length,0);
});
test('timestamp-specific time pricing is not multiplied twice by its settlement trace',()=>{
  const timed='('+expression.split('|||')[0]+') * (hour("Asia/Shanghai") >= 9 ? 3 : 1)|||when(param("service_tier") == "priority") * 2';
  const result=requestBilling({...snapshot({expr_b64:Buffer.from(timed).toString('base64'),request_rules:[{cond:'hour("Asia/Shanghai") >= 9',multiplier:3,matched:true},traces[1]]}),created_at:Date.parse('2026-10-05T02:00:00Z')/1000},status);
  assert.equal(result.sections.length,2);assert.equal(result.selected?.rows[0].usd,6);assert.equal(result.requestMultiplier,2);
});
test('embedded request factors and unsupported formulas retain safe display behavior',()=>{
  assert.equal(displayPricingChoices({...model,billing_expr:'tier("base",p*2+c*10)*(param("service_tier") == "priority" ? 7 : 1)'},status)[0].section?.rows[0].usd,2);
  assert.equal(displayPricingChoices({...model,billing_expr:'tier("base",p*2+c*10)*(param("service_tier") == "priority" ? 7 : 1)*(hour("Asia/Shanghai")>0 ? 3 : 1)'},status,new Date('2026-10-05T02:00:00Z'))[0].section?.rows[0].usd,6);
  assert.equal(publishedRequestPricing({...model,billing_expr:'tier("base",p*2+c*10)|||when(header("anthropic-beta") has "fast-mode") * 6'}).rules[0].multiplier,6);
  for(const billing_expr of ['p*param("price")','p*(param("fast") ? 2 : 1.5)','p*(len>272000 ? 2 : 1)'])assert.equal(publishedRequestPricing({...model,billing_expr}).rules.length,0);
  const plain=requestBilling({...log,other:JSON.stringify({model_ratio:1,completion_ratio:5,cache_ratio:0,group_ratio:.5})},status);
  assert.deepEqual(plain.sections[0].rows.map(row=>row.usd),[2,10,0]);
});
