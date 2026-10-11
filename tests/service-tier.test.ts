import test from 'node:test';
import assert from 'node:assert/strict';
import {publishedServiceTiers,validServiceTier} from '../shared/pricing';
import type {ModelInfo} from '../shared/types';

const model:ModelInfo={model_name:'fixture',quota_type:0,model_ratio:1,model_price:0,completion_ratio:1,enable_groups:['standard'],supported_endpoint_types:[],billing_mode:'tiered_expr'};
const expression='(len <= 272000 ? tier("0_272k", p * 2 + cr * 0.2 + cc * 2.5 + c * 10) : tier("272k_plus", p * 4 + cr * 0.4 + cc * 5 + c * 15)) * (param("service_tier") == "fast" ? 2 : 1) * (param("service_tier") == "priority" ? 2 : 1) * (param("service_tier") == "ultrafast" ? 8 : 1)';

test('service tiers preserve exact request values, including equal-priced aliases',()=>{
  assert.deepEqual(publishedServiceTiers({...model,billing_expr:expression}),['fast','priority','ultrafast']);
  const rules='p*2|||when(param("service_tier") == "priority") * 2|||when(param("service_tier") == "ultrafast") * 8';
  assert.deepEqual(publishedServiceTiers({...model,billing_expr:rules}),['priority','ultrafast']);
});
test('service tiers come from nested conditions and active variant formulas, with deduplication',()=>{
  const nested='len <= 272000 ? ("flex" == param("service_tier") ? p : p*2) : ((param("service_tier")=="flex" || param("service_tier")=="economy-x") ? p*3 : p*4)';
  assert.deepEqual(publishedServiceTiers({...model,billing_expr:nested,billing_plugin_variants:[
    {plugin_key:'secondary',plugin_name:'Secondary',billing_expr:expression},
    {plugin_key:'inactive',plugin_name:'Inactive',billing_mode:'ratio',billing_expr:'param("service_tier")=="ignored" ? p : p*2'},
  ]}),['flex','economy-x','fast','priority','ultrafast']);
  assert.deepEqual(publishedServiceTiers({...model,billing_mode:'ratio',billing_expr:expression}),[]);
});
test('unreadable formulas, arbitrary text, unrelated parameters and unsafe values never advertise tiers',()=>{
  for(const billing_expr of [
    'tier("param(\\"service_tier\\")==\\"ultrafast\\"",p*2)',
    'header("service_tier")=="ultrafast" ? p : p*2',
    'param("unrelated")=="ultrafast" ? p : p*2',
    'p * param("service_tier")',
    'unknown(param("service_tier")=="ultrafast" ? p : p*2)',
    'param("service_tier")==8 ? p : p*2',
    'param("service_tier")=="bad tier" ? p : p*2',
    'param("service_tier")=="'+'a'.repeat(65)+'" ? p : p*2',
    'param("service_tier")=="ultrafast" ? p :',
  ])assert.deepEqual(publishedServiceTiers({...model,billing_expr}),[],billing_expr);
  for(const value of ['',null,123,'two words','line\nbreak','x'.repeat(65),'bad"value'])assert.equal(validServiceTier(value),false);
  assert.equal(validServiceTier('provider.custom-tier_1'),true);
});
