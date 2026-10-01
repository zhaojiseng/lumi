import test from 'node:test';
import assert from 'node:assert/strict';
import {publishedPriceSections,publishedPricingStates} from '../shared/pricing';
import type {ModelInfo} from '../shared/types';
const status={system_name:'Fixture',quota_per_unit:500000};
const model:ModelInfo={model_name:'arbitrary-model',quota_type:0,model_ratio:1,model_price:0,completion_ratio:1,enable_groups:['default'],supported_endpoint_types:[],billing_mode:'tiered_expr'};
test('automatic unit price derivation folds arithmetic rates and embedded matching conditions without model-name assumptions',()=>{
  const expr='tier("rate",p*(len<=272000 ? 1.2/2 : 1.2)+c*(len<=272000 ? 4+2 : 12)+cr*(len<=272000 ? .06 : .12))';
  for(const model_name of ['gpt-6-luna','arbitrary-model']){
    const states=publishedPricingStates({...model,model_name,billing_expr:expr},status);
    assert.deepEqual(states.map(s=>s.label),['上下文 ≤ 272K','上下文 > 272K']);
    assert.deepEqual(states.map(s=>s.section!.rows.map(r=>r.usd)),[[.6,6,.06],[1.2,12,.12]]);
  }
  assert.equal(publishedPriceSections({...model,billing_expr:'p*((3+5)/4)+c*(2**3)'},status)[0].rows[1].usd,8);
});
test('published conditional multipliers and per-call arithmetic become separate price states without inventing requests',()=>{
  const rows=publishedPriceSections({...model,billing_expr:'fixed(.01)|||when(header("beta") has "fast") * 6'},status);
  assert.deepEqual(rows.map(s=>s.rows[0].usd),[.06,.01]);assert.match(rows[0].condition,/header/);
  const param=publishedPriceSections({...model,billing_expr:'p*3*(param("fast") == true ? 2 : 1)'},status);assert.deepEqual(param.map(s=>s.rows[0].usd),[6,3]);
  assert.equal(publishedPriceSections({...model,billing_expr:'fixed((2+3)/100)'},status)[0].rows[0].usd,.05);
  for(const billing_expr of ['p/(2-2)','p*len','p*p','p*(2**9999)','p*param("price")'])assert.deepEqual(publishedPriceSections({...model,billing_expr},status),[]);
});
