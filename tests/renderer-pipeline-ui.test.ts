import test from 'node:test';
import assert from 'node:assert/strict';
import {build} from 'esbuild';
import {createRequire} from 'node:module';
import {existsSync} from 'node:fs';
import {mkdir,mkdtemp,readFile,writeFile,rm} from 'node:fs/promises';
import {spawn} from 'node:child_process';
import path from 'node:path';

test('main renderer isolates chrome updates, coalesces dashboard reads and only synchronizes changed appearance',{timeout:30000},async t=>{
  const electron=createRequire(import.meta.url)('electron') as string;
  if(!existsSync(electron))return t.skip('Electron runtime unavailable');
  const parent=path.resolve('.test-data');await mkdir(parent,{recursive:true});
  const root=await mkdtemp(path.join(parent,'renderer-pipeline-'));
  t.after(async()=>{assert.equal(path.dirname(root),parent);await rm(root,{recursive:true,force:true,maxRetries:5,retryDelay:100});});
  const output=await build({stdin:{resolveDir:process.cwd(),loader:'tsx',contents:`
import React,{lazy} from 'react';import {createRoot} from 'react-dom/client';
import {DEFAULT_PREFERENCES} from './shared/types';import {applyPreferencePatch} from './shared/selections';
import {builtinManifests} from './plugins/manifests';import {newApiRenderer} from './plugins/provider.newapi/renderer';
import {useApp} from './src/context';import {useWorkbench} from './src/host/workbench';import {useUsageViews} from './src/host/usage';
import {useContentViews} from './src/host/content-views';import {useToolConfigViews} from './src/host/tool-config';import {useSourcePreferences} from './src/host/source-preferences';
let prefs={...structuredClone(DEFAULT_PREFERENCES),refreshInterval:0,theme:'light'};
prefs.sites[0]={...prefs.sites[0],url:'https://fixture.invalid',name:'Fixture',userId:1,accessTokenConfigured:true};
const dashboard={status:{system_name:'Fixture',quota_per_unit:500000},user:{id:1,username:'fixture',quota:100},logs:{items:[],total:0,page:1,pageSize:15},series:[],stat:null,catalog:{models:[],groupRatio:{},usableGroups:{},autoGroups:[],vendors:[]},tokens:[],warnings:[],days:7,fetchedAt:1};
window.fixture={renders:0,reads:0,themes:[],errors:[],refreshListeners:new Set(),navigateListeners:new Set(),pending:[],hold:false};
function Probe(){const app=useApp();useWorkbench();useUsageViews();useContentViews();useToolConfigViews();useSourcePreferences();fixture.renders++;fixture.app=app;return <p id="pipeline-probe">{app.preferences.activeSiteId}:{app.dashboard?.fetchedAt ?? 'empty'}</p>;}
newApiRenderer.workbench=[{id:'pipeline-probe',title:'Pipeline',order:1,scope:'site',component:lazy(async()=>({default:Probe}))}];
const stub=()=>()=>{};
window.lumi={bootstrap:async()=>({preferences:prefs,desktop:true,platform:'win32',version:'fixture',configs:[],secureStorage:true}),inspectConfigs:async()=>[],
listPlugins:async()=>builtinManifests.map(manifest=>({manifest,state:manifest.configurable && manifest.id!=='provider.newapi' ? 'disabled' : 'active',generation:0})),listExtensions:async()=>({plugins:[],statuses:[],directory:'fixture'}),
dashboard:async()=>{fixture.reads++;if(fixture.hold)return new Promise(resolve=>fixture.pending.push(resolve));return {...dashboard,fetchedAt:fixture.reads};},
onRefresh:fn=>{fixture.refreshListeners.add(fn);return()=>fixture.refreshListeners.delete(fn);},onNavigate:fn=>{fixture.navigateListeners.add(fn);return()=>fixture.navigateListeners.delete(fn);},onWidgetVisibility:stub,onUpdate:stub,onReviewUpdate:stub,
updateStatus:async()=>({phase:'unsupported',currentVersion:'fixture'}),updatePreferences:async patch=>(prefs=applyPreferencePatch(prefs,patch)),syncSurfaceTheme:async theme=>{fixture.themes.push(theme);},windowControl:async()=>{}};
addEventListener('error',event=>fixture.errors.push(event.message));addEventListener('unhandledrejection',event=>fixture.errors.push(String(event.reason)));
const {default:App}=await import('./src/App');createRoot(document.getElementById('root')).render(<App/>);
`},bundle:true,platform:'browser',format:'esm',write:false,loader:{'.svg':'text','.css':'empty'},define:{'process.env.NODE_ENV':'"production"'},logLevel:'silent'});
  await writeFile(path.join(root,'renderer.js'),output.outputFiles[0].contents);
  const css=await Promise.all(['styles.css','workbench.css','select.css','theme-tokens.css','theme.css','updates-trends.css','filters-tools-motion.css','platform-logs.css'].map(file=>readFile(path.join('src',file),'utf8')));
  await writeFile(path.join(root,'style.css'),css.join('\n'));
  await writeFile(path.join(root,'index.html'),'<!doctype html><html><head><meta charset="utf-8"><link rel="stylesheet" href="style.css"></head><body><div id="root"></div><script type="module" src="renderer.js"></script></body></html>');
  await writeFile(path.join(root,'audit.cjs'),String.raw`
const {app,BrowserWindow}=require('electron'),fs=require('node:fs'),path=require('node:path');
for(const name of ['userData','sessionData','logs','crashDumps']){const folder=path.join(__dirname,name);fs.mkdirSync(folder,{recursive:true});app.setPath(name,folder);}
app.commandLine.appendSwitch('force-prefers-reduced-motion');
const watchdog=setTimeout(()=>{console.error('Renderer pipeline timed out');app.exit(1);},25000);
app.whenReady().then(async()=>{
  const win=new BrowserWindow({width:1100,height:800,show:false,webPreferences:{sandbox:true,contextIsolation:true,nodeIntegration:false,backgroundThrottling:false}});
  await win.loadFile(path.join(__dirname,'index.html'));
  const result=await win.webContents.executeJavaScript('('+async function(){
    const settle=()=>new Promise(resolve=>setTimeout(resolve,50));
    const until=async predicate=>{const end=performance.now()+5000;while(!predicate()){if(performance.now()>end)throw new Error('Pipeline fixture not ready: '+fixture.errors.join(','));await settle();}};
    await until(()=>document.querySelector('#pipeline-probe') && fixture.app.dashboard && fixture.themes.length);await settle();
    const initialRenders=fixture.renders,initialThemes=fixture.themes.length;
    document.querySelector('.global-search').click();await settle();
    const input=document.querySelector('[aria-label="搜索工作台内容"]');
    if(!input)throw new Error('Search did not open');
    for(const value of ['m','mo','mod','mode','model','model-','model-a','model-ab']){
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(input,value);input.dispatchEvent(new Event('input',{bubbles:true}));await settle();
    }
    document.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true,cancelable:true}));await settle();
    fixture.app.toast('Fixture notice');await settle();
    const chromeRenders=fixture.renders-initialRenders;
    await fixture.app.updatePreferences({lowBalanceThreshold:42});await settle();
    const unrelatedThemeSyncs=fixture.themes.length-initialThemes;
    await fixture.app.updatePreferences({theme:'dark'});await until(()=>fixture.themes.at(-1).mode==='dark');await settle();
    const changedThemeSyncs=fixture.themes.length-initialThemes-unrelatedThemeSyncs;
    fixture.hold=true;const beforeReads=fixture.reads;
    const jobs=[fixture.app.refresh(true),fixture.app.refresh(true),fixture.app.refresh(false)];await settle();
    const concurrentReads=fixture.reads-beforeReads;
    fixture.pending.splice(0).forEach(resolve=>resolve({...fixture.app.dashboard,fetchedAt:99}));await Promise.all(jobs);await until(()=>fixture.app.dashboard?.fetchedAt===99);
    return {chromeRenders,unrelatedThemeSyncs,changedThemeSyncs,concurrentReads,errors:fixture.errors};
  }.toString()+')()');
  console.log('RENDERER_PIPELINE_RESULT '+JSON.stringify(result));clearTimeout(watchdog);win.destroy();app.exit(0);
}).catch(error=>{console.error(error.stack || error);app.exit(1);});
`);
  const env={...process.env};delete env.ELECTRON_RUN_AS_NODE;
  const child=spawn(electron,[path.join(root,'audit.cjs')],{env,windowsHide:true,stdio:['ignore','pipe','pipe'],signal:t.signal});
  let stdout='',stderr='';child.stdout.on('data',chunk=>stdout+=chunk);child.stderr.on('data',chunk=>stderr+=chunk);
  const code=await new Promise<number|null>((resolve,reject)=>{child.once('error',reject);child.once('close',resolve);});assert.equal(code,0,stderr+stdout);
  const line=stdout.split(/\r?\n/).find(line=>line.startsWith('RENDERER_PIPELINE_RESULT '));assert.ok(line,stdout+stderr);
  const result=JSON.parse(line.slice('RENDERER_PIPELINE_RESULT '.length));t.diagnostic(JSON.stringify(result));
  assert.deepEqual(result,{chromeRenders:0,unrelatedThemeSyncs:0,changedThemeSyncs:1,concurrentReads:1,errors:[]});
});
