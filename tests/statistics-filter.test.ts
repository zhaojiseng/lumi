import test from 'node:test';
import assert from 'node:assert/strict';
import {filterLogs,logStat} from '../shared/statistics';
import {resolveRange} from '../shared/range';
import {usageSeries} from '../shared/utils';
import {validSelectionValue,normalizeSelections} from '../shared/selections';
import type {UsageLog} from '../shared/types';
const row=(id:number,model:string,token:number,type=2):UsageLog=>({id,created_at:0,type,model_name:model,token_name:'Same name',token_id:token,prompt_tokens:10,completion_tokens:5,quota:100,use_time:2,is_stream:true,group:'test'});
test('statistics OR each multi-selection and AND models with real token IDs, including duplicate names',()=>{
  const rows=[row(1,'a',1),row(2,'b',1),row(3,'a',2),row(4,'b',3),row(5,'c',2),row(6,'b',2,5)];
  const selected=filterLogs(rows,{models:['a','b'],tokenIds:[2,3]});assert.deepEqual(selected.map(r=>r.id),[3,4,6]);
  assert.equal(logStat(selected,{start_timestamp:0,end_timestamp:119}).quota,200);
  assert.equal(logStat(selected,{start_timestamp:0,end_timestamp:119}).rpm,1);
  assert.deepEqual(filterLogs(rows,{}),rows);assert.deepEqual(filterLogs(rows,{models:['a']}).map(r=>r.id),[1,3]);
  assert.throws(()=>filterLogs([{...rows[0],token_id:undefined}],{tokenIds:[1]}),/令牌 ID/);
});
test('minute windows include the complete end minute, clip current time, cross dates and reject malformed times',()=>{
  const now=new Date(2026,9,1,16,24,37),query={startDate:'2026-10-01',endDate:'2026-10-01',startTime:'15:20',endTime:'16:22'};
  const window=resolveRange(query,now);assert.equal(new Date(window.start_timestamp*1000).getMinutes(),20);assert.equal(new Date(window.end_timestamp*1000).getSeconds(),59);
  assert.equal(window.end_timestamp-window.start_timestamp+1,63*60);
  assert.equal(resolveRange({...query,endTime:'16:24'},now).end_timestamp,now.getTime()/1000);
  assert.equal(resolveRange({...query,startDate:'2026-09-30',startTime:'23:58',endTime:'00:02'},now).end_timestamp-resolveRange({...query,startDate:'2026-09-30',startTime:'23:58',endTime:'00:02'},now).start_timestamp+1,300);
  for(const startTime of ['24:00','01:60','9:01','nope','17:00'])assert.throws(()=>resolveRange({...query,startTime},now));
});
test('minute charts adapt to actual duration, retain bounds and totals across midnight',()=>{
  const now=new Date(2026,9,1,16),range={startDate:'2026-09-30',endDate:'2026-10-01',startTime:'23:58',endTime:'00:27'},w=resolveRange(range,now);
 const midnight=new Date(2026,9,1).getTime()/1000;
 const rows=usageSeries([w.start_timestamp-1,w.start_timestamp,midnight-1,midnight,w.end_timestamp,w.end_timestamp+1].map(created_at=>({created_at,model_name:'a',quota:100,token_used:5,count:1})),2,{system_name:'test',quota_per_unit:100},range,now);
 assert.equal(rows.length,30);assert.deepEqual(rows.reduce((s,r)=>[s[0]+r.cost,s[1]+r.tokens,s[2]+r.requests],[0,0,0]),[4,20,4]);
 assert.deepEqual(rows.map(row=>row.timestamp),Array.from({length:30},(_,i)=>w.start_timestamp+i*60));
 assert.deepEqual(rows.map(row=>row.end_timestamp),Array.from({length:30},(_,i)=>w.start_timestamp+(i+1)*60-1));
 assert.equal(rows[0].label,'9/30 23:58');assert.equal(rows[1].tooltipLabel,'2026-09-30 23:59 – 2026-09-30 23:59');
 assert.equal(rows[2].label,'10/1 00:00');assert.equal(rows[2].date,'2026-10-01');
 assert.deepEqual([rows[0].requests,rows[1].requests,rows[2].requests,rows.at(-1)?.requests],[1,1,1,1]);
 assert.equal(rows.at(-1)?.tooltipLabel,'2026-10-01 00:27 – 2026-10-01 00:27');
});
test('multi-select and minute preferences survive normalization while invalid arrays, extra fields and times are dropped',()=>{
  const valid={startDate:'2026-09-01',endDate:'2026-09-02',startTime:'09:05',endTime:'18:45'};
  assert.equal(validSelectionValue(['gpt-a','gpt-b']),true);assert.equal(validSelectionValue(valid),true);
  for(const value of [['a','a'],[1],Array.from({length:501},(_,i)=>String(i)),{...valid,startTime:'24:00'},{...valid,other:1}])assert.equal(validSelectionValue(value),false);
  assert.deepEqual(normalizeSelections({site:{models:['a','b'],range:valid,bad:['a','a']}}),{site:{models:['a','b'],range:valid}});
});
