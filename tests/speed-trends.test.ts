import test from 'node:test';
import assert from 'node:assert/strict';
import {tokenPoints,groupedTrend} from '../shared/trends';
import {usageSeries} from '../shared/utils';
import {summarizeQuality} from '../shared/usage-quality';
import type {QuotaPoint,UsageLog} from '../shared/types';

const now=new Date(2026,9,2,12,34),start=new Date(2026,9,2,12,33).getTime()/1000;
const range={startDate:'2026-10-02',endDate:'2026-10-02',startTime:'12:33',endTime:'12:33'};
const window={start_timestamp:start,end_timestamp:start+59},status={system_name:'Fixture',quota_per_unit:100};
const log=(id:number,overrides:Partial<UsageLog>={}):UsageLog=>({id,created_at:start,type:2,model_name:'model-a',token_id:1,token_name:'Same label',prompt_tokens:100,completion_tokens:50,quota:100,use_time:1,is_stream:true,other:'{"frt":500}',group:'fixture',...overrides});
const point=(overrides:Partial<QuotaPoint>={}):QuotaPoint=>({created_at:start,model_name:'model-a',token_id:1,token_name:'Same label',quota:100,token_used:10,count:1,...overrides});

test('speed trends include first-token time and independently admit nonstream and missing first-token samples',()=>{
  const logs=[log(1),log(2,{created_at:start+1,completion_tokens:150,use_time:9,other:'{"frt":1500}'}),log(3,{other:undefined}),log(4,{is_stream:false}),log(5,{status_code:500}),log(6,{type:5}),log(7,{created_at:start-1}),log(8,{created_at:start+60})];
  const before=structuredClone(logs),points=tokenPoints(logs,window),rows=usageSeries(points,1,status,range,now),quality=summarizeQuality(logs,window);
  assert.equal(rows[0].speed,300/12,'weighted rate must include every corresponding total duration');
  assert.equal(rows[0].netSpeed,200/8);assert.equal(rows[0].speedSamples,4);assert.equal(rows[0].netSpeedSamples,2);
  assert.equal(rows[0].outputTokens,quality.outputTokens);assert.equal(rows[0].durationSeconds,quality.durationSeconds);assert.equal(rows[0].speed,quality.averageTokenSpeed);
  assert.equal(rows[0].requests,5,'failed requests remain part of ordinary usage totals');assert.equal(rows[1].speed,null);
  assert.deepEqual(logs,before);
});

test('speed trends exclude invalid duration/output and retain exact timestamps at the range edges',()=>{
  const logs=[log(1),...[-1,0,NaN,Infinity].map((use_time,i)=>log(i+2,{use_time})),...[-1,0,NaN,Infinity].map((completion_tokens,i)=>log(i+6,{completion_tokens})),log(10,{created_at:start+59,completion_tokens:100,use_time:5}),log(11,{created_at:start+60})];
  const rows=usageSeries(tokenPoints(logs,window),1,status,range,now);
  assert.equal(rows[0].speed,50);assert.equal(rows[0].speedSamples,1);assert.equal(rows[29].speed,20);assert.equal(rows[29].speedSamples,1);
  assert.ok(rows.slice(1,29).every(row=>row.speed===null));
});

test('model and same-named token speed curves keep selected weighted samples separate',()=>{
  const points=tokenPoints([log(1),log(2,{created_at:start+1,completion_tokens:150,use_time:9}),log(3,{created_at:start+2,use_time:0}),log(4,{model_name:'model-b',token_id:2,completion_tokens:40})],window);
  for(const grouping of ['model','token'] as const){
    const chart=groupedTrend(points,1,status,range,now,grouping,'speed');
    assert.deepEqual(Object.values(chart.rows[0].values),[20,40]);assert.equal(chart.rows[0].speed,240/11);
    const selected=groupedTrend(points,1,status,range,now,grouping,'speed',grouping==='model' ? 'model-a' : 'id:1');
    assert.equal(selected.lines.length,1);assert.equal(selected.rows[0].values[selected.lines[0].id],20);assert.equal(selected.rows[1].values[selected.lines[0].id],null);
    if(grouping==='token')assert.deepEqual(chart.options.map(option=>option.name),['Same label (#1)','Same label (#2)']);
  }
});

test('speed curves rank the top eight by eligible output and recompute the remaining rate',()=>{
  const points=Array.from({length:8},(_,i)=>point({model_name:'large-'+i,token_id:i+1,token_name:'large-'+i,outputTokens:1000+i*100,durationSeconds:2,speedSamples:1}));
  points.push(point({model_name:'small-fast',token_id:9,outputTokens:100,durationSeconds:.5,speedSamples:1}),point({model_name:'small-slow',token_id:10,outputTokens:900,durationSeconds:9,speedSamples:1}),point({model_name:'unknown',token_id:11,quota:100000}));
  for(const grouping of ['model','token'] as const){
    const chart=groupedTrend(points,1,status,range,now,grouping,'speed');
    assert.equal(chart.options.length,11);assert.equal(chart.lines.length,9);assert.equal(chart.combined,3);assert.ok(chart.lines.slice(0,8).every(line=>line.name.startsWith('large-')));
    assert.equal(chart.rows[0].values.remaining,1000/9.5,'remaining speed is not an average of per-model rates');
    assert.ok(chart.rows.slice(1).every(row=>Object.values(row.values).every(value=>value===null)));
  }
});

test('legacy and malformed speed pairs remain unknown without independently combining fragments',()=>{
  const pairs:[number|undefined,number|undefined][]=[[undefined,1],[1,undefined],[0,1],[-1,1],[NaN,1],[Infinity,1],[1,0],[1,-1],[1,NaN],[1,Infinity]];
  const rows=usageSeries([point(),...pairs.map(([outputTokens,durationSeconds])=>point({outputTokens,durationSeconds,speedSamples:1}))],1,status,range,now);
  assert.equal(rows[0].speed,null);assert.equal(rows[0].speedSamples,0);assert.equal(rows[0].requests,11);assert.equal(rows[0].tokens,110);
});
