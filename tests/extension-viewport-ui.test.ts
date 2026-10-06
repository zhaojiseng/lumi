import test from 'node:test';
import assert from 'node:assert/strict';
import {build} from 'esbuild';
import {mkdir,mkdtemp,readFile,writeFile,rm} from 'node:fs/promises';
import {existsSync} from 'node:fs';
import {createRequire} from 'node:module';
import {spawn} from 'node:child_process';
import path from 'node:path';

test('sandbox sidebar fills the real host viewport and returns to natural sizing without remounting',{timeout:30000},async t=>{
  const electron=createRequire(import.meta.url)('electron');if(!existsSync(electron))return t.skip('Electron unavailable');
  await mkdir('.test-data',{recursive:true});const directory=await mkdtemp(path.resolve('.test-data/extension-viewport-'));
  t.after(()=>rm(directory,{recursive:true,force:true,maxRetries:5,retryDelay:100}));
  const built=await build({stdin:{resolveDir:process.cwd(),loader:'tsx',contents:`
import React,{useState} from 'react';import {createRoot} from 'react-dom/client';
import {ExtensionFrame} from './src/host/extension-frame';import {PluginSettingsProvider} from './src/host/plugins';
import {AppContext} from './src/context';import {DEFAULT_PREFERENCES} from './shared/types';
window.fixture={};window.lumi={extensionRequest:async()=>({}),onExtensionEvent:()=>()=>{}};
function Host(){const [visible,setVisible]=useState(true);fixture.visible=setVisible;
return <AppContext.Provider value={{preferences:DEFAULT_PREFERENCES}}><PluginSettingsProvider value={{statuses:[{manifest:{id:'extension.fixture.viewport'},generation:1,state:'active'}],items:[]}}><div className="content-scroll"><div className="content-container">{visible && <ExtensionFrame pluginId="extension.fixture.viewport" view={{id:'chat',slot:'sidebar',title:'Fixture',entry:'index.html'}}/>}</div></div></PluginSettingsProvider></AppContext.Provider>}
createRoot(document.getElementById('root')).render(<Host/>);`},bundle:true,format:'esm',platform:'browser',write:false,loader:{'.css':'empty','.svg':'text'},define:{'process.env.NODE_ENV':'"production"'},logLevel:'silent'});
  await writeFile(path.join(directory,'renderer.js'),built.outputFiles[0].contents);
  await writeFile(path.join(directory,'sdk.js'),await readFile('public/lumi-extension-sdk.js'));
  await writeFile(path.join(directory,'style.css'),await readFile('src/host/extension-layout.css','utf8'));
  await writeFile(path.join(directory,'index.html'),`<link rel="stylesheet" href="style.css"><style>*{box-sizing:border-box}body{margin:0}#root{height:100vh;padding-top:48px}.content-scroll{height:calc(100vh - 48px);overflow:auto}.content-container{max-width:1000px;margin:auto;padding:12px 20px 16px}.extension-view{width:100%}</style><div id="root"></div><script type="module" src="renderer.js"></script>`);
  await writeFile(path.join(directory,'plugin.html'),`<!doctype html><style>body{margin:0}#chat{height:var(--lumi-viewport-height,720px);display:flex;flex-direction:column}#stream{flex:1;min-height:0;overflow:auto}textarea{height:60px;flex:none}</style><body data-lumi-layout="fill"><div id="chat"><div id="stream">Fixture</div><textarea>retained draft</textarea></div><script src="lumi-extension://extension.fixture.viewport/1/sdk.js"></script>`);
  await writeFile(path.join(directory,'audit.cjs'),String.raw`
const {app,BrowserWindow,protocol}=require('electron'),fs=require('node:fs'),path=require('node:path');
protocol.registerSchemesAsPrivileged([{scheme:'lumi-extension',privileges:{standard:true,secure:true,supportFetchAPI:true}}]);
for(const name of ['userData','sessionData','logs','crashDumps']){const dir=path.join(__dirname,name);fs.mkdirSync(dir,{recursive:true});app.setPath(name,dir);}app.disableHardwareAcceleration();
app.whenReady().then(async()=>{
protocol.handle('lumi-extension',request=>{const script=request.url.endsWith('sdk.js');return new Response(fs.readFileSync(path.join(__dirname,script?'sdk.js':'plugin.html')),{headers:{'Content-Type':script?'text/javascript':'text/html'}})});
const win=new BrowserWindow({show:process.platform==='darwin',frame:process.platform!=='darwin',width:1600,height:1000,webPreferences:{sandbox:true,contextIsolation:true,nodeIntegration:false,backgroundThrottling:false}});await win.loadFile(path.join(__dirname,'index.html'));
const run=code=>win.webContents.executeJavaScript(code),until=async fn=>{const end=Date.now()+6000;while(!await fn()){if(Date.now()>end)throw Error('timeout '+fn+'; '+await run('JSON.stringify({viewport:[innerWidth,innerHeight],layout:document.querySelector(".extension-view")?.dataset.layout,height:document.querySelector("iframe")?.clientHeight})'));await win.webContents.capturePage(undefined,{stayHidden:true,stayAwake:true});await new Promise(r=>setTimeout(r,20));}},check=async(code,label)=>{if(!await run(code))throw Error(label)};
await until(()=>run('document.querySelector(".extension-view")?.dataset.layout==="fill"'));const child=()=>win.webContents.mainFrame.frames[0];
for(const [width,height] of [[2100,1200],[900,540],[1200,800],[1000,420],[1600,1000]]){
// Native platforms can clamp oversized windows to the screen. Compare with
// their actual content size and require all host layout constraints together.
win.setSize(width,height);await until(()=>{const [contentWidth,contentHeight]=win.getContentSize();return run('innerWidth==='+contentWidth+' && innerHeight==='+contentHeight+' && Math.abs(document.querySelector("iframe").getBoundingClientRect().bottom-innerHeight)<=1 && document.querySelector(".content-scroll").scrollHeight<=document.querySelector(".content-scroll").clientHeight+1 && document.querySelector("iframe").clientWidth===document.querySelector(".content-scroll").clientWidth-40')});
await check('document.querySelector(".content-scroll").scrollHeight<=document.querySelector(".content-scroll").clientHeight+1','outer scrollbar');
await check('document.querySelector("iframe").clientWidth===document.querySelector(".content-scroll").clientWidth-40','workspace width capped');
await until(()=>child().executeJavaScript('Math.abs(document.getElementById("chat").clientHeight-innerHeight)<1'));
if(!await child().executeJavaScript('document.querySelector("textarea").value==="retained draft" && document.querySelector("textarea").getBoundingClientRect().bottom<=innerHeight+1'))throw Error('draft/input lost '+await child().executeJavaScript('JSON.stringify({height:innerHeight,chat:document.getElementById("chat").clientHeight,bottom:document.querySelector("textarea").getBoundingClientRect().bottom})'));
}
await child().executeJavaScript('delete document.body.dataset.lumiLayout;document.getElementById("chat").style.height="300px"');
await until(()=>run('document.querySelector(".extension-view").dataset.layout==="content" && document.querySelector("iframe").clientHeight===320'));
await check('document.querySelector("iframe").clientWidth===960','natural width not restored');
await run('fixture.visible(false)');await until(()=>run('!document.querySelector("iframe")'));await run('fixture.visible(true)');await until(()=>run('document.querySelector(".extension-view")?.dataset.layout==="fill"'));
console.log('VIEWPORT_UI_OK resize fill natural draft lifecycle');win.destroy();app.exit(0);
}).catch(error=>{console.error(error.stack);app.exit(1)});
`);
  const env={...process.env};delete env.ELECTRON_RUN_AS_NODE;
  const child=spawn(electron,[path.join(directory,'audit.cjs')],{env,windowsHide:true,stdio:['ignore','pipe','pipe']});let output='';child.stdout.on('data',data=>output+=data);child.stderr.on('data',data=>output+=data);
  const timer=setTimeout(()=>child.kill(),25000);const code=await new Promise(resolve=>child.on('close',resolve));clearTimeout(timer);
  assert.equal(code,0,output);assert.match(output,/VIEWPORT_UI_OK/);
});
