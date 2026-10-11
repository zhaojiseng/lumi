import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdir,mkdtemp,rm,writeFile} from 'node:fs/promises';
import path from 'node:path';
import {LocalUsageService} from '../electron/services/local-usage';
import {LocalSessionPages} from '../electron/services/local-session-pages';
import type {Tool} from '../shared/types';

async function fixture(t:{after(fn:()=>Promise<void>):void},tool:Tool){
  const root=path.resolve('.test-data'),home=await mkdtemp(path.join(root,'local-resilience-'));
  const file=path.join(home,tool==='codex' ? '.codex/sessions/fixture.jsonl' : '.claude/projects/fixture/session.jsonl');
  await mkdir(path.dirname(file),{recursive:true});
  const service=new LocalUsageService(home),now=Date.now(),start=Math.floor(now/60000)*60-60;
  t.after(async()=>{service.close();assert.equal(path.dirname(home),root);await rm(home,{recursive:true,force:true});});
  const event=(i:number)=>tool==='codex'
    ? {type:'event_msg',timestamp:new Date((start+10)*1000).toISOString(),payload:{type:'token_count',info:{model:'fixture',total_token_usage:{input_tokens:i*100,output_tokens:i*10,cached_input_tokens:i*20}}}}
    : {type:'assistant',timestamp:new Date((start+10)*1000).toISOString(),message:{id:'message-'+i,model:'fixture',usage:{input_tokens:80,output_tokens:10,cache_read_input_tokens:20}}};
  const write=async(events:unknown[])=>writeFile(file,events.map(value=>JSON.stringify(value)).join('\n')+'\n');
  return {home,file,service,now,event,write};
}

for(const tool of ['codex','claude'] as const){
  test(`${tool} historical scanning skips non-object JSON and retains subsequent usage`,async t=>{
    const f=await fixture(t,tool);await f.write([f.event(1),null,[],42,'unknown',false,f.event(2)]);
    const result=await f.service.scan('24h');
    assert.equal(result.filesScanned,1);assert.deepEqual(result.warnings,[]);
    assert.equal(result.rows.length,1);assert.equal(result.rows[0].requests,2);
    assert.equal(result.rows[0].inputTokens,160);assert.equal(result.rows[0].cacheReadTokens,40);
    assert.equal(result.sessions?.[0].requests,2);
  });

  test(`${tool} widget scanning skips non-object JSON in its first read`,async t=>{
    const f=await fixture(t,tool);await f.write([f.event(1),null,[],42,'unknown',false,f.event(2)]);
    const result=await f.service.widgetUsage(f.now);
    assert.deepEqual(result.warnings,[]);assert.equal(result.minute?.requests,2);
    assert.equal(result.minute?.models[0].inputTokens,160);assert.equal(result.minute?.models[0].cacheReadTokens,40);
    assert.deepEqual((await f.service.widgetUsage(f.now)).minute,result.minute,'repeated reads must not duplicate usage');
  });

  test(`${tool} compatibility details advance past non-object JSON`,async t=>{
    const f=await fixture(t,tool);await f.write([f.event(1),null,[],42,'unknown',false,f.event(2)]);
    const pages=new LocalSessionPages();pages.register('fixture',f.file,tool);
    const result=await pages.read({sessionId:'fixture',query:'24h'});
    assert.equal(result.items.length,2);assert.equal(result.scannedBytes,result.totalBytes);
    assert.equal(result.nextCursor,undefined);assert.equal(result.items[1].inputTokens,80);
  });
}

test('historical scanning registers each long session once with final metadata and complete totals',async t=>{
  const f=await fixture(t,'codex'),count=3000;
  await f.write([...Array.from({length:count},(_,i)=>f.event(i+1)),{type:'session_meta',payload:{title:'Final title',cwd:'/fixture/project'}}]);
  const register=t.mock.method(f.service.sessionStore,'register');
  const result=await f.service.scan('24h');
  assert.equal(result.rows[0].requests,count);assert.equal(result.rows[0].inputTokens,count*80);
  assert.equal(result.sessions?.length,1);assert.equal(result.sessions?.[0].metadata?.title,'Final title');
  assert.equal(register.mock.callCount(),1,'registration work should be per file rather than per usage record');
  assert.equal(register.mock.calls[0].arguments[3]?.title,'Final title');
  const details=await f.service.sessionDetails({sessionId:result.sessions![0].id,query:'24h'});
  assert.equal(details.items.length,50);assert.ok(details.nextCursor);
});
