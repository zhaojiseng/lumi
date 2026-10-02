import test from 'node:test';
import assert from 'node:assert/strict';
import {appendFile, mkdtemp, mkdir, rm, writeFile} from 'node:fs/promises';
import path from 'node:path';
import {LocalUsageService} from '../electron/services/local-usage';

async function fixture(prefix:string) {
  const home=await mkdtemp(path.resolve('.test-data',prefix));
  return {home,cleanup:()=>rm(home,{recursive:true,force:true})};
}

function codexToken(timestamp:string,total:{input_tokens:number;output_tokens:number;cached_input_tokens:number;cache_creation_input_tokens?:number}) {
  return {type:'event_msg',timestamp,payload:{type:'token_count',info:{total_token_usage:total}}};
}

test('local widget usage streams Codex and Claude sessions with cache metrics',async t=>{
  const f=await fixture('local-widget-');t.after(f.cleanup);
  const now=Date.now(),currentStart=Math.floor(now/60000)*60,targetStart=currentStart-60;
  const at=(offset:number)=>new Date((targetStart+offset)*1000).toISOString();
  const codexDir=path.join(f.home,'.codex','sessions'),claudeDir=path.join(f.home,'.claude','projects','fixture');
  await mkdir(codexDir,{recursive:true});await mkdir(claudeDir,{recursive:true});
  await writeFile(path.join(codexDir,'rollout.jsonl'),[
    {type:'session_meta',payload:{id:'codex-session'}},
    {type:'turn_context',payload:{model:'gpt-fixture'}},
    codexToken(at(10),{input_tokens:100,output_tokens:20,cached_input_tokens:25,cache_creation_input_tokens:2}),
    codexToken(at(10),{input_tokens:100,output_tokens:20,cached_input_tokens:25,cache_creation_input_tokens:2}),
    codexToken(at(40),{input_tokens:160,output_tokens:30,cached_input_tokens:35,cache_creation_input_tokens:5}),
  ].map(event=>JSON.stringify(event)).join('\n')+'\n');
  const claude=(output:number)=>({type:'assistant',timestamp:at(20),sessionId:'claude-session',message:{id:'message-1',model:'claude-fixture',usage:{input_tokens:20,output_tokens:output,cache_read_input_tokens:4,cache_creation_input_tokens:2}}});
  await writeFile(path.join(claudeDir,'session.jsonl'),[claude(4),claude(9)].map(event=>JSON.stringify(event)).join('\n')+'\n');

  const result=await new LocalUsageService(f.home).widgetUsage(now);
  assert.equal(result.source,'local');assert.equal(result.historical,false);assert.equal(result.minute?.start,targetStart);
  assert.equal(result.minute?.requests,3);assert.equal(result.minute?.quota,230);
  assert.deepEqual(result.minute?.models.map(m=>[m.name,m.requests,m.inputTokens,m.outputTokens,m.cacheReadTokens,m.cacheWriteTokens]),[
    ['gpt-fixture',2,125,30,35,5],['claude-fixture',1,20,9,4,2],
  ]);
});

test('local widget usage falls back to the newest earlier minute',async t=>{
  const f=await fixture('local-widget-fallback-');t.after(f.cleanup);
  const now=Date.now(),currentStart=Math.floor(now/60000)*60,targetStart=currentStart-60,olderStart=targetStart-120;
  const file=path.join(f.home,'.codex','sessions','fallback.jsonl');await mkdir(path.dirname(file),{recursive:true});
  await writeFile(file,[
    {type:'turn_context',payload:{model:'fallback-model'}},
    codexToken(new Date((olderStart+12)*1000).toISOString(),{input_tokens:30,output_tokens:4,cached_input_tokens:6}),
  ].map(event=>JSON.stringify(event)).join('\n')+'\n');
  const result=await new LocalUsageService(f.home).widgetUsage(now);
  assert.equal(result.historical,true);assert.equal(result.minute?.start,olderStart);assert.equal(result.minute?.quota,34);
  assert.equal(result.minute?.models[0].cacheReadTokens,6);
});

test('local widget usage resumes from the saved read offset when a session grows',async t=>{
  const f=await fixture('local-widget-cursor-');t.after(f.cleanup);
  const now=Date.now(),currentStart=Math.floor(now/60000)*60,targetStart=currentStart-60;
  const file=path.join(f.home,'.codex','sessions','cursor.jsonl');await mkdir(path.dirname(file),{recursive:true});
  await writeFile(file,[
    {type:'turn_context',payload:{model:'cursor-model'}},
    codexToken(new Date((targetStart+10)*1000).toISOString(),{input_tokens:100,output_tokens:10,cached_input_tokens:0}),
  ].map(event=>JSON.stringify(event)).join('\n')+'\n');
  const service=new LocalUsageService(f.home);
  const first=await service.widgetUsage(now);
  assert.equal(first.minute?.requests,1);assert.equal(first.minute?.quota,110);
  await appendFile(file,JSON.stringify(codexToken(new Date((targetStart+40)*1000).toISOString(),{input_tokens:150,output_tokens:15,cached_input_tokens:0}))+'\n');
  const second=await service.widgetUsage(now);
  assert.equal(second.minute?.requests,2);assert.equal(second.minute?.quota,165);assert.equal(second.minute?.models[0].inputTokens,150);
});

test('local historical usage reads a JSONL file larger than 32 MiB',async t=>{
  const f=await fixture('local-widget-large-');t.after(f.cleanup);
  const dir=path.join(f.home,'.codex','sessions');await mkdir(dir,{recursive:true});
  const timestamp=new Date().toISOString();
  const header=[
    {type:'turn_context',payload:{model:'large-file-model'}},
    codexToken(timestamp,{input_tokens:100,output_tokens:10,cached_input_tokens:20}),
  ].map(event=>JSON.stringify(event)).join('\n')+'\n';
  // Keep the filler invalid and line-delimited so the parser can discard it
  // immediately while the stream still has to traverse the complete file.
  const filler=Buffer.alloc(33*1024*1024,0x78);
  await writeFile(path.join(dir,'large.jsonl'),Buffer.concat([Buffer.from(header),filler,Buffer.from('\n')]));
  const result=await new LocalUsageService(f.home).scan(1);
  assert.equal(result.filesScanned,1);assert.equal(result.rows.length,1);assert.equal(result.rows[0].inputTokens,80);
});
