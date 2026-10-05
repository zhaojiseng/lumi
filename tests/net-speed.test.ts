import test from 'node:test';
import assert from 'node:assert/strict';
import {logMetrics,requestTiming,normalizeLogColumns,visibleLogColumns,normalizeActivityColumns} from '../shared/logs';
import {summarizeQuality} from '../shared/usage-quality';
import {tokenPoints,groupedTrend} from '../shared/trends';
import {logsToCsv,usageSeries} from '../shared/utils';
import {DEFAULT_LOG_COLUMNS,type UsageLog,type QuotaPoint} from '../shared/types';

const now=new Date(2026,9,2,12,34),start=new Date(2026,9,2,12,33).getTime()/1000;
const range={startDate:'2026-10-02',endDate:'2026-10-02',startTime:'12:33',endTime:'12:33'};
const window={start_timestamp:start,end_timestamp:start+59},status={system_name:'Fixture',quota_per_unit:100};
const log=(id:number,overrides:Partial<UsageLog>={}):UsageLog=>({id,created_at:start,type:2,model_name:'model-a',token_id:1,token_name:'Same label',prompt_tokens:100,completion_tokens:50,quota:100,use_time:1,is_stream:true,other:'{"frt":500}',group:'fixture',...overrides});
const point=(overrides:Partial<QuotaPoint>={}):QuotaPoint=>({created_at:start,model_name:'model-a',token_id:1,token_name:'Same label',quota:100,token_used:10,count:1,...overrides});

test('net speed removes the reported first-token wait while keeping total speed intact',()=>{
  const row=log(1),before=structuredClone(row);
  assert.equal(logMetrics(row).speed,50);assert.equal(logMetrics(row).netSpeed,100);
  assert.deepEqual(requestTiming(row),{firstMs:500,subsequentMs:500});
  assert.equal(logMetrics(log(2,{other:'{"frt":0}'})).netSpeed,50);
  assert.equal(logMetrics(log(3,{other:'{"frt":1000}'})).netSpeed,null);
  assert.deepEqual(requestTiming(log(3,{other:'{"frt":1000}'})),{firstMs:1000,subsequentMs:0});
  assert.deepEqual(row,before);
});

test('missing, malformed, nonstream and inconsistent timings never fabricate net speed',()=>{
  const cases:Partial<UsageLog>[]=[
    {is_stream:false},{other:undefined},{other:'not-json'},{other:'{}'},
    ...[-1,'0',null,1001].map(frt=>({other:JSON.stringify({frt})})),
    ...[-1,0,NaN,Infinity,Number.MAX_VALUE].map(use_time=>({use_time})),
    ...[-1,0,NaN,Infinity].map(completion_tokens=>({completion_tokens})),
    {use_time:Number.MIN_VALUE,other:'{"frt":0}',completion_tokens:Number.MAX_VALUE},
    {type:1},
  ];
  for(const overrides of cases)assert.equal(logMetrics(log(1,overrides)).netSpeed,null,JSON.stringify(overrides));
  const legacy=log(2,{is_stream:false,other:undefined});
  assert.equal(logMetrics(legacy).speed,50);assert.deepEqual(requestTiming(legacy),{firstMs:null,subsequentMs:null});
});

test('net quality weights by subsequent duration and reports only valid sample coverage',()=>{
  const rows=[
    log(1),log(2,{completion_tokens:150,use_time:9,other:'{"frt":1500}'}),
    log(3,{other:undefined}),log(4,{is_stream:false}),
    log(5,{status_code:500}),log(6,{type:5}),log(7,{created_at:start-1}),
    log(8,{created_at:start+60}),log(9,{created_at:NaN}),
  ];
  const result=summarizeQuality(rows,window,123);
  assert.equal(result.requestCount,4);assert.equal(result.netSpeedSamples,2);
  assert.equal(result.netOutputTokens,200);assert.equal(result.subsequentDurationSeconds,8);
  assert.equal(result.averageNetTokenSpeed,25,'200 / (0.5 + 7.5), not the mean of per-request rates');
  assert.equal(result.averageTokenSpeed,300/12);assert.equal(result.speedSamples,4);
  assert.equal(result.fetchedAt,123);
  const unknown=summarizeQuality([log(1,{other:undefined}),log(2,{is_stream:false})],window);
  assert.equal(unknown.averageNetTokenSpeed,null);assert.equal(unknown.netSpeedSamples,0);
  assert.equal(unknown.netOutputTokens,0);assert.equal(unknown.subsequentDurationSeconds,0);
});

test('exact-time points and thirty trend buckets sum independent valid timing samples',()=>{
  const rows=[
    log(1),log(2,{created_at:start+1,completion_tokens:150,use_time:9,other:'{"frt":1500}'}),
    log(3,{created_at:start+1,other:undefined}),log(4,{created_at:start+2,is_stream:false}),
    log(5,{created_at:start+4,other:'{"frt":1000}'}),
    log(6,{created_at:start+59,model_name:'model-b',token_id:2}),
    log(7,{created_at:start+60}),log(8,{type:5}),log(9,{status_code:500}),
  ];
  const before=structuredClone(rows),points=tokenPoints(rows,window),series=usageSeries(points,1,status,range,now);
  assert.deepEqual(points.filter(p=>p.netSpeedSamples).map(p=>[p.created_at,p.netOutputTokens,p.subsequentDurationSeconds,p.netSpeedSamples]),[
    [start,50,.5,1],[start+1,150,7.5,1],[start+59,50,.5,1],
  ]);
  assert.equal(series.length,30);assert.equal(series[0].netSpeed,25);assert.equal(series[0].netSpeedSamples,2);
  assert.equal(series[1].netSpeed,null);assert.equal(series[2].netSpeed,null);
  assert.equal(series[29].netSpeed,100);assert.equal(series[29].netSpeedSamples,1);
  assert.equal(series.reduce((s,row)=>s+row.requests,0),7,'unknown timing and type-2 error logs retain ordinary usage totals');
  assert.deepEqual(rows,before);
});

test('model and same-named token net curves retain weighted samples and unknown gaps',()=>{
  const points=tokenPoints([
    log(1),log(2,{created_at:start+1,completion_tokens:150,use_time:9,other:'{"frt":1500}'}),
    log(3,{created_at:start+2,other:undefined}),
    log(4,{model_name:'model-b',token_id:2,completion_tokens:40}),
  ],window);
  for(const grouping of ['model','token'] as const){
    const chart=groupedTrend(points,1,status,range,now,grouping,'netSpeed');
    assert.equal(chart.lines.length,2);assert.deepEqual(Object.values(chart.rows[0].values),[25,80]);
    assert.equal(chart.rows[0].netSpeed,240/8.5);
    assert.ok(Object.values(chart.rows[1].values).every(v=>v===null));
    const selected=groupedTrend(points,1,status,range,now,grouping,'netSpeed',grouping==='model' ? 'model-a' : 'id:1');
    assert.equal(selected.lines.length,1);assert.equal(selected.rows[0].values[selected.lines[0].id],25);
    assert.equal(selected.rows[1].values[selected.lines[0].id],null);
    if(grouping==='token')assert.deepEqual(chart.options.map(o=>o.name),['Same label (#1)','Same label (#2)']);
  }
  const total=groupedTrend(points,1,status,range,now,'total','netSpeed');
  assert.equal(total.rows[0].netSpeed,240/8.5);assert.equal(total.rows[1].netSpeed,null);
});

test('more than eight net curves rank by sampled output and recompute the combined rate',()=>{
  const points=Array.from({length:8},(_,i)=>point({model_name:'large-'+i,token_id:i+1,token_name:'large-'+i,netOutputTokens:1000+i*100,subsequentDurationSeconds:2,netSpeedSamples:1}));
  points.push(
    point({model_name:'small-fast',token_id:9,token_name:'small-fast',netOutputTokens:100,subsequentDurationSeconds:.5,netSpeedSamples:1}),
    point({model_name:'small-slow',token_id:10,token_name:'small-slow',netOutputTokens:900,subsequentDurationSeconds:9,netSpeedSamples:1}),
    point({model_name:'unknown',token_id:11,token_name:'unknown',quota:100000}),
  );
  for(const grouping of ['model','token'] as const){
    const chart=groupedTrend(points,1,status,range,now,grouping,'netSpeed');
    assert.equal(chart.options.length,11);assert.equal(chart.lines.length,9);assert.equal(chart.combined,3);
    assert.ok(chart.lines.slice(0,8).every(line=>line.name.startsWith('large-')));
    assert.equal(chart.rows[0].values.remaining,1000/9.5);
    assert.ok(chart.rows.slice(1).every(row=>Object.values(row.values).every(value=>value===null)));
    const unknown=groupedTrend(points,1,status,range,now,grouping,'netSpeed',grouping==='model' ? 'unknown' : 'id:11');
    assert.ok(unknown.rows.every(row=>row.values[unknown.lines[0].id]===null));
  }
});

test('malformed point timing pairs leave rates unknown without losing usage totals',()=>{
  const pairs:[number|undefined,number|undefined][]=[
    [undefined,1],[1,undefined],[0,1],[-1,1],[NaN,1],[Infinity,1],
    [1,0],[1,-1],[1,NaN],[1,Infinity],
  ];
  const rows=usageSeries(pairs.map(([netOutputTokens,subsequentDurationSeconds])=>point({netOutputTokens,subsequentDurationSeconds})),1,status,range,now);
  assert.equal(rows[0].netSpeed,null);assert.equal(rows[0].netSpeedSamples,0);
  assert.equal(rows[0].requests,pairs.length);assert.equal(rows[0].tokens,10*pairs.length);
});

test('net speed stays opt-in and paired duration hides redundant first-token columns',()=>{
  assert.ok(!DEFAULT_LOG_COLUMNS.includes('netSpeed'));
  assert.deepEqual(normalizeLogColumns(['netSpeed','bad','speed','netSpeed']),['netSpeed','speed']);
  assert.deepEqual(normalizeActivityColumns(['netSpeed','timing']),['netSpeed','timing']);
  assert.deepEqual(visibleLogColumns(['firstToken','duration','netSpeed','input','cacheRead']),['duration','netSpeed','input']);
  assert.deepEqual(visibleLogColumns(['firstToken','netSpeed']),['firstToken','netSpeed']);
});

test('CSV exports subsequent timing and net speed with blank unavailable values',()=>{
  const csv=logsToCsv([log(1),log(2,{is_stream:false})],status),rows=csv.split('\r\n');
  assert.ok(rows[0].endsWith(',"后续耗时 (ms)","净速率 (t/s)"'));
  assert.ok(rows[1].endsWith(',"500","100"'));
  assert.ok(rows[2].endsWith(',"",""'));
});
