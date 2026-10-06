import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile,mkdir,mkdtemp,writeFile,rm} from 'node:fs/promises';
import {existsSync} from 'node:fs';
import {createRequire} from 'node:module';
import {spawn} from 'node:child_process';
import path from 'node:path';
import {build} from 'esbuild';
import {LayoutDashboard,TerminalSquare,KeyRound,Settings} from 'lucide-react';
import {modelsManifest} from '../plugins/feature.models/manifest';
import {builtinManifests} from '../plugins/manifests';
import {tokensManifest} from '../plugins/feature.tokens/manifest';
import {newApiManifest} from '../plugins/provider.newapi/manifest';
import {rendererRegistry,rendererNavigation,resolveRendererPage,isRendererPageAvailable,configurableRendererContributions,contentContributions,workbenchContributions,toolConfigContributions,connectionContributions,settingsTabContributions,validateRendererRegistry,type RendererContribution,type NavigationItem} from '../src/host/renderer-registry';
import {lazy} from 'react';
import {CatalogResource,type CatalogScope} from '../src/host/catalog-resource';
import {PluginResource} from '../src/host/plugin-resource';
import type {CatalogSnapshot} from '../shared/contracts/catalog';
import type {PluginStatus} from '../shared/contracts/plugins';

function deferred<T>(){let resolve!:(value:T)=>void,reject!:(error:Error)=>void;const promise=new Promise<T>((yes,no)=>{resolve=yes;reject=no;});return {promise,resolve,reject};}
const scope=(accountKey='account-a',siteId='site-a',siteUrl='https://fixture.invalid'):CatalogScope=>({accountKey,siteId,siteUrl});
const snapshot=(siteId='site-a',siteUrl='https://fixture.invalid',fetchedAt=1):CatalogSnapshot=>({siteId,siteUrl,loggedIn:true,catalog:{models:[],groupRatio:{},usableGroups:{},autoGroups:[],vendors:[]},status:{system_name:'Fixture',quota_per_unit:500000},warnings:[],fetchedAt});
const status=(state:PluginStatus['state']):PluginStatus=>({manifest:modelsManifest,state});
const provider:PluginStatus={manifest:newApiManifest,state:'active'};
const builtinStatuses=(modelState:PluginStatus['state']='active'):PluginStatus[]=>builtinManifests.map(manifest=>({manifest,state:'active',views:manifest.id==='provider.newapi' ? {models:modelState==='active'} : undefined}));
const legacy:NavigationItem[]=[
  {id:'settings',label:'Settings',hint:'',icon:Settings,section:'settings'},
];

test('system surfaces receive provider content and adapter options; extra sidebar pages are scoped and withdrawn',()=>{
  const statuses=builtinStatuses();
  assert.deepEqual(contentContributions('tokens',statuses).map(view=>view.id),['newapi.tokens']);
  assert.deepEqual(contentContributions('models',statuses).map(view=>view.id),['newapi.models']);
  const noProvider=statuses.map(item=>item.manifest.id==='provider.newapi' ? {...item,state:'disabled' as const} : item);
  assert.deepEqual(contentContributions('tokens',noProvider),[]);assert.deepEqual(contentContributions('models',noProvider),[]);
  assert.ok(!rendererNavigation(legacy,noProvider).some(item=>item.id==='tokens'),'Empty uniform surfaces are hidden');
  assert.deepEqual(toolConfigContributions(statuses).map(view=>[view.tool,view.defaultPath]),[['codex','~/.codex/config.toml'],['claude','~/.claude/settings.json']]);
  for(const tool of ['codex','claude']){
    const withdrawn=statuses.map(item=>item.manifest.id==='adapter.tool.'+tool ? {...item,state:'disabled' as const} : item);
    assert.deepEqual(toolConfigContributions(withdrawn).map(view=>view.tool),[tool==='codex' ? 'claude' : 'codex']);
    assert.equal(resolveRendererPage('tools',withdrawn),'tools');
  }
  const page='plugin:provider.codex:quota',manifest=builtinManifests.find(item=>item.id==='provider.codex')!;
  const extra:RendererContribution={manifest,settings:{title:'fixture',description:''},sidebar:[{page:{id:page,scope:'independent',component:lazy(async()=>({default:()=>null}))},navigation:{id:page,label:'Quota',hint:'',icon:LayoutDashboard,section:'settings'}}]};
  validateRendererRegistry([extra]);
  assert.deepEqual(rendererNavigation(legacy,statuses,[extra]).map(item=>item.id),['settings',page]);
  assert.equal(resolveRendererPage(page,statuses,[extra]),page);
  const disabled=statuses.map(item=>item.manifest.id===manifest.id ? {...item,state:'disabled' as const} : item);
  assert.deepEqual(rendererNavigation(legacy,disabled,[extra]),legacy);assert.equal(resolveRendererPage(page,disabled,[extra]),'settings');
  assert.throws(()=>validateRendererRegistry([extra,extra]),/重复/);
  assert.throws(()=>validateRendererRegistry([{...extra,sidebar:[{...extra.sidebar![0],page:{...extra.sidebar![0].page,id:'plugin:another:quota'}}]}]),/命名空间/);
  assert.equal(resolveRendererPage('plugin:unknown:missing',statuses),'overview');
});

test('static Models contribution keeps navigation sections stable and revokes retained motion children',()=>{
  assert.equal(rendererRegistry.length,12);assert.equal(rendererRegistry.find(item=>item.page?.id==='models')?.manifest,modelsManifest);
  assert.equal(rendererRegistry.find(item=>item.page?.id==='tokens')?.manifest,tokensManifest);
  assert.deepEqual(modelsManifest.requires,[]);
  assert.equal(modelsManifest.hostApiVersion,1);assert.deepEqual(modelsManifest.provides,[]);
  for(const state of ['disabled','activating','deactivating','failed'] as const){
    const statuses=builtinStatuses(state),nav=rendererNavigation(legacy,statuses);
    assert.deepEqual(nav.filter(item=>item.section==='tools').map(item=>item.id),['tools','tokens']);
    assert.ok(!nav.some(item=>item.id==='models'));assert.equal(resolveRendererPage('models',statuses),'overview');
    assert.equal(resolveRendererPage('tools',statuses),'tools');
    assert.equal(isRendererPageAvailable('models',statuses),false);
    assert.equal(isRendererPageAvailable('settings',statuses),true);
  }
  assert.deepEqual(rendererNavigation(legacy,builtinStatuses()).map(item=>item.id),['overview','usage','models','tools','tokens','settings']);
  assert.equal(resolveRendererPage('models',[status('active'),provider]),'models');
  assert.equal(isRendererPageAvailable('models',[status('active'),provider]),true);
  assert.deepEqual(configurableRendererContributions([provider,status('active')]).map(item=>item.manifest.id),['provider.newapi']);
  const onlyProvider=builtinStatuses().map(item=>({...item,state:item.manifest.configurable ? 'disabled' as const : 'active' as const}));
  for(const page of ['overview','models','tokens'] as const){assert.equal(resolveRendererPage(page,onlyProvider),'settings');assert.equal(isRendererPageAvailable(page,onlyProvider),false);}
  assert.deepEqual(rendererNavigation(legacy,onlyProvider).map(item=>item.id),['usage','tools','settings']);
});

test('a declared custom switch independently controls system cards and a plugin sidebar page',()=>{
  const manifest={...newApiManifest,id:'provider.custom',settings:{title:'Custom',description:'',order:50,views:[{id:'history',title:'History',defaultEnabled:false}]}};
  const contribution:RendererContribution={manifest,settings:{title:'Custom',description:'',component:()=>null},workbench:[{id:'custom.history',title:'History',order:1,scope:'independent',view:'history',component:lazy(async()=>({default:()=>null}))}],sidebar:[{view:'history',page:{id:'plugin:provider.custom:history',scope:'independent',component:lazy(async()=>({default:()=>null}))},navigation:{id:'plugin:provider.custom:history',label:'History',hint:'',icon:LayoutDashboard,section:'workspace'}}]};
  validateRendererRegistry([contribution]);const statuses:PluginStatus[]=[{manifest,state:'active'}];
  assert.deepEqual(rendererNavigation([],statuses,[contribution]),[]);assert.deepEqual(workbenchContributions(statuses,[contribution]),[]);
  const enabled=statuses.map(s=>({...s,views:{history:true}}));assert.equal(rendererNavigation([],enabled,[contribution])[0].id,'plugin:provider.custom:history');assert.equal(workbenchContributions(enabled,[contribution])[0].id,'custom.history');
  assert.throws(()=>validateRendererRegistry([{...contribution,sidebar:[{...contribution.sidebar![0],view:'undeclared'}]}]),/声明/);
});

test('plugins register connection options and settings tabs with scoped validation and withdrawal',()=>{
  const statuses=builtinStatuses();assert.deepEqual(connectionContributions(statuses).map(c=>c.label),['NewAPI','Codex']);assert.deepEqual(settingsTabContributions(statuses).map(tab=>tab.label),['托盘','浮窗']);
  for(const id of ['provider.newapi','provider.codex','surface.widget','surface.tray']){
    const disabled=statuses.map(s=>s.manifest.id===id ? {...s,state:'disabled' as const} : s);
    assert.ok(!connectionContributions(disabled).some(c=>c.id.startsWith('plugin:'+id+':')));assert.ok(!settingsTabContributions(disabled).some(c=>c.id.startsWith('plugin:'+id+':')));
  }
  const component=lazy(async()=>({default:()=>null})),manifest={...newApiManifest,id:'provider.custom',settings:{title:'Custom',description:'',order:50,views:[{id:'connection',title:'Connection',defaultEnabled:false}]}};
  const custom:RendererContribution={manifest,settings:{title:'Custom',description:''},connections:[{id:'plugin:provider.custom:connection',label:'Custom',order:1,view:'connection',component}],settingsTabs:[{id:'plugin:provider.custom:settings',label:'Custom settings',order:1,view:'connection',component}]};
  validateRendererRegistry([custom]);assert.equal(connectionContributions([{manifest,state:'active'}],[custom]).length,0);
  assert.equal(connectionContributions([{manifest,state:'active',views:{connection:true}}],[custom]).length,1);
  assert.throws(()=>validateRendererRegistry([custom,custom]),/重复/);assert.throws(()=>validateRendererRegistry([{...custom,settingsTabs:[{...custom.settingsTabs![0],id:'general'}]}]),/无效/);
});

test('catalog is lazy, coalesces reads, retains same-account data, and rejects stale account/site/logout/disabled work',async()=>{
  const requests:{input:{siteId:string;siteUrl:string;force?:boolean};result:ReturnType<typeof deferred<CatalogSnapshot>>}[]=[];
  const resource=new CatalogResource(input=>{const result=deferred<CatalogSnapshot>();requests.push({input,result});return result.promise;});
  await resource.refresh();assert.equal(requests.length,0);
  resource.configure(scope());assert.equal(requests.length,0,'configuring a scope itself performs no read');
  const first=resource.refresh(),coalesced=resource.refresh();assert.equal(first,coalesced);
  await Promise.resolve();assert.equal(requests.length,1);requests[0].result.resolve(snapshot());await first;
  const previous=resource.getState().snapshot,force=resource.refresh(true),sameForce=resource.refresh(true);
  assert.equal(force,sameForce);assert.equal(resource.getState().snapshot,previous);assert.equal(resource.getState().loading,true);
  await Promise.resolve();assert.equal(requests[1].input.force,true);
  resource.configure(scope('account-b'));assert.equal(resource.getState().snapshot,null);
  const next=resource.refresh();await Promise.resolve();requests[1].result.resolve(snapshot('site-a','https://fixture.invalid',99));await force;
  assert.equal(resource.getState().snapshot,null,'late old-account result is invisible');
  requests[2].result.resolve(snapshot('site-a','https://fixture.invalid',2));await next;assert.equal(resource.getState().snapshot?.fetchedAt,2);
  for(const nextScope of [scope('account-b','site-b','https://another.invalid'),scope('logged-out','site-a'),null]){
    const late=resource.refresh(true);await Promise.resolve();const request=requests.at(-1)!;
    resource.configure(nextScope);assert.equal(resource.getState().snapshot,null);request.result.reject(new Error('late rejected read'));await late;
    assert.equal(resource.getState().error,'');
  }
  await resource.refresh(true);assert.equal(resource.getState().snapshot,null);
});

test('new force ownership supersedes an ordinary read and mismatched catalog scope fails closed',async()=>{
  const requests:ReturnType<typeof deferred<CatalogSnapshot>>[]=[];
  const resource=new CatalogResource(()=>{const request=deferred<CatalogSnapshot>();requests.push(request);return request.promise;});
  resource.configure(scope());const ordinary=resource.refresh();await Promise.resolve();const forced=resource.refresh(true);await Promise.resolve();
  assert.notEqual(ordinary,forced);requests[1].resolve(snapshot('site-a','https://fixture.invalid',8));await forced;
  requests[0].resolve(snapshot('site-a','https://fixture.invalid',1));await ordinary;assert.equal(resource.getState().snapshot?.fetchedAt,8);
  const bad=resource.refresh(true);await Promise.resolve();requests[2].resolve(snapshot('different-site'));await bad;
  assert.match(resource.getState().error,/站点范围/);assert.equal(resource.getState().snapshot?.fetchedAt,8);
});

test('child toggles persist via main, immediately revoke Models and recover failures',async()=>{
  let persisted=builtinStatuses(),lists=0;
  const writes:{id:string;enabled:boolean;result:ReturnType<typeof deferred<PluginStatus[]>>}[]=[];
  const resource=new PluginResource({setPluginEnabled:async()=>persisted,listPlugins:async()=>{lists++;return persisted;},setPluginView:(id,view,enabled)=>{const result=deferred<PluginStatus[]>();writes.push({id,enabled,result});return result.promise;}});
  await resource.load();assert.equal(lists,1);
  await assert.rejects(resource.setEnabled('feature.models',false),/不可配置/);assert.equal(writes.length,0);
  const disabled=resource.setView('provider.newapi','models',false);
  assert.equal(resource.getState().busyId,'provider.newapi:models');assert.equal(resolveRendererPage('models',resource.getState().statuses),'overview');
  await assert.rejects(resource.setView('provider.newapi','models',true),/正在更新/);
  persisted=builtinStatuses('disabled');writes[0].result.resolve(persisted);await disabled;
  const restarted=new PluginResource({listPlugins:async()=>persisted,setPluginEnabled:async()=>persisted,setPluginView:async()=>persisted});await restarted.load();assert.equal(resolveRendererPage('models',restarted.getState().statuses),'overview');
  const enable=resource.setView('provider.newapi','models',true);assert.equal(resource.getState().statuses.find(s=>s.manifest.id==='provider.newapi')?.views?.models,true);writes[1].result.reject(new Error('activation failed'));await assert.rejects(enable,/activation failed/);
  assert.equal(resource.getState().statuses.find(s=>s.manifest.id==='provider.newapi')?.views?.models,false);assert.equal(resource.getState().busyId,null);assert.equal(resource.getState().error,'activation failed');assert.equal(lists,2);
});

test('renderer integration uses narrow catalog and settings context without positional navigation or dashboard user gate',async()=>{
  const app=await readFile(new URL('../src/App.tsx',import.meta.url),'utf8'),models=await readFile(new URL('../plugins/provider.newapi/renderer/Models.tsx',import.meta.url),'utf8');
  const settings=await readFile(new URL('../src/host/plugins.tsx',import.meta.url),'utf8');
  assert.doesNotMatch(models,/dashboard/);assert.match(models,/useCatalog\(\)/);assert.match(models,/snapshot=\{d\}/);
  assert.doesNotMatch(app,/nav\.slice/);assert.match(app,/<RendererPageSwap identity=\{visiblePage\} accountKey=\{accountKey\} statuses=\{plugins.statuses\}/);assert.match(app,/\{pages\[visiblePage\]\}/);
  assert.match(app,/visiblePage==='models'.*catalog\.refresh\(true\)/);assert.doesNotMatch(settings,/useApp\(/);assert.match(settings,/usePluginSettings\(\)/);assert.match(settings,/scope=JSON\.stringify\(\[app\?\.page/);
});

test('Chromium plugin switches preserve Settings drafts, focus, scroll and dialogs while revoking outgoing plugin pages',{timeout:45000},async t=>{
  let electron:string;try{electron=createRequire(import.meta.url)('electron');}catch{return t.skip('Electron runtime unavailable');}
  if(!existsSync(electron))return t.skip('Electron runtime unavailable');
  const base=path.resolve('.test-data');await mkdir(base,{recursive:true});const root=await mkdtemp(path.join(base,'renderer-plugins-'));
  t.after(async()=>{const relative=path.relative(base,root);assert.ok(relative && !relative.startsWith('..') && !path.isAbsolute(relative));await rm(root,{recursive:true,force:true,maxRetries:5,retryDelay:100});});
  const renderer=await build({stdin:{contents:`
    import React,{useState,useEffect} from 'react';
    import {createRoot} from 'react-dom/client';
    import {useCatalogHost,CatalogProvider,useCatalog} from './src/host/catalog';
    import {usePluginHost,PluginSettingsProvider} from './src/host/plugins';
    import {resolveRendererPage,rendererNavigation} from './src/host/renderer-registry';
    import {RendererPageSwap} from './src/host/page-swap';
    import Settings from './src/pages/Settings';
    import {AppContext} from './src/context';
    import {UpdateDialogProvider} from './src/components/UpdateDialog';
    import {DEFAULT_PREFERENCES} from './shared/types';
    function ModelFixture(){const catalog=useCatalog();useEffect(()=>{fixture.mounts++;return()=>{fixture.unmounts++;};},[]);return <article id="models">{catalog.snapshot ? 'catalog:'+catalog.snapshot.fetchedAt : 'empty'}{catalog.loading ? ':loading' : ''}<button id="force" onClick={()=>catalog.refresh(true)}>force</button></article>;}
    function SettingsFixture(){useEffect(()=>{fixture.settingsMounts++;},[]);return <div id="settings"><Settings/></div>;}
    function Fixture(){
      const [page,setPage]=useState('overview'),[account,setAccount]=useState('a'),[site,setSite]=useState('site-a');
      fixture.page=setPage;fixture.account=setAccount;fixture.site=setSite;
      const plugins=usePluginHost(),visible=resolveRendererPage(page,plugins.statuses);
      fixture.setEnabled=plugins.settings.setEnabled;fixture.setView=plugins.settings.setView;
      const catalog=useCatalogHost({scope:visible==='models' ? {accountKey:account,siteId:site,siteUrl:'https://fixture.invalid'} : null,refreshInterval:30});
      const preferences=DEFAULT_PREFERENCES,noop=()=>{};
      const app={preferences,bootstrap:{preferences,desktop:false,version:'fixture',secureStorage:false,configs:[]},dashboard:null,page:visible,setPage,
        openLogin:noop,updatePreferences:async()=>{},setPreferences:noop,reloadBootstrap:async()=>{},refresh:async()=>{},toast:noop};
      return <AppContext.Provider value={app}><PluginSettingsProvider value={plugins.settings}><CatalogProvider value={catalog}><UpdateDialogProvider>
        <div id="navigation">{rendererNavigation([],plugins.statuses).map(item=>item.id).join(',')}</div>
        <div className="content-scroll"><RendererPageSwap accountKey={account} statuses={plugins.statuses} identity={visible}>{visible==='models' ? <ModelFixture/> : visible==='settings' ? <SettingsFixture/> : <div id="overview">overview</div>}</RendererPageSwap></div>
      </UpdateDialogProvider></CatalogProvider></PluginSettingsProvider></AppContext.Provider>;
    }
    createRoot(document.getElementById('root')).render(<Fixture/>);
  `,resolveDir:process.cwd(),sourcefile:'renderer-plugin-fixture.tsx',loader:'tsx'},bundle:true,platform:'browser',format:'iife',write:false,loader:{'.svg':'text','.css':'empty'},define:{'process.env.NODE_ENV':'"production"'},logLevel:'silent'});
  const js=renderer.outputFiles.find(file=>file.path.endsWith('.js')) || renderer.outputFiles[0];
  await writeFile(path.join(root,'renderer.js'),js.contents);
  const styles=await Promise.all(['components/segmented-switch.css','styles.css','theme-tokens.css','theme.css','platform-logs.css'].map(file=>readFile(path.resolve('src',file),'utf8')));
  await writeFile(path.join(root,'fixture.css'),styles.join('\n')+'\n.content-scroll {height:240px;overflow:auto;} .settings-page section {min-height:150px;}');
  await writeFile(path.join(root,'fixture.html'),`<!doctype html><html><head><link rel="stylesheet" href="fixture.css"/></head><body><div id="root"></div><script>
    window.fixture={reads:[],writes:[],listeners:new Set(),mounts:0,unmounts:0,settingsMounts:0,errors:[],intervals:[]};
    const realMatchMedia=window.matchMedia.bind(window);window.matchMedia=query=>query==='(prefers-reduced-motion: reduce)' ? {matches:false,addEventListener(){},removeEventListener(){}} : realMatchMedia(query);
    const realTimeout=window.setTimeout;window.setTimeout=(fn,delay,...args)=>realTimeout(fn,fixture.holdExit && delay===110 ? 5000 : delay,...args);
    window.addEventListener('error',event=>fixture.errors.push(event.message));window.addEventListener('unhandledrejection',event=>fixture.errors.push(String(event.reason)));
    const realInterval=window.setInterval;window.setInterval=(fn,delay)=>{const id=realInterval(fn,delay);fixture.intervals.push({fn,delay});return id;};
    let persisted=${JSON.stringify(builtinStatuses())};window.fixtureStatuses=(state)=>persisted.map(item=>item.manifest.id==='provider.newapi' ? {...item,views:{...item.views,models:state==='active'}} : item);
    window.lumi={listPlugins:async()=>persisted,setPluginView:(id,view,enabled)=>new Promise((resolve,reject)=>fixture.writes.push({id,view,enabled,resolve:statuses=>{persisted=statuses;resolve(statuses);},reject})),setPluginEnabled:(id,enabled)=>new Promise((resolve,reject)=>fixture.writes.push({id,enabled,resolve:statuses=>{persisted=statuses;resolve(statuses);},reject})),
      readCatalog:input=>new Promise((resolve,reject)=>fixture.reads.push({input,resolve,reject})),onRefresh:listener=>{fixture.listeners.add(listener);return()=>fixture.listeners.delete(listener);},
      onUpdate:()=>()=>{},onReviewUpdate:()=>()=>{},updateStatus:async()=>({phase:'unsupported',currentVersion:'fixture'})};
  </script><script src="renderer.js"></script></body></html>`);
  await writeFile(path.join(root,'audit.cjs'),String.raw`
    const {app,BrowserWindow}=require('electron'),path=require('node:path'),fs=require('node:fs');
    for(const name of ['userData','sessionData','logs','crashDumps']){const folder=path.join(__dirname,name);fs.mkdirSync(folder,{recursive:true});app.setPath(name,folder);}
    let phase='startup';const fail=error=>{console.error('PLUGIN_UI_FAILURE '+phase+' '+(error.stack || error));app.exit(1);};
    process.on('uncaughtException',fail);process.on('unhandledRejection',fail);
    const watchdog=setTimeout(()=>{console.error('PLUGIN_UI_TIMEOUT '+phase);app.exit(1);},30000);
    app.disableHardwareAcceleration();app.whenReady().then(async()=>{
      phase='window';console.log('PLUGIN_UI_PHASE '+phase);
      const win=new BrowserWindow({show:false,webPreferences:{offscreen:true,sandbox:true,contextIsolation:true,nodeIntegration:false,backgroundThrottling:false}});
      win.webContents.on('console-message',event=>{if(event.message.startsWith('PLUGIN_UI_PHASE ')){phase=event.message.slice(16);console.log(event.message);}});
      phase='load';console.log('PLUGIN_UI_PHASE '+phase);
      await win.loadFile(path.join(__dirname,'fixture.html'));
      win.webContents.debugger.attach('1.3');await win.webContents.debugger.sendCommand('Emulation.setEmulatedMedia',{features:[{name:'prefers-reduced-motion',value:'no-preference'}]});
      phase='audit';console.log('PLUGIN_UI_PHASE '+phase);
      const result=await win.webContents.executeJavaScript('('+async function audit(){
        const check=(value,label)=>{if(!value)throw new Error(label);};
        const until=async(predicate,label)=>{console.log('PLUGIN_UI_PHASE '+label);const end=performance.now()+4000;while(!predicate()){if(performance.now()>end)throw new Error(label);await new Promise(resolve=>setTimeout(resolve,5));}};
        const settle=()=>new Promise(resolve=>setTimeout(resolve,35)),models=()=>document.getElementById('models');
        const resolve=(index,time)=>{const r=fixture.reads[index];r.resolve({siteId:r.input.siteId,siteUrl:r.input.siteUrl,loggedIn:true,catalog:{models:[],groupRatio:{},usableGroups:{},autoGroups:[],vendors:[]},status:{system_name:'Fixture',quota_per_unit:500000},warnings:[],fetchedAt:time});};
        await until(()=>document.getElementById('navigation').textContent==='overview,usage,models,tools,tokens','Plugin list loads');
        check(fixture.reads.length===0 && fixture.listeners.size===0,'Hidden Models performs no read/subscription');
        fixture.page('models');await until(()=>models() && fixture.reads.length===1,'Models performs first narrow read');resolve(0,1);await until(()=>models().textContent.includes('catalog:1'),'First catalog visible');
        document.getElementById('force').click();await until(()=>fixture.reads.length===2,'Force refresh');check(models().textContent.includes('catalog:1'),'Same-account refresh retains prior data');
        fixture.listeners.forEach(listener=>listener());await settle();check(fixture.reads.length===2,'Refresh event coalesces forced pending read');resolve(1,2);await until(()=>models().textContent.includes('catalog:2'),'Fresh data replaces prior');
        const interval=fixture.intervals.find(item=>item.delay===30000);check(interval,'Configured refresh interval installed');interval.fn();await until(()=>fixture.reads.length===3,'Interval performs narrow read');resolve(2,3);await until(()=>models().textContent.includes('catalog:3'),'Interval data visible');
        document.getElementById('force').click();await until(()=>fixture.reads.length===4,'Old account request pending');fixture.account('b');await until(()=>fixture.reads.length===5 && models().textContent.includes('empty'),'Account immediately clears snapshot');resolve(3,99);await settle();check(!models().textContent.includes('catalog:99'),'Late account response invisible');resolve(4,4);await until(()=>models().textContent.includes('catalog:4'),'New account owns data');
        document.getElementById('force').click();await until(()=>fixture.reads.length===6,'Logout pending read');fixture.account('logged-out');await until(()=>fixture.reads.length===7 && models().textContent.includes('empty'),'Logout clears ownership');fixture.reads[5].reject(new Error('old logout error'));resolve(6,5);await until(()=>models().textContent.includes('catalog:5'),'Logged-out snapshot accepted from main scope');
        fixture.site('site-b');await until(()=>fixture.reads.length===8 && models().textContent.includes('empty'),'Site clears snapshot');resolve(7,6);await until(()=>models().textContent.includes('catalog:6'),'Site snapshot visible');
        document.getElementById('force').click();await until(()=>fixture.reads.length===9,'Read pending before exit');fixture.holdExit=true;fixture.page('overview');await until(()=>document.querySelector('.motion-panel.leaving'),'Outgoing Models retained during exit');
        const before=fixture.unmounts;fixture.setView('provider.newapi','models',false);await until(()=>fixture.writes.length===1 && !models(),'Disable immediately unmounts outgoing page');check(fixture.unmounts>before,'Outgoing effect disposed');check(document.getElementById('navigation').textContent==='overview,usage,tools,tokens','Disabled Models excluded');check(fixture.listeners.size===0,'Disabled read subscription disposed');
        fixture.holdExit=false;resolve(8,999);fixture.writes[0].resolve(fixtureStatuses('disabled'));await settle();check(!models(),'Late disabled response cannot remount');
        fixture.setView('provider.newapi','models',true);await until(()=>fixture.writes.length===2,'Enable persisted flag');fixture.writes[1].resolve(fixtureStatuses('active'));await until(()=>document.getElementById('navigation').textContent==='overview,usage,models,tools,tokens','Enabled nav restored');check(!models() && fixture.reads.length===9,'Re-enabling stays lazy off page');
        fixture.page('settings');await until(()=>document.querySelector('[role=switch]'),'Real Settings mounted');await settle();
        const settings=document.getElementById('settings'),threshold=document.querySelector('[aria-label="余额提醒阈值"]'),scroll=document.querySelector('.content-scroll');
        check(document.querySelectorAll('.plugin-settings-overview [data-plugin] [role=switch]').length===7,'Seven independent plugin switches present in list');
        Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(threshold,'123.4');threshold.dispatchEvent(new Event('input',{bubbles:true}));await settle();scroll.scrollTop=80;
        const providerRow=document.querySelector('[data-plugin="provider.newapi"] .plugin-row-button');providerRow.focus({preventScroll:true});providerRow.click();await until(()=>document.querySelector('.plugin-details-modal[aria-hidden="false"]') || document.querySelector('.plugin-details-modal:not([aria-hidden])'),'Provider dialog opens');await until(()=>document.querySelector('[data-plugin-details="provider.newapi"] input[name=prefix]'),'Provider lazy settings render');await settle();
        const pluginDialog=document.querySelector('.plugin-details-modal'),detail=pluginDialog.querySelector('[data-plugin-details="provider.newapi"]'),prefix=detail.querySelector('input[name=prefix]'),toggle=detail.querySelector('[role=switch][aria-label="显示NewAPI 模型广场"]'),settingsMounts=fixture.settingsMounts;prefix.value='DraftPrefix';prefix.focus();prefix.setSelectionRange(2,6);
        check(pluginDialog.contains(document.activeElement) && scroll.scrollTop===80 && !document.querySelector('.plugin-settings-overview').hidden,'Details is a focused dialog over the unchanged list');
        let providerPresent=true;const retained=()=>{check(document.getElementById('settings')===settings && fixture.settingsMounts===settingsMounts,'Settings instance survives plugin status');if(providerPresent)check(detail.querySelector('input[name=prefix]')===prefix && prefix.value==='DraftPrefix','Uncontrolled plugin prefix draft retained');check(threshold.value==='123.4','Controlled threshold draft retained');check(scroll.scrollTop===80,'Settings scroll retained');};
        check(toggle.getAttribute('aria-checked')==='true' && toggle.classList.contains('on'),'Slider initially on');check(toggle.offsetWidth===42 && getComputedStyle(toggle.firstElementChild).transform.includes('18'),'Slider uses real track/thumb styles');
        toggle.click();await until(()=>fixture.writes.length===3 && toggle.getAttribute('aria-disabled')==='true','Disable switch busy');retained();check(toggle.getAttribute('aria-checked')==='false' && toggle.getAttribute('aria-busy')==='true','Slider reflects pending disable');check(document.activeElement===prefix && prefix.selectionStart===2 && prefix.selectionEnd===6,'Draft focus and selection retained');toggle.click();await settle();check(fixture.writes.length===3,'Busy switch ignores duplicate clicks');
        fixture.writes[2].resolve(fixtureStatuses('disabled'));await until(()=>toggle.getAttribute('aria-disabled')==='false','Disable settles');retained();check(document.activeElement===prefix,'Draft focus remains after save');
        toggle.focus({preventScroll:true});toggle.click();await until(()=>fixture.writes.length===4,'Enable switch');retained();check(document.activeElement===toggle,'Busy switch keeps keyboard focus');fixture.writes[3].resolve(fixtureStatuses('active'));await until(()=>toggle.getAttribute('aria-disabled')==='false','Enable settles');retained();check(document.activeElement===toggle,'Enabled switch keeps focus');
        const addSite=Array.from(detail.querySelectorAll('button')).find(button=>button.textContent.includes('添加站点'));addSite.focus({preventScroll:true});addSite.click();await until(()=>document.querySelector('[role=dialog][aria-label="添加站点"] input'),'Open nested real Settings dialog');await settle();
        const dialog=document.querySelector('[role=dialog][aria-label="添加站点"]'),dialogInput=dialog.querySelector('input');check(dialog.contains(document.activeElement) && dialog.parentElement.parentElement===pluginDialog.parentElement.parentElement,'Nested modal keeps focus and shares the unscrolled portal');Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(dialogInput,'Draft site');dialogInput.dispatchEvent(new Event('input',{bubbles:true}));dialogInput.focus();scroll.scrollTop=80;
        fixture.setView('provider.newapi','models',false).catch(()=>{});await until(()=>fixture.writes.length===5,'Plugin update with open dialog');retained();check(document.querySelector('[role=dialog][aria-label="添加站点"]')===dialog && dialogInput.value==='Draft site' && document.activeElement===dialogInput,'Open nested dialog and form retained while pending');
        fixture.writes[4].reject(new Error('fixture persistence failure'));await until(()=>toggle.getAttribute('aria-disabled')==='false' && document.querySelector('[role=alert]'),'Failed update settles');retained();check(toggle.getAttribute('aria-checked')==='true','Failed update restores switch state');check(document.querySelector('[role=dialog][aria-label="添加站点"]')===dialog && dialogInput.value==='Draft site' && document.activeElement===dialogInput,'Failed update preserves nested dialog draft/focus');
        document.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true,cancelable:true}));await until(()=>!document.querySelector('[role=dialog][aria-label="添加站点"]'),'Escape closes nested draft dialog');check(!pluginDialog.closest('[hidden],[inert]') && document.activeElement===addSite,'Nested Escape retains parent and restores its editing button');document.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true,cancelable:true}));await until(()=>pluginDialog.closest('[hidden],[inert]'),'Escape closes plugin dialog');check(document.activeElement===providerRow,'Second Escape restores plugin row');scroll.scrollTop=80;
        for(const [id,label] of [['provider.codex','Codex'],['surface.widget','浮窗'],['surface.tray','托盘'],['provider.newapi','NewAPI']]){
          const beforeWrites=fixture.writes.length,control=document.querySelector('[role=switch][aria-label="启用'+label+'"]');
          control.focus({preventScroll:true});if(id==='provider.newapi')providerPresent=false;control.click();await until(()=>fixture.writes.length===beforeWrites+1,'Parent writes '+id);retained();
          check(fixture.writes[beforeWrites].id===id && !fixture.writes[beforeWrites].enabled,'Correct parent '+id);
          fixture.writes[beforeWrites].resolve((await window.lumi.listPlugins()).map(item=>item.manifest.id===id ? {...item,state:'disabled'} : item));await until(()=>control.getAttribute('aria-disabled')==='false','Parent disabled '+id);retained();check(document.activeElement===control,'Parent focus '+id);
        }
        check(document.getElementById('navigation').textContent==='usage,tools','Local usage and tool config survive all providers off');
        const child=document.querySelector('[role=switch][aria-label="显示NewAPI 模型广场"]');check(child.getAttribute('aria-checked')==='true' && child.getAttribute('aria-disabled')==='true','Child choice retained under disabled parent');
        check(!document.querySelector('[aria-label=连接]') && !document.querySelector('input[name=prefix]'),'Disabled providers withdraw connection options');check(Array.from(document.querySelectorAll('.settings-subnav button')).map(b=>b.textContent).join(',')==='常规设置,实时日志','Disabled surfaces withdraw settings tabs');document.querySelector('[data-plugin="provider.newapi"] .plugin-settings-button').click();await until(()=>!pluginDialog.closest('[hidden],[inert]'),'Disabled plugin dialog reopens');fixture.account('fresh-account');await until(()=>fixture.settingsMounts===settingsMounts+1,'Account switch still resets Settings');await until(()=>document.querySelector('[aria-label=余额提醒阈值]'),'General settings remounts');check(document.querySelector('[aria-label=余额提醒阈值]').value!=='123.4' && !document.querySelector('[role=dialog]') && !pluginDialog.isConnected && !dialog.isConnected,'Account isolation withdraws active and visited dialog nodes and clears drafts');
        check(fixture.errors.length===0,'Renderer errors '+fixture.errors.join(','));return {reads:fixture.reads.length,writes:fixture.writes.length,settingsResets:fixture.settingsMounts-settingsMounts};
        function fixtureManifest(){return {id:'feature.models',version:'1.0.0',hostApiVersion:1,configurable:true,requires:[{sourceId:'provider.newapi',capability:'catalog.read'}],optional:[],provides:[]};}
      }.toString()+')()');console.log('RENDERER_PLUGINS_RESULT '+JSON.stringify(result));clearTimeout(watchdog);win.destroy();app.exit(0);
    }).catch(error=>{console.error(error.stack || error);app.exit(1);});
  `);
  const env={...process.env};delete env.ELECTRON_RUN_AS_NODE;
  const child=spawn(electron,[path.join(root,'audit.cjs')],{env,windowsHide:true,stdio:['ignore','pipe','pipe'],signal:t.signal});
  let stdout='',stderr='';child.stdout.on('data',chunk=>stdout+=chunk);child.stderr.on('data',chunk=>stderr+=chunk);
  t.after(()=>{if(t.signal.aborted)t.diagnostic(stdout+stderr);});
  const code=await new Promise<number|null>((resolve,reject)=>{child.once('error',reject);child.once('close',resolve);});assert.equal(code,0,stderr);
  const line=stdout.split(/\r?\n/).find(line=>line.startsWith('RENDERER_PLUGINS_RESULT '));assert.ok(line,stdout+stderr);assert.deepEqual(JSON.parse(line.slice('RENDERER_PLUGINS_RESULT '.length)),{reads:9,writes:9,settingsResets:1});
});
