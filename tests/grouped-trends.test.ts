import test from 'node:test';
import assert from 'node:assert/strict';
import {groupedTrend,tokenPoints} from '../shared/trends';
import type {UsageLog} from '../shared/types';
const now=new Date(2026,9,1,13,25),range={startDate:'2026-10-01',endDate:'2026-10-01'},status={system_name:'Fixture',quota_per_unit:100};
const at=(hour:number)=>new Date(2026,9,1,hour).getTime()/1000;
const log=(id:number,token_id:number,model_name:string,quota=100):UsageLog=>({id,token_id,model_name,token_name:'Same label',created_at:at(12),type:2,quota,prompt_tokens:10,completion_tokens:5,use_time:1,is_stream:true,group:'fixture'});
test('model and token curves preserve bucket totals, keep same-named tokens distinct and omit error logs',()=>{
  const logs=[log(1,11,'__proto__'),log(2,22,'model-b'),{...log(3,11,'model-b'),type:5}, {...log(4,11,'model-b'),created_at:at(15)}];
  const points=tokenPoints(logs,{start_timestamp:at(0),end_timestamp:Math.floor(now.getTime()/1000)});assert.equal(points.length,2);
  for(const grouping of ['model','token'] as const){const chart=groupedTrend(points,1,status,range,now,grouping,'cost');assert.equal(chart.lines.length,2);assert.equal(chart.rows.length,14);assert.equal(chart.rows.reduce((sum,row)=>sum+Object.values(row.values!).reduce((n,v)=>n+v,0),0),2);assert.ok(chart.rows.slice(0,12).every(row=>Object.values(row.values!).every(v=>v===0)));}
  const tokens=groupedTrend(points,1,status,range,now,'token','tokens','id:11');assert.equal(tokens.lines.length,1);assert.equal(tokens.rows.reduce((s,row)=>s+Object.values(row.values!).reduce((n,v)=>n+v,0),0),15);assert.match(tokens.lines[0].name,/#11/);
});
test('many grouped curves combine remaining series without dropping totals and allow every group individually',()=>{
  const points=Array.from({length:12},(_,i)=>({created_at:at(12),model_name:'model-'+i,quota:(i+1)*100,token_used:i+1,count:1}));
  const chart=groupedTrend(points,1,status,range,now,'model','cost');assert.equal(chart.options.length,12);assert.equal(chart.lines.length,9);assert.equal(chart.combined,4);assert.equal(chart.rows.reduce((n,row)=>n+Object.values(row.values!).reduce((s,v)=>s+v,0),0),78);
  const single=groupedTrend(points,1,status,range,now,'model','cost','model-0');assert.equal(single.lines.length,1);assert.equal(single.rows.at(-2)!.values?.[single.lines[0].id],1);
});
