import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile} from 'node:fs/promises';
import path from 'node:path';
import {LocalUsageService} from '../electron/services/local-usage';

test('local historical usage applies minute and model selection, preserving cumulative deltas outside the range',async()=>{
  const home=await mkdtemp(path.resolve('.test-data/local-filter-')),sessions=path.join(home,'.codex','sessions');await mkdir(sessions,{recursive:true});
  const date='2026-09-20',events=[{type:'turn_context',payload:{model:'a'}},...[['09:04',100],['09:05',200],['09:06',300],['09:07',400]].map(([time,tokens])=>({type:'event_msg',timestamp:new Date(date+'T'+time+':00').toISOString(),payload:{type:'token_count',info:{total_token_usage:{input_tokens:tokens,output_tokens:0}}}}))];
  await writeFile(path.join(sessions,'fixture.jsonl'),events.map(e=>JSON.stringify(e)).join('\n'));
  const service=new LocalUsageService(home),range={startDate:date,endDate:date,startTime:'09:05',endTime:'09:06'};
  const local=await service.scan({range,models:['a']});assert.equal(local.rows.length,1);assert.equal(local.rows[0].inputTokens,200);assert.equal(local.rows[0].requests,2);
  assert.deepEqual((await service.scan({range,models:['b']})).rows,[]);
  const tokens=await service.scan({range,tokenIds:[1]});assert.deepEqual(tokens.rows,[]);assert.match(tokens.warnings[0],/令牌 ID/);assert.equal(tokens.filesScanned,0);
});
test('portable extraction cache is deterministic across file order, changes with every packaged resource and architecture',async()=>{
  const modulePath='../scripts/portable-build.mjs';const {portableCacheIdentity}=await import(modulePath);
  const a=await mkdtemp(path.resolve('.test-data/portable-a-')),b=await mkdtemp(path.resolve('.test-data/portable-b-'));
  await mkdir(path.join(a,'resources'));await mkdir(path.join(b,'resources'));
  for(const dir of [a,b]){await writeFile(path.join(dir,'Lumi.exe'),'fixture executable');await writeFile(path.join(dir,'resources','app.asar'),'fixture archive');await writeFile(path.join(dir,'file.dll'),'fixture dll');}
  const initial=await portableCacheIdentity(a,1);assert.equal(initial,await portableCacheIdentity(b,1));assert.notEqual(initial,await portableCacheIdentity(a,2));
  await writeFile(path.join(a,'file.dll'),'changed dll');assert.notEqual(initial,await portableCacheIdentity(a,1));
  await writeFile(path.join(a,'new-resource.bin'),'new resource');assert.notEqual(await portableCacheIdentity(a,1),await portableCacheIdentity(b,1));
});
