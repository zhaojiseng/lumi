import test from 'node:test';
import assert from 'node:assert/strict';
import {appendFile,mkdir,mkdtemp,rm,writeFile} from 'node:fs/promises';
import path from 'node:path';
import {LocalUsageService} from '../electron/services/local-usage';
import {widgetPeriodWindow} from '../shared/widget-period';
import {formattedWidget} from '../shared/widget';
const now=new Date(2026,9,2,13,25,30).getTime(),current=Math.floor(now/60000)*60;
const token=(at:number,i:number)=>({type:'event_msg',timestamp:new Date(at*1000).toISOString(),payload:{type:'token_count',info:{total_token_usage:{input_tokens:i*100,output_tokens:i*10,cached_input_tokens:i*20},last_token_usage:{input_tokens:100,output_tokens:10,cached_input_tokens:20}}}});
async function fixture(t:any){const home=await mkdtemp(path.resolve('.test-data/local-periods-'));const file=path.join(home,'.codex','sessions','rollout.jsonl');await mkdir(path.dirname(file),{recursive:true});t.after(()=>rm(home,{recursive:true,force:true}));return {home,file,service:new LocalUsageService(home)};}
test('range switches reuse read pointers and quotes; latest is a single current call and input normalization never accumulates',async t=>{
  const f=await fixture(t),events=[{type:'turn_context',payload:{model:'fixture'}},token(current-3600,1),token(current-120,2),token(current-40,3),token(current+10,4)];await writeFile(f.file,events.map(e=>JSON.stringify(e)).join('\n')+'\n');
  let quotes=0;const pricing={revision:'r1',quote:(_tool:unknown,_model:unknown,facts:any)=>{quotes++;return facts.inputTokens+facts.outputTokens*2+facts.cacheReadTokens*.1;}};
  const minute=await f.service.widgetUsage(now,{...pricing,period:60});assert.equal(minute.minute?.quota,102);assert.equal(minute.minute?.models[0].inputTokens,100);assert.equal(minute.minute?.latestModel?.inputTokens,100);assert.equal(quotes,4);
  const long=await f.service.widgetUsage(now,{...pricing,period:2592000});assert.equal(long.minute?.requests,3);assert.equal(long.minute?.quota,306);assert.equal(long.minute?.models[0].inputTokens,300);assert.equal(quotes,4,'period changes never rescan or requote');
  for(let i=0;i<3;i++){const latest=await f.service.widgetUsage(now,{...pricing,period:'latest'});assert.equal(latest.minute?.requests,1);assert.equal(latest.minute?.start,current+10);assert.equal(latest.minute?.models[0].inputTokens,100);assert.equal(latest.minute?.latestModel?.inputTokens,100);assert.equal(latest.minute?.quota,102);}
  assert.equal(quotes,4);
  const context={...minute,status:{system_name:'Fixture',quota_per_unit:1},balance:10};const options={enabled:true,viewKey:'fixture',theme:'light' as const};
  assert.equal(formattedWidget('ready',context,{...options,inputMode:'total'}).models[0].input,'100');assert.equal(formattedWidget('ready',context,{...options,inputMode:'uncached'}).models[0].input,'80');
  await appendFile(f.file,JSON.stringify(token(current+20,5))+'\n');const next=await f.service.widgetUsage(now,{...pricing,period:'latest'});assert.equal(next.minute?.requests,1);assert.equal(next.minute?.start,current+20);assert.equal(quotes,5);
});
test('one minute fallback and explicit empty ranges remain distinct; unknown price never becomes invented zero',async t=>{
  const f=await fixture(t);await writeFile(f.file,[{type:'turn_context',payload:{model:'unpriced'}},token(current-3600,1)].map(e=>JSON.stringify(e)).join('\n'));
  const quote=()=>null;
  const one=await f.service.widgetUsage(now,{period:60,revision:'r',quote});assert.equal(one.historical,true);assert.equal(one.minute?.quotaKnown,false);assert.equal(one.minute?.latestModel?.inputTokens,100);
  assert.equal(formattedWidget('ready',one,{enabled:true,viewKey:'r',theme:'light'}).cost,'—');
  const empty=await f.service.widgetUsage(now,{period:180,revision:'r',quote});assert.equal(empty.minute,null);assert.equal(empty.historical,false);
});
test('widget windows always cover complete minutes except the latest single call',()=>{
  assert.deepEqual(widgetPeriodWindow(60,now),{start_timestamp:current-60,end_timestamp:current-1});assert.deepEqual(widgetPeriodWindow(1800,now),{start_timestamp:current-1800,end_timestamp:current-1});assert.deepEqual(widgetPeriodWindow('latest',now),{start_timestamp:0,end_timestamp:Math.floor(now/1000)});
});


test('Claude snapshots crossing a minute replace the same call and keep its original pricing time',async t=>{
  const f=await fixture(t),file=path.join(f.home,'.claude/projects/project/cross-minute.jsonl');await mkdir(path.dirname(file),{recursive:true});
  const event=(timestamp:number,output:number)=>({type:'assistant',timestamp:new Date(timestamp*1000).toISOString(),message:{id:'streamed-call',model:'claude',usage:{input_tokens:10,output_tokens:output,cache_read_input_tokens:5,cache_creation_input_tokens:2}}});
  await writeFile(file,JSON.stringify(event(current-30,1))+'\n');
  const pricing={revision:'r',quote:(_tool:unknown,_model:unknown,facts:any)=>facts.outputTokens===1 ? null : facts.createdAt<current ? facts.outputTokens : 999};
  const first=await f.service.widgetUsage(now,{...pricing,period:180});assert.equal(first.minute?.requests,1);assert.equal(first.minute?.quotaKnown,false);
  await appendFile(file,JSON.stringify(event(current+10,8))+'\n');
  const updated=await f.service.widgetUsage(now,{...pricing,period:180});assert.equal(updated.minute?.requests,1);assert.equal(updated.minute?.quota,8);assert.equal(updated.minute?.quotaKnown,true);assert.equal(updated.minute?.models[0].inputTokens,15);assert.equal(updated.minute?.models[0].outputTokens,8);
  const latest=await f.service.widgetUsage(now,{...pricing,period:'latest'});assert.equal(latest.minute?.requests,1);assert.equal(latest.minute?.start,current-30);assert.equal(latest.minute?.quota,8);
});
