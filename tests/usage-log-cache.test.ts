import test from 'node:test';
import assert from 'node:assert/strict';
import {UsageLogCache,USAGE_LIVE_TTL,USAGE_HISTORY_TTL,type UsageWindow} from '../electron/services/usage-log-cache';
import type {UsageLog} from '../shared/types';
const row=(id:number,time:number,type=2):UsageLog=>({id,created_at:time,type,model_name:'fixture',token_name:'fixture',prompt_tokens:10,completion_tokens:5,quota:1,use_time:1,is_stream:true,group:'fixture'});
function fixture(){
  let now=1000000000;const cache=new UsageLogCache(()=>now),seen:UsageWindow[]=[];
  let rows=[row(1,999000),row(2,999800),row(3,999990)];
  const load=async(window:UsageWindow)=>{seen.push(window);return rows.filter(row=>row.created_at>=window.start_timestamp && row.created_at<=window.end_timestamp);};
  return {cache,seen,load,now:()=>now,tick:(ms:number)=>{now+=ms;},setRows:(value:UsageLog[])=>{rows=value;}};
}
test('live reads reuse history and revalidate only the overlap, replacing edits/deletions and accepting delayed records',async()=>{
  const f=fixture(),initial={start_timestamp:990000,end_timestamp:1000000};
  assert.deepEqual((await f.cache.get('site:account',2,initial,f.load)).rows.map(row=>row.id),[3,2,1]);
  f.tick(1000);assert.equal((await f.cache.get('site:account',2,{...initial,end_timestamp:1000001},f.load)).rows.length,3);assert.equal(f.seen.length,1);
  f.tick(USAGE_LIVE_TTL);f.setRows([row(1,999000),{...row(2,999800),quota:7},row(4,999900),row(5,1000050)]);
  const refreshed=await f.cache.get('site:account',2,{...initial,end_timestamp:1000061},f.load);
  assert.deepEqual(f.seen[1],{start_timestamp:999700,end_timestamp:1000061});
  assert.deepEqual(refreshed.rows.map(row=>row.id),[5,4,2,1]);assert.equal(refreshed.rows.find(row=>row.id===2)?.quota,7);
  assert.equal(refreshed.fetchedAt,f.now());
});
test('overlapping and nested ranges fetch only holes and retain exact inclusive boundaries',async()=>{
  const f=fixture();f.setRows(Array.from({length:10},(_,i)=>row(i+1,990000+i)));
  const first={start_timestamp:990002,end_timestamp:990007};await f.cache.get('site:account',2,first,f.load);
  const nested=await f.cache.get('site:account',2,{start_timestamp:990004,end_timestamp:990005},f.load);assert.deepEqual(nested.rows.map(row=>row.id),[6,5]);assert.equal(f.seen.length,1);
  const full=await f.cache.get('site:account',2,{start_timestamp:990000,end_timestamp:990009},f.load);
  assert.deepEqual(f.seen.slice(1),[{start_timestamp:990000,end_timestamp:990001},{start_timestamp:990008,end_timestamp:990009}]);
  assert.deepEqual(full.rows.map(row=>row.id),[10,9,8,7,6,5,4,3,2,1]);
  f.tick(USAGE_LIVE_TTL);await f.cache.get('site:account',2,first,f.load);assert.equal(f.seen.length,3,'closed history must outlive the live TTL');
  f.tick(USAGE_HISTORY_TTL);await f.cache.get('site:account',2,first,f.load);assert.deepEqual(f.seen.at(-1),first);
});
test('complete type-0 snapshots also serve consumption curves without including errors or treating type-2 as complete',async()=>{
  const f=fixture(),window={start_timestamp:990000,end_timestamp:1000000};f.setRows([row(1,999000),row(2,999800,5)]);
  assert.equal((await f.cache.get('site:account',0,window,f.load)).rows.length,2);
  assert.deepEqual((await f.cache.get('site:account',2,window,f.load)).rows.map(row=>row.id),[1]);assert.equal(f.seen.length,1);
  const other=fixture();await other.cache.get('site:account',2,window,other.load);await other.cache.get('site:account',0,window,other.load);assert.equal(other.seen.length,2);
});
test('concurrent identical/expanded ranges serialize page work and share covered history',async()=>{
  const f=fixture();let release!:()=>void;const gate=new Promise<void>(resolve=>{release=resolve;});let active=0,maximum=0;
  const load=async(window:UsageWindow)=>{active++;maximum=Math.max(active,maximum);await gate;const rows=await f.load(window);active--;return rows;};
  const first={start_timestamp:990000,end_timestamp:999000},expanded={start_timestamp:990000,end_timestamp:999990};
  const pending=[f.cache.get('site:account',2,first,load),f.cache.get('site:account',2,first,load),f.cache.get('site:account',2,expanded,load)];release();
  const result=await Promise.all(pending);assert.equal(maximum,1);assert.equal(f.seen.length,2);assert.equal(result[2].rows.length,3);
});
test('invalidating an in-flight range rejects its late result and prevents restoring old history',async()=>{
  const f=fixture(),window={start_timestamp:990000,end_timestamp:1000000};let release!:(rows:UsageLog[])=>void;
  const pending=f.cache.get('site:account',2,window,()=>new Promise<UsageLog[]>(resolve=>{release=resolve;}));const rejected=assert.rejects(pending,/失效/);await Promise.resolve();
  f.cache.invalidate('site:');f.setRows([row(9,999999)]);assert.equal((await f.cache.get('site:account',2,window,f.load)).rows[0].id,9);
  release([row(1,999000)]);await rejected;assert.equal((await f.cache.get('site:account',2,window,f.load)).rows[0].id,9);
});
test('a failing expansion never publishes successful holes as a partial cache and can be retried immediately',async()=>{
  const f=fixture();await f.cache.get('site:account',2,{start_timestamp:990002,end_timestamp:990007},f.load);
  const full={start_timestamp:990000,end_timestamp:990009};let calls=0;
  await assert.rejects(f.cache.get('site:account',2,full,async window=>{if(++calls===2)throw new Error('Temporary failure');return f.load(window);}),/Temporary/);
  assert.equal(f.seen.length,2);await f.cache.get('site:account',2,full,f.load);assert.equal(f.seen.length,4,'both uncommitted holes must be retried');
});
test('account LRU eviction never caps record counts and recent scopes remain reusable',async()=>{
  let calls=0;const cache=new UsageLogCache(()=>1000000000,2),window={start_timestamp:990000,end_timestamp:999000};
  const rows=Array.from({length:25001},(_,i)=>row(i+1,990000)),load=async()=>{calls++;return rows;};
  for(const key of ['one','two','three'])assert.equal((await cache.get(key,2,window,load)).rows.length,25001);
  await cache.get('three',2,window,load);assert.equal(calls,3);await cache.get('one',2,window,load);assert.equal(calls,4);
});

test('a fresh complete snapshot supersedes the consumption subset including corrections',async()=>{
  const f=fixture(),window={start_timestamp:990000,end_timestamp:1000000};
  await f.cache.get('site:account',2,window,f.load);f.tick(1);f.setRows([{...row(1,999000),quota:7},row(2,999800,5)]);
  assert.equal((await f.cache.get('site:account',0,window,f.load)).rows.length,2);
  const curve=await f.cache.get('site:account',2,window,f.load);assert.equal(curve.rows.length,1);assert.equal(curve.rows[0].quota,7);assert.equal(f.seen.length,2);
});

test('a covered cache hit remains available while a larger history read is pending',async()=>{
  const f=fixture(),covered={start_timestamp:999000,end_timestamp:999100};await f.cache.get('site:account',2,covered,f.load);
  let release!:()=>void;const gate=new Promise<void>(resolve=>{release=resolve;});
  const expansion=f.cache.get('site:account',2,{start_timestamp:990000,end_timestamp:999100},async window=>{await gate;return f.load(window);});await Promise.resolve();
  let hit=false;const cached=f.cache.get('site:account',2,covered,f.load).then(result=>{hit=true;return result;});await Promise.resolve();
  try{assert.equal(hit,true,'a fresh hit must not wait for unrelated pages');assert.equal((await cached).rows.length,1);}finally{release();await expansion;}
});

test('disjoint snapshots retain query-local display IDs including same-second requests',async()=>{
  const f=fixture();f.setRows([row(1,990001),row(2,990001),row(1,990003)]);
  await f.cache.get('site:account',2,{start_timestamp:990003,end_timestamp:990003},f.load);
  const result=await f.cache.get('site:account',2,{start_timestamp:990000,end_timestamp:990003},f.load);
  assert.deepEqual(result.rows.map(row=>[row.created_at,row.id]),[[990003,1],[990001,2],[990001,1]]);
  assert.equal(result.rows.reduce((sum,row)=>sum+row.quota,0),3);
});
