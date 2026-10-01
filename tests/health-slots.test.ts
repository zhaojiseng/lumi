import test from 'node:test';
import assert from 'node:assert/strict';
import {healthSlots} from '../shared/health';
const end=Date.parse('2026-10-01T10:30:00Z')/1000,hour=Math.floor(end/3600)*3600;
test('missing health always has exactly 24 hourly gray slots including the current hour',()=>{
  const s=healthSlots(undefined,end);assert.equal(s.length,24);assert.ok(s.every(p=>p.success_rate===null));assert.equal(s[0].ts,hour-23*3600);assert.equal(s[23].ts,hour);
});
test('sparse unordered health samples preserve hourly gaps and real zero success rate',()=>{
  const s=healthSlots([{ts:hour+60,success_rate:100},{ts:hour-2*3600+1,success_rate:0},{ts:hour-3600,success_rate:NaN},{ts:hour-24*3600,success_rate:90},{ts:hour+3600,success_rate:90}],end);
  assert.equal(s.length,24);assert.equal(s[23].success_rate,100);assert.equal(s[21].success_rate,0);assert.equal(s[22].success_rate,null);assert.equal(s.filter(p=>p.success_rate!==null).length,2);
});
test('a full day has 24 slots independent of the number of samples or rate values',()=>{
  const series=Array.from({length:40},(_,i)=>({ts:hour-i*3600,success_rate:i%2 ? 75 : 100}));const s=healthSlots(series,end);assert.equal(s.length,24);assert.ok(s.every(p=>p.success_rate!==null));
});
