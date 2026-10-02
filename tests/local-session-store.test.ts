import test,{type TestContext} from 'node:test';
import assert from 'node:assert/strict';
import {createHash,randomUUID} from 'node:crypto';
import {appendFile,lstat,mkdir,mkdtemp,open,readFile,readdir,rename,rm,symlink,truncate,utimes,writeFile} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {LocalSessionStore} from '../electron/services/local-session-store';
import type {DashboardQuery,LocalSessionContentPage,LocalSessionEvent,LocalSessionProgress,LocalSessionRecord,Tool} from '../shared/types';

// All session fixtures and even the store's temporary SQLite indexes stay under .test-data.
// No LocalUsageService/discovery is used: these tests never inspect a real session directory.
const BASE=path.resolve('.test-data'),BLOCK=64*1024;
const range={startDate:'2026-10-01',endDate:'2026-10-01',startTime:'00:00',endTime:'23:59'};
const at=(seconds=0)=>new Date(2026,9,1,10,0,seconds).toISOString();
const jsonl=(events:unknown[])=>events.map(event=>JSON.stringify(event)).join('\n')+'\n';
const digest=(value:string|Buffer)=>createHash('sha256').update(value).digest('hex');
const user=(text:string)=>({type:'response_item',timestamp:at(),payload:{type:'message',role:'user',content:[{type:'input_text',text}]}});
const answer=(text:string)=>({type:'response_item',timestamp:at(),payload:{type:'message',role:'assistant',content:[{type:'output_text',text}]}});
const turn=(id:string,model='gpt-fixture')=>({type:'turn_context',timestamp:at(),payload:{turn_id:id,model,effort:'high'}});
function usage(index:number,model?:string,timestamp=at(index)){
  return {type:'event_msg',timestamp,payload:{type:'token_count',info:{...(model ? {model} : {}),
    total_token_usage:{input_tokens:index*100,output_tokens:index*10,cached_input_tokens:index*20},
    last_token_usage:{input_tokens:100,output_tokens:10,cached_input_tokens:20}}}};
}
const claudeUser=(text:string,id='u')=>({type:'user',uuid:id,timestamp:at(),message:{role:'user',content:[{type:'text',text}]}});
function claude(id:string,output=1,text=id,content:unknown[]=[{type:'text',text}],timestamp=at(1)){
  return {type:'assistant',timestamp,message:{id,role:'assistant',model:'claude-fixture',content,
    usage:{input_tokens:10,output_tokens:output,cache_read_input_tokens:5,cache_creation_input_tokens:2}}};
}
const toolResult=(id:string,text:string)=>({type:'user',timestamp:at(2),message:{role:'user',content:[{type:'tool_result',tool_use_id:id,content:text}]}});

async function fixture(t:TestContext,tool:Tool='codex'){
  await mkdir(BASE,{recursive:true});
  const root=await mkdtemp(path.join(BASE,'session-store-')),tmp=path.join(root,'tmp'),file=path.join(root,'synthetic.jsonl');
  await mkdir(tmp);t.mock.method(os,'tmpdir',()=>tmp);
  const store=new LocalSessionStore(),sessionId=digest(root);store.register(sessionId,file,tool);
  t.after(async()=>{
    try{
      store.close();
      for(let i=0;i<100 && (await readdir(tmp)).length;i++)await new Promise(resolve=>setTimeout(resolve,10));
      assert.deepEqual(await readdir(tmp),[],'release/close must remove all temporary indexes');
    }finally{
      const relative=path.relative(BASE,root);
      assert.ok(relative.startsWith('session-store-') && !relative.includes(path.sep),'cleanup stays within this test fixture');
      await rm(root,{recursive:true,force:true});
    }
  });
  const load=(query:DashboardQuery=range,notify?:(progress:LocalSessionProgress)=>void,requestId=randomUUID())=>store.load({sessionId,query,requestId},notify);
  return {root,tmp,file,store,sessionId,load};
}
async function records(store:LocalSessionStore,snapshotId:string,pageSize=37){
  const items:LocalSessionRecord[]=[];let total=0;
  for(let page=1;page<=1000;page++){
    const result=await store.records({snapshotId,page,pageSize});total=result.total;
    assert.equal(result.page,page);assert.equal(result.pageSize,pageSize);assert.ok(result.items.length<=pageSize);
    items.push(...result.items);if(items.length>=total){assert.equal(items.length,total);return items;}
    assert.ok(result.items.length,'pagination must advance before all records are reached');
  }
  assert.fail('record pagination did not terminate');
}
async function content(store:LocalSessionStore,snapshotId:string,recordId?:string,pageSize=13){
  const items:LocalSessionEvent[]=[];let total=0,association:LocalSessionContentPage['association']='session';
  for(let page=1;page<=1000;page++){
    const result=await store.content({snapshotId,recordId,page,pageSize});total=result.total;association=result.association;
    assert.equal(result.page,page);assert.equal(result.pageSize,pageSize);assert.ok(result.items.length<=pageSize);
    items.push(...result.items);if(items.length>=total){assert.equal(items.length,total);return {items,total,association};}
    assert.ok(result.items.length,'content pagination must advance');
  }
  assert.fail('content pagination did not terminate');
}
async function rawEquals(store:LocalSessionStore,snapshotId:string,eventId:string,expected:Buffer){
  const hash=createHash('sha256');let offset=0,pages=0;
  while(true){
    const result=await store.raw({snapshotId,eventId,offset});pages++;
    assert.equal(result.offset,offset);assert.equal(result.totalBytes,expected.length);
    assert.ok(Buffer.byteLength(result.text)<=BLOCK);assert.ok(!result.text.includes('\ufffd'),'raw UTF-8 pages must not split a character');
    hash.update(result.text);
    if(result.nextOffset===undefined){assert.equal(offset+Buffer.byteLength(result.text),expected.length);break;}
    assert.equal(result.nextOffset,offset+Buffer.byteLength(result.text));assert.ok(result.nextOffset>offset);
    assert.ok(pages<=Math.ceil(expected.length/(BLOCK-4))+1,'raw byte offsets must advance');offset=result.nextOffset;
  }
  assert.equal(hash.digest('hex'),digest(expected),'every original byte, including line endings, is reachable');return pages;
}
const texts=(items:LocalSessionEvent[])=>items.map(item=>item.text).join('\n');

test('one complete scan exposes every call beyond 200 and bounds record/content pages',async t=>{
  const f=await fixture(t),count=617;
  await writeFile(f.file,jsonl([turn('bulk'),...Array.from({length:count},(_,i)=>usage(i+1))]));
  const snapshot=await f.load();assert.equal(snapshot.total,count);assert.equal(snapshot.eventTotal,count+1);
  const items=await records(f.store,snapshot.snapshotId);assert.equal(items.length,count);assert.equal(new Set(items.map(item=>item.id)).size,count);
  assert.ok(items.every(item=>item.inputTokens===80 && item.outputTokens===10 && item.cacheReadTokens===20 && item.contextTokens===100 && item.reasoning==='high'));
  assert.equal(items[0].created_at,Date.parse(at(count))/1000);assert.equal(items.at(-1)!.created_at,Date.parse(at(1))/1000);
  const events=await content(f.store,snapshot.snapshotId);assert.equal(events.total,count+1);assert.equal(new Set(events.items.map(item=>item.id)).size,count+1);
  assert.equal((await f.store.records({snapshotId:snapshot.snapshotId,page:1,pageSize:999})).items.length,50);
  assert.equal((await f.store.content({snapshotId:snapshot.snapshotId,page:1,pageSize:999})).items.length,20);
  assert.deepEqual((await f.store.records({snapshotId:snapshot.snapshotId,page:100,pageSize:50})).items,[]);
  assert.deepEqual((await f.store.content({snapshotId:snapshot.snapshotId,page:100,pageSize:20})).items,[]);
});

test('Claude streamed messages separated by over 512 events keep only final text and maximum usage',async t=>{
  const f=await fixture(t,'claude');
  const filler=Array.from({length:530},(_,i)=>({type:'system',timestamp:at(),subtype:'synthetic-'+i}));
  // A stable producer index makes arbitrary draft/final text a proven revision of one block.
  const streamed=(output:number,text:string)=>claude('stream',output,'',[{type:'text',index:0,text}]);
  await writeFile(f.file,jsonl([claudeUser('original user'),streamed(1,'draft'),...filler,
    streamed(9,'final'),streamed(2,'regressive'),streamed(9,'final replacement')]));
  const snapshot=await f.load(),items=await records(f.store,snapshot.snapshotId);assert.equal(snapshot.total,1);assert.equal(items.length,1);
  assert.equal(items[0].outputTokens,9);assert.equal(items[0].contextTokens,17);assert.equal(items[0].cacheWriteTokens,2);
  const events=await content(f.store,snapshot.snapshotId);assert.equal(events.total,filler.length+2);
  assert.equal(events.items.filter(item=>item.role==='assistant').length,1);
  assert.ok(texts(events.items).includes('final replacement'));assert.ok(!texts(events.items).includes('draft'));assert.ok(!texts(events.items).includes('regressive'));
  const related=await content(f.store,snapshot.snapshotId,items[0].id);assert.equal(related.association,'message');
  assert.ok(texts(related.items).includes('original user'));assert.ok(texts(related.items).includes('final replacement'));
});

test('Claude rows for different content blocks of one message preserve thinking, text and tool calls across 512 events',async t=>{
  const f=await fixture(t,'claude'),filler=Array.from({length:520},()=>({type:'system',subtype:'synthetic gap'}));
  await writeFile(f.file,jsonl([claudeUser('multi-block user'),
    claude('multi-block',1,'',[{type:'thinking',thinking:'first block thinking',signature:'opaque signature'}],at(1)),...filler,
    claude('multi-block',8,'',[{type:'text',text:'second block answer'}],at(2)),
    claude('multi-block',8,'',[{type:'tool_use',id:'multi-tool',name:'Read',input:{file_path:'third-block.txt'}}],at(3)),
    toolResult('multi-tool','third block tool result')]));
  const snapshot=await f.load(),calls=await records(f.store,snapshot.snapshotId);assert.equal(calls.length,1);assert.equal(calls[0].outputTokens,8);
  assert.equal(calls[0].created_at,Date.parse(at(1))/1000,'one message keeps its original timestamp');
  const session=await content(f.store,snapshot.snapshotId),related=await content(f.store,snapshot.snapshotId,calls[0].id);
  for(const page of [session,related]){
    const text=texts(page.items);
    for(const marker of ['first block thinking','second block answer','third-block.txt','third block tool result'])assert.ok(text.includes(marker),`${marker} must survive a later, different block with the same message.id`);
  }
});

test('Claude lower-output rows with a new content block cannot erase that block',async t=>{
  const f=await fixture(t,'claude');
  await writeFile(f.file,jsonl([claudeUser('mixed usage user'),claude('mixed',12,'complete text'),
    claude('mixed',1,'',[{type:'tool_use',id:'new-block-tool',name:'Grep',input:{pattern:'new independent block'}}]),toolResult('new-block-tool','new independent result')]));
  const snapshot=await f.load(),[call]=await records(f.store,snapshot.snapshotId);assert.equal(call.outputTokens,12);
  const events=await content(f.store,snapshot.snapshotId,call.id),text=texts(events.items);
  assert.ok(text.includes('complete text'));assert.ok(text.includes('new independent block'),'maximum usage chooses counters, not which independent content blocks exist');
  assert.ok(text.includes('new independent result'));
});

test('Claude final rows without usage retain content while the existing usage row remains stable',async t=>{
  const f=await fixture(t,'claude'),final=claude('usage-then-content',0,'',[{type:'text',index:0,text:'final content without repeated usage'}]);
  const {usage:_usage,...message}=final.message;
  await writeFile(f.file,jsonl([claudeUser('missing usage user'),claude('usage-then-content',5,'',[{type:'text',index:0,text:'draft with usage'}]),{...final,message}]));
  const snapshot=await f.load(),[call]=await records(f.store,snapshot.snapshotId);assert.equal(call.outputTokens,5);
  const events=await content(f.store,snapshot.snapshotId,call.id);assert.ok(texts(events.items).includes('final content without repeated usage'));
});

test('Claude cumulative multi-block snapshots show each final block once and keep the earliest timestamp',async t=>{
  const f=await fixture(t,'claude'),thinking={type:'thinking',thinking:'cumulative thought'},text={type:'text',text:'cumulative answer'},
    read={type:'tool_use',id:'cumulative-read',name:'Read',input:{file_path:'cumulative.txt'}},
    search={type:'tool_use',id:'cumulative-search',name:'Grep',input:{pattern:'cumulative needle'}};
  await writeFile(f.file,jsonl([claudeUser('cumulative user'),claude('cumulative',1,'',[thinking],at(1)),
    claude('cumulative',3,'',[thinking,text],at(2)),claude('cumulative',7,'',[thinking,text,read,search],at(3)),
    claude('cumulative',7,'',[thinking,text,read,search],at(4)),toolResult('cumulative-read','read result'),toolResult('cumulative-search','search result')]));
  const snapshot=await f.load(),calls=await records(f.store,snapshot.snapshotId);assert.equal(calls.length,1);assert.equal(calls[0].outputTokens,7);
  assert.equal(calls[0].created_at,Date.parse(at(1))/1000);
  for(const page of [await content(f.store,snapshot.snapshotId),await content(f.store,snapshot.snapshotId,calls[0].id)]){
    const joined=texts(page.items);
    for(const marker of ['cumulative thought','cumulative answer','cumulative.txt','cumulative needle','read result','search result'])
      assert.equal(joined.split(marker).length-1,1,`${marker} must be displayed once across cumulative snapshots`);
  }
});

test('Claude distinct text blocks sharing one message ID survive without double-counting usage',async t=>{
  const f=await fixture(t,'claude');
  // Explicit producer indexes distinguish independent blocks from revisions of one text block.
  await writeFile(f.file,jsonl([claudeUser('two text blocks'),claude('two-texts',2,'',[{type:'text',index:0,text:'before tool text'}]),
    claude('two-texts',5,'',[{type:'tool_use',id:'between-texts',name:'Read',input:{file_path:'between.txt'}}]),
    claude('two-texts',7,'',[{type:'text',index:1,text:'after tool text'}]),toolResult('between-texts','between result')]));
  const snapshot=await f.load(),[call]=await records(f.store,snapshot.snapshotId);assert.equal(snapshot.total,1);assert.equal(call.outputTokens,7);
  const events=await content(f.store,snapshot.snapshotId,call.id),joined=texts(events.items);
  for(const marker of ['before tool text','after tool text','between.txt','between result'])assert.equal(joined.split(marker).length-1,1,`${marker} belongs to the message`);
});

test('Claude blocks without producer IDs keep distinct fragments and dedupe exact repeated fragments',async t=>{
  const f=await fixture(t,'claude');await writeFile(f.file,jsonl([claudeUser('ambiguous fragments'),claude('fragments',2,'before tool'),claude('fragments',3,'',[{type:'tool_use',id:'fragment-tool',name:'Read',input:{file_path:'fragment.txt'}}]),claude('fragments',5,'after tool'),claude('fragments',5,'after tool'),toolResult('fragment-tool','fragment result')]));
  const snapshot=await f.load(),[call]=await records(f.store,snapshot.snapshotId),events=await content(f.store,snapshot.snapshotId,call.id),joined=texts(events.items);
  for(const marker of ['before tool','after tool','fragment.txt','fragment result'])assert.equal(joined.split(marker).length-1,1);
  assert.equal(call.outputTokens,5);assert.equal(snapshot.total,1);
});

test('Claude legacy assistant UUID is usable when message.id is absent',async t=>{
  const f=await fixture(t,'claude'),event=claude('legacy',3,'legacy reply');delete (event.message as {id?:string}).id;
  await writeFile(f.file,jsonl([claudeUser('legacy question'),{...event,uuid:'legacy-uuid'}]));
  const snapshot=await f.load(),[call]=await records(f.store,snapshot.snapshotId);assert.equal(snapshot.total,1);assert.equal(call.outputTokens,3);
  const related=await content(f.store,snapshot.snapshotId,call.id);assert.ok(texts(related.items).includes('legacy question'));assert.ok(texts(related.items).includes('legacy reply'));
});

test('Claude explicit zero block index remains stable when a cumulative snapshot reorders its array',async t=>{
  const f=await fixture(t,'claude'),text={type:'text',index:0,text:'indexed zero text'},thinking={type:'thinking',index:1,thinking:'indexed one thought'};
  await writeFile(f.file,jsonl([claudeUser('indexed block user'),claude('zero-index',1,'',[text,thinking]),claude('zero-index',4,'',[thinking,text])]));
  const snapshot=await f.load(),[call]=await records(f.store,snapshot.snapshotId);assert.equal(call.outputTokens,4);
  const events=await content(f.store,snapshot.snapshotId,call.id),joined=texts(events.items);
  assert.equal(joined.split('indexed zero text').length-1,1,'index 0 is an explicit identity, not a missing index');
  assert.equal(joined.split('indexed one thought').length-1,1);
});

test('Codex call content includes the same turn user, tool call and tool result, without the next turn',async t=>{
  const f=await fixture(t);
  await writeFile(f.file,jsonl([turn('t1'),user('first user'),
    {type:'response_item',payload:{type:'function_call',call_id:'c1',name:'read_file',arguments:'{"path":"synthetic.txt"}'}},
    {type:'response_item',payload:{type:'function_call_output',call_id:'c1',output:'first tool result'}},
    answer('first answer'),usage(1),turn('t2'),user('second user'),answer('second answer'),usage(2)]));
  const snapshot=await f.load(),items=await records(f.store,snapshot.snapshotId);
  const first=items.find(item=>item.created_at===Date.parse(at(1))/1000)!;
  const related=await content(f.store,snapshot.snapshotId,first.id);assert.equal(related.association,'turn');
  const text=texts(related.items);for(const marker of ['first user','read_file','first tool result','first answer'])assert.ok(text.includes(marker),marker);
  assert.ok(!text.includes('second user'));assert.ok(!text.includes('second answer'));
  assert.ok(related.items.some(item=>item.role==='tool' && item.toolCallId==='c1'));
});

test('Codex task_started and a following turn_context describe one turn even without a repeated turn ID',async t=>{
  const f=await fixture(t);
  await writeFile(f.file,jsonl([{type:'event_msg',payload:{type:'task_started',turn_id:'real-turn'}},user('before context user'),
    {type:'response_item',payload:{type:'function_call',call_id:'early-tool',name:'early_read',arguments:'{}'}},
    {type:'turn_context',payload:{model:'gpt-fixture'}},
    {type:'response_item',payload:{type:'function_call_output',call_id:'early-tool',output:'after context result'}},usage(1)]));
  const snapshot=await f.load(),[call]=await records(f.store,snapshot.snapshotId),related=await content(f.store,snapshot.snapshotId,call.id);
  assert.ok(texts(related.items).includes('early_read'),'turn_context must not split a turn that task_started already identified');
  assert.ok(texts(related.items).includes('before context user'));assert.ok(texts(related.items).includes('after context result'));
});

test('Codex mirrored UI events are deduplicated in favor of canonical response_item messages',async t=>{
  const f=await fixture(t);
  await writeFile(f.file,jsonl([turn('mirror'),{type:'event_msg',payload:{type:'user_message',message:'same user'}},user('same user'),
    answer('same answer'),{type:'event_msg',payload:{type:'agent_message',message:'same answer'}},usage(1)]));
  const snapshot=await f.load(),events=await content(f.store,snapshot.snapshotId);
  assert.equal(events.items.filter(item=>item.role==='user').length,1);assert.equal(events.items.filter(item=>item.role==='assistant').length,1);
  const [call]=await records(f.store,snapshot.snapshotId),related=await content(f.store,snapshot.snapshotId,call.id);
  assert.equal(related.items.filter(item=>item.role==='user').length,1);
});

test('missing Codex turn boundaries do not falsely associate the whole session with one call',async t=>{
  const f=await fixture(t);await writeFile(f.file,jsonl([user('first question'),answer('first answer'),usage(1),user('another question'),answer('another answer'),usage(2)]));
  const snapshot=await f.load(),[call]=await records(f.store,snapshot.snapshotId),related=await content(f.store,snapshot.snapshotId,call.id);
  assert.equal(related.association,'unavailable');assert.equal(related.total,0);assert.ok(texts((await content(f.store,snapshot.snapshotId)).items).includes('first answer'));
});

test('Claude tool-producing call includes its user and linked tool result without later unrelated user content',async t=>{
  const f=await fixture(t,'claude');
  await writeFile(f.file,jsonl([claudeUser('first Claude user'),claude('owner',1,'',[{type:'tool_use',id:'tool-one',name:'Read',input:{file_path:'synthetic.txt'}}]),
    toolResult('tool-one','owned tool result'),claudeUser('unrelated later user','u2'),claude('later',1,'later answer')]));
  const snapshot=await f.load(),items=await records(f.store,snapshot.snapshotId),first=items.find(item=>item.id.endsWith(digest('owner')))!;
  const related=await content(f.store,snapshot.snapshotId,first.id),text=texts(related.items);assert.equal(related.association,'message');
  for(const marker of ['first Claude user','Read','owned tool result'])assert.ok(text.includes(marker),marker);
  assert.ok(!text.includes('unrelated later user'));assert.ok(!text.includes('later answer'));
});

test('Claude follow-up call retains the tool results that it consumes as context',async t=>{
  const f=await fixture(t,'claude');
  await writeFile(f.file,jsonl([claudeUser('please read'),claude('read-call',1,'',[{type:'tool_use',id:'read-one',name:'Read',input:{file_path:'synthetic.txt'}}]),
    toolResult('read-one','input tool result'),claude('follow-up',2,'answer using tool output')]));
  const snapshot=await f.load(),items=await records(f.store,snapshot.snapshotId),follow=items.find(item=>item.id.endsWith(digest('follow-up')))!;
  const related=await content(f.store,snapshot.snapshotId,follow.id),text=texts(related.items);
  assert.ok(text.includes('input tool result'),'a follow-up model call must expose the tool result supplied in its input');
  assert.ok(text.includes('please read'));assert.ok(text.includes('answer using tool output'));
});

test('snapshot model/time filters remain fixed through pagination, query mutation and append',async t=>{
  const f=await fixture(t),query={range:{...range},models:['allowed']};
  await writeFile(f.file,jsonl([turn('filter','allowed'),usage(1),usage(2,'blocked'),usage(3,'allowed'),usage(4,'allowed',new Date(2026,8,30,10).toISOString())]));
  const snapshot=await f.load(query);assert.equal(snapshot.total,2);
  query.models[0]='blocked';query.range.startDate='2026-09-30';query.range.endDate='2026-09-30';
  await appendFile(f.file,jsonl([usage(5,'allowed')]));
  const items=await records(f.store,snapshot.snapshotId,1);assert.equal(items.length,2);assert.ok(items.every(item=>item.model==='allowed'));
  assert.equal((await content(f.store,snapshot.snapshotId)).total,snapshot.eventTotal,'appended content belongs to a new snapshot');
  const newSnapshot=await f.load();assert.equal(newSnapshot.total,4);
  const tokenFiltered=await f.load({range,tokenIds:[7]});assert.equal(tokenFiltered.total,0);assert.ok(tokenFiltered.warnings.some(value=>value.includes('令牌')));
  assert.equal((await content(f.store,tokenFiltered.snapshotId)).total,newSnapshot.eventTotal,'usage filters do not remove whole-session content');
});

test('legal append preserves fixed raw offsets, record count, metadata and bytes',async t=>{
  const f=await fixture(t),original=jsonl([{type:'session_meta',payload:{title:'original title',id:'synthetic-session'}},turn('append'),user('original prompt'),usage(1)]);
  await writeFile(f.file,original);const snapshot=await f.load(),before=await records(f.store,snapshot.snapshotId),events=await content(f.store,snapshot.snapshotId);
  await appendFile(f.file,jsonl([{type:'session_meta',payload:{title:'appended title'}},usage(2)]));
  assert.deepEqual(await records(f.store,snapshot.snapshotId),before);assert.equal(snapshot.metadata.title,'original title');assert.equal(snapshot.totalBytes,Buffer.byteLength(original));
  assert.equal((await content(f.store,snapshot.snapshotId)).total,events.total);
  await rawEquals(f.store,snapshot.snapshotId,events.items[0].id,Buffer.from(original.split('\n')[0]+'\n'));
  assert.equal((await f.load()).metadata.title,'appended title');
});

for(const mutation of ['rewrite','shrink','replace'] as const){
  test(`snapshot rejects ${mutation} for records, content and raw`,async t=>{
    const f=await fixture(t);await writeFile(f.file,jsonl([turn('change'),user('before'),usage(1)]));
    const snapshot=await f.load(),events=await content(f.store,snapshot.snapshotId),before=await lstat(f.file);
    if(mutation==='rewrite'){await writeFile(f.file,jsonl([turn('change'),user('AFTER!'),usage(1)]));await utimes(f.file,before.atime,new Date(before.mtimeMs+2000));}
    if(mutation==='shrink')await truncate(f.file,2);
    if(mutation==='replace'){await rename(f.file,path.join(f.root,'old.jsonl'));await writeFile(f.file,jsonl([turn('replacement'),usage(1)]));}
    await assert.rejects(f.store.records({snapshotId:snapshot.snapshotId,page:1,pageSize:50}),/修改|失效/);
    await assert.rejects(f.store.content({snapshotId:snapshot.snapshotId,page:1,pageSize:20}),/修改|失效/);
    await assert.rejects(f.store.raw({snapshotId:snapshot.snapshotId,eventId:events.items[0].id,offset:0}),/修改|失效/);
  });
}

test('middle rewrite plus append cannot leave a stale usage snapshot accepted by endpoint-only checks',async t=>{
  const f=await fixture(t),filler={type:'system',padding:'x'.repeat(BLOCK*2)},middle={...usage(1),checkpoint_marker:'A'};
  const prefix=jsonl([filler]),line=jsonl([middle]),suffix=jsonl([filler]);await writeFile(f.file,prefix+line+suffix);
  const snapshot=await f.load(),before=await lstat(f.file),position=Buffer.byteLength(prefix)+line.indexOf('input_tokens":100')+'input_tokens":'.length;
  assert.equal((await records(f.store,snapshot.snapshotId))[0].inputTokens,80);
  // 100 -> 900 input tokens changes the indexed facts without moving any offset or endpoint block.
  const handle=await open(f.file,'r+');try{await handle.write(Buffer.from('9'),0,1,position);}finally{await handle.close();}
  await appendFile(f.file,jsonl([usage(2)]));await utimes(f.file,before.atime,new Date(before.mtimeMs+2000));
  await assert.rejects(f.store.records({snapshotId:snapshot.snapshotId,page:1,pageSize:50}),/修改|变化|失效/,'all indexed prefix bytes must remain immutable');
});

test('symlink session files are rejected before scan',async t=>{
  const f=await fixture(t),target=path.join(f.root,'target.jsonl');await writeFile(target,jsonl([usage(1)]));
  try{await symlink(target,f.file,'file');}catch(error){if(['EPERM','EACCES'].includes((error as NodeJS.ErrnoException).code ?? '')){t.skip('Windows account cannot create file symlinks');return;}throw error;}
  assert.ok((await lstat(f.file)).isSymbolicLink());await assert.rejects(f.load(),/修改|失效/);
});

test('a registered file swapped for a symlink after load is rejected',async t=>{
  const f=await fixture(t),target=path.join(f.root,'target.jsonl');await writeFile(f.file,jsonl([usage(1)]));
  const snapshot=await f.load();await rename(f.file,target);
  try{await symlink(target,f.file,'file');}catch(error){if(['EPERM','EACCES'].includes((error as NodeJS.ErrnoException).code ?? '')){t.skip('Windows account cannot create file symlinks');return;}throw error;}
  await assert.rejects(f.store.records({snapshotId:snapshot.snapshotId,page:1,pageSize:50}),/修改|失效/);
});

test('progress reports monotonic real bytes and a final count only after the full scan',async t=>{
  const f=await fixture(t),progress:LocalSessionProgress[]=[],requestId=randomUUID();
  await writeFile(f.file,jsonl([turn('progress'),...Array.from({length:620},(_,i)=>usage(i+1))]));
  const snapshot=await f.load(range,value=>progress.push(value),requestId);
  assert.ok(progress.length>=4);assert.equal(progress[0].phase,'read');assert.equal(progress[0].bytesRead,0);
  assert.equal(progress.at(-1)!.phase,'complete');assert.equal(progress.at(-1)!.bytesRead,snapshot.totalBytes);assert.equal(progress.at(-1)!.calls,snapshot.total);
  assert.equal(progress.filter(value=>value.phase==='complete').length,1);
  for(let i=0;i<progress.length;i++){
    assert.equal(progress[i].requestId,requestId);assert.equal(progress[i].totalBytes,snapshot.totalBytes);
    assert.ok(progress[i].bytesRead>=0 && progress[i].bytesRead<=snapshot.totalBytes);
    if(i)assert.ok(progress[i].bytesRead>=progress[i-1].bytesRead);
    assert.ok(!JSON.stringify(progress[i]).includes(f.file));
  }
});

test('cancel during progress rejects load, emits no complete event and disposes the index',async t=>{
  const f=await fixture(t),requestId=randomUUID(),progress:LocalSessionProgress[]=[];
  await writeFile(f.file,jsonl([turn('cancel'),...Array.from({length:800},(_,i)=>usage(i+1))]));
  await assert.rejects(f.load(range,value=>{progress.push(value);if(value.bytesRead>0)f.store.release({requestId});},requestId),/取消/);
  assert.ok(progress.some(value=>value.bytesRead>0));assert.ok(!progress.some(value=>value.phase==='complete'));assert.deepEqual(await readdir(f.tmp),[]);
  assert.equal((await f.load()).total,800,'cancelled work does not poison a subsequent request');
});

test('pre-cancel, release, repeated release and close invalidate snapshots and dispose resources',async t=>{
  const f=await fixture(t);await writeFile(f.file,jsonl([turn('dispose'),usage(1)]));
  const requestId=randomUUID();f.store.release({requestId});await assert.rejects(f.load(range,undefined,requestId),/取消/);assert.deepEqual(await readdir(f.tmp),[]);
  const snapshot=await f.load();assert.equal((await readdir(f.tmp)).length,1);f.store.release({snapshotId:snapshot.snapshotId});f.store.release({snapshotId:snapshot.snapshotId});
  await assert.rejects(f.store.records({snapshotId:snapshot.snapshotId,page:1,pageSize:50}),/失效/);
  await assert.rejects(f.store.content({snapshotId:snapshot.snapshotId,page:1,pageSize:20}),/失效/);
  await assert.rejects(f.store.raw({snapshotId:snapshot.snapshotId,eventId:'1',offset:0}),/失效/);
  const next=await f.load();f.store.close();f.store.close();await assert.rejects(f.load(),/取消|关闭/);
  await assert.rejects(f.store.records({snapshotId:next.snapshotId,page:1,pageSize:50}),/失效/);
});

test('close during scan cancels work and removes partially created indexes',async t=>{
  const f=await fixture(t);await writeFile(f.file,jsonl([turn('close'),...Array.from({length:700},(_,i)=>usage(i+1))]));
  await assert.rejects(f.load(range,value=>{if(value.bytesRead>0)f.store.close();}),/取消|关闭/);assert.deepEqual(await readdir(f.tmp),[]);
});

test('release while a content page is running lets that page settle and blocks future reads',async t=>{
  const f=await fixture(t);await writeFile(f.file,jsonl([turn('busy'),user('busy content'),usage(1)]));const snapshot=await f.load();
  const pending=f.store.content({snapshotId:snapshot.snapshotId,page:1,pageSize:20});f.store.release({snapshotId:snapshot.snapshotId});
  const result=await pending;assert.ok(texts(result.items).includes('busy content'));
  await assert.rejects(f.store.records({snapshotId:snapshot.snapshotId,page:1,pageSize:50}),/失效/);
});

test('close while a content page is running does not double-close its database or handle',async t=>{
  const f=await fixture(t);await writeFile(f.file,jsonl([turn('busy-close'),user('pending page'),usage(1)]));const snapshot=await f.load();
  const pending=f.store.content({snapshotId:snapshot.snapshotId,page:1,pageSize:20});f.store.close();
  // Either finish the page or deliberately cancel it; a database/EBADF failure is not cancellation.
  try{const result=await pending;assert.ok(texts(result.items).includes('pending page'));}
  catch(error){assert.match((error as Error).message,/取消|关闭|失效/);}
  f.store.close();
});

test('notification exceptions do not abort a successful scan',async t=>{
  const f=await fixture(t);await writeFile(f.file,jsonl([usage(1)]));const snapshot=await f.load(range,()=>{throw new Error('synthetic renderer closed');});assert.equal(snapshot.total,1);
});

test('huge valid records and malformed JSON retain all raw bytes in bounded pages',async t=>{
  const f=await fixture(t),huge=Buffer.from(jsonl([user('x'.repeat(8*1024*1024+BLOCK+11))])),malformed=Buffer.from('malformed '+('中🙂é'.repeat(16000))+'\r\n');
  await writeFile(f.file,Buffer.concat([huge,malformed,Buffer.from(jsonl([turn('after-huge'),usage(1)]))]));
  const snapshot=await f.load(),events=await content(f.store,snapshot.snapshotId);assert.equal(snapshot.total,1);assert.equal(events.total,4);
  assert.equal(events.items[0].truncated,true);assert.equal(events.items[0].rawBytes,huge.length);
  assert.ok(snapshot.warnings.some(value=>/8 MiB|较大|超过/.test(value)));assert.ok(snapshot.warnings.some(value=>/解析/.test(value)));
  assert.ok((await rawEquals(f.store,snapshot.snapshotId,events.items[0].id,huge))>128);
  assert.ok((await rawEquals(f.store,snapshot.snapshotId,events.items[1].id,malformed))>1);
});

test('malformed and oversized unterminated EOF records remain reachable through raw',async t=>{
  for(const [name,tail] of [['malformed',Buffer.from('{"unfinished":"中🙂')],['oversized',Buffer.alloc(8*1024*1024+7,120)]] as const){
    await t.test(name,async st=>{
      const f=await fixture(st);await writeFile(f.file,Buffer.concat([Buffer.from(jsonl([usage(1)])),tail]));
      const snapshot=await f.load(),events=await content(f.store,snapshot.snapshotId);assert.equal(snapshot.total,1);
      assert.equal(events.total,2,'an unfinished record still needs an event offset for raw access');
      await rawEquals(f.store,snapshot.snapshotId,events.items.at(-1)!.id,tail);assert.ok(snapshot.warnings.length);
    });
  }
});

test('UTF-8 two/three/four-byte characters crossing 64 KiB raw boundaries remain intact',async t=>{
  for(const character of ['é','中','🙂'])await t.test(character,async st=>{
    const f=await fixture(st),prefix='{"type":"system","message":"',line=Buffer.from(prefix+'x'.repeat(BLOCK-1-Buffer.byteLength(prefix))+character+'中🙂é'.repeat(20000)+'"}\n');
    await writeFile(f.file,line);const snapshot=await f.load(),events=await content(f.store,snapshot.snapshotId);
    const first=await f.store.raw({snapshotId:snapshot.snapshotId,eventId:events.items[0].id,offset:0});assert.equal(first.nextOffset,BLOCK-1);
    await rawEquals(f.store,snapshot.snapshotId,events.items[0].id,line);
    const eof=await f.store.raw({snapshotId:snapshot.snapshotId,eventId:events.items[0].id,offset:line.length});assert.equal(eof.text,'');assert.equal(eof.nextOffset,undefined);
    await assert.rejects(f.store.raw({snapshotId:snapshot.snapshotId,eventId:events.items[0].id,offset:line.length+1}),/位置|无效/);
  });
});

test('XSS-looking message, tool argument and tool result content is returned as inert text',async t=>{
  const f=await fixture(t),markup='<img src=x onerror="globalThis.__session_xss=1"><script>alert(1)</script>';
  await writeFile(f.file,jsonl([turn('xss'),user(markup),
    {type:'response_item',payload:{type:'function_call',name:'synthetic_tool',call_id:'xss-tool',arguments:markup}},
    {type:'response_item',payload:{type:'function_call_output',call_id:'xss-tool',output:markup}},answer(markup),usage(1)]));
  const snapshot=await f.load(),events=await content(f.store,snapshot.snapshotId);
  assert.equal(events.items.find(item=>item.role==='user')!.text,markup);assert.equal(events.items.find(item=>item.role==='assistant' && item.kind==='message')!.text,markup);
  assert.ok(events.items.find(item=>item.kind==='tool_call')!.text.includes(markup));assert.ok(events.items.find(item=>item.role==='tool')!.text.includes(markup));
  assert.ok(events.items.every(item=>typeof item.text==='string' && !('html' in item) && !('innerHTML' in item)));
  assert.equal((globalThis as Record<string,unknown>).__session_xss,undefined);
});

test('cross-session and filtered-out record IDs cannot retrieve another call content',async t=>{
  const f=await fixture(t),otherFile=path.join(f.root,'other-synthetic.jsonl'),otherId=digest(otherFile);
  await writeFile(f.file,jsonl([turn('a','model-a'),user('session A private text'),usage(1)]));
  await writeFile(otherFile,jsonl([turn('b','model-b'),user('session B private text'),usage(1)]));f.store.register(otherId,otherFile,'codex');
  const a=await f.load(),b=await f.store.load({sessionId:otherId,query:range,requestId:randomUUID()}),[aCall]=await records(f.store,a.snapshotId),[bCall]=await records(f.store,b.snapshotId);
  await assert.rejects(f.store.content({snapshotId:a.snapshotId,recordId:bCall.id,page:1,pageSize:20}),/失效|不存在/);
  await assert.rejects(f.store.content({snapshotId:b.snapshotId,recordId:aCall.id,page:1,pageSize:20}),/失效|不存在/);
  const filtered=await f.load({range,models:['unmatched']});assert.equal(filtered.total,0);
  await assert.rejects(f.store.content({snapshotId:filtered.snapshotId,recordId:aCall.id,page:1,pageSize:20}),/失效|不存在/);
  await assert.rejects(f.store.raw({snapshotId:a.snapshotId,eventId:'99999',offset:0}),/不存在/);
});

test('temporary SQLite stores offsets/usage rather than prompt, answer, tool output or opaque payloads',async t=>{
  const f=await fixture(t),secret='SYNTHETIC_PRIVATE_'+randomUUID(),prompt='PROMPT_'+secret,reply='REPLY_'+secret,output='TOOL_'+secret;
  await writeFile(f.file,jsonl([turn('privacy'),user(prompt),answer(reply),
    {type:'response_item',payload:{type:'function_call_output',call_id:'privacy-tool',output},opaque_secret:secret},usage(1)]));
  const progress:LocalSessionProgress[]=[],snapshot=await f.load(range,value=>progress.push(value)),calls=await records(f.store,snapshot.snapshotId);
  assert.ok(!JSON.stringify({calls,progress,warnings:snapshot.warnings}).includes(secret));assert.ok(!JSON.stringify({snapshot,calls,progress}).includes(f.file));
  const directories=await readdir(f.tmp);assert.equal(directories.length,1);
  const index=path.join(f.tmp,directories[0]);for(const name of await readdir(index)){
    const bytes=await readFile(path.join(index,name));assert.equal(bytes.indexOf(Buffer.from(secret)),-1,`${name} must not persist body content`);
  }
  assert.ok(texts((await content(f.store,snapshot.snapshotId)).items).includes(secret),'explicit content reads may show the synthetic private text');
});

test('empty files, valid EOF without a newline and unknown/malformed records have stable totals',async t=>{
  const f=await fixture(t);await writeFile(f.file,'');const empty=await f.load();assert.equal(empty.total,0);assert.equal(empty.eventTotal,0);
  assert.deepEqual((await records(f.store,empty.snapshotId)),[]);assert.deepEqual((await content(f.store,empty.snapshotId)).items,[]);
  const data=Buffer.from('null\n[]\nnot-json\n'+JSON.stringify(usage(1)));await writeFile(f.file,data);const snapshot=await f.load();
  assert.equal(snapshot.total,1);assert.equal(snapshot.eventTotal,4);const events=await content(f.store,snapshot.snapshotId);assert.equal(events.items.length,4);
  await rawEquals(f.store,snapshot.snapshotId,events.items.at(-1)!.id,Buffer.from(JSON.stringify(usage(1))));
});

test('malformed Claude content blocks do not abort otherwise readable records',async t=>{
  const f=await fixture(t,'claude'),bad={type:'user',timestamp:at(),message:{role:'user',content:[null,17,false,{}, {type:'text',text:'valid text after invalid blocks'}]}};
  const original=jsonl([bad]);await writeFile(f.file,original+jsonl([claude('after-bad',3,'valid answer after invalid blocks')]));
  const snapshot=await f.load();assert.equal(snapshot.total,1);assert.equal(snapshot.eventTotal,2);
  const events=await content(f.store,snapshot.snapshotId);assert.ok(texts(events.items).includes('valid text after invalid blocks'));
  assert.ok(texts(events.items).includes('valid answer after invalid blocks'));await rawEquals(f.store,snapshot.snapshotId,events.items[0].id,Buffer.from(original));
});
