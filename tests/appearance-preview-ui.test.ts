import test from 'node:test';
import assert from 'node:assert/strict';
import {build} from 'esbuild';
import {createHash} from 'node:crypto';
import {createRequire} from 'node:module';
import {existsSync} from 'node:fs';
import {mkdir,mkdtemp,readFile,writeFile,rm} from 'node:fs/promises';
import {spawn} from 'node:child_process';
import path from 'node:path';
import {appearancePreviewRuntime,appearancePreviewEsbuildPlugin,appearancePreviewVitePlugin} from '../scripts/appearance-preview-build';

test('appearance previews render host refraction under production CSP, isolate content and release hidden documents',{timeout:45000},async t=>{
  let electron:string;try{electron=createRequire(import.meta.url)('electron');}catch{return t.skip('Electron unavailable');}if(!existsSync(electron))return t.skip('Electron unavailable');
  await mkdir('.test-data',{recursive:true});const directory=await mkdtemp(path.resolve('.test-data/appearance-preview-'));
  t.after(()=>rm(directory,{recursive:true,force:true,maxRetries:5,retryDelay:100}));
  const runtime=await appearancePreviewRuntime();assert.equal(createHash('sha256').update(runtime.source).digest('base64'),runtime.hash);assert.doesNotMatch(runtime.source,/<\/script/i);
  const plugin=appearancePreviewVitePlugin(),transform=plugin.transformIndexHtml as (html:string,context:{filename:string})=>Promise<string>;
  const parent=await transform(await readFile('index.html','utf8'),{filename:path.resolve('index.html')});
  const csp=parent.match(/http-equiv="Content-Security-Policy" content="([^"]+)"/)![1];assert.ok(csp.includes("script-src 'self' 'sha256-"+runtime.hash+"'"));
  await assert.rejects(()=>transform('<html></html>',{filename:path.resolve('index.html')}),/CSP/);
  const skin=`:scope{--lumi-glass-distortion:0;background:repeating-linear-gradient(38deg,#ff8b79 0 3px,#77caff 3px 6px,#fae887 6px 9px);color:#173142}
:scope[data-appearance-distortion="mild"]{--lumi-glass-distortion:3}:scope[data-appearance-distortion="strong"]{--lumi-glass-distortion:8}
.sidebar{margin:12px;border-radius:24px;background:rgb(240 248 255 / .12);backdrop-filter:var(--lumi-glass-filter,blur(0px))}
.content-scroll{position:relative;margin:12px;border-radius:24px;--lumi-glass-surface:1;background:rgb(240 248 255 / .12)}
.content-scroll::before{content:'';position:absolute;inset:0;border-radius:inherit;pointer-events:none;backdrop-filter:var(--lumi-glass-filter,blur(0px))}
.content-container{position:relative}.panel{background:rgb(255 255 255 / .4)}`;
  const script=await build({stdin:{resolveDir:process.cwd(),loader:'tsx',contents:`
import React from 'react';import {createRoot} from 'react-dom/client';
import {AppearancePreview,appearancePreviewDocument,sanitizeInterfacePreview} from './src/host/appearance-preview';
const style={id:'extension.fixture.preview',css:${JSON.stringify(skin)}},root=createRoot(document.getElementById('root'));
window.fixture={style,appearancePreviewDocument,sanitizeInterfacePreview,errors:[]};
addEventListener('error',e=>fixture.errors.push(e.message));addEventListener('unhandledrejection',e=>fixture.errors.push(String(e.reason)));
fixture.render=(distortion='strong',transparency='clear')=>root.render(<><AppearancePreview style={style} mode="light" values={{distortion,transparency}} platform="win32"/><AppearancePreview style={style} mode="dark" values={{distortion,transparency}} platform="win32"/></>);
fixture.render();`},plugins:[appearancePreviewEsbuildPlugin()],bundle:true,platform:'browser',format:'esm',write:false,loader:{'.css':'empty','.svg':'text'},define:{'process.env.NODE_ENV':'"production"'},logLevel:'silent'});
  assert.ok(script.outputFiles[0].text.includes(runtime.hash),'esbuild omitted host preview runtime');
  await writeFile(path.join(directory,'app.js'),script.outputFiles[0].contents);
  const css=(await Promise.all(['theme-tokens.css','styles.css','workbench.css','theme.css'].map(file=>readFile(path.join('src',file),'utf8')))).join('\n');
  await writeFile(path.join(directory,'style.css'),css+'\nbody{margin:0;min-width:0}#root{display:flex;gap:20px}.theme-preview.live{position:relative;flex:none;width:480px;height:300px;overflow:hidden}.theme-preview iframe{position:absolute;inset:0;border:0}');
  await writeFile(path.join(directory,'index.html'),`<!doctype html><html><head><meta charset="UTF-8"><meta http-equiv="Content-Security-Policy" content="${csp}"><link rel="stylesheet" href="style.css"></head><body><div id="root"></div><script type="module" src="app.js"></script></body></html>`);
  await writeFile(path.join(directory,'main.cjs'),String.raw`
const {app,BrowserWindow}=require('electron'),fs=require('node:fs'),path=require('node:path');
for(const name of ['userData','sessionData','logs','crashDumps']){const dir=path.join(__dirname,name);fs.mkdirSync(dir,{recursive:true});app.setPath(name,dir);}
if(process.env.LUMI_GLASS_HARDWARE!=='1')app.disableHardwareAcceleration();app.commandLine.appendSwitch('force-device-scale-factor','1');
app.whenReady().then(async()=>{
const win=new BrowserWindow({width:1000,height:380,useContentSize:true,show:process.platform==='darwin',webPreferences:{sandbox:true,contextIsolation:true,nodeIntegration:false,backgroundThrottling:false}});
if(process.platform==='win32')win.showInactive();
const requests=[];win.webContents.session.webRequest.onBeforeRequest((details,callback)=>{if(/^https?:/.test(details.url))requests.push(details.url);callback({cancel:/^https?:/.test(details.url)});});
await win.loadFile(path.join(__dirname,'index.html'));
const media=async(reduced=false,forced=false)=>until(async()=>frames().length===2 && (await Promise.all(frames().map(f=>inspect(f,fixtureMedia+';(()=>{if(typeof setFixtureMedia!=="function")return false;setFixtureMedia("(prefers-reduced-transparency: reduce)",'+reduced+');setFixtureMedia("(forced-colors: active)",'+forced+');return true})()')))).every(Boolean),'preview media control document not ready');
const run=code=>win.webContents.executeJavaScript(code),frames=()=>win.webContents.mainFrame.frames.filter(frame=>!frame.detached);
const inspect=(frame,code)=>new Promise((resolve,reject)=>{const timer=setTimeout(()=>resolve(false),1000);timer.unref();frame.executeJavaScript(code).then(value=>{clearTimeout(timer);resolve(value);},error=>{clearTimeout(timer);if(frame.detached || /disposed|destroyed/.test(String(error)))resolve(false);else reject(error);});});
const check=(value,label)=>{if(!value)throw Error(label);};
const until=async(fn,label)=>{const end=Date.now()+7000;while(!await fn()){if(Date.now()>end)throw Error(label+' frames='+frames().map(f=>f.url)+' states='+JSON.stringify(states)+' parent='+JSON.stringify(await run('Array.from(document.querySelectorAll("iframe")).map(f=>({style:f.style.cssText,rect:f.getBoundingClientRect().toJSON(),display:getComputedStyle(f).display,root:document.getElementById("root").getBoundingClientRect().toJSON()}))')));try{await win.webContents.capturePage(undefined,{stayHidden:true,stayAwake:true})}catch(e){if(!String(e).includes('UnknownVizError'))throw e;}await new Promise(r=>setTimeout(r,20));}};
let states=[];
// Opaque srcdoc frames do not inherit parent CDP media emulation. Control the
// runtime's two MediaQueryLists in the child, then reinstall through its real
// page lifecycle. The document/script bytes and production CSP remain exact.
const fixtureMedia='(()=>{if(document.readyState!=="complete" || !document.querySelector(".desktop-shell") || window.setFixtureMedia)return;const native=matchMedia.bind(window),queries=new Map();window.nativeFixtureMedia={reduced:native("(prefers-reduced-transparency: reduce)").matches,forced:native("(forced-colors: active)").matches};dispatchEvent(new PageTransitionEvent("pagehide"));window.matchMedia=query=>{if(!["(prefers-reduced-transparency: reduce)","(forced-colors: active)"].includes(query))return native(query);if(!queries.has(query))queries.set(query,{matches:false,listeners:new Set(),addEventListener:(_type,fn)=>queries.get(query).listeners.add(fn),removeEventListener:(_type,fn)=>queries.get(query).listeners.delete(fn)});return queries.get(query)};window.setFixtureMedia=(query,value)=>{const media=matchMedia(query);media.matches=value;for(const fn of media.listeners)fn()};dispatchEvent(new PageTransitionEvent("pageshow"));})()';
const ready=async strength=>until(async()=>{if(frames().length!==2)return false;await Promise.all(frames().map(frame=>inspect(frame,fixtureMedia)));states=await Promise.all(frames().map(frame=>inspect(frame,'(()=>{const shell=document.querySelector(".desktop-shell"),sidebar=document.querySelector(".sidebar"),scroll=document.querySelector(".content-scroll");if(!shell)return {};return {nativeMedia:window.nativeFixtureMedia,viewport:[innerWidth,innerHeight],strength:shell?.dataset.appearanceDistortion,ready:document.readyState,raw:getComputedStyle(shell).getPropertyValue("--lumi-glass-distortion"),defs:!!document.querySelector("[data-lumi-glass-defs]"),filters:document.querySelectorAll("[data-lumi-glass-defs] filter").length,sidebar:sidebar?.style.getPropertyValue("--lumi-glass-filter"),scroll:scroll?.style.getPropertyValue("--lumi-glass-filter"),shellSize:shell.getBoundingClientRect().toJSON()}})()').then(value=>value || {})));return states.every(s=>s.ready==='complete' && s.strength===strength && s.defs && (strength==='off' ? s.filters===0 && s.shellSize.width>0 : s.sidebar?.includes('url(') && s.scroll?.includes('url(')));},'preview runtime missing for '+strength);
const paint=async()=>{await run('new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)))');await win.webContents.capturePage(undefined,{stayHidden:true,stayAwake:true});await run('new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)))');};
const shots={};
for(const strength of ['off','mild','strong']){await run('fixture.render('+JSON.stringify(strength)+')');await ready(strength);await paint();shots[strength]=[];for(const x of [0,500])shots[strength].push((await win.webContents.capturePage({x,y:0,width:480,height:300},{stayHidden:true,stayAwake:true})).toBitmap());}
console.log('APPEARANCE_PREVIEW_NATIVE_MEDIA '+JSON.stringify(states.map(s=>s.nativeMedia)));
const difference=(a,b)=>{let count=0;for(let i=0;i<a.length;i+=4)if(Math.max(Math.abs(a[i]-b[i]),Math.abs(a[i+1]-b[i+1]),Math.abs(a[i+2]-b[i+2]))>3)count++;return count;};
const pixels=shots.off.map((off,index)=>({mode:index ? 'dark' : 'light',offMild:difference(off,shots.mild[index]),mildStrong:difference(shots.mild[index],shots.strong[index])}));
check(pixels.every(p=>p.offMild>50 && p.mildStrong>50),'preview refraction pixels missing '+JSON.stringify(pixels));
// Negative control: removing the trusted runtime must remove the rendered effect.
await run('for(const frame of document.querySelectorAll("iframe"))frame.srcdoc=frame.srcdoc.replace(/<script>[\\s\\S]*?<\\/script>/g,"")');
await until(async()=>frames().length===2 && (await Promise.all(frames().map(f=>inspect(f,'!!document.querySelector(".sidebar") && document.readyState==="complete" && document.querySelector(".desktop-shell").getBoundingClientRect().width>0 && !document.querySelector("[data-lumi-glass-defs]")')))).every(Boolean),'negative control document not loaded');await paint();
const negative={};
for(const strength of ['off','mild','strong']){
await Promise.all(frames().map(f=>inspect(f,'document.querySelector(".desktop-shell").dataset.appearanceDistortion='+JSON.stringify(strength))));await paint();negative[strength]=[];
for(const x of [0,500])negative[strength].push((await win.webContents.capturePage({x,y:0,width:480,height:300},{stayHidden:true,stayAwake:true})).toBitmap());
}
for(const index of [0,1]){check(difference(negative.off[index],negative.mild[index])===0 && difference(negative.mild[index],negative.strong[index])===0,'script-free preview still changed with distortion');check(difference(shots.strong[index],negative.strong[index])>50,'removing the runtime did not remove the rendered effect');}
await run('fixture.render("mild")');await ready('mild');
for(const [reduced,forced] of [[true,false],[false,true]]){
await media(reduced,forced);
await until(async()=>frames().length===2 && (await Promise.all(frames().map(f=>inspect(f,'document.querySelectorAll("[data-lumi-glass-defs] filter").length===0')))).every(Boolean),'accessibility preference retained preview filters');
await media();await ready('mild');
}
check(await run('Array.from(document.querySelectorAll("iframe")).every(f=>f.getAttribute("sandbox")==="allow-scripts" && f.contentDocument===null)'),'preview origin isolation lost');
for(const frame of frames()){
check(await frame.executeJavaScript('(()=>{let blocked=false;try{void parent.document.body}catch{blocked=true}return blocked && typeof require==="undefined" && typeof lumi==="undefined"})()'),'preview accessed privileged parent');
await frame.executeJavaScript('window.violations=[];addEventListener("securitypolicyviolation",e=>violations.push(e.effectiveDirective));const inline=document.createElement("script");inline.textContent="window.previewAttack=1";document.body.append(inline);const external=document.createElement("script");external.src="https://fixture.invalid/attack.js";document.body.append(external);fetch("https://fixture.invalid/request").catch(()=>{});const child=document.createElement("iframe");child.src="https://fixture.invalid/frame";document.body.append(child);');
await until(()=>frame.executeJavaScript('violations.includes("script-src-elem") && violations.includes("connect-src") && violations.includes("frame-src")'),'preview CSP did not reject hostile code/requests');
check(await frame.executeJavaScript('typeof previewAttack==="undefined"'),'arbitrary inline script executed');
await frame.executeJavaScript('dispatchEvent(new PageTransitionEvent("pagehide"))');
check(await frame.executeJavaScript('!document.querySelector("[data-lumi-glass-defs]") && !document.querySelector(".sidebar").style.getPropertyValue("--lumi-glass-filter")'),'pagehide retained glass resources');
await frame.executeJavaScript('dispatchEvent(new PageTransitionEvent("pageshow"))');
await until(()=>frame.executeJavaScript('document.querySelectorAll("[data-lumi-glass-defs]").length===1 && !!document.querySelector("[data-lumi-glass-defs] filter")'),'pageshow failed to reinstall one runtime');
}
check(requests.length===0,'preview attempted external requests '+requests);
check(await run('(()=>{const attacks=["<script>alert(1)</script>","<img src=https://fixture.invalid/x>","<div onclick=alert(1)>x</div>","<div style=color:red>x</div>","<iframe></iframe>","<div data-lumi-glass=lens>x</div>"];return attacks.every(html=>{try{fixture.sanitizeInterfacePreview(html);return false}catch{return true}})})()'),'preview sanitizer accepted active content');
await run('document.getElementById("root").style.transform="translateY(2000px)"');await until(()=>frames().length===0,'hidden previews retained iframe documents');
await run('document.getElementById("root").style.transform=""');await ready('mild');
await run('fixture.render("strong","solid")');await until(async()=>frames().length===2 && (await Promise.all(frames().map(f=>f.executeJavaScript('!document.querySelector("[data-lumi-glass-defs] filter")')))).every(Boolean),'solid preview retained filters');
check(await run('fixture.errors.length===0'),'preview renderer errors');
console.log('APPEARANCE_PREVIEW_RESULT '+JSON.stringify({pixels,isolated:true,cleaned:true}));win.destroy();app.exit(0);
}).catch(error=>{console.error(error.stack || error);app.exit(1);});`);
  const env={...process.env};delete env.ELECTRON_RUN_AS_NODE;
  const child=spawn(electron,[path.join(directory,'main.cjs')],{env,windowsHide:true,stdio:['ignore','pipe','pipe'],signal:t.signal});let stdout='',stderr='';child.stdout.on('data',chunk=>stdout+=chunk);child.stderr.on('data',chunk=>stderr+=chunk);
  const code=await new Promise<number|null>((resolve,reject)=>{child.on('error',reject);child.on('close',resolve);});assert.equal(code,0,stderr+stdout);assert.match(stdout,/APPEARANCE_PREVIEW_RESULT.*"isolated":true.*"cleaned":true/);t.diagnostic(stdout.trim());
});
