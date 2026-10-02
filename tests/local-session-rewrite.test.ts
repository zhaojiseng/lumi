import test,{type TestContext} from 'node:test';
import assert from 'node:assert/strict';
import {appendFile,mkdir,mkdtemp,open,readFile,rm,stat,utimes,writeFile} from 'node:fs/promises';
import path from 'node:path';
import {LocalSessionPages,LOCAL_PAGE_BYTES} from '../electron/services/local-session-pages';

// ASCII JSONL records have fixed byte lengths, so rewriting counters does not move page boundaries.
// An ordinary call has total += (100 input, 10 output, 20 reads), hence 80 uncached input.
function record(index:number,timestamp:string,bytes:number,factor=1){
  const event={type:'event_msg',timestamp,payload:{type:'token_count',info:{model:'rewrite-fixture',
    total_token_usage:{input_tokens:index*100*factor,output_tokens:index*10*factor,cached_input_tokens:index*20*factor},
    last_token_usage:{input_tokens:100*factor,output_tokens:10*factor,cached_input_tokens:20*factor}}},
    padding:'',checkpoint_marker:'A'};
  const length=Buffer.byteLength(JSON.stringify(event));assert.ok(length<bytes);
  event.padding='x'.repeat(bytes-length-1);
  const result=JSON.stringify(event)+'\n';assert.equal(Buffer.byteLength(result),bytes);return result;
}
function records(count:number,timestamp:string,bytes:number,factor=1,first=1){
  return Array.from({length:count},(_,index)=>record(first+index,timestamp,bytes,factor)).join('');
}
async function fixture(t:TestContext,count:number,bytes:number){
  const parent=path.resolve('.test-data');await mkdir(parent,{recursive:true});
  const root=await mkdtemp(path.join(parent,'local-session-rewrite-')),file=path.join(root,'session.jsonl');
  t.after(async()=>{assert.equal(path.dirname(root),parent);await rm(root,{recursive:true,force:true,maxRetries:5,retryDelay:100});});
  const timestamp=new Date(Date.now()-10*60000).toISOString();
  await writeFile(file,records(count,timestamp,bytes));
  const pages=new LocalSessionPages();pages.register('rewrite-session',file,'codex');
  const input={sessionId:'rewrite-session',query:7};
  const first=await pages.read(input);assert.ok(first.nextCursor);assert.ok(first.scannedBytes<=LOCAL_PAGE_BYTES);
  assert.ok(first.items.every(item=>item.inputTokens===80));
  return {file,pages,input,first,timestamp,before:await stat(file)};
}

test('an in-place larger rewrite rejects the old cursor instead of mixing old and new cumulative counters',async(t)=>{
  const f=await fixture(t,60,512);assert.equal(f.first.items.length,50);assert.equal(f.first.scannedBytes,50*512);
  // Same path/inode: replace 60 original events with 64 events whose cumulative and last counts are doubled.
  // The unfixed implementation resumes with old (5000 input, 1000 reads), then sees new (10200, 2040),
  // and emits 4160 input instead of a new call's 160. The existing cursor must reject this rewrite.
  await writeFile(f.file,records(64,f.timestamp,512,2));
  await utimes(f.file,f.before.atime,new Date(f.before.mtimeMs+2000));
  const after=await stat(f.file);assert.equal(after.dev,f.before.dev);assert.equal(after.ino,f.before.ino);
  assert.ok(after.size>f.before.size);assert.ok(after.mtimeMs>f.before.mtimeMs);
  await assert.rejects(f.pages.read({...f.input,cursor:f.first.nextCursor}),/修改|变化|失效/);
});

test('a genuine append preserves cursor continuation, the initial snapshot and the two-MiB page budget',async(t)=>{
  const bytes=64*1024,f=await fixture(t,96,bytes);assert.equal(f.first.scannedBytes,LOCAL_PAGE_BYTES);
  const prefix=await readFile(f.file);
  await appendFile(f.file,records(4,f.timestamp,bytes,1,97));
  await utimes(f.file,f.before.atime,new Date(f.before.mtimeMs+2000));
  const after=await stat(f.file);assert.equal(after.ino,f.before.ino);assert.equal(after.size,100*bytes);
  assert.deepEqual((await readFile(f.file)).subarray(0,prefix.length),prefix,'the entire original snapshot is unchanged');
  let cursor=f.first.nextCursor,scanned=f.first.scannedBytes,total=f.first.items.length,reads=1;
  while(cursor){
    const page=await f.pages.read({...f.input,cursor});
    assert.ok(page.scannedBytes>scanned);assert.ok(page.scannedBytes-scanned<=LOCAL_PAGE_BYTES);
    assert.equal(page.totalBytes,f.first.totalBytes);assert.ok(page.items.every(item=>item.inputTokens===80));
    scanned=page.scannedBytes;total+=page.items.length;cursor=page.nextCursor;reads++;assert.ok(reads<=4);
  }
  assert.equal(reads,3);assert.equal(total,96,'new appended events belong to a later snapshot');assert.equal(scanned,96*bytes);
});

test('changing the cursor-boundary marker rejects continuation even when the fixed snapshot prefix and tail are intact',async(t)=>{
  const bytes=64*1024,f=await fixture(t,96,bytes);assert.equal(f.first.scannedBytes,LOCAL_PAGE_BYTES);
  const original=await readFile(f.file),markerOffset=f.first.scannedBytes-4;
  assert.equal(original[markerOffset],0x41,'the last consumed record ends with checkpoint_marker A');
  // Change only the final metadata marker of the last consumed record. JSON and all token facts stay valid.
  // Then append, ensuring the inode/size/mtime-only guard would accept it and endpoint samples stay unchanged.
  const handle=await open(f.file,'r+');try{await handle.write(Buffer.from('B'),0,1,markerOffset);}finally{await handle.close();}
  await appendFile(f.file,records(4,f.timestamp,bytes,1,97));
  await utimes(f.file,f.before.atime,new Date(f.before.mtimeMs+2000));
  const rewritten=await readFile(f.file),after=await stat(f.file);
  assert.equal(after.dev,f.before.dev);assert.equal(after.ino,f.before.ino);assert.ok(after.size>f.before.size);
  assert.deepEqual(rewritten.subarray(0,bytes),original.subarray(0,bytes),'snapshot prefix is unchanged');
  assert.deepEqual(rewritten.subarray(original.length-bytes,original.length),original.subarray(-bytes),'fixed snapshot tail is unchanged');
  const changedRecord=JSON.parse(rewritten.subarray(markerOffset-(bytes-4),markerOffset+4).toString('utf8'));
  assert.equal(changedRecord.checkpoint_marker,'B');assert.equal(changedRecord.payload.info.last_token_usage.input_tokens,100);
  await assert.rejects(f.pages.read({...f.input,cursor:f.first.nextCursor}),/修改|变化|失效/);
});
