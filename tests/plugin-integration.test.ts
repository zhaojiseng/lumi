import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdir,mkdtemp,readFile,writeFile,rm} from 'node:fs/promises';
import path from 'node:path';
import {build} from 'esbuild';
import {runInNewContext} from 'node:vm';
import {SettingsStore} from '../electron/services/store';
import {ConfigService} from '../electron/services/config';
import {NewApiClient} from '../electron/services/new-api';
import {createBuiltinPlugins} from '../electron/host/plugins';
import {normalizePluginEnabled,normalizePluginViews,settingsGroups,validatePluginView} from '../shared/plugin-preferences';
import type {CatalogSnapshot} from '../shared/contracts/catalog';
import type {LumiBridge} from '../shared/types';
import {builtinManifests} from '../plugins/manifests';
const cipher={available:()=>true,encrypt:(s:string)=>Buffer.from(s).toString('base64'),decrypt:(s:string)=>Buffer.from(s,'base64').toString()};
async function fixture(t:{after(fn:()=>Promise<void>):void}){const parent=path.resolve('.test-data');await mkdir(parent,{recursive:true});const root=await mkdtemp(path.join(parent,'plugin-integration-'));t.after(()=>rm(root,{recursive:true,force:true,maxRetries:5,retryDelay:100}));const store=new SettingsStore(root,cipher);await store.load();return {root,store};}
function deferred<T>(){let resolve!:(value:T)=>void;const promise=new Promise<T>(r=>resolve=r);return {resolve,promise};}
const request=(store:SettingsStore)=>({siteId:store.activeSite().id,siteUrl:store.activeSite().url});
function snapshot(store:SettingsStore):CatalogSnapshot{return {...request(store),loggedIn:false,catalog:{models:[],groupRatio:{},usableGroups:{},autoGroups:[],vendors:[]},status:{system_name:'Fixture',quota_per_unit:1},warnings:[],fetchedAt:1};}

test('product and tool plugins own declared settings and extensible custom switches',()=>{
  assert.deepEqual(settingsGroups().filter(g=>g.group!=='interface').map(g=>[g.title,g.views.map(v=>v.title)]),[['NewAPI',['工作台','用量分析','模型广场','API令牌']],['Codex',['工作台']],['Codex 桥接',['桥接']],['浮窗',[]],['托盘',[]],['Codex 工具配置',[]],['Claude Code 工具配置',[]]]);
  assert.deepEqual(builtinManifests.filter(m=>m.configurable && m.settings?.group!=='interface').map(m=>m.id),['provider.newapi','provider.codex','provider.codex-bridge','surface.widget','surface.tray','adapter.tool.codex','adapter.tool.claude']);
  assert.deepEqual(settingsGroups().filter(group=>group.group==='tools').map(group=>group.id),['adapter.tool.codex','adapter.tool.claude']);
  const custom={...builtinManifests[0],id:'provider.custom',settings:{title:'Custom',description:'',order:50,views:[{id:'history',title:'History',defaultEnabled:false}]}};
  validatePluginView('provider.custom','history',[custom]);assert.throws(()=>validatePluginView('provider.custom','tokens',[custom]));
  assert.deepEqual(normalizePluginViews({'provider.custom':{history:true,tokens:false}},{},[custom]),{'provider.custom':{history:true}});
});
test('legacy flags migrate to provider children preserving selections',async t=>{
  const {root,store}=await fixture(t);for(const v of [null,[],false,'bad',{'feature.models':'false'}])assert.deepEqual(normalizePluginEnabled(v),{});
  await store.update({theme:'dark',favoriteModels:['fixture'],selection:{siteId:store.activeSite().id,values:{'models.search':'kept'}}});
  const raw=JSON.parse(await readFile(path.join(root,'settings.json'),'utf8'));raw.preferences.pluginEnabled={'feature.models':false,'feature.tokens':false,'provider.newapi':false,unknown:true};
  await writeFile(path.join(root,'settings.json'),JSON.stringify(raw));await store.load();assert.deepEqual(store.preferences.pluginEnabled,{'provider.newapi':false});assert.deepEqual(store.preferences.pluginViews,{'provider.newapi':{models:false,tokens:false}});
  await store.setPluginEnabled('provider.newapi',true);await store.setPluginView('provider.newapi','tokens',true);const next=new SettingsStore(root,cipher);await next.load();
  assert.equal(next.preferences.pluginViews['provider.newapi'].models,false);assert.equal(next.preferences.theme,'dark');assert.deepEqual(next.preferences.favoriteModels,['fixture']);assert.equal(next.preferences.viewSelections[store.activeSite().id]['models.search'],'kept');
  await assert.rejects(store.setPluginEnabled('feature.models',false));await assert.rejects(store.setPluginView('provider.codex','tokens',false));
});
test('Codex subscription provider starts disabled unless explicitly enabled and keeps its saved choice',async t=>{
  const {root,store}=await fixture(t),host=await createBuiltinPlugins(store,{localHome:root,resolveCodex:async()=>assert.fail('Inactive provider must not resolve the CLI')});t.after(()=>host.dispose());
  assert.equal(host.isEnabled('provider.codex'),false);assert.equal(host.list().find(s=>s.manifest.id==='provider.codex')?.manifest.defaultEnabled,false);
  assert.throws(()=>host.require('provider.codex','subscriptionUsage.read'),/未启用/);assert.equal(host.isEnabled('provider.newapi'),true);assert.equal(host.isEnabled('adapter.tool.codex'),true);
  await host.setEnabled('provider.codex',true);
  const restored=new SettingsStore(root,cipher);await restored.load();const enabled=await createBuiltinPlugins(restored,{localHome:root});t.after(()=>enabled.dispose());assert.equal(enabled.isEnabled('provider.codex'),true);
  await enabled.setEnabled('provider.codex',false);const disabledStore=new SettingsStore(root,cipher);await disabledStore.load();const disabled=await createBuiltinPlugins(disabledStore,{localHome:root});t.after(()=>disabled.dispose());assert.equal(disabled.isEnabled('provider.codex'),false);
});
test('provider shutdown revokes late reads; stable ports reacquire capabilities after restart',async t=>{
  const {root,store}=await fixture(t),waiting=deferred<CatalogSnapshot>();let calls=0;
  const host=await createBuiltinPlugins(store,{localHome:root,catalog:{read:()=>{calls++;return calls===1 ? waiting.promise : Promise.resolve(snapshot(store));}}});t.after(()=>host.dispose());
  assert.equal(calls,0);const port=host.port('provider.newapi','catalog.read'),oldPort=host.require('provider.newapi','catalog.read');
  const old=host.readCatalog(request(store)),revoked=assert.rejects(old,/active|停用/i);await host.setEnabled('provider.newapi',false);assert.throws(()=>port.read(request(store)),/未启用/);
  assert.equal(host.isEnabled('feature.tool-config'),true);assert.equal(host.isEnabled('feature.usage'),true);await host.setEnabled('provider.newapi',true);waiting.resolve(snapshot(store));await revoked;
  assert.throws(()=>oldPort.read(request(store)),/active/i);assert.equal((await port.read(request(store))).siteId,store.activeSite().id);
  await host.setView('provider.newapi','models',false);assert.throws(()=>host.readCatalog(request(store)),/未启用/);assert.equal(typeof host.require('provider.newapi','toolCredential.provision').provision,'function');
  const next=new SettingsStore(root,cipher);await next.load();const restarted=await createBuiltinPlugins(next,{localHome:root});t.after(()=>restarted.dispose());assert.equal(restarted.list().find(s=>s.manifest.id==='provider.newapi')?.views?.models,false);
});
test('child off/on rejects pending catalog results without stopping the provider',async t=>{
  const {root,store}=await fixture(t),waiting=deferred<CatalogSnapshot>(),host=await createBuiltinPlugins(store,{localHome:root,catalog:{read:()=>waiting.promise}});t.after(()=>host.dispose());
  const read=host.readCatalog(request(store));await host.setView('provider.newapi','models',false);await host.setView('provider.newapi','models',true);waiting.resolve(snapshot(store));await assert.rejects(read,/关闭/);assert.equal(host.isEnabled('provider.newapi'),true);
});

test('NewAPI disable aborts an actual pending transport and restart uses a fresh controller',async t=>{
  const {root,store}=await fixture(t);await store.saveSite({name:'Fixture',url:'https://fixture.invalid',allowHttp:false});
  const original=globalThis.fetch,started=deferred<void>();let aborted=false,reads=0;
  globalThis.fetch=async(_input,options)=>{reads++;if(reads>1)return new Response(JSON.stringify({success:true,data:{system_name:'Fixture',quota_per_unit:1}}));
    const signal=options!.signal!;started.resolve();return new Promise<Response>((_resolve,reject)=>signal.addEventListener('abort',()=>{aborted=true;reject(new DOMException('Stopped','AbortError'));},{once:true}));};
  t.after(()=>{globalThis.fetch=original;});const host=await createBuiltinPlugins(store,{localHome:root});t.after(()=>host.dispose());
  const port=host.port('provider.newapi','online.usage'),old=port.status(),rejected=assert.rejects(old,/active|停用/i);await started.promise;await host.setEnabled('provider.newapi',false);await rejected;
  assert.equal(aborted,true);await host.setEnabled('provider.newapi',true);assert.equal((await port.status()).system_name,'Fixture');assert.equal(reads,2);
});
test('disk failures restore parent runtime, child flags and widget compatibility',async t=>{
  const {root,store}=await fixture(t),host=await createBuiltinPlugins(store,{localHome:root});t.after(()=>host.dispose());await host.setEnabled('surface.widget',true);await host.setView('provider.newapi','models',true);
  await rm(root,{recursive:true,force:true});await writeFile(root,'blocked directory');await assert.rejects(host.setEnabled('surface.widget',false));assert.equal(host.isEnabled('surface.widget'),true);assert.equal(store.preferences.widgetEnabled,true);assert.equal(store.preferences.pluginEnabled['surface.widget'],true);
  await assert.rejects(host.setView('provider.newapi','models',false));assert.equal(store.preferences.pluginViews['provider.newapi'].models,true);
});
test('mutations lock parent and child disable; hidden token UI preserves credential capability',async t=>{
  const {root,store}=await fixture(t),waiting=deferred<string>();let invalidated=0;const host=await createBuiltinPlugins(store,{localHome:root,beforeDisable:id=>{if(id==='provider.newapi')invalidated++;}});t.after(()=>host.dispose());
  const action=host.runView('provider.newapi','tokens',()=>waiting.promise);await assert.rejects(host.setEnabled('provider.newapi',false),/正在执行/);await assert.rejects(host.setView('provider.newapi','tokens',false),/正在执行/);assert.equal(invalidated,0);
  waiting.resolve('done');assert.equal(await action,'done');await host.setView('provider.newapi','tokens',false);await assert.rejects(host.runView('provider.newapi','tokens',async()=>assert.fail('hidden action')),/未启用/);
  assert.equal(typeof host.require('provider.newapi','toolCredential.provision').provision,'function');await host.setEnabled('provider.newapi',false);assert.equal(invalidated,1);
});
test('provider restart invalidates actual previews without deleting backups or CLI files',async t=>{
  const {root,store}=await fixture(t),site=store.activeSite(),config=new ConfigService(store,root,root,async()=>({key:'fake-key',tokenName:'fixture',tokenId:1,group:'default',created:false,siteId:site.id,siteUrl:site.url}));
  const host=await createBuiltinPlugins(store,{localHome:root,beforeDisable:id=>{if(id==='provider.newapi')config.invalidatePreviews();}});t.after(()=>host.dispose());const preview=await host.runFeature('provider.newapi',()=>config.preview({tool:'claude',model:'fixture',group:'default'}));
  await host.setEnabled('provider.newapi',false);assert.equal(host.isEnabled('feature.tool-config'),true);assert.ok(Array.isArray(await config.inspect()));await host.setEnabled('provider.newapi',true);
  await assert.rejects(config.apply(preview.id),/预览.*失效|重新预览/);assert.deepEqual(await config.backups(),[]);await assert.rejects(readFile(path.join(root,'.claude','settings.json')),e=>e instanceof Error && 'code' in e && e.code==='ENOENT');
});
test('widget and tray are independent projections; display switches retain underlying data',async t=>{
  const {root,store}=await fixture(t),host=await createBuiltinPlugins(store,{localHome:root});t.after(()=>host.dispose());await host.setEnabled('surface.widget',true);
  const widget=host.port('surface.widget','widget.project'),tray=host.port('surface.tray','tray.project');await host.setView('provider.newapi','workbench',false);await host.setView('provider.newapi','usage',false);
  assert.equal((await widget.loadWidget()).loggedIn,false);assert.equal((await tray.loadMenu()).siteId,store.activeSite().id);const old=host.require('surface.widget','widget.project');
  await host.setEnabled('surface.widget',false);assert.throws(()=>old.loadWidget(),/active/i);assert.equal((await tray.loadMenu()).siteId,store.activeSite().id);await host.setEnabled('surface.widget',true);
  await host.setEnabled('surface.tray',false);assert.equal((await widget.loadWidget()).loggedIn,false);assert.throws(()=>tray.loadMenu(),/未启用/);
  await host.setEnabled('provider.newapi',false);await assert.rejects(widget.loadWidget(),/active/i);assert.equal((await host.require('source.local-sessions','localSessions.read').scan(7)).filesScanned,0);
  await host.setEnabled('provider.newapi',true);assert.equal((await widget.loadWidget()).siteId,store.activeSite().id);
  for(const file of ['plugins/surface.widget/main.ts','plugins/surface.tray/main.ts'])assert.doesNotMatch(await readFile(file,'utf8'),/provider\.newapi|localWidgetPricing/);
});
test('shutdown drains mutations and immediately rejects new commands',async t=>{
  const {root,store}=await fixture(t),host=await createBuiltinPlugins(store,{localHome:root}),waiting=deferred<string>();const action=host.runFeature('provider.newapi',()=>waiting.promise),rejected=assert.rejects(action,/停用/);let disposed=false;
  const closing=host.dispose().then(()=>{disposed=true;});await new Promise(resolve=>setImmediate(resolve));assert.equal(disposed,false);await assert.rejects(host.setEnabled('provider.newapi',true),/退出/);await assert.rejects(host.runFeature('provider.newapi',async()=>''),/退出/);
  waiting.resolve('done');await rejected;await closing;assert.ok(host.list().every(s=>s.state==='disabled'));
});
const browserBundle=build({entryPoints:['src/bridge.ts'],bundle:true,platform:'browser',format:'cjs',write:false,logLevel:'silent'});
async function browser(storage=new Map<string,string>(),fail=false){const module={exports:{} as {bridge:LumiBridge}};runInNewContext((await browserBundle).outputFiles[0].text,{module,exports:module.exports,structuredClone,window:{},localStorage:{getItem:(key:string)=>storage.get(key) ?? null,setItem:(key:string,value:string)=>{if(fail)throw new Error('storage unavailable');storage.set(key,value);}},fetch:()=>assert.fail('placeholder must not fetch')});return {bridge:module.exports.bridge,storage};}
test('browser stores product and child flags without desktop privileges and rolls back failures',async()=>{
  const {bridge,storage}=await browser();assert.equal((await bridge.listPlugins()).find(s=>s.manifest.id==='provider.codex')?.state,'disabled');await bridge.setPluginEnabled('provider.codex',true);await bridge.setPluginView('provider.newapi','models',false);await bridge.setPluginEnabled('provider.newapi',false);const next=(await browser(storage)).bridge;
  assert.equal((await next.listPlugins()).find(s=>s.manifest.id==='provider.codex')?.state,'active');
  assert.equal((await next.listPlugins()).find(s=>s.manifest.id==='provider.newapi')?.state,'disabled');await next.setPluginEnabled('provider.newapi',true);assert.equal((await next.listPlugins()).find(s=>s.manifest.id==='provider.newapi')?.views?.models,false);
  await assert.rejects(next.readCatalog({siteId:'x',siteUrl:'https://fixture.invalid'}),/Electron/);await next.dashboard(7);await assert.rejects(next.setPluginView('provider.codex','tokens',false));await assert.rejects(next.setPluginEnabled('feature.usage',false));
  const failed=(await browser(new Map(),true)).bridge;await assert.rejects(failed.setPluginEnabled('provider.newapi',false),/storage unavailable/);assert.equal((await failed.listPlugins()).find(s=>s.manifest.id==='provider.newapi')?.state,'active');
  await assert.rejects(failed.setPluginView('provider.newapi','models',false));assert.equal((await failed.listPlugins()).find(s=>s.manifest.id==='provider.newapi')?.views?.models,undefined);
});
test('catalog remains narrow; renderer and restricted preloads preserve privilege boundaries',async t=>{
  const {store}=await fixture(t),api=new NewApiClient(store);t.after(async()=>api.close());const value=await api.readCatalog(request(store));assert.equal(value.loggedIn,false);assert.equal('logs' in value,false);assert.equal('tokens' in value,false);await assert.rejects(api.readCatalog({...request(store),siteId:'other'}),/切换/);
  const bundle=await build({entryPoints:['src/host/renderer-registry.ts'],bundle:true,platform:'browser',outdir:'.test-data/plugin-boundary-build',write:false,metafile:true,loader:{'.svg':'text'},logLevel:'silent'});
  for(const input of Object.keys(bundle.metafile!.inputs))assert.ok(!input.startsWith('electron/') && !/^plugins\/[^/]+\/(?:main\.|services\/|build\.)/.test(input),input);
  for(const file of ['electron/widget-preload.ts','electron/tray-preload.ts'])assert.doesNotMatch(await readFile(file,'utf8'),/readCatalog|readCodexUsage|setPluginEnabled|setPluginView|listPlugins/);
  const main=await readFile('electron/main.ts','utf8');for(const op of ['readCatalog','readCodexUsage','listPlugins','setPluginEnabled','setPluginView'])assert.ok(main.includes(`handle('${op}',`));
});
test('all product and tool plugins can stay disabled across restart with shared systems available',async t=>{
  const {root,store}=await fixture(t),host=await createBuiltinPlugins(store,{localHome:root});t.after(()=>host.dispose());for(const m of builtinManifests.filter(m=>m.configurable))await host.setEnabled(m.id,false);
  const restored=new SettingsStore(root,cipher);await restored.load();const next=await createBuiltinPlugins(restored,{localHome:root});t.after(()=>next.dispose());for(const s of next.list())assert.equal(s.state,s.manifest.configurable ? 'disabled' : 'active',s.manifest.id);
  for(const id of ['feature.workbench','feature.usage','feature.models','feature.tokens','feature.tool-config','theme.default'])await assert.rejects(next.setEnabled(id,false),/不能切换/);
  const input={request:{tool:'codex' as const,model:'fixture',group:'default'},config:null,auth:'{"tokens":{}}',baseUrl:'https://fixture.invalid',key:'fake-key',configDir:path.join(root,'.codex')};
  assert.throws(()=>next.require('adapter.tool.codex','toolConfig.build'),/未启用/);assert.throws(()=>next.require('adapter.tool.claude','toolConfig.build'),/未启用/);
  await next.setEnabled('adapter.tool.codex',true);await next.setEnabled('adapter.tool.claude',true);
  assert.match(next.require('adapter.tool.codex','toolConfig.build').build(input).config,/model_provider = "custom"/);assert.equal(JSON.parse(next.require('adapter.tool.claude','toolConfig.build').build({...input,request:{...input.request,tool:'claude'}}).config).env.ANTHROPIC_MODEL,'fixture');
});

test('tool plugins toggle and reload independently without stopping the shared tool page',async t=>{
  const {root,store}=await fixture(t),host=await createBuiltinPlugins(store,{localHome:root});t.after(()=>host.dispose());
  const old=host.require('adapter.tool.codex','toolConfig.build');
  await host.setEnabled('adapter.tool.codex',false);
  assert.equal(host.isEnabled('feature.tool-config'),true);assert.equal(host.isEnabled('adapter.tool.claude'),true);
  assert.throws(()=>old.build({request:{tool:'codex',model:'fixture',group:'default'},config:null,auth:null,baseUrl:'https://fixture.invalid',key:'fake-key',configDir:root}),/active/i);
  const restored=new SettingsStore(root,cipher);await restored.load();const next=await createBuiltinPlugins(restored,{localHome:root});t.after(()=>next.dispose());
  assert.equal(next.isEnabled('adapter.tool.codex'),false);assert.equal(next.isEnabled('adapter.tool.claude'),true);assert.equal(next.isEnabled('feature.tool-config'),true);
  await next.setEnabled('adapter.tool.codex',true);await next.setEnabled('adapter.tool.claude',false);
  assert.equal(next.isEnabled('adapter.tool.codex'),true);assert.equal(next.isEnabled('feature.tool-config'),true);
});

test('tool disable invalidates only its previews and rejects restore until re-enabled, preserving files and backups',async t=>{
  const {root,store}=await fixture(t),site=store.activeSite();let config:ConfigService;
  const host=await createBuiltinPlugins(store,{localHome:root,beforeDisable:id=>{if(id==='adapter.tool.codex')config.invalidatePreviews('codex');if(id==='adapter.tool.claude')config.invalidatePreviews('claude');}});t.after(()=>host.dispose());
  config=new ConfigService(store,root,root,async request=>({key:'fake-'+request.tool,tokenName:'fixture-'+request.tool,tokenId:request.tool==='codex' ? 1 : 2,group:'default',created:false,siteId:site.id,siteUrl:site.url}),tool=>host.require('adapter.tool.'+tool,'toolConfig.build'));
  const codex=await config.preview({tool:'codex',model:'fixture',group:'default'}),claude=await config.preview({tool:'claude',model:'fixture',group:'default'});
  await host.setEnabled('adapter.tool.codex',false);await assert.rejects(config.apply(codex.id),/预览.*过期|重新预览/);
  await config.apply(claude.id);const file=path.join(root,'.claude','settings.json'),content=await readFile(file,'utf8'),backups=await config.backups();
  assert.equal(backups.length,1);assert.equal(JSON.parse(content).env.ANTHROPIC_MODEL,'fixture');
  await host.setEnabled('adapter.tool.claude',false);
  await assert.rejects(config.preview({tool:'claude',model:'fixture',group:'default'}),/未启用/);
  await assert.rejects(config.restore(backups[0].id),/未启用/);
  assert.equal(await readFile(file,'utf8'),content);assert.deepEqual(await config.backups(),backups);
  await host.setEnabled('adapter.tool.claude',true);await config.restore(backups[0].id);
  await assert.rejects(readFile(file),error=>error instanceof Error && 'code' in error && error.code==='ENOENT');
});

test('an actual pending tool preview locks only its plugin until provisioning settles',async t=>{
  const {root,store}=await fixture(t),site=store.activeSite(),waiting=deferred<void>(),started=deferred<void>();let config:ConfigService;
  const host=await createBuiltinPlugins(store,{localHome:root,beforeDisable:id=>{if(id.startsWith('adapter.tool.'))config.invalidatePreviews(id.endsWith('codex') ? 'codex' : 'claude');}});t.after(()=>host.dispose());
  config=new ConfigService(store,root,root,async()=>{started.resolve();await waiting.promise;return {key:'fake-key',tokenName:'fixture',tokenId:1,group:'default',created:false,siteId:site.id,siteUrl:site.url};},tool=>host.require('adapter.tool.'+tool,'toolConfig.build'));
  const preview=host.runFeature('adapter.tool.claude',()=>host.runFeature('provider.newapi',()=>config.preview({tool:'claude',model:'fixture',group:'default'})));
  await started.promise;await assert.rejects(host.setEnabled('adapter.tool.claude',false),/正在执行/);
  await host.setEnabled('adapter.tool.codex',false);assert.equal(host.isEnabled('adapter.tool.claude'),true);
  waiting.resolve();const prepared=await preview;await host.setEnabled('adapter.tool.claude',false);
  await assert.rejects(config.apply(prepared.id),/预览.*过期|重新预览/);assert.deepEqual(await config.backups(),[]);
});
