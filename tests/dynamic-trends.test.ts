import test from 'node:test';
import assert from 'node:assert/strict';
import {usageGranularity,usageSeries} from '../shared/utils';
import {resolveRange} from '../shared/range';
const now=new Date(2026,9,1,13,25);
const status={system_name:'Test',quota_per_unit:500000};
test('granularity divides elapsed days into thirty intervals with approximate human labels',() => {
 for(const days of [1/86400,15/86400,1/24,1,2,3,4,7,8,30,31,32,60,61,90]) {
  const grain=usageGranularity(days),seconds=Math.max(1,days*86400/30);
  assert.equal(grain.seconds,seconds);assert.equal(grain.hours,seconds/3600);assert.equal(grain.days,seconds/86400);
 }
 for(const [days,label] of [[1/86400,'约每 1 秒'],[1/24,'约每 2 分钟'],[1,'约每 48 分钟'],[2,'约每 1.6 小时'],[30,'约每 1 天'],[90,'约每 3 天']] as const)assert.equal(usageGranularity(days).label,label);
});
test('multi-day elapsed buckets include both bounds, assign exact edges once and exclude invalid timestamps',() => {
 const range={startDate:'2026-09-29',endDate:'2026-10-01'},w=resolveRange(range,now);
 // The inclusive window is 221101 seconds: the first edge is 02:02:50, not an hour boundary.
 const edge=w.start_timestamp+7370;
 const points=[edge-1,edge,edge,w.end_timestamp,w.start_timestamp-1,w.end_timestamp+1,NaN,Infinity].map((created_at,i)=>({created_at,model_name:i===2 ? 'other' : 'm',quota:500000,token_used:10,count:1}));
 const rows=usageSeries(points,7,status,range,now);
 assert.equal(rows.length,30);assert.equal(rows[0].requests,1);assert.equal(rows[1].requests,2);assert.equal(rows[1].cost,2);
 assert.equal(rows[0].end_timestamp,edge-1);assert.equal(rows[1].timestamp,edge);assert.equal(rows[1].label,'9/29 02:02');
 assert.equal(rows.at(-1)?.end_timestamp,w.end_timestamp);
 assert.equal(rows.at(-1)?.label,'10/1 11:22');assert.equal(rows.at(-1)?.tooltipLabel,'2026-10-01 11:22 – 2026-10-01 13:25');
 assert.deepEqual(rows.reduce((t,r) => [t[0]+r.cost,t[1]+r.tokens,t[2]+r.requests],[0,0,0]),[4,40,4]);
});
test('long custom windows retain elapsed bucket starts across months without snapping to calendar days',() => {
 const range={startDate:'2026-08-31',endDate:'2026-10-01'};const resolved=resolveRange(range,now);
 const rows=usageSeries([{created_at:resolved.start_timestamp,model_name:'a',quota:500000,count:1,token_used:10},{created_at:resolved.end_timestamp,model_name:'b',quota:500000,count:2,token_used:20},{created_at:resolved.start_timestamp-1,model_name:'c',quota:500000,count:3,token_used:30},{created_at:resolved.end_timestamp+1,model_name:'c',quota:500000,count:3,token_used:30}],1,status,range,now);
 assert.equal(rows.length,30);assert.equal(rows[0].tooltipLabel,'2026-08-31 00:00 – 2026-09-01 01:14');assert.equal(rows.at(-1)?.tooltipLabel,'2026-09-30 12:10 – 2026-10-01 13:25');
 assert.equal(rows[1].timestamp,resolved.start_timestamp+90890);assert.equal(rows[1].label,'9/1');
 assert.equal(rows[0].requests,1);assert.equal(rows.at(-1)?.requests,2);
 assert.deepEqual(rows.reduce((t,r) => [t[0]+r.cost,t[1]+r.tokens,t[2]+r.requests],[0,0,0]),[2,30,3]);
});
test('all resolutions conserve sparse source totals over month boundaries and fill missing buckets',() => {
 for(const days of [1,2,3,4,7,8,30,31,32,60,61,90]) {
  const r=resolveRange(days,now);const points=[r.start_timestamp,r.end_timestamp].map((created_at,i) => ({created_at,model_name:'m',quota:(i+1)*500000,token_used:(i+1)*100,count:i+1}));
  const rows=usageSeries(points,days,status,undefined,now);assert.equal(rows.reduce((s,r) => s+r.cost,0),3);assert.equal(rows.reduce((s,r) => s+r.tokens,0),300);assert.equal(rows.reduce((s,r) => s+r.requests,0),3);
  const duration=r.end_timestamp-r.start_timestamp+1;
  assert.equal(rows.length,30);assert.deepEqual(rows.map(row=>row.timestamp),Array.from({length:30},(_,i)=>r.start_timestamp+Math.floor(i*duration/30)));
  assert.deepEqual(rows.map(row=>row.end_timestamp),Array.from({length:30},(_,i)=>r.start_timestamp+Math.floor((i+1)*duration/30)-1));
  assert.ok(rows.every((row,i)=>row.end_timestamp>=row.timestamp && (i===0 || row.timestamp===rows[i-1].end_timestamp+1)));
  assert.equal(rows.at(-1)?.end_timestamp,r.end_timestamp);
  assert.ok(rows.every(r => r.timestamp<=r.end_timestamp));assert.ok(rows.some(r => r.requests===0));
 }
});

test('very short and uneven windows partition every inclusive second exactly once',()=>{
 const start=new Date(2026,9,1,12).getTime()/1000,range={startDate:'2026-10-01',endDate:'2026-10-01',startTime:'12:00'};
 for(const duration of [1,2,7,29,30,31,61]) {
  const clock=new Date((start+duration-1)*1000+999),bucketCount=Math.min(30,duration);
  const points=Array.from({length:duration},(_,i)=>({created_at:start+i,model_name:'m',quota:500000,token_used:10,count:1}));
  const rows=usageSeries(points,1,status,range,clock);
  const offsets=Array.from({length:bucketCount+1},(_,i)=>Math.floor(i*duration/bucketCount));
  assert.equal(rows.length,bucketCount,`duration ${duration}`);
  assert.deepEqual(rows.map(row=>row.timestamp),offsets.slice(0,-1).map(offset=>start+offset));
  assert.deepEqual(rows.map(row=>row.end_timestamp),offsets.slice(1).map(offset=>start+offset-1));
  assert.equal(rows.reduce((sum,row)=>sum+row.end_timestamp-row.timestamp+1,0),duration);
  assert.deepEqual(rows.map(row=>[row.cost,row.tokens,row.requests]),offsets.slice(1).map((end,i)=>{const width=end-offsets[i];return [width,width*10,width];}));
  assert.equal(rows[0].label,'10/1 12:00:00');
  const seconds=String(duration-1).padStart(2,'0');
  if(duration<=30)assert.equal(rows.at(-1)?.label,`10/1 12:00:${seconds}`);
 }
 const rows=usageSeries([],1,status,range,new Date((start+60)*1000));
 assert.equal(rows.at(-1)?.tooltipLabel,'2026-10-01 12:00:58 – 2026-10-01 12:01:00');
});
