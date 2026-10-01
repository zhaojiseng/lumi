import test from 'node:test';
import assert from 'node:assert/strict';
import {summarizeQuality} from '../shared/usage-quality';
import type {UsageLog} from '../shared/types';
const window={start_timestamp:100,end_timestamp:200};
const log=(id:number,prompt_tokens:number,completion_tokens:number,use_time:number,other:object={}):UsageLog=>({id,created_at:150,type:2,model_name:'fixture',token_name:'fixture',prompt_tokens,completion_tokens,use_time,other:JSON.stringify(other),quota:1,is_stream:true,group:'fixture'});

test('model cache hit rate sums real input tokens and average token speed is weighted by request duration',()=>{
  const rows=[log(1,100,50,1,{cache_tokens:80}),log(2,900,150,9,{billing_tokens:{cr:0}})];
  const result=summarizeQuality(rows,window,123);
  assert.equal(result.cacheHitRate,.08);assert.equal(result.averageTokenSpeed,20);
  assert.equal(result.cacheSamples,2);assert.equal(result.speedSamples,2);assert.equal(result.requestCount,2);assert.equal(result.fetchedAt,123);
});
test('missing or inconsistent cache fields remain unknown and failed or out-of-range requests do not affect efficiency',()=>{
  const rows=[log(1,100,5,0),log(2,100,5,0,{cache_tokens:200}),{...log(3,100,100,1,{cache_tokens:100}),type:5},{...log(4,100,100,1,{cache_tokens:100}),created_at:300},{...log(5,100,100,1,{cache_tokens:100}),status_code:500}];
  const result=summarizeQuality(rows,window);assert.equal(result.requestCount,2);assert.equal(result.cacheHitRate,null);assert.equal(result.averageTokenSpeed,null);
  const zero=summarizeQuality([log(6,100,0,1,{cache_tokens:0})],window);assert.equal(zero.cacheHitRate,0);assert.equal(zero.averageTokenSpeed,null);
});
