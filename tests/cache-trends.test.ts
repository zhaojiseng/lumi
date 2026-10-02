import test from 'node:test';
import assert from 'node:assert/strict';
import {tokenPoints,groupedTrend} from '../shared/trends';
import {usageSeries} from '../shared/utils';
import type {QuotaPoint,UsageLog} from '../shared/types';

const now=new Date(2026,9,2,12,34),start=new Date(2026,9,2,12,33).getTime()/1000;
const range={startDate:'2026-10-02',endDate:'2026-10-02',startTime:'12:33',endTime:'12:33'};
const window={start_timestamp:start,end_timestamp:start+59},status={system_name:'Fixture',quota_per_unit:100};
const log=(id:number,overrides:Partial<UsageLog>={}):UsageLog=>({id,created_at:start,type:2,model_name:'model-a',token_id:1,token_name:'Same label',prompt_tokens:100,completion_tokens:5,quota:100,use_time:1,is_stream:true,group:'fixture',...overrides});
const point=(created_at:number,overrides:Partial<QuotaPoint>={}):QuotaPoint=>({created_at,model_name:'model-a',token_id:1,token_name:'Same label',quota:100,token_used:10,count:1,...overrides});

test('tokenPoints preserves request timestamps and adds only known valid cache samples to merged points',()=>{
  const logs=[
    log(1,{other:JSON.stringify({cache_tokens:100})}),
    log(2,{prompt_tokens:900,other:JSON.stringify({cache_tokens:0})}),
    log(3,{prompt_tokens:50,other:JSON.stringify({billing_tokens:{cr:10}})}),
    log(4,{prompt_tokens:7000}),
    log(5,{created_at:start+1,other:JSON.stringify({cache_tokens:0,billing_tokens:{cr:99}})}),
    log(6,{created_at:window.end_timestamp,model_name:'model-b',token_id:2,other:JSON.stringify({cache_tokens:50})}),
    log(7,{created_at:start-1,other:JSON.stringify({cache_tokens:100})}),
    log(8,{created_at:window.end_timestamp+1,other:JSON.stringify({cache_tokens:100})}),
    log(9,{type:5,other:JSON.stringify({cache_tokens:100})}),log(10,{created_at:NaN}),
  ];
  const before=structuredClone(logs),points=tokenPoints(logs,window);
  assert.equal(points.length,3);
  assert.deepEqual(points.map(p=>[p.created_at,p.quota,p.token_used,p.count,p.cacheInputTokens,p.cacheReadTokens]),[
    [start,400,8070,4,1050,110],[start+1,100,105,1,100,0],[start+59,100,105,1,100,50],
  ]);
  assert.deepEqual(logs,before);
});

test('tokenPoints leaves cache samples absent for unknown metadata, invalid input and failed type-2 requests',()=>{
  const cases:Partial<UsageLog>[]=[
    {},{other:'not-json'},{other:'{}'},
    ...[-1,'0',null].map(cache_tokens=>({other:JSON.stringify({cache_tokens})})),
    {other:JSON.stringify({cache_tokens:101})},
    ...[0,-1,NaN,Infinity].map(prompt_tokens=>({prompt_tokens,other:JSON.stringify({cache_tokens:0})})),
    {status_code:500,other:JSON.stringify({cache_tokens:50})},
    {other:JSON.stringify({status_code:429,cache_tokens:50})},
    {other:JSON.stringify({stream_status:{status:'error'},cache_tokens:50})},
  ];
  for(const overrides of cases) {
    const points=tokenPoints([log(1,overrides)],window);
    assert.equal(points.length,1);assert.equal(points[0].count,1);assert.equal(points[0].quota,100);
    assert.equal(Object.hasOwn(points[0],'cacheInputTokens'),false);
    assert.equal(Object.hasOwn(points[0],'cacheReadTokens'),false);
    assert.equal(usageSeries(points,1,status,range,now)[0].cacheHitRate,null);
  }
  assert.deepEqual(tokenPoints([log(1,{type:5})],window),[]);
});

test('usageSeries computes token-weighted ratios, distinguishes zero from unknown and preserves usage totals',()=>{
  const points=[
    point(start,{cacheInputTokens:100,cacheReadTokens:100}),
    point(start+1,{cacheInputTokens:900,cacheReadTokens:0}),
    point(start+1,{token_used:10000}),
    point(start+2),
    point(start+4,{cacheInputTokens:200,cacheReadTokens:0}),
    point(start+6,{cacheInputTokens:25,cacheReadTokens:25}),
    point(start-1,{cacheInputTokens:10000,cacheReadTokens:10000}),
    point(start+60,{cacheInputTokens:10000,cacheReadTokens:10000}),
  ];
  const rows=usageSeries(points,1,status,range,now);
  assert.deepEqual(rows.slice(0,4).map(row=>[row.cacheInputTokens,row.cacheReadTokens,row.cacheHitRate]),[
    [1000,100,.1],[0,0,null],[200,0,0],[25,25,1],
  ]);
  assert.equal(rows[1].requests,1,'a request with unknown cache usage is still counted');
  assert.ok(rows.slice(4).every(row=>row.cacheHitRate===null));
  assert.deepEqual(rows.reduce((s,row)=>[s[0]+row.cost,s[1]+row.tokens,s[2]+row.requests],[0,0,0]),[6,10050,6]);
  assert.ok(rows.every(row=>row.cacheHitRate===null || Number.isFinite(row.cacheHitRate) && row.cacheHitRate>=0 && row.cacheHitRate<=1));
});

test('usageSeries rejects malformed cache pairs without fabricating a zero rate or losing usage',()=>{
  const pairs:[number|undefined,number|undefined][]=[
    [undefined,0],[100,undefined],[0,0],[-1,0],[NaN,0],[Infinity,0],
    [100,-1],[100,NaN],[100,Infinity],[100,101],
  ];
  const points=pairs.map(([cacheInputTokens,cacheReadTokens])=>point(start,{cacheInputTokens,cacheReadTokens}));
  const rows=usageSeries(points,1,status,range,now);
  assert.equal(rows[0].cacheHitRate,null);assert.equal(rows[0].cacheInputTokens,0);assert.equal(rows[0].cacheReadTokens,0);
  assert.deepEqual([rows[0].cost,rows[0].tokens,rows[0].requests],[pairs.length,pairs.length*10,pairs.length]);
});

test('model and same-named token cache curves weight each bucket and retain unknown gaps when selected',()=>{
  const points=[
    point(start,{cacheInputTokens:100,cacheReadTokens:100}),
    point(start+1,{cacheInputTokens:900,cacheReadTokens:0}),
    point(start,{model_name:'model-b',token_id:2,cacheInputTokens:50,cacheReadTokens:25}),
    point(start+2),point(start+2,{model_name:'model-b',token_id:2}),
    point(start+4,{cacheInputTokens:20,cacheReadTokens:0}),
  ];
  for(const grouping of ['model','token'] as const) {
    const chart=groupedTrend(points,1,status,range,now,grouping,'cacheHitRate');
    assert.equal(chart.lines.length,2);assert.equal(chart.combined,0);
    assert.deepEqual(chart.rows[0].values,Object.fromEntries(chart.lines.map((line,i)=>[line.id,i===0 ? .1 : .5])));
    assert.equal(chart.rows[0].cacheHitRate,125/1050);
    assert.ok(chart.rows[1].requests>0);assert.ok(Object.values(chart.rows[1].values).every(value=>value===null));
    assert.ok(chart.rows.slice(3).every(row=>Object.values(row.values).every(value=>value===null)));
    const selected=groupedTrend(points,1,status,range,now,grouping,'cacheHitRate',grouping==='model' ? 'model-a' : 'id:1');
    assert.equal(selected.lines.length,1);
    assert.deepEqual(selected.rows.slice(0,4).map(row=>row.values[selected.lines[0].id]),[.1,null,0,null]);
    if(grouping==='token')assert.deepEqual(chart.options.map(option=>option.name),['Same label (#1)','Same label (#2)']);
  }
  const total=groupedTrend(points,1,status,range,now,'total','cacheHitRate');
  assert.equal(total.rows[0].cacheHitRate,125/1050);assert.equal(total.rows[1].cacheHitRate,null);
  assert.deepEqual(total.lines,[]);assert.deepEqual(total.options,[]);assert.equal(total.combined,0);
});

test('more than eight model or token cache groups rank by input and weight the combined other group',()=>{
  const points:QuotaPoint[]=Array.from({length:8},(_,i)=>point(start,{
    model_name:'large-'+i,token_id:i+1,token_name:'large-'+i,
    cacheInputTokens:1000+i*100,cacheReadTokens:(1000+i*100)/4,quota:1,
  }));
  points.push(
    point(start,{model_name:'small-hit',token_id:9,token_name:'small-hit',cacheInputTokens:100,cacheReadTokens:100,quota:10000}),
    point(start,{model_name:'small-miss',token_id:10,token_name:'small-miss',cacheInputTokens:900,cacheReadTokens:0,quota:20000}),
    point(start,{model_name:'unknown',token_id:11,token_name:'unknown',quota:30000}),
    point(start+2,{model_name:'small-hit',token_id:9,token_name:'small-hit'}),
  );
  for(const grouping of ['model','token'] as const) {
    const chart=groupedTrend(points,1,status,range,now,grouping,'cacheHitRate');
    assert.equal(chart.options.length,11);assert.equal(chart.lines.length,9);assert.equal(chart.combined,3);
    assert.ok(chart.lines.slice(0,8).every(line=>line.name.startsWith('large-')),'cache ranking follows sample input, even when other groups cost more');
    assert.equal(chart.rows[0].values.remaining,.1,'combined rate is 100/1000, rather than a sum or mean of group rates');
    assert.equal(chart.rows[1].values.remaining,null,'unknown requests cannot manufacture a zero cache rate');
    assert.ok(chart.rows.slice(2).every(row=>Object.values(row.values).every(value=>value===null)));
    assert.equal(chart.rows[0].cacheHitRate,2800/11800);
    const unknown=groupedTrend(points,1,status,range,now,grouping,'cacheHitRate',grouping==='model' ? 'unknown' : 'id:11');
    assert.equal(unknown.lines.length,1);assert.ok(unknown.rows.every(row=>row.values[unknown.lines[0].id]===null));
    const single=groupedTrend(points,1,status,range,now,grouping,'cacheHitRate',grouping==='model' ? 'small-hit' : 'id:9');
    assert.equal(single.rows[0].values[single.lines[0].id],1);assert.equal(single.combined,0);
  }
});
