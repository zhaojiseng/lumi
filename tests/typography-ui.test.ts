import test from 'node:test';
import assert from 'node:assert/strict';
import {build} from 'esbuild';
import {mkdir,mkdtemp,writeFile,readFile,rm} from 'node:fs/promises';
import {existsSync} from 'node:fs';
import {createRequire} from 'node:module';
import {spawn} from 'node:child_process';
import path from 'node:path';

test('real appearance controls scale host and SDK text, retain drafts and restore defaults',{timeout:40000},async t=>{
  const electron=createRequire(import.meta.url)('electron');if(!existsSync(electron))return t.skip('Electron unavailable');
  await mkdir('.test-data',{recursive:true});const root=await mkdtemp(path.resolve('.test-data/font-ui-'));
  t.after(()=>rm(root,{recursive:true,force:true,maxRetries:5,retryDelay:100}));
  const {extensionSdkRuntime}=await import(new URL('../scripts/extension-ui.mjs',import.meta.url).href);
  await writeFile(path.join(root,'sdk.js'),await extensionSdkRuntime());
  await writeFile(path.join(root,'plugin.html'),`<!doctype html><meta charset="utf-8"><link rel="stylesheet" data-lumi-ui href="plugin.css"><script src="sdk.js" defer></script><body data-lumi-ui><article id="message">A readable reply · 模型回复</article><p id="caption">状态说明</p><code id="code">const answer = 42;</code><textarea id="draft">retained draft</textarea>`);
  await writeFile(path.join(root,'plugin.css'),'body{margin:0;font:13px/1.6 sans-serif}#message{font-size:14px}#caption{font-size:10px}code{font:12px monospace}textarea{font:inherit}');
  const source=await build({stdin:{resolveDir:process.cwd(),loader:'tsx',contents:`
import React,{useState,useLayoutEffect} from 'react';import {createRoot} from 'react-dom/client';
import {DEFAULT_PREFERENCES} from './shared/types';import {applyPreferencePatch} from './shared/selections';import {AppContext} from './src/context';
import {applyDocumentTypography} from './src/host/typography';
import {TrendChart} from './src/components/charts';
window.fixture={patches:[],errors:[]};addEventListener('error',e=>fixture.errors.push(e.message));
window.lumi={extensionRequest:async()=>({}),onExtensionEvent:()=>()=>{}};
const {PluginSettingsProvider}=await import('./src/host/plugins');
const {AppearanceSettings}=await import('./src/host/appearance-settings');
const {ExtensionFrame}=await import('./src/host/extension-frame');
function Host(){const [preferences,setPreferences]=useState(structuredClone(DEFAULT_PREFERENCES));fixture.preferences=preferences;
fixture.refresh=()=>applyDocumentTypography(document,fixture.preferences);
useLayoutEffect(()=>applyDocumentTypography(document,preferences),[preferences.fontSize,preferences.fontFamily]);
return <AppContext.Provider value={{preferences,bootstrap:{platform:'win32'},updatePreferences:async patch=>{fixture.patches.push(patch);setPreferences(current=>applyPreferencePatch(current,patch));},toast:()=>{}}}>
  <PluginSettingsProvider value={{statuses:[{manifest:{id:'extension.fixture.typography'},generation:1,state:'active'}],items:[]}}>
    <AppearanceSettings/><h2 id="host-heading">Host heading</h2>
    <div id="fixed-box"><p id="host-text">Host text · 本机文字</p><code id="host-code">local code</code><p className="skin-text">Skin typography</p></div>
    <div id="chart-fixture"><TrendChart metric="speed" data={[{label:'08:00',cost:1,tokens:10,requests:1,speed:12},{label:'09:00',cost:2,tokens:20,requests:2,speed:25}]}/></div>
    <ExtensionFrame pluginId="extension.fixture.typography" view={{id:'chat',slot:'sidebar',entry:'plugin.html',title:'Font fixture'}}/>
  </PluginSettingsProvider>
</AppContext.Provider>}
createRoot(document.getElementById('root')).render(<Host/>);`},bundle:true,platform:'browser',format:'esm',write:false,loader:{'.css':'empty','.svg':'text'},define:{'process.env.NODE_ENV':'"production"'},logLevel:'silent'});
  await writeFile(path.join(root,'renderer.js'),source.outputFiles[0].contents);
  const files=['theme-tokens.css','styles.css','workbench.css','select.css','theme.css','filters-tools-motion.css','platform-logs.css','components/segmented-switch.css','host/typography-settings.css'];
  await writeFile(path.join(root,'style.css'),(await Promise.all(files.map(file=>readFile(path.join('src',file),'utf8')))).join('\n')+'\nbody{min-width:0;overflow:auto;padding:20px}h2#host-heading{font-size:18px}#host-text{font-size:13px}#fixed-box{width:300px}#host-code{font:12px monospace}.theme-options{display:none}#chart-fixture{width:360px;height:220px}.trend-chart{height:100%}');
  await writeFile(path.join(root,'index.html'),'<meta charset="utf-8"><link rel="stylesheet" href="style.css"><div id="root"></div><script type="module" src="renderer.js"></script>');
  await writeFile(path.join(root,'main.cjs'),String.raw`
const {app,BrowserWindow,protocol}=require('electron'),fs=require('node:fs'),path=require('node:path');
protocol.registerSchemesAsPrivileged([{scheme:'lumi-extension',privileges:{standard:true,secure:true,supportFetchAPI:true,corsEnabled:true}}]);
for(const name of ['userData','sessionData','logs','crashDumps']){const dir=path.join(__dirname,name);fs.mkdirSync(dir,{recursive:true});app.setPath(name,dir);}app.disableHardwareAcceleration();
app.whenReady().then(async()=>{
protocol.handle('lumi-extension',request=>{const name=new URL(request.url).pathname.split('/').at(-1),file=['plugin.html','plugin.css','sdk.js'].includes(name) ? name : 'plugin.html';const origin='lumi-extension://extension.fixture.typography';return new Response(fs.readFileSync(path.join(__dirname,file)),{headers:{'Content-Type':file.endsWith('.js') ? 'text/javascript' : file.endsWith('.css') ? 'text/css' : 'text/html','Access-Control-Allow-Origin':'*','Content-Security-Policy':"default-src 'none'; script-src "+origin+"; style-src "+origin+" 'unsafe-inline'; img-src "+origin+" data:; font-src "+origin+"; connect-src 'none'; frame-src 'none'; worker-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'"}})});
const win=new BrowserWindow({show:process.platform==='darwin',frame:process.platform!=='darwin',width:1000,height:900,webPreferences:{sandbox:true,contextIsolation:true,nodeIntegration:false,backgroundThrottling:false}});await win.loadFile(path.join(__dirname,'index.html'));
const run=code=>win.webContents.executeJavaScript(code),frame=()=>win.webContents.mainFrame.frames.find(f=>f.url.startsWith('lumi-extension:'));
const until=async(fn,label)=>{const deadline=Date.now()+6000;while(!await fn()){if(Date.now()>deadline){console.log(await frame()?.executeJavaScript('JSON.stringify([...document.styleSheets].map(s=>{try{return {href:s.href,rules:[...s.cssRules].map(r=>r.cssText)}}catch(e){return {href:s.href,error:e.message}}}))'));throw Error(label);}await win.webContents.capturePage(undefined,{stayHidden:true,stayAwake:true});await new Promise(r=>setTimeout(r,20));}};
await until(()=>frame()?.executeJavaScript('document.body.dataset.interface==="interface.default" && !!window.lumiExtension && getComputedStyle(document.getElementById("message")).fontSize==="14px"'),'SDK did not initialize');
if(!await frame().executeJavaScript('(()=>{try{void parent.document.body;return false}catch{return typeof require==="undefined"}})()'))throw Error('Typography escaped iframe isolation');
await run('window.selectFont=(label,value)=>{const select=[...document.querySelectorAll("select")].find(el=>el.getAttribute("aria-label")===label);select.value=value;select.dispatchEvent(new Event("change",{bubbles:true}))};void 0');
await frame().executeJavaScript('window.originalDraft=document.getElementById("draft");originalDraft.focus();');
for(const [size,family] of [[24,'serif'],[18,'sans'],[11,'mono'],[15,'sans'],[13,'system']]){
await run('selectFont("字体大小",'+JSON.stringify(String(size))+');selectFont("字体样式",'+JSON.stringify(family)+')');
await until(()=>frame().executeJavaScript('Math.abs(parseFloat(getComputedStyle(document.getElementById("message")).fontSize)-'+(14*size/13)+')<.02'),'Plugin size did not update');
const host=await run('({heading:parseFloat(getComputedStyle(document.getElementById("host-heading")).fontSize),text:parseFloat(getComputedStyle(document.getElementById("host-text")).fontSize),family:getComputedStyle(document.body).fontFamily,code:getComputedStyle(document.getElementById("host-code")).fontFamily,width:document.getElementById("fixed-box").offsetWidth,saved:fixture.preferences})');
if(Math.abs(host.heading-18*size/13)>.02 || Math.abs(host.text-size)>.02 || host.width!==300 || !host.code.includes('monospace') || host.saved.fontSize!==size || host.saved.fontFamily!==family)throw Error('Host text/geometry contract '+JSON.stringify(host));
await until(()=>run('(()=>{const ticks=[...document.querySelectorAll("#chart-fixture text.recharts-cartesian-axis-tick-value")];return ticks.length>0 && ticks.every(t=>Math.abs(parseFloat(getComputedStyle(t).fontSize)-11*'+size+'/13)<.02)})()'),'SVG chart text did not scale at '+size);
if(!await run('(()=>{const chart=document.querySelector("#chart-fixture").getBoundingClientRect();return [...document.querySelectorAll("#chart-fixture text.recharts-cartesian-axis-tick-value")].every(t=>{const r=t.getBoundingClientRect();return r.left>=chart.left-.5 && r.right<=chart.right+.5 && r.top>=chart.top-.5 && r.bottom<=chart.bottom+.5})})()'))throw Error('Chart axis labels clipped at '+size+' '+JSON.stringify(await run('({chart:document.querySelector("#chart-fixture").getBoundingClientRect().toJSON(),ticks:[...document.querySelectorAll("#chart-fixture text")].map(t=>({text:t.textContent,...t.getBoundingClientRect().toJSON()}))})')));
const listSize=await run('parseFloat(getComputedStyle(document.querySelector(".typography-controls select")).fontSize)');if(Math.abs(listSize-14*size/13)>.02)throw Error('List typography token did not scale');
if(!await frame().executeJavaScript('document.getElementById("draft")===originalDraft && originalDraft.value==="retained draft" && document.activeElement===originalDraft && getComputedStyle(document.getElementById("code")).fontFamily.includes("monospace")'))throw Error('SDK typography remounted a draft, moved focus or changed code family');
}
await run('selectFont("字体大小","24");selectFont("字体样式","serif")');await until(()=>frame().executeJavaScript('Math.abs(parseFloat(getComputedStyle(document.getElementById("message")).fontSize)-14*24/13)<.02'),'Larger type not applied');
await run('window.skinSheet=new CSSStyleSheet();skinSheet.replaceSync("@scope (#root) {.skin-text {font-size:17px}}");document.adoptedStyleSheets=[skinSheet];fixture.refresh();void 0');
await until(()=>run('Math.abs(parseFloat(getComputedStyle(document.querySelector(".skin-text")).fontSize)-17*24/13)<.02'),'Adopted skin stylesheet did not scale');
await run('document.adoptedStyleSheets=[];fixture.refresh();void 0');if(!await run('skinSheet.cssRules[0].cssRules[0].style.fontSize==="17px"'))throw Error('Detached skin retained typography mutation');
await run('document.adoptedStyleSheets=[skinSheet];fixture.refresh();void 0');await until(()=>run('Math.abs(parseFloat(getComputedStyle(document.querySelector(".skin-text")).fontSize)-17*24/13)<.02'),'Reattached skin scaled twice');
fs.writeFileSync(path.join(__dirname,'..','font-settings-24-serif-wide.png'),(await win.webContents.capturePage(undefined,{stayHidden:true,stayAwake:true})).toPNG());
win.setContentSize(420,480);await until(()=>run('innerWidth===420 && innerHeight===480'),'Narrow window did not settle');
if(!await run('document.documentElement.scrollWidth<=innerWidth && [...document.querySelectorAll(".typography-controls .select-wrap,.typography-controls .button")].every(el=>{const r=el.getBoundingClientRect();return r.left>=0 && r.right<=innerWidth})'))throw Error('Large fonts overflowed narrow appearance controls');
fs.writeFileSync(path.join(__dirname,'..','font-settings-24-serif-narrow.png'),(await win.webContents.capturePage(undefined,{stayHidden:true,stayAwake:true})).toPNG());
await frame().executeJavaScript('var late=document.createElement("style");late.textContent="#caption{font-size:16px!important}";document.head.append(late)');await until(()=>frame().executeJavaScript('Math.abs(parseFloat(getComputedStyle(document.getElementById("caption")).fontSize)-'+(16*24/13)+')<.02'),'Late CSS did not scale');
await frame().executeJavaScript('dispatchEvent(new PageTransitionEvent("pagehide"))');if(!await frame().executeJavaScript('getComputedStyle(document.getElementById("message")).fontSize==="14px"'))throw Error('Typography disposal left scaled rules');
await frame().executeJavaScript('dispatchEvent(new PageTransitionEvent("pageshow"))');await until(()=>frame().executeJavaScript('getComputedStyle(document.getElementById("message")).fontSize!=="14px"'),'Pageshow lost font settings');
await run('[...document.querySelectorAll("button")].find(b=>b.textContent==="恢复默认字体").click()');await until(()=>frame().executeJavaScript('getComputedStyle(document.getElementById("message")).fontSize==="14px"'),'Reset did not reach plugin');
await run('(()=>{if(fixture.preferences.fontSize!==13 || fixture.preferences.fontFamily!=="system" || fixture.errors.length)throw Error("Default or browser errors")})()');
console.log('TYPOGRAPHY_UI_OK controls host SDK hierarchy geometry drafts focus late-CSS lifecycle reset');win.destroy();app.exit(0);
}).catch(e=>{console.error(e.stack);app.exit(1)});`);
  const env={...process.env};delete env.ELECTRON_RUN_AS_NODE;
  const child=spawn(electron,[path.join(root,'main.cjs')],{env,windowsHide:true,stdio:['ignore','pipe','pipe'],signal:t.signal});let output='';child.stdout.on('data',data=>output+=data);child.stderr.on('data',data=>output+=data);
  const code=await new Promise<number|null>((resolve,reject)=>{child.on('error',reject);child.on('close',resolve)});assert.equal(code,0,output);assert.match(output,/TYPOGRAPHY_UI_OK/);
});
