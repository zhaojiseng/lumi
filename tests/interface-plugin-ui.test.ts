import test from 'node:test';
import assert from 'node:assert/strict';
import {build} from 'esbuild';
import {mkdir,mkdtemp,readFile,writeFile,rm} from 'node:fs/promises';
import {existsSync} from 'node:fs';
import {createRequire} from 'node:module';
import path from 'node:path';
import {spawn} from 'node:child_process';
import {readExtensionPackage} from '../electron/extensions/packages';
test('real interface host applies external layout, preserves settings drafts and confines/rejects unsafe CSS',{timeout:30000},async t=>{
  let electron:string;try{electron=createRequire(import.meta.url)('electron');}catch{return t.skip('Electron unavailable');}if(!existsSync(electron))return t.skip('Electron unavailable');
  await mkdir('.test-data',{recursive:true});const directory=await mkdtemp(path.resolve('.test-data/interface-ui-'));t.after(()=>rm(directory,{recursive:true,force:true,maxRetries:5,retryDelay:100}));
  const pkg=await readExtensionPackage('extensions/packages/extension.lumi.compact'),descriptor={manifest:pkg.manifest,digest:pkg.digest},css=pkg.files.get('interface.css')!.toString()+`
:scope{--text:light-dark(rgb(50,30,70),rgb(240,230,250));--panel:light-dark(rgb(250,245,255),rgb(35,25,50));color:var(--text)}
:scope[data-theme="light"]{--theme-marker:light}:scope[data-theme="dark"]{--theme-marker:dark}
.nav-item.active{color:white!important}
`;
  const script=await build({stdin:{resolveDir:process.cwd(),loader:'tsx',contents:`import React from 'react';import {createRoot} from 'react-dom/client';import {DEFAULT_PREFERENCES} from './shared/types';import {builtinManifests} from './plugins/manifests';import {extensionPluginManifest} from './shared/contracts/extensions';
const prefs=structuredClone(DEFAULT_PREFERENCES),pkg=${JSON.stringify(descriptor)},css=${JSON.stringify(css+'\n#outside{color:red!important}')} ;let enabled=false;const stub=()=>()=>{};
const statuses=()=>[...builtinManifests.map(manifest=>({manifest,state:['provider.newapi','provider.codex','surface.widget'].includes(manifest.id) ? 'disabled' : 'active'})),{manifest:extensionPluginManifest(pkg.manifest),origin:'external',state:enabled ? 'active' : 'disabled'}];
const inventory=()=>({directory:'fixture',plugins:[pkg],diagnostics:[],interfaceStyle:enabled ? {id:pkg.manifest.id,css:fixture.cssOverride ?? css} : undefined});
window.fixture={errors:[],fail:false};window.addEventListener('error',event=>fixture.errors.push(event.message));window.addEventListener('unhandledrejection',event=>fixture.errors.push(String(event.reason)));
fixture.media={matches:true,listeners:new Set()};fixture.setSystemDark=value=>{fixture.media.matches=value;fixture.media.listeners.forEach(fn=>fn());};const matchMedia=window.matchMedia.bind(window);window.matchMedia=query=>query==='(prefers-color-scheme: dark)' ? {get matches(){return fixture.media.matches;},addEventListener:(_type,fn)=>fixture.media.listeners.add(fn),removeEventListener:(_type,fn)=>fixture.media.listeners.delete(fn)} : matchMedia(query);
window.lumi={bootstrap:async()=>({preferences:prefs,desktop:true,platform:'win32',version:'fixture',configs:[],secureStorage:true}),inspectConfigs:async()=>[],listPlugins:async()=>statuses(),extensionInventory:async()=>inventory(),reloadExtensions:async()=>inventory(),setPluginEnabled:async(id,value)=>{if(fixture.fail)throw new Error('fixture write failed');if(id===pkg.manifest.id)enabled=value;return statuses();},updatePreferences:async patch=>Object.assign(prefs,patch),onNavigate:stub,onRefresh:stub,onWidgetVisibility:stub,onUpdate:stub,onReviewUpdate:stub,onToolRuntime:stub,onConfigProgress:stub,onAppLog:stub,updateStatus:async()=>({phase:'unsupported',currentVersion:'fixture'}),appCache:async()=>({categories:[],totalBytes:0,browserBytes:0,updateBytes:0,protectedBytes:0,warnings:[],scannedAt:Date.now()}),windowControl:async()=>{}};
const {scopedInterfaceSheet}=await import('./src/host/interface');fixture.scopedInterfaceSheet=scopedInterfaceSheet;const {default:App}=await import('./src/App');createRoot(document.getElementById('root')).render(<App/>);`},bundle:true,platform:'browser',format:'esm',write:false,loader:{'.css':'empty','.svg':'text'},define:{'process.env.NODE_ENV':'"production"'},logLevel:'silent'});
  await writeFile(path.join(directory,'app.js'),script.outputFiles[0].contents);
  const styles=await Promise.all(['styles.css','workbench.css','select.css','theme.css','updates-trends.css','filters-tools-motion.css','platform-logs.css','app-cache.css'].map(file=>readFile(path.resolve('src',file),'utf8')));await writeFile(path.join(directory,'style.css'),styles.join('\n')+'\n*{animation:none!important;transition:none!important}');
  await writeFile(path.join(directory,'index.html'),'<html><head><meta charset="UTF-8"><link rel="stylesheet" href="style.css"></head><body><div id="outside" style="position:fixed;color:rgb(0,0,0)">outside</div><div id="root"></div><script type="module" src="app.js"></script></body></html>');
  await writeFile(path.join(directory,'main.cjs'),String.raw`
const {app,BrowserWindow}=require('electron'),path=require('node:path'),fs=require('node:fs');for(const name of ['userData','sessionData','logs','crashDumps']){const dir=path.join(__dirname,name);fs.mkdirSync(dir,{recursive:true});app.setPath(name,dir);}app.disableHardwareAcceleration();app.whenReady().then(async()=>{
const win=new BrowserWindow({width:1280,height:900,show:false,webPreferences:{sandbox:true,contextIsolation:true,nodeIntegration:false,offscreen:true,backgroundThrottling:false}});await win.loadFile(path.join(__dirname,'index.html'));
const result=await win.webContents.executeJavaScript('('+async function(){
const check=(value,label)=>{if(!value)throw new Error(label);},until=async fn=>{const end=performance.now()+5000;while(!fn()){if(performance.now()>end)throw new Error('Interface UI timeout');await new Promise(r=>setTimeout(r,10));}};
await until(()=>document.querySelector('.settings-page') && document.querySelector('[role=radio][aria-checked=true]'));
const root=document.querySelector('.settings-page'),threshold=document.querySelector('[aria-label=余额提醒阈值]'),scroll=document.querySelector('.content-scroll'),shell=document.querySelector('.desktop-shell');
Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(threshold,'123.4');threshold.dispatchEvent(new Event('input',{bubbles:true}));threshold.focus();scroll.scrollTop=80;const originalWidth=document.querySelector('.sidebar').getBoundingClientRect().width;
Array.from(document.querySelectorAll('[role=radio]')).find(e=>e.textContent==='紧凑界面').click();await until(()=>shell.dataset.interface==='extension.lumi.compact');
check(document.querySelector('.sidebar').getBoundingClientRect().width<originalWidth,'Interface layout did not change');
check(getComputedStyle(document.querySelector('.sidebar')).borderTopLeftRadius==='12px','Default geometry overrode interface rounding');
check(getComputedStyle(document.querySelector('.nav-item.active')).color==='rgb(255, 255, 255)','Active navigation lost its foreground');
const theme=label=>Array.from(document.querySelectorAll('.theme-options button')).find(button=>button.textContent===label),palette=async(name,text,panel)=>{
await until(()=>shell.dataset.theme===name && document.documentElement.dataset.theme===name && getComputedStyle(shell).getPropertyValue('--theme-marker')===name);
check(getComputedStyle(shell).color===text && getComputedStyle(document.querySelector('.surface.panel')).backgroundColor===panel,'Interface palette disagrees with Lumi '+name);
check(document.querySelector('.settings-page')===root && threshold.value==='123.4','Theme switch reset settings');
};
await palette('light','rgb(50, 30, 70)','rgb(250, 245, 255)');
theme('深色').click();await palette('dark','rgb(240, 230, 250)','rgb(35, 25, 50)');
fixture.setSystemDark(false);await palette('dark','rgb(240, 230, 250)','rgb(35, 25, 50)');
theme('跟随系统').click();await palette('light','rgb(50, 30, 70)','rgb(250, 245, 255)');
fixture.setSystemDark(true);await palette('dark','rgb(240, 230, 250)','rgb(35, 25, 50)');
theme('浅色').click();await palette('light','rgb(50, 30, 70)','rgb(250, 245, 255)');
check(document.querySelector('.settings-page')===root && threshold.value==='123.4' && document.activeElement===threshold && scroll.scrollTop===80,'Switch reset settings state');
check(getComputedStyle(document.getElementById('outside')).color==='rgb(0, 0, 0)','Interface CSS escaped shell');
const recovery=document.querySelector('.interface-recovery button');check(recovery && !shell.contains(recovery),'Recovery must be outside interface scope');
fixture.fail=true;recovery.click();await until(()=>document.querySelector('.interface-recovery [role=alert]')?.textContent.includes('fixture write failed'));check(shell.dataset.interface==='extension.lumi.compact' && document.querySelector('.settings-page')===root,'Write failure lost selected interface');fixture.fail=false;recovery.click();await until(()=>shell.dataset.interface==='interface.default');
check(document.querySelector('.sidebar').getBoundingClientRect().width===originalWidth && threshold.value==='123.4' && document.querySelector('.settings-page')===root,'Recovery reset content');
for(const css of ['@import "https://fixture.invalid/x.css";:scope{color:red}','@\\69mport "https://fixture.invalid/x.css";:scope{color:red}','.sidebar{background:u\\72l(https://fixture.invalid/x)}',':scope{--image:u\\72l(https://fixture.invalid/x)}','.sidebar{-webkit-app-region:drag}','.sidebar{app-region:drag}','@font-face{font-family:x;src:url(file:///private)}',':scope{z-index:999999999}']){let rejected=false;try{fixture.scopedInterfaceSheet({id:'extension.lumi.compact',css});}catch{rejected=true;}check(rejected,'Unsafe style accepted '+css);}
fixture.scopedInterfaceSheet({id:'extension.lumi.compact',css:':scope::before{content:"@import example"} /* @import */'});
fixture.cssOverride='@font-face{font-family:x;src:url(file:///private)}';Array.from(document.querySelectorAll('[role=radio]')).find(e=>e.textContent==='紧凑界面').click();await until(()=>document.querySelector('.interface-recovery [role=alert]'));
check(shell.dataset.interface==='interface.default' && document.querySelector('.settings-page')===root && threshold.value==='123.4' && document.querySelector('.sidebar').getBoundingClientRect().width===originalWidth,'Invalid stylesheet did not fall back safely');document.querySelector('.interface-recovery button').click();await until(()=>!document.querySelector('.interface-recovery'));
check(fixture.errors.length===0,'Renderer errors '+fixture.errors);return {preserved:true,scoped:true,recovered:true};
}.toString()+')()');console.log('INTERFACE_RESULT '+JSON.stringify(result));win.destroy();app.exit(0);}).catch(error=>{console.error(error.stack || error);app.exit(1);});`);
  const env={...process.env};delete env.ELECTRON_RUN_AS_NODE;const child=spawn(electron,[path.join(directory,'main.cjs')],{env,windowsHide:true,stdio:['ignore','pipe','pipe'],signal:t.signal});let stdout='',stderr='';child.stdout.on('data',chunk=>stdout+=chunk);child.stderr.on('data',chunk=>stderr+=chunk);
  const code=await new Promise<number|null>((resolve,reject)=>{child.on('error',reject);child.on('close',resolve);});assert.equal(code,0,stderr+stdout);assert.match(stdout,/INTERFACE_RESULT.*"preserved":true.*"scoped":true.*"recovered":true/);
});
