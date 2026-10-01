import test from 'node:test';
import assert from 'node:assert/strict';
import {usageGranularity,usageSeries} from '../shared/utils';
import {resolveRange} from '../shared/range';
const now=new Date(2026,9,1,13,25);
const status={system_name:'Test',quota_per_unit:500000};
test('dynamic resolution has predictable boundaries for any selected calendar range',() => {
 for(const [days,hours,groupDays] of [[1,1,0],[2,3,0],[3,3,0],[4,6,0],[7,6,0],[8,0,1],[31,0,1],[32,0,3],[60,0,3],[61,0,7],[90,0,7]]) {
  const grain=usageGranularity(days);assert.equal(grain.hours,hours);assert.equal(grain.days,groupDays);
 }
});
test('multi-day subdaily charts merge at bucket boundaries, preserve totals and exclude future records',() => {
 const range={startDate:'2026-09-29',endDate:'2026-10-01'};
 const point=(d:number,h:number,m=0) => ({created_at:new Date(2026,d===1 ? 9 : 8,d,h,m).getTime()/1000,model_name:'m',quota:500000,token_used:10,count:1});
 const rows=usageSeries([point(29,2,59),point(29,3),{...point(29,3),model_name:'other'},point(1,13),point(1,14),point(28,23)],7,status,range,now);
 assert.equal(rows.length,21);assert.equal(rows[0].requests,1);assert.equal(rows[1].requests,2);assert.equal(rows[1].cost,2);
 assert.equal(rows.at(-1)?.label,'10/1 12:00');assert.equal(rows.at(-1)?.tooltipLabel,'2026-10-01 12:00 – 2026-10-01 13:25');
 assert.deepEqual(rows.reduce((t,r) => [t[0]+r.cost,t[1]+r.tokens,t[2]+r.requests],[0,0,0]),[4,40,4]);
});
test('long custom windows group local calendar days and clip the final partial group',() => {
 const range={startDate:'2026-08-31',endDate:'2026-10-01'};const resolved=resolveRange(range,now);
 const rows=usageSeries([{created_at:resolved.start_timestamp,model_name:'a',quota:500000,count:1,token_used:10},{created_at:resolved.end_timestamp,model_name:'b',quota:500000,count:2,token_used:20},{created_at:resolved.start_timestamp-1,model_name:'c',quota:500000,count:3,token_used:30}],1,status,range,now);
 assert.equal(rows.length,11);assert.equal(rows[0].tooltipLabel,'2026-08-31 – 2026-09-02');assert.equal(rows.at(-1)?.tooltipLabel,'2026-09-30 – 2026-10-01');
 assert.deepEqual(rows.reduce((t,r) => [t[0]+r.cost,t[1]+r.tokens,t[2]+r.requests],[0,0,0]),[2,30,3]);
});
test('all resolutions conserve sparse source totals over month boundaries and fill missing buckets',() => {
 for(const days of [1,2,3,4,7,8,30,31,32,60,61,90]) {
  const r=resolveRange(days,now);const points=[r.start_timestamp,r.end_timestamp].map((created_at,i) => ({created_at,model_name:'m',quota:(i+1)*500000,token_used:(i+1)*100,count:i+1}));
  const rows=usageSeries(points,days,status,undefined,now);assert.equal(rows.reduce((s,r) => s+r.cost,0),3);assert.equal(rows.reduce((s,r) => s+r.tokens,0),300);assert.equal(rows.reduce((s,r) => s+r.requests,0),3);
  assert.ok(rows.every(r => r.timestamp<=now.getTime()/1000));assert.ok(rows.length<=31);assert.ok(rows.some(r => r.requests===0));
 }
});
