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
