import test from 'node:test';
import assert from 'node:assert/strict';
import {publishedPriceSections,publishedPricingStates} from '../shared/pricing';
import {requestTiming,requestStatus} from '../shared/logs';
import type {ModelInfo,UsageLog} from '../shared/types';
const expr='(len <= 272000 ? tier("0_272k", p * 0.1 + cr * 0.02 + cc * 0.125 + c * 0.5) : tier("272k_plus", p * 0.2 + cr * 0.04 + cc * 0.25 + c * 0.75)) * (hour("Asia/Shanghai") >= 9 && hour("Asia/Shanghai") < 23 ? 2 : 1)';
const model:ModelInfo={model_name:'gpt-6-luna',quota_type:0,model_ratio:1,model_price:0,completion_ratio:1,enable_groups:['default'],supported_endpoint_types:[],billing_mode:'tiered_expr',billing_expr:expr};
const status={system_name:'Fixture',quota_per_unit:500000};
test('user-supplied luna expression publishes every tier multiplied by its schedule, preserving all cache categories',()=>{
  const sections=publishedPriceSections(model,status,new Date('2026-10-01T01:00:00Z'));
  assert.deepEqual(sections.map(s=>s.rows.map(r=>r.usd)),[[.2,1,.04,.25],[.1,.5,.02,.125],[.4,1.5,.08,.5],[.2,.75,.04,.25]]);
  assert.deepEqual(sections.map(s=>s.label),['0_272k','0_272k','272k_plus','272k_plus']);
  assert.deepEqual(sections.map(s=>s.rows.map(r=>r.label)),Array(4).fill(['普通输入','输出','缓存读取','缓存写入']));
  assert.deepEqual(sections.map(s=>s.current),[true,false,true,false]);
  const labels=publishedPricingStates(model,status).map(s=>s.label);
  assert.equal(labels.length,4);assert.match(labels[0],/上下文 ≤ 272K.*上海时间 09:00–23:00/);assert.match(labels[1],/23:00–次日09:00/);assert.match(labels[2],/上下文 > 272K/);
});
test('Shanghai hourly price defaults respect 09:00 and 23:00 boundaries without host timezone assumptions',()=>{
  for(const [date,day] of [['2026-10-01T00:59:59Z',false],['2026-10-01T01:00:00Z',true],['2026-10-01T14:59:59Z',true],['2026-10-01T15:00:00Z',false]] as const){
    assert.deepEqual(publishedPriceSections(model,status,new Date(date)).map(s=>s.current),[day,!day,day,!day]);
  }
});
const log:UsageLog={id:1,created_at:1,type:2,model_name:'fixture',token_name:'fixture',prompt_tokens:1500,completion_tokens:1200,quota:1,use_time:4,is_stream:true,group:'standard',other:JSON.stringify({frt:750})};
test('recent timing uses reported first-token latency and remaining stream duration, rejecting unavailable and contradictory values',()=>{
  assert.deepEqual(requestTiming(log),{firstMs:750,subsequentMs:3250});
  for(const other of ['{}','not-json',JSON.stringify({frt:5000}),JSON.stringify({frt:-1})])assert.deepEqual(requestTiming({...log,other}),{firstMs:null,subsequentMs:null});
  assert.deepEqual(requestTiming({...log,is_stream:false}),{firstMs:null,subsequentMs:null});
  assert.deepEqual(requestTiming({...log,other:'{"frt":0}'}),{firstMs:0,subsequentMs:4000});
});
test('HTTP status is never inferred from a successful log and explicit error fields are available for status details',()=>{
  assert.equal(requestStatus(log).httpStatus,null);assert.equal(requestStatus(log).isError,false);
  const error=requestStatus({...log,type:5,content:'Returned error message',other:JSON.stringify({status_code:429,error_type:'upstream_error',error_code:'rate_limit_exceeded'})});
  assert.equal(error.httpStatus,429);assert.equal(error.errorType,'upstream_error');assert.equal(error.errorCode,'rate_limit_exceeded');assert.equal(error.message,'Returned error message');assert.equal(error.isError,true);
  assert.equal(requestStatus({...log,status_code:200}).httpStatus,200);
  assert.equal(requestStatus({...log,other:'{"status_code":999}'}).httpStatus,null);
  assert.equal(requestStatus({...log,other:'{"stream_status":{"status":"error","end_error":"Stream failed"}}'}).message,'Stream failed');
});
