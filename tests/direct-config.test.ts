import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,readFile,access} from 'node:fs/promises';
import {DatabaseSync} from 'node:sqlite';
import path from 'node:path';
import {parse} from 'smol-toml';
import {SettingsStore,type Cipher} from '../electron/services/store';
import {ConfigService,buildCodex} from '../electron/services/config';
import {switchSessionDocument,applyStateChanges} from '../electron/services/codex-direct';
const cipher:Cipher={available:()=>true,encrypt:s=>Buffer.from(s).toString('base64'),decrypt:s=>Buffer.from(s,'base64').toString()};
async function fixture(){const root=await mkdtemp(path.resolve('.test-data/direct-config-')),home=path.join(root,'home'),dir=path.join(home,'.codex');await mkdir(dir,{recursive:true});const store=new SettingsStore(path.join(root,'app'),cipher);await store.load();await store.saveSite({id:store.activeSite().id,name:'Fixture',url:'https://fixture.invalid',allowHttp:false});let tokenCalls=0;const service=new ConfigService(store,path.join(root,'app'),home,async()=>{tokenCalls++;return {siteId:store.activeSite().id,siteUrl:store.activeSite().url,key:'sk-only-fixture',tokenId:1,tokenName:'Lumi-test',group:'test',created:false};});return {root,home,dir,store,service,get tokenCalls(){return tokenCalls;}};}
const req={tool:'codex' as const,model:'new-model',group:'test',contextWindow:400000};
function rollout(id:string,provider:string){return [{type:'session_meta',payload:{id,model_provider:provider}},{type:'turn_context',payload:{model:'historical-model'}},{type:'event_msg',payload:{type:'token_count',info:{total_token_usage:{input_tokens:100}}}},{type:'event_msg',payload:{type:'thread_settings_applied',thread_settings:{model:'old-model',model_provider_id:provider,collaboration_mode:{mode:'default',settings:{model:'old-model',developer_instructions:'User content preserved'}}}}}].map(x=>JSON.stringify(x)).join('\n')+'\n';}
test('direct Codex context updates active profile without forced reasoning or compact thresholds',()=>{
 const original='profile="work"\nmodel_auto_compact_token_limit=220000\n[profiles.work]\nmodel_context_window=100000\nmodel_reasoning_effort="high"\n[profiles.personal]\nmodel_context_window=1000000\n';const d:any=parse(buildCodex(original,null,req,'https://fixture.invalid','sk-only-fixture').config);
 assert.equal(d.model_context_window,400000);assert.equal(d.profiles.work.model_context_window,400000);assert.equal(d.profiles.work.model_reasoning_effort,undefined);assert.equal(d.model_auto_compact_token_limit,220000);assert.equal(d.profiles.personal.model_context_window,1000000);
});
test('snapshot migration updates only provider and latest session settings while preserving past turns and user instructions',()=>{
 const content=rollout('id','lumi'),r=switchSessionDocument(content,'new-model',272000,new Set(['lumi']))!;
 const before=content.trim().split('\n'),after=r.after.trim().split('\n');assert.equal(after[1],before[1]);assert.equal(after[2],before[2]);
 const settings=JSON.parse(after[3]).payload.thread_settings;assert.equal(settings.model,'new-model');assert.equal(settings.collaboration_mode.settings.model,'new-model');assert.equal(settings.collaboration_mode.settings.developer_instructions,'User content preserved');
 assert.equal(switchSessionDocument(rollout('other','openai'),'new',272000,new Set(['lumi'])),null);
});
test('config application atomically migrates active and archived Lumi sessions and SQLite rows; encrypted backup restores all',async()=>{
 const f=await fixture(),sessions=path.join(f.dir,'sessions'),archived=path.join(f.dir,'archived_sessions');await mkdir(sessions);await mkdir(archived);
 const files=[path.join(sessions,'one.jsonl'),path.join(archived,'two.jsonl'),path.join(sessions,'other.jsonl')],contents=[rollout('one','lumi'),rollout('two','lumi'),rollout('other','openai')];for(let i=0;i<3;i++)await writeFile(files[i],contents[i]);
 const dbPath=path.join(f.dir,'state_5.sqlite');let db=new DatabaseSync(dbPath);db.exec("CREATE TABLE threads(id TEXT PRIMARY KEY,model_provider TEXT,model TEXT);INSERT INTO threads VALUES('one','lumi','old-model'),('two','lumi','old-model'),('other','openai','official-model')");db.close();
 const preview=await f.service.preview(req);assert.equal(preview.files.length,2);assert.ok(preview.changes.some(s=>s.includes('应用时同步相关旧对话')));assert.ok(!JSON.stringify(preview).includes('sk-only-fixture'));
 await f.service.apply(preview.id);for(const file of files.slice(0,2))assert.equal(JSON.parse((await readFile(file,'utf8')).trim().split('\n').at(-1)!).payload.thread_settings.model,'new-model');assert.equal(await readFile(files[2],'utf8'),contents[2]);
 db=new DatabaseSync(dbPath);assert.deepEqual({...db.prepare('SELECT model_provider,model FROM threads WHERE id=?').get('one')},{model_provider:'custom',model:'new-model'});db.close();
 const [backup]=await f.service.backups();await f.service.restore(backup.id);for(let i=0;i<3;i++)assert.equal(await readFile(files[i],'utf8'),contents[i]);
 db=new DatabaseSync(dbPath);assert.equal(db.prepare('SELECT model_provider FROM threads WHERE id=?').get('one')?.model_provider,'lumi');db.close();
});
test('SQLite conflicts roll back configuration and history rather than overwrite concurrent updates',async()=>{
 const f=await fixture();await mkdir(path.join(f.dir,'sessions'));const file=path.join(f.dir,'sessions','one.jsonl'),content=rollout('one','lumi');await writeFile(file,content);
 const dbPath=path.join(f.dir,'state_5.sqlite'),db=new DatabaseSync(dbPath);db.exec("CREATE TABLE threads(id TEXT PRIMARY KEY,model_provider TEXT,model TEXT);INSERT INTO threads VALUES('one','lumi','old-model')");
 const preview=await f.service.preview(req);db.exec("UPDATE threads SET model='external-model'");await assert.rejects(f.service.apply(preview.id),/索引已变更/);assert.equal(await readFile(file,'utf8'),content);await assert.rejects(access(path.join(f.dir,'config.toml')));assert.equal(db.prepare('SELECT model FROM threads').get()?.model,'external-model');db.close();
});
test('Claude CLI accepts actual model IDs and ignores Desktop files in preview, application, inspection and restore',async()=>{
 const f=await fixture(),cliPath=path.join(f.home,'.claude','settings.json');
 const desktopPath=path.join(f.home,'AppData','Local','Claude-3p','configLibrary','_meta.json'),desktopBefore='{malformed Desktop fixture';
 await mkdir(path.dirname(desktopPath),{recursive:true});await writeFile(desktopPath,desktopBefore);
 await mkdir(path.dirname(cliPath),{recursive:true});const original='{"permissions":{"allow":["Read"]},"mcpServers":{"kept":{}},"env":{"OTHER":"preserved","ANTHROPIC_AUTH_TOKEN":"old-token","ANTHROPIC_API_KEY":"old-key"}}';await writeFile(cliPath,original);
 const preview=await f.service.preview({tool:'claude',model:'gpt-fixture-anthropic',group:'test'});assert.equal(preview.files.length,1);assert.equal(preview.files[0].path,cliPath);assert.ok(!JSON.stringify(preview).includes('sk-only-fixture'));
 await f.service.apply(preview.id);const cli=JSON.parse(await readFile(cliPath,'utf8'));assert.equal(cli.env.ANTHROPIC_API_KEY,'sk-only-fixture');assert.equal(cli.env.ANTHROPIC_AUTH_TOKEN,undefined);assert.equal(cli.env.ANTHROPIC_MODEL,'gpt-fixture-anthropic');assert.equal(cli.env.OTHER,'preserved');assert.deepEqual(cli.mcpServers,{kept:{}});assert.deepEqual(cli.permissions,{allow:['Read']});
 const state=(await f.service.inspect()).find(c=>c.tool==='claude')!;assert.equal(state.model,'gpt-fixture-anthropic');assert.equal(state.error,undefined);assert.equal(state.keyConfigured,true);assert.ok(!JSON.stringify(state).includes('desktop'));
 const [backup]=await f.service.backups();assert.deepEqual(backup.paths,[cliPath]);await f.service.restore(backup.id);assert.equal(await readFile(cliPath,'utf8'),original);assert.equal(await readFile(desktopPath,'utf8'),desktopBefore);
});
test('historical multi-file Claude backups restore only CLI even if Desktop settings have changed',async()=>{
 const f=await fixture(),cliPath=path.join(f.home,'.claude','settings.json'),desktopPath=path.join(f.home,'AppData','Local','Claude','claude_desktop_config.json');
 await mkdir(path.dirname(cliPath),{recursive:true});await mkdir(path.dirname(desktopPath),{recursive:true});await writeFile(cliPath,'{"model":"new"}');await writeFile(desktopPath,'Desktop user changed settings');
 const backup={id:'legacy-claude',tool:'claude',createdAt:1,paths:[cliPath,desktopPath],before:[{path:cliPath,content:'{"model":"old"}'},{path:desktopPath,content:'Old Desktop settings'}],after:[{path:cliPath,content:'{"model":"new"}'},{path:desktopPath,content:'Applied Desktop settings'}]};
 const backupDir=path.join(f.root,'app','backups');await mkdir(backupDir,{recursive:true});await writeFile(path.join(backupDir,'legacy-claude.json'),JSON.stringify({version:1,encrypted:cipher.encrypt(JSON.stringify(backup))}));
 const [listed]=await f.service.backups();assert.deepEqual(listed.paths,[cliPath]);await f.service.restore(listed.id);assert.equal(await readFile(cliPath,'utf8'),'{"model":"old"}');assert.equal(await readFile(desktopPath,'utf8'),'Desktop user changed settings');
});
test('invalid Claude CLI configuration stops before key provisioning and invalid contexts are rejected',async()=>{
 const f=await fixture(),cliPath=path.join(f.home,'.claude','settings.json');await mkdir(path.dirname(cliPath),{recursive:true});await writeFile(cliPath,'{invalid');await assert.rejects(f.service.preview({tool:'claude',model:'claude-sonnet-4-6',group:'test'}));assert.equal(f.tokenCalls,0);
 await assert.rejects(f.service.preview({...req,contextWindow:0}),/上下文/);assert.equal(f.tokenCalls,0);
});
