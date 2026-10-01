import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdir,mkdtemp,readFile,writeFile,access} from 'node:fs/promises';
import path from 'node:path';
import {parse} from 'smol-toml';
import {SettingsStore,type Cipher} from '../electron/services/store';
import {ConfigService,buildCodex} from '../electron/services/config';
const cipher:Cipher={available:()=>true,encrypt:s=>Buffer.from(s).toString('base64'),decrypt:s=>Buffer.from(s,'base64').toString()};
const req={tool:'codex' as const,model:'actual-custom-model-name',group:'standard'};
const legacyName='lumi-model-catalog.json';
async function fixture(){
  await mkdir('.test-data',{recursive:true});const root=await mkdtemp(path.resolve('.test-data/pass-through-'));
  const home=path.join(root,'home'),dir=path.join(home,'.codex');await mkdir(dir,{recursive:true});
  const store=new SettingsStore(path.join(root,'app'),cipher);await store.load();
  await store.saveSite({id:store.activeSite().id,name:'Fixture',url:'https://fixture.invalid',allowHttp:false});
  let resolves=0;
  const service=new ConfigService(store,path.join(root,'app'),home,async()=>{resolves++;return {key:'sk-isolated-only',tokenName:'Lumi-Codex-standard',tokenId:1,group:'standard',created:false,siteId:store.activeSite().id,siteUrl:store.activeSite().url};});
  return {root,dir,store,service,get resolves(){return resolves;}};
}
test('fresh Codex config sets the actual model and connection without any catalog or instruction fields',()=>{
  const result=buildCodex(null,null,req,'https://fixture.invalid','sk-test'),doc:any=parse(result.config);
  assert.deepEqual(JSON.parse(JSON.stringify(doc)),{model:req.model,model_provider:'custom',model_context_window:272000,model_providers:{custom:{name:'Lumi · New API',base_url:'https://fixture.invalid/v1',wire_api:'responses',experimental_bearer_token:'sk-test',requires_openai_auth:false}}});
  assert.equal(JSON.parse(result.auth).OPENAI_API_KEY,undefined);
});
test('active profile changes model and connection while user instructions, personal profiles and MCP settings remain untouched',()=>{
  const before='profile = "work"\nbase_instructions = "User-owned content"\nmodel_instructions_file = "user.md"\n[profiles.work]\nmodel = "old"\nmodel_reasoning_effort = "high"\ndeveloper_instructions = "User-owned profile content"\n[profiles.personal]\nmodel = "personal"\n[mcp_servers.docs]\ncommand = "kept"\n';
  const original:any=parse(before),doc:any=parse(buildCodex(before,null,req,'https://fixture.invalid','sk-test').config);
  assert.equal(doc.profiles.work.model,req.model);assert.equal(doc.profiles.work.model_provider,'custom');
  assert.equal(doc.profiles.work.model_reasoning_effort,undefined);
  assert.equal(doc.base_instructions,original.base_instructions);assert.equal(doc.model_instructions_file,original.model_instructions_file);
  assert.equal(doc.profiles.work.developer_instructions,original.profiles.work.developer_instructions);
  assert.deepEqual(doc.profiles.personal,original.profiles.personal);assert.deepEqual(doc.mcp_servers,original.mcp_servers);
});
test('migration disconnects only the exact obsolete Lumi catalog, including relative paths and inactive profiles',()=>{
  const dir=path.resolve('.test-data/home/.codex'),legacy=path.join(dir,legacyName),user=path.resolve('.test-data/user',legacyName);
  const before='model_catalog_json = '+JSON.stringify(legacy)+'\nprofile = "work"\n[profiles.work]\nmodel_catalog_json = "./'+legacyName+'"\n[profiles.old]\nmodel_catalog_json = '+JSON.stringify(legacy)+'\n[profiles.personal]\nmodel_catalog_json = '+JSON.stringify(user)+'\n';
  const doc:any=parse(buildCodex(before,null,req,'https://fixture.invalid','sk-test',dir).config);
  assert.equal(doc.model_catalog_json,undefined);assert.equal(doc.profiles.work.model_catalog_json,undefined);assert.equal(doc.profiles.old.model_catalog_json,undefined);
  assert.equal(doc.profiles.personal.model_catalog_json,user);
  const external:any=parse(buildCodex('model_catalog_json = "user-catalog.json"\n',null,req,'https://fixture.invalid','sk-test',dir).config);
  assert.equal(external.model_catalog_json,'user-catalog.json');
});
test('two-file preview/apply/backup/restore leaves cache and old catalog bytes untouched, even when malformed',async()=>{
  const f=await fixture(),config=path.join(f.dir,'config.toml'),legacy=path.join(f.dir,legacyName),cache=path.join(f.dir,'models_cache.json');
  const old='model = "original"\nmodel_catalog_json = "./'+legacyName+'"\n';
  await writeFile(config,old);await writeFile(legacy,'{not-parsed');await writeFile(cache,'{also-not-parsed');
  const preview=await f.service.preview(req);assert.equal(preview.files.length,2);
  assert.equal(parse(preview.files[0].after).model_catalog_json,undefined);assert.equal(await readFile(config,'utf8'),old);
  await f.service.apply(preview.id);assert.equal(parse(await readFile(config,'utf8')).model,req.model);
  assert.equal(await readFile(legacy,'utf8'),'{not-parsed');assert.equal(await readFile(cache,'utf8'),'{also-not-parsed');
  const [backup]=await f.service.backups();assert.deepEqual(backup.paths,[config,path.join(f.dir,'auth.json')]);
  await f.service.restore(backup.id);assert.equal(await readFile(config,'utf8'),old);
  await assert.rejects(access(path.join(f.dir,'auth.json')));
});
test('external user catalogs are neither imported nor rewritten and are not part of the generated preview',async()=>{
  const f=await fixture(),external=path.join(f.root,'user-catalog.json'),config=path.join(f.dir,'config.toml');
  await writeFile(external,'User-owned catalog bytes');
  await writeFile(config,'model_catalog_json = '+JSON.stringify(external)+'\n');
  const preview=await f.service.preview(req);assert.equal(preview.files.length,2);assert.equal(parse(preview.files[0].after).model_catalog_json,external);
  await writeFile(external,'User changed their own catalog');
  await f.service.apply(preview.id);
  assert.equal(await readFile(external,'utf8'),'User changed their own catalog');await assert.rejects(access(path.join(f.dir,legacyName)));
});
test('malformed config stops before provisioning, and changed config invalidates apply',async()=>{
  const f=await fixture(),config=path.join(f.dir,'config.toml');
  await writeFile(config,'broken = [');await assert.rejects(f.service.preview(req),/语法无效/);assert.equal(f.resolves,0);
  await writeFile(config,'model = "old"\n');const preview=await f.service.preview(req);
  await writeFile(config,'model = "edited"\n');await assert.rejects(f.service.apply(preview.id),/其他程序修改/);
  assert.equal((await f.service.backups()).length,0);
});
test('historical three-file backups remain restorable and reject unrelated catalog paths',async()=>{
  const f=await fixture(),config=path.join(f.dir,'config.toml'),auth=path.join(f.dir,'auth.json'),catalog=path.join(f.dir,legacyName);
  const before=[{path:config,content:'model = "original"\n'},{path:auth,content:null},{path:catalog,content:null}];
  const after=[{path:config,content:'model = "old-lumi"\n'},{path:auth,content:'{}'},{path:catalog,content:'Legacy backup bytes'}];
  for(const file of after)await writeFile(file.path,file.content);
  const backup={id:'historical-three-files',tool:'codex',createdAt:Date.now(),paths:after.map(f=>f.path),before,after};
  await mkdir(path.join(f.root,'app/backups'),{recursive:true});
  await writeFile(path.join(f.root,'app/backups',backup.id+'.json'),JSON.stringify({version:1,encrypted:cipher.encrypt(JSON.stringify(backup))}));
  await f.service.restore(backup.id);assert.equal(await readFile(config,'utf8'),before[0].content);await assert.rejects(access(auth));await assert.rejects(access(catalog));
  const unrelated=path.join(f.root,'unrelated.json');
  const invalid={...backup,id:'invalid-path',before:[{path:unrelated,content:'before'}],after:[{path:unrelated,content:'after'}]};
  await writeFile(path.join(f.root,'app/backups',invalid.id+'.json'),JSON.stringify({version:1,encrypted:cipher.encrypt(JSON.stringify(invalid))}));
  await assert.rejects(f.service.restore(invalid.id),/备份路径/);
});
