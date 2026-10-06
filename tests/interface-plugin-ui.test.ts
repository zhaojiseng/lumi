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
:scope{--lumi-glass-distortion:3;--text:light-dark(rgb(50,30,70),rgb(240,230,250));--panel:light-dark(rgb(250,245,255),rgb(35,25,50));color:var(--text)}
:scope[data-theme="light"]{--theme-marker:light}:scope[data-theme="dark"]{--theme-marker:dark}
.sidebar{backdrop-filter:var(--lumi-glass-filter,blur(0px))}
.content-scroll{--lumi-glass-surface:1}
.content-scroll::before{content:'';position:absolute;inset:0;border-radius:inherit;pointer-events:none;backdrop-filter:var(--lumi-glass-filter,blur(0px))}
.segmented-thumb{backdrop-filter:var(--lumi-glass-filter,blur(0px))}
.nav-item.active{color:white!important}
`;
  const script=await build({stdin:{resolveDir:process.cwd(),loader:'tsx',contents:`import React from 'react';import {createRoot} from 'react-dom/client';import {DEFAULT_PREFERENCES} from './shared/types';import {builtinManifests} from './plugins/manifests';import {extensionPluginManifest} from './shared/contracts/extensions';
const prefs=structuredClone(DEFAULT_PREFERENCES),pkg=${JSON.stringify(descriptor)},css=${JSON.stringify(css+'\n#outside{color:red!important}')} ;let enabled=false;const stub=()=>()=>{};
const statuses=()=>[...builtinManifests.map(manifest=>({manifest,state:['provider.newapi','provider.codex','surface.widget','interface.background'].includes(manifest.id) ? 'disabled' : 'active'})),{manifest:extensionPluginManifest(pkg.manifest),origin:'external',state:enabled ? 'active' : 'disabled'}];
const inventory=()=>({directory:'fixture',plugins:[pkg],diagnostics:[],interfaceStyle:enabled ? {id:pkg.manifest.id,css:fixture.cssOverride ?? css,preview:fixture.previewOverride,appearanceGroups:pkg.manifest.interface.appearanceGroups} : undefined});
window.fixture={errors:[],fail:false,updateListeners:new Set(),palettes:[]};fixture.showUpdate=state=>fixture.updateListeners.forEach(fn=>fn(state));window.addEventListener('error',event=>fixture.errors.push(event.message));window.addEventListener('unhandledrejection',event=>fixture.errors.push(String(event.reason)));
fixture.media={matches:true,listeners:new Set()};fixture.setSystemDark=value=>{fixture.media.matches=value;fixture.media.listeners.forEach(fn=>fn());};const matchMedia=window.matchMedia.bind(window);window.matchMedia=query=>['(prefers-reduced-transparency: reduce)','(forced-colors: active)'].includes(query) ? {matches:false,addEventListener(){},removeEventListener(){}} : query==='(prefers-color-scheme: dark)' ? {get matches(){return fixture.media.matches;},addEventListener:(_type,fn)=>fixture.media.listeners.add(fn),removeEventListener:(_type,fn)=>fixture.media.listeners.delete(fn)} : matchMedia(query);
const {applyPreferencePatch}=await import('./shared/selections');
window.lumi={bootstrap:async()=>({preferences:prefs,desktop:true,platform:'win32',version:'fixture',configs:[],secureStorage:true}),inspectConfigs:async()=>[],listPlugins:async()=>statuses(),extensionInventory:async()=>inventory(),reloadExtensions:async()=>inventory(),setPluginEnabled:async(id,value)=>{if(fixture.fail)throw new Error('fixture write failed');if(id===pkg.manifest.id)enabled=value;return statuses();},updatePreferences:async patch=>{await new Promise(r=>setTimeout(r,25));Object.assign(prefs,applyPreferencePatch(prefs,patch));return structuredClone(prefs);},syncSurfaceTheme:async input=>{const mode=prefs.theme==='system' ? fixture.media.matches ? 'dark' : 'light' : prefs.theme;if(input.mode===mode && input.interfaceId===(enabled ? pkg.manifest.id : 'interface.default'))fixture.palettes.push(input);},onNavigate:stub,onRefresh:stub,onWidgetVisibility:stub,onUpdate:fn=>{fixture.updateListeners.add(fn);return()=>fixture.updateListeners.delete(fn);},onReviewUpdate:stub,onToolRuntime:stub,onConfigProgress:stub,onAppLog:stub,updateStatus:async()=>({phase:'unsupported',currentVersion:'fixture'}),appCache:async()=>({categories:[],totalBytes:0,browserBytes:0,updateBytes:0,protectedBytes:0,warnings:[],scannedAt:Date.now()}),windowControl:async()=>{}};
const {scopedInterfaceSheet}=await import('./src/host/interface');fixture.scopedInterfaceSheet=scopedInterfaceSheet;const {sanitizeInterfacePreview}=await import('./src/host/appearance-preview');fixture.sanitizeInterfacePreview=sanitizeInterfacePreview;const {default:App}=await import('./src/App');createRoot(document.getElementById('root')).render(<App/>);`},bundle:true,platform:'browser',format:'esm',write:false,loader:{'.css':'empty','.svg':'text'},define:{'process.env.NODE_ENV':'"production"'},logLevel:'silent'});
  await writeFile(path.join(directory,'app.js'),script.outputFiles[0].contents);
  const styles=await Promise.all(['components/segmented-switch.css','styles.css','workbench.css','select.css','theme-tokens.css','theme.css','updates-trends.css','filters-tools-motion.css','platform-logs.css','app-cache.css'].map(file=>readFile(path.resolve('src',file),'utf8')));await writeFile(path.join(directory,'style.css'),styles.join('\n')+'\n*{animation:none!important;transition:none!important}');
  await writeFile(path.join(directory,'index.html'),'<html><head><meta charset="UTF-8"><link rel="stylesheet" href="style.css"></head><body><div id="outside" style="position:fixed;color:rgb(0,0,0)">outside</div><div id="root"></div><script type="module" src="app.js"></script></body></html>');
  await writeFile(path.join(directory,'main.cjs'),String.raw`
const {app,BrowserWindow}=require('electron'),path=require('node:path'),fs=require('node:fs');for(const name of ['userData','sessionData','logs','crashDumps']){const dir=path.join(__dirname,name);fs.mkdirSync(dir,{recursive:true});app.setPath(name,dir);}app.disableHardwareAcceleration();app.whenReady().then(async()=>{
const win=new BrowserWindow({width:1280,height:900,show:process.platform==='darwin',frame:process.platform!=='darwin',webPreferences:{sandbox:true,contextIsolation:true,nodeIntegration:false,backgroundThrottling:false}});await win.loadFile(path.join(__dirname,'index.html'));
const result=await win.webContents.executeJavaScript('('+async function(){
const check=(value,label)=>{if(!value)throw new Error(label);},until=async fn=>{const end=performance.now()+5000;while(!fn()){if(performance.now()>end)throw new Error('Interface UI timeout: '+fn.toString()+'; errors='+JSON.stringify(fixture.errors)+'; body='+document.body.innerText.slice(0,500));await new Promise(r=>setTimeout(r,10));}};
await until(()=>document.querySelector('.settings-page') && document.querySelector('[data-interface-style="interface.default"] [role=switch]'));
const root=document.querySelector('.settings-page'),threshold=document.querySelector('[aria-label=余额提醒阈值]'),scroll=document.querySelector('.content-scroll'),shell=document.querySelector('.desktop-shell');
Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(threshold,'123.4');threshold.dispatchEvent(new Event('input',{bubbles:true}));threshold.focus();scroll.scrollTop=80;const originalWidth=document.querySelector('.sidebar').getBoundingClientRect().width;
document.querySelector('[data-interface-style="extension.lumi.compact"] [role=switch]').click();await until(()=>shell.dataset.interface==='extension.lumi.compact');
check(document.querySelector('.sidebar').getBoundingClientRect().width<originalWidth,'Interface layout did not change');
await until(()=>document.querySelector('.sidebar').style.getPropertyValue('--lumi-glass-filter').includes('url('));check(shell.querySelector('[data-lumi-glass-defs] filter'),'Host refraction missing');
await until(()=>scroll.style.getPropertyValue('--lumi-glass-filter').includes('url('));
scroll.style.setProperty('--lumi-glass-surface','0');await until(()=>!scroll.style.getPropertyValue('--lumi-glass-filter'));
scroll.style.removeProperty('--lumi-glass-surface');await until(()=>scroll.style.getPropertyValue('--lumi-glass-filter').includes('url('));
// Offscreen layout boxes must not exhaust the 96 surface slots. Scrolling a
// clipped list must release old surfaces and attach newly visible ones.
const viewport=document.createElement('div');viewport.style.cssText='position:fixed;left:400px;top:200px;width:200px;height:80px;overflow:auto';
for(let i=0;i<120;i++){const item=document.createElement('span');item.className='segmented-thumb';item.style.cssText='display:block;width:100px;height:30px';viewport.append(item);}shell.append(viewport);
const tail=document.createElement('span');tail.className='segmented-thumb';tail.style.cssText='position:fixed;left:620px;top:200px;width:100px;height:30px';shell.append(tail);
await until(()=>tail.style.getPropertyValue('--lumi-glass-filter').includes('url('));
const first=viewport.firstElementChild,last=viewport.lastElementChild;await until(()=>first.style.getPropertyValue('--lumi-glass-filter').includes('url('));check(!last.style.getPropertyValue('--lumi-glass-filter'),'Clipped surface allocated a filter');
viewport.scrollTop=viewport.scrollHeight;await until(()=>last.style.getPropertyValue('--lumi-glass-filter').includes('url('));await until(()=>!first.style.getPropertyValue('--lumi-glass-filter'));viewport.remove();tail.remove();
check(getComputedStyle(document.querySelector('.sidebar')).borderTopLeftRadius==='12px','Default geometry overrode interface rounding');
check(getComputedStyle(document.querySelector('.nav-item.active')).color==='rgb(255, 255, 255)','Active navigation lost its foreground');
const brand=document.querySelector('.titlebar-brand'),brandBox=brand.getBoundingClientRect(),crumb=document.querySelector('.breadcrumb').getBoundingClientRect();
check(brand.textContent.includes('Lumi') && brandBox.left>0 && brandBox.right<crumb.left,'Windows titlebar brand overlapped breadcrumb');
check(!document.querySelector('.app-statusbar'),'Removed bottom status bar remains');
fixture.showUpdate({phase:'available',currentVersion:'0.5.0',version:'0.5.1',received:0,total:1024,releaseNotes:'- Fixture update'});
await until(()=>shell.querySelector('.update-release-modal'));
const updateModal=document.querySelector('.update-release-modal');
const theme=label=>Array.from(document.querySelectorAll('.theme-options button')).find(button=>button.textContent===label),palette=async(name,text,panel)=>{
await until(()=>shell.dataset.theme===name && document.documentElement.dataset.theme===name && getComputedStyle(shell).getPropertyValue('--theme-marker')===name);
await until(()=>fixture.palettes.at(-1)?.mode===name && fixture.palettes.at(-1)?.interfaceId===shell.dataset.interface);
check(fixture.palettes.at(-1).palette.panel.slice(0,3).join(',')===(name==='dark' ? '35,25,50' : '250,245,255'),'Surface palette did not resolve plugin colors');
check(getComputedStyle(shell).color===text && getComputedStyle(document.querySelector('.surface.panel')).backgroundColor===panel,'Interface palette disagrees with Lumi '+name);
check(document.querySelector('.settings-page')===root && threshold.value==='123.4','Theme switch reset settings');
check(document.querySelector('.update-release-modal')===updateModal && getComputedStyle(updateModal).backgroundColor===panel && getComputedStyle(updateModal.querySelector('h2')).color===text,'Update dialog lost scoped theme or remounted');
const site=document.querySelector('.site-switch'),probe=document.createElement('span');probe.style.color='var(--accent)';shell.append(probe);
const canvas=document.createElement('canvas');canvas.width=canvas.height=1;const context=canvas.getContext('2d',{willReadFrequently:true}),rgba=value=>{context.clearRect(0,0,1,1);context.fillStyle='transparent';context.fillStyle=value;context.fillRect(0,0,1,1);return [...context.getImageData(0,0,1,1).data].join(',');};
await until(()=>rgba(getComputedStyle(site,'::before').backgroundColor)===rgba(getComputedStyle(probe).color));
const dot=getComputedStyle(site,'::before').backgroundColor;
check(rgba(dot)===rgba(getComputedStyle(probe).color),'Site dot ignored interface accent: '+dot+' expected '+getComputedStyle(probe).color);probe.remove();
for(const select of shell.querySelectorAll('.select-wrap select'))check(getComputedStyle(select).getPropertyValue('--choice-fg').trim()===getComputedStyle(select.closest('.select-wrap')).getPropertyValue('--choice-fg').trim(),'Select palette lost inheritance');
};
await palette('light','rgb(50, 30, 70)','rgb(250, 245, 255)');
const rose=document.querySelector('[aria-label="强调色"] [role=radio]:last-child');check(rose.textContent==='玫红','Plugin appearance group missing');rose.click();
await until(()=>shell.dataset.appearanceAccent==='rose' && fixture.palettes.at(-1)?.palette.accent.slice(0,3).join(',')==='181,62,113');
check(document.querySelector('.settings-page')===root && threshold.value==='123.4','Appearance choice reset settings');
await until(()=>[...document.querySelectorAll('.theme-preview iframe')].every(frame=>frame.srcdoc.includes('data-appearance-accent="rose"')));
document.querySelector('[aria-label="强调色"] [role=radio]').click();await until(()=>shell.dataset.appearanceAccent==='blue');
theme('深色').click();await palette('dark','rgb(240, 230, 250)','rgb(35, 25, 50)');
fixture.setSystemDark(false);await palette('dark','rgb(240, 230, 250)','rgb(35, 25, 50)');
theme('跟随系统').click();await palette('light','rgb(50, 30, 70)','rgb(250, 245, 255)');
fixture.setSystemDark(true);await palette('dark','rgb(240, 230, 250)','rgb(35, 25, 50)');
theme('浅色').click();await palette('light','rgb(50, 30, 70)','rgb(250, 245, 255)');
updateModal.querySelector('[aria-label="关闭弹窗"]').click();await until(()=>!document.querySelector('.update-release-modal'));
check(document.querySelector('.settings-page')===root && threshold.value==='123.4','Switch reset settings draft');
await until(()=>document.activeElement===threshold);check(scroll.scrollTop===80,'Switch reset settings scroll');
check(getComputedStyle(document.getElementById('outside')).color==='rgb(0, 0, 0)','Interface CSS escaped shell');
check(!document.querySelector('.interface-recovery'),'Floating recovery control remains');
const recovery=document.querySelector('[data-interface-style="extension.lumi.compact"] [role=switch]');
fixture.fail=true;recovery.click();await until(()=>document.querySelector('.plugin-settings [role=alert]')?.textContent.includes('fixture write failed'));check(shell.dataset.interface==='extension.lumi.compact' && document.querySelector('.settings-page')===root,'Write failure lost selected interface');fixture.fail=false;recovery.click();await until(()=>shell.dataset.interface==='interface.default');
check(document.querySelector('.sidebar').getBoundingClientRect().width===originalWidth && threshold.value==='123.4' && document.querySelector('.settings-page')===root,'Recovery reset content');
check(!document.querySelector('[aria-label="强调色"]') && !shell.hasAttribute('data-appearance-accent'),'Disabled theme retained appearance groups');
check(!shell.querySelector('[data-lumi-glass-defs]') && !document.querySelector('.sidebar').style.getPropertyValue('--lumi-glass-filter'),'Disabled theme retained refraction resources');
for(const css of ['@import "https://fixture.invalid/x.css";:scope{color:red}','@\\69mport "https://fixture.invalid/x.css";:scope{color:red}','.sidebar{background:u\\72l(https://fixture.invalid/x)}',':scope{--image:u\\72l(https://fixture.invalid/x)}','.sidebar{-webkit-app-region:drag}','.sidebar{app-region:drag}','@font-face{font-family:x;src:url(file:///private)}',':scope{z-index:999999999}']){let rejected=false;try{fixture.scopedInterfaceSheet({id:'extension.lumi.compact',css});}catch{rejected=true;}check(rejected,'Unsafe style accepted '+css);}
fixture.scopedInterfaceSheet({id:'extension.lumi.compact',css:':scope::before{content:"@import example"} /* @import */'});
fixture.cssOverride='@font-face{font-family:x;src:url(file:///private)}';document.querySelector('[data-interface-style="extension.lumi.compact"] [role=switch]').click();await until(()=>document.querySelector('.plugin-settings [role=alert]'));
check(shell.dataset.interface==='interface.default' && document.querySelector('.settings-page')===root && threshold.value==='123.4' && document.querySelector('.sidebar').getBoundingClientRect().width===originalWidth,'Invalid stylesheet did not fall back safely');recovery.click();await until(()=>!document.querySelector('.plugin-settings [role=alert]'));
for(const html of ['<script>alert(1)</script>','<img src="https://fixture.invalid/preview.png">','<div onclick="alert(1)">x</div>','<iframe></iframe>','<style>body{color:red}</style>','<div style="background:url(https://fixture.invalid)">x</div>']){let rejected=false;try{fixture.sanitizeInterfacePreview(html);}catch{rejected=true;}check(rejected,'Unsafe preview accepted '+html);}
fixture.cssOverride=undefined;fixture.previewOverride='<header class="titlebar"><div class="breadcrumb">Lumi</div></header><aside class="sidebar surface"><div class="nav-item active">工作台</div></aside><main class="main-area"><div class="content-container"><section class="surface panel custom-preview"><h2>主题预览</h2><div class="preview-bars"><i></i><i></i><i></i></div></section></div></main>';
document.querySelector('[data-interface-style="extension.lumi.compact"] [role=switch]').click();await until(()=>shell.dataset.interface==='extension.lumi.compact');
document.querySelector('[aria-label="强调色"] [role=radio]:last-child').click();await until(()=>shell.dataset.appearanceAccent==='rose' && [...document.querySelectorAll('.theme-preview iframe')].every(frame=>frame.srcdoc.includes('data-appearance-accent="rose"') && frame.srcdoc.includes('custom-preview')));
check(fixture.errors.length===0,'Renderer errors '+fixture.errors);return {preserved:true,scoped:true,recovered:true};
}.toString()+')()');
const until=async(fn,label=()=> 'Preview frames did not render')=>{const end=Date.now()+6000;while(!await fn()){if(Date.now()>end)throw new Error(label());await new Promise(r=>setTimeout(r,20));}};
await until(()=>win.webContents.mainFrame.frames.length===3);
const previews=await win.webContents.executeJavaScript('Array.from(document.querySelectorAll(".theme-preview.live")).map(node=>{const frame=node.querySelector("iframe");if(frame.getAttribute("sandbox")!=="" || frame.contentDocument!==null)throw new Error("Preview sandbox lost isolation");return node.dataset.previewMode;})');
for(const [index,mode] of previews.entries()){
// Inspect source-size pixels so thumbnail antialiasing cannot change the expected color.
await win.webContents.executeJavaScript('('+function(index){const node=document.querySelectorAll('.theme-preview.live')[index],frame=node.querySelector('iframe'),transform=frame.style.transform;node.style.cssText='position:fixed;inset:0;width:1024px;height:640px;z-index:1000';frame.style.transform='none';fixture.restorePreview=()=>{node.style.cssText='';frame.style.transform=transform;};}.toString()+')('+index+')');
const rect={x:0,y:0,width:1024,height:640};
const expected=mode==='dark' ? [255,177,209] : [181,62,113];
let count=0,lastImage;
try{await until(async()=>{lastImage=await win.webContents.capturePage(rect);const pixels=lastImage.toBitmap();count=0;for(let offset=0;offset<pixels.length;offset+=4)if(pixels[offset]===expected[2] && pixels[offset+1]===expected[1] && pixels[offset+2]===expected[0])++count;return count>10;},()=> 'Preview '+mode+' color '+expected+' has '+count+' pixels at '+JSON.stringify(rect)+'; bitmap='+JSON.stringify(lastImage.getSize()));}
catch(error){fs.mkdirSync(path.resolve('.cache/ui-review'),{recursive:true});fs.writeFileSync(path.resolve('.cache/ui-review/appearance-failed.png'),(await win.webContents.capturePage()).toPNG());fs.writeFileSync(path.resolve('.cache/ui-review/appearance-frame-failed.png'),lastImage.toPNG());throw error;}
await win.webContents.executeJavaScript('fixture.restorePreview()');
}
if(process.env.LUMI_UI_REVIEW==='1'){
const out=path.resolve('.cache/ui-review');fs.mkdirSync(out,{recursive:true});
for(const [width,height] of [[1280,900],[1080,800]]){win.setSize(width,height);await win.webContents.executeJavaScript('new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))');fs.writeFileSync(path.join(out,'appearance-'+width+'.png'),(await win.webContents.capturePage()).toPNG());}
await win.webContents.executeJavaScript('Array.from(document.querySelectorAll("[data-interface-style]")).find(node=>node.dataset.interfaceStyle==="extension.lumi.compact").querySelector("[role=switch]").click()');
await until(()=>win.webContents.executeJavaScript('document.querySelector(".desktop-shell").dataset.interface==="interface.default"'));
for(const mode of ['light','dark']){
await win.webContents.executeJavaScript('Array.from(document.querySelectorAll(".theme-options button")).find(button=>button.textContent==='+JSON.stringify(mode==='dark' ? '深色' : '浅色')+').click()');
await until(()=>win.webContents.executeJavaScript('document.documentElement.dataset.theme==='+JSON.stringify(mode)));
for(const [width,height] of [[1280,900],[1080,800]]){win.setSize(width,height);await win.webContents.executeJavaScript('document.querySelector(".about-panel").scrollIntoView({block:"end"});new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))');fs.writeFileSync(path.join(out,'default-about-'+mode+'-'+width+'.png'),(await win.webContents.capturePage()).toPNG());}
}
}
console.log('INTERFACE_RESULT '+JSON.stringify(result));win.destroy();app.exit(0);}).catch(error=>{console.error(error.stack || error);app.exit(1);});`);
  const env={...process.env};delete env.ELECTRON_RUN_AS_NODE;const child=spawn(electron,[path.join(directory,'main.cjs')],{env,windowsHide:true,stdio:['ignore','pipe','pipe'],signal:t.signal});let stdout='',stderr='';child.stdout.on('data',chunk=>stdout+=chunk);child.stderr.on('data',chunk=>stderr+=chunk);
  const code=await new Promise<number|null>((resolve,reject)=>{child.on('error',reject);child.on('close',resolve);});assert.equal(code,0,stderr+stdout);assert.match(stdout,/INTERFACE_RESULT.*"preserved":true.*"scoped":true.*"recovered":true/);
});
