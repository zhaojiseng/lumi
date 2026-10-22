import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {MarketFileCache} from '../electron/extensions/market-file-cache';

function file(value:string){
  const bytes=Buffer.from(value);
  return {bytes,size:bytes.length,sha:createHash('sha1').update('blob '+bytes.length+'\0').update(bytes).digest('hex')};
}

test('verified market bytes coalesce downloads and isolate transport, pending callers and cache hits',async()=>{
  const cache=new MarketFileCache(),source=file('shared public content');let reads=0;
  const load=async()=>{reads++;return source.bytes;};
  const [a,b]=await Promise.all([cache.get(source,load),cache.get(source,load)]);
  assert.equal(reads,1);a.fill(0);assert.equal(b.toString(),'shared public content');
  source.bytes.fill(1);b.fill(2);
  assert.equal((await cache.get(source,load)).toString(),'shared public content');assert.equal(reads,1);
  cache.dispose();
});

test('failed, corrupt and wrong-size downloads are not cached and can recover',async()=>{
  const cache=new MarketFileCache(),source=file('verified');let reads=0;
  const fail=()=>{reads++;throw new Error('fixture offline');};
  await assert.rejects(cache.get(source,fail),/fixture offline/);
  await assert.rejects(cache.get(source,async()=>{reads++;return Buffer.from('corrupt!');}),/校验失败/);
  await assert.rejects(cache.get({...source,size:source.size+1},async()=>{reads++;return source.bytes;}),/校验失败/);
  assert.deepEqual(await cache.get(source,async()=>{reads++;return source.bytes;}),source.bytes);assert.equal(reads,4);
  cache.dispose();
});

test('market byte cache evicts least recently used entries and skips oversized files',async()=>{
  const cache=new MarketFileCache(8),a=file('aaaa'),b=file('bbbb'),c=file('cccc'),large=file('oversized');
  const reads=new Map<string,number>();
  const get=(f:ReturnType<typeof file>)=>cache.get(f,async()=>{reads.set(f.sha,(reads.get(f.sha)||0)+1);return f.bytes;});
  await get(a);await get(b);await get(a);await get(c);await get(a);
  assert.equal(reads.get(a.sha),1);await get(b);assert.equal(reads.get(b.sha),2);
  await get(large);await get(large);assert.equal(reads.get(large.sha),2);
  await get(b);assert.equal(reads.get(b.sha),2,'oversized downloads do not evict useful bytes');cache.dispose();
});

test('entry limit also bounds zero-byte blobs and cache disposal rejects late downloads',async()=>{
  const cache=new MarketFileCache(100,1),empty=file(''),other=file('other');let reads=0;
  await cache.get(empty,async()=>empty.bytes);await cache.get(other,async()=>other.bytes);
  await cache.get(empty,async()=>{reads++;return empty.bytes;});assert.equal(reads,1);
  let release!:(bytes:Buffer)=>void,entered!:()=>void;
  const started=new Promise<void>(resolve=>entered=resolve);
  const pending=cache.get(other,()=>{entered();return new Promise<Buffer>(resolve=>release=resolve);});
  const rejected=assert.rejects(pending,/正在退出/);await started;cache.dispose();release(other.bytes);await rejected;
  await assert.rejects(cache.get(empty,async()=>empty.bytes),/正在退出/);
});
