import test from 'node:test';
import assert from 'node:assert/strict';
import {appendFile,mkdir,mkdtemp,rm,stat,writeFile} from 'node:fs/promises';
import path from 'node:path';
import {LocalSessionPages,LOCAL_PAGE_BYTES} from '../electron/services/local-session-pages';
import {LocalUsageService} from '../electron/services/local-usage';
import type {LocalSessionPage,LocalUsageProgress} from '../shared/types';
const query={startDate:'2026-10-01',endDate:'2026-10-01',startTime:'00:00',endTime:'23:59'};
const at=(second:number)=>new Date(2026,9,1,10,0,second).toISOString();
const event=(i:number)=>({type:'event_msg',timestamp:at(i),payload:{type:'token_count',info:{total_token_usage:{input_tokens:i*100,output_tokens:i*10,cached_input_tokens:i*20},last_token_usage:{input_tokens:100,output_tokens:10,cached_input_tokens:20}}}});
async function fixture(t:any,tool:'codex'|'claude'='codex'){
  const root=await mkdtemp(path.resolve('.test-data/session-pages-')),file=path.join(root,tool==='codex' ? '.codex/sessions/file.jsonl' : '.claude/projects/project/file.jsonl');
  await mkdir(path.dirname(file),{recursive:true});
  t.after(async()=>{assert.ok(path.relative(path.resolve('.test-data'),root).startsWith('session-pages-'));await rm(root,{recursive:true,force:true});});
  const pages=new LocalSessionPages();pages.register('a',file,tool);return {root,file,pages};
}
test('details bound pages to fifty calls, preserve deltas/reasoning across pages, and fix the file snapshot',async t=>{
  const f=await fixture(t);await writeFile(f.file,[{type:'turn_context',payload:{model:'gpt-fixture',effort:'high'}},...Array.from({length:125},(_,i)=>event(i+1))].map(e=>JSON.stringify(e)).join('\n')+'\n');
  const first=await f.pages.read({sessionId:'a',query});assert.equal(first.items.length,50);assert.ok(first.nextCursor);assert.equal(first.items[0].inputTokens,80);assert.equal(first.items[0].reasoning,'high');
  await appendFile(f.file,JSON.stringify(event(126))+'\n');
  const second=await f.pages.read({sessionId:'a',query,cursor:first.nextCursor});assert.equal(second.items.length,50);assert.equal(second.items[0].inputTokens,80);assert.equal(second.totalBytes,first.totalBytes);
  const last=await f.pages.read({sessionId:'a',query,cursor:second.nextCursor});assert.equal(last.items.length,25);assert.equal(last.nextCursor,undefined);assert.equal(last.scannedBytes,last.totalBytes);
  assert.ok(!JSON.stringify(first).includes(f.file));
});
test('huge lines advance the byte budget, including empty pages and partial lines, without a stuck cursor',async t=>{
  const f=await fixture(t);await writeFile(f.file,Buffer.alloc(5*1024*1024,120));await appendFile(f.file,'\n'+JSON.stringify({type:'turn_context',payload:{model:'after-huge'}})+'\n'+JSON.stringify(event(1))+'\n');
  let cursor:string|undefined,previous=0,total=0,calls=0,page:LocalSessionPage;
  do{page=await f.pages.read({sessionId:'a',query,cursor});assert.ok(page.scannedBytes>previous);assert.ok(page.scannedBytes-previous<=LOCAL_PAGE_BYTES);previous=page.scannedBytes;total+=page.items.length;cursor=page.nextCursor;calls++;assert.ok(calls<5);}while(cursor);
  assert.equal(calls,3);assert.equal(total,1);assert.equal(page!.items[0].model,'after-huge');
});
test('page boundaries retry a valid small record and stop on an unfinished EOF instead of spinning',async t=>{
  const f=await fixture(t);const filler='x'.repeat(1023)+'\n';await writeFile(f.file,filler.repeat(2047)+JSON.stringify({...event(1),padding:'x'.repeat(2048)})+'\n'+JSON.stringify(event(2)).slice(0,-30));
  const first=await f.pages.read({sessionId:'a',query});assert.equal(first.items.length,0);assert.ok(first.nextCursor);
  const second=await f.pages.read({sessionId:'a',query,cursor:first.nextCursor});assert.equal(second.items.length,1);assert.equal(second.items[0].inputTokens,80);assert.equal(second.nextCursor,undefined);assert.equal(second.scannedBytes,second.totalBytes);
});
test('details reject a mismatched session/query or modified file and apply model/token filters',async t=>{
  const f=await fixture(t);await writeFile(f.file,[{type:'turn_context',payload:{model:'allowed'}},...Array.from({length:60},(_,i)=>event(i+1))].map(e=>JSON.stringify(e)).join('\n'));
  const first=await f.pages.read({sessionId:'a',query});f.pages.register('b',f.file,'codex');
  await assert.rejects(f.pages.read({sessionId:'b',query,cursor:first.nextCursor}),/失效/);
  await assert.rejects(f.pages.read({sessionId:'a',query:{range:query,models:['else']},cursor:first.nextCursor}),/失效/);
  const filtered=await f.pages.read({sessionId:'a',query:{range:query,models:['else']}});assert.equal(filtered.items.length,0);
  assert.equal((await f.pages.read({sessionId:'a',query:{range:query,tokenIds:[1]}})).items.length,0);
  await writeFile(f.file,'{}\n');await assert.rejects(f.pages.read({sessionId:'a',query,cursor:first.nextCursor}),/修改/);
});
test('Claude streamed snapshots keep a stable record ID across pages for replacement rather than double display',async t=>{
  const f=await fixture(t,'claude');const claude=(id:string,output:number)=>({type:'assistant',timestamp:at(1),message:{id,model:'claude-fixture',usage:{input_tokens:10,output_tokens:output,cache_read_input_tokens:5,cache_creation_input_tokens:2}}});
  await writeFile(f.file,[claude('same',1),...Array.from({length:49},(_,i)=>claude('m'+i,1)),claude('same',8),claude('same',8),claude('same',2)].map(e=>JSON.stringify(e)).join('\n'));
  const first=await f.pages.read({sessionId:'a',query});const second=await f.pages.read({sessionId:'a',query,cursor:first.nextCursor});assert.equal(second.items.length,1);assert.equal(second.items[0].id,first.items[0].id);assert.equal(second.items[0].outputTokens,8);
});
test('historical scan emits actual bounded byte progress and exposes metadata-only details',async t=>{
  const f=await fixture(t);await writeFile(f.file,[{type:'turn_context',payload:{model:'progress-model'}},event(1),{type:'response_item',payload:{content:'private prompt fixture'}}].map(e=>JSON.stringify(e)).join('\n'));
  const service=new LocalUsageService(f.root),progress:Omit<LocalUsageProgress,'requestId'>[]=[];
  const result=await service.scan(query,value=>progress.push(value));assert.equal(result.sessions?.length,1);assert.equal(progress[0].phase,'discover');assert.equal(progress.at(-1)?.phase,'complete');assert.equal(progress.at(-1)?.bytesRead,(await stat(f.file)).size);assert.equal(progress.at(-1)?.bytesTotal,progress.at(-1)?.bytesRead);
  const details=await service.sessionDetails({sessionId:result.sessions![0].id,query});assert.equal(details.items.length,1);assert.ok(!JSON.stringify(details).includes('private prompt'));assert.ok(!JSON.stringify(result).includes(f.file));
});
