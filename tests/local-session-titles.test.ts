import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdir,mkdtemp,writeFile,rm} from 'node:fs/promises';
import path from 'node:path';
import {sessionTitles} from '../electron/services/local-session-titles';
import {LocalUsageService} from '../electron/services/local-usage';

test('official Codex and Claude indexes identify sessions without loading unrelated titles',async t=>{
  const parent=path.resolve('.test-data');await mkdir(parent,{recursive:true});const root=await mkdtemp(path.join(parent,'session-titles-'));
  const codexRoot=path.join(root,'.codex'),project=path.join(root,'.claude/projects/project');
  await mkdir(path.join(codexRoot,'sessions'),{recursive:true});await mkdir(project,{recursive:true});
  t.after(async()=>{assert.equal(path.dirname(root),parent);await rm(root,{recursive:true,force:true,maxRetries:5});});
  const id='11111111-2222-4333-8444-555555555555',codex=path.join(codexRoot,'sessions',`rollout-2026-10-02-${id}.jsonl`),claude=path.join(project,'claude-fixture.jsonl');
  await writeFile(path.join(codexRoot,'session_index.jsonl'),[
    {id,thread_name:'修复布局'}, {id:'unrelated',thread_name:'不匹配的会话'}, {id,thread_name:'优化会话详情'},
  ].map(value=>JSON.stringify(value)).join('\n')+'\n');
  await writeFile(path.join(project,'sessions-index.json'),JSON.stringify({entries:[{sessionId:'claude-fixture',summary:'调用统计',firstPrompt:'统计会话的调用',projectPath:'/fixture/project',gitBranch:'main'}]}));
  const titles=await sessionTitles(codexRoot,[codex],[claude]);assert.equal(titles.size,2);assert.equal(titles.get(codex)?.title,'优化会话详情');assert.equal(titles.get(claude)?.cwd,'/fixture/project');
  const timestamp=new Date().toISOString();
  await writeFile(codex,[{type:'session_meta',payload:{id,cwd:'/fixture/codex'}},{type:'turn_context',payload:{model:'fixture-model'}},{type:'response_item',payload:{type:'message',role:'user',content:[{type:'input_text',text:'用户原始问题'}]}},{type:'event_msg',timestamp,payload:{type:'token_count',info:{last_token_usage:{input_tokens:20,output_tokens:3}}}}].map(value=>JSON.stringify(value)).join('\n')+'\n');
  await writeFile(claude,[{type:'user',sessionId:'claude-fixture',cwd:'/fixture/project',message:{content:'统计会话的调用'}},{type:'assistant',timestamp,message:{id:'m1',model:'claude-fixture',usage:{input_tokens:3,output_tokens:4}}}].map(value=>JSON.stringify(value)).join('\n')+'\n');
  const usage=new LocalUsageService(root);t.after(()=>usage.close());const result=await usage.scan(7);
  const summary=result.sessions?.find(value=>value.tool==='codex');assert.equal(summary?.metadata?.title,'优化会话详情');assert.equal(summary?.metadata?.firstPrompt,'用户原始问题');
  const snapshot=await usage.sessionStore.load({sessionId:summary!.id,query:7,requestId:crypto.randomUUID()});assert.equal(snapshot.metadata.title,'优化会话详情');assert.equal(snapshot.metadata.sessionKey,id);usage.sessionStore.release({snapshotId:snapshot.snapshotId});
});

test('missing or malformed optional title indexes do not prevent fallback metadata',async t=>{
  const parent=path.resolve('.test-data');await mkdir(parent,{recursive:true});const root=await mkdtemp(path.join(parent,'session-titles-'));t.after(async()=>{await rm(root,{recursive:true,force:true});});
  await writeFile(path.join(root,'session_index.jsonl'),'invalid\n'+JSON.stringify({id:'a',thread_name:'有效会话'})+'\n');
  const result=await sessionTitles(root,[path.join(root,'a.jsonl')],[]);assert.equal(result.get(path.join(root,'a.jsonl'))?.title,'有效会话');assert.equal((await sessionTitles(path.join(root,'missing'),[],[])).size,0);
});
