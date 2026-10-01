import test from 'node:test';
import assert from 'node:assert/strict';
import {ReadCache} from '../electron/services/read-cache';

test('read cache shares concurrent work, isolates callers and reloads after expiry',async()=>{
  let time=0,calls=0;const cache=new ReadCache(()=>time);
  const load=async()=>{calls++;return {rows:[1,2]};};
  const [a,b]=await Promise.all([cache.get('site:account',50,load),cache.get('site:account',50,load)]);
  assert.equal(calls,1);a.rows.push(99);assert.deepEqual(b.rows,[1,2]);assert.deepEqual((await cache.get('site:account',50,load)).rows,[1,2]);
  time=51;await cache.get('site:account',50,load);assert.equal(calls,2);
  await cache.get('other:account',50,load);await cache.get('site:other-account',50,load);assert.equal(calls,4);
});
test('invalidating a pending read prevents it from restoring obsolete cache data and failures are not cached',async()=>{
  const cache=new ReadCache();let complete!:(value:string)=>void;
  const old=cache.get('site:pending',1000,()=>new Promise<string>(resolve=>{complete=resolve;}));await Promise.resolve();cache.invalidate('site:');
  assert.equal(await cache.get('site:pending',1000,async()=>'new'),'new');complete('old');assert.equal(await old,'old');assert.equal(await cache.get('site:pending',1000,async()=>'wrong'),'new');
  await assert.rejects(cache.get('failed',1000,async()=>{throw new Error('Transient failure');}));assert.equal(await cache.get('failed',1000,async()=>'recovered'),'recovered');
});
