import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile,mkdir,mkdtemp,writeFile,rm} from 'node:fs/promises';
import {createRequire} from 'node:module';
import {existsSync} from 'node:fs';
import {spawn} from 'node:child_process';
import path from 'node:path';


test('embedded settings glass keeps foreground pixels sharp above and inside the iframe',{timeout:20000},async t=>{
  const electron=createRequire(import.meta.url)('electron');if(!existsSync(electron))return t.skip('Electron unavailable');
  await mkdir('.test-data',{recursive:true});const directory=await mkdtemp(path.resolve('.test-data/settings-glass-'));
  t.after(()=>rm(directory,{recursive:true,force:true,maxRetries:5,retryDelay:100}));
  await writeFile(path.join(directory,'ui.css'),(await Promise.all(['theme-tokens.css','styles.css','workbench.css','select.css','theme.css','filters-tools-motion.css','platform-logs.css','host/extension-ui.css'].map(file=>readFile(path.join('src',file),'utf8')))).join('\n'));
  await writeFile(path.join(directory,'layout.css'),await readFile('src/host/extension-layout.css'));
  await writeFile(path.join(directory,'sdk.js'),await readFile('public/lumi-extension-sdk.js'));
  // Mirrors the plugin's nested surface without using private user data.
  await writeFile(path.join(directory,'plugin.html'),`<!doctype html><link rel="stylesheet" href="ui.css" data-lumi-ui><style>body{font:14px sans-serif}.surface.panel{padding:20px}.probe{width:160px;height:24px;background:repeating-linear-gradient(to right,#000 0 4px,#fff 4px 8px);position:relative;z-index:1}</style><body data-lumi-ui><section class="surface panel"><h2>Codex 设置内容</h2><div id="inside" class="probe"></div><p>权限与本地桥接说明</p></section><script src="sdk.js"></script>`);
  await writeFile(path.join(directory,'index.html'),`<!doctype html><link rel="stylesheet" href="ui.css"><link rel="stylesheet" href="layout.css"><style>body{min-width:0}.modal{width:700px}.probe{width:160px;height:24px;background:repeating-linear-gradient(to right,#000 0 4px,#fff 4px 8px)}</style><body data-lumi-ui><div class="modal-overlay"><section class="modal surface plugin-details-modal"><header class="modal-heading"><div><h2>Codex 插件设置</h2><div id="heading" class="probe"></div></div></header><div class="plugin-details-page"><section class="plugin-details-section"><h3>插件介绍</h3><div id="intro" class="probe"></div></section><section class="plugin-details-section"><h3>插件自身设置</h3><div class="extension-view"><iframe sandbox="allow-scripts" src="plugin.html" style="width:100%;height:240px;border:0"></iframe></div></section><section class="plugin-details-section"><h3>声明权限</h3><div id="footer" class="probe"></div></section></div></section></div><script>const nonce='fixture';addEventListener('message',e=>{if(e.data?.type==='ready')e.source.postMessage({protocol:'lumi-extension/1',nonce,type:'init',context:{},view:{id:'settings',slot:'settingsTab'},uiTheme:window.uiTheme},'*')});</script>`);
  await writeFile(path.join(directory,'audit.cjs'),String.raw`
const {app,BrowserWindow,protocol}=require('electron'),fs=require('node:fs'),path=require('node:path');
for(const name of ['userData','sessionData','logs','crashDumps']){const dir=path.join(__dirname,name);fs.mkdirSync(dir,{recursive:true});app.setPath(name,dir);}app.disableHardwareAcceleration();app.commandLine.appendSwitch('force-device-scale-factor','1');
app.whenReady().then(async()=>{
const win=new BrowserWindow({show:process.platform==='darwin',width:900,height:900,webPreferences:{sandbox:true,contextIsolation:true,nodeIntegration:false,backgroundThrottling:false}});await win.loadFile(path.join(__dirname,'index.html'));
const run=code=>win.webContents.executeJavaScript(code),frame=()=>win.webContents.mainFrame.frames[0];
await new Promise(r=>setTimeout(r,200));
for(const mode of ['light','dark']){
await run('document.documentElement.dataset.theme='+JSON.stringify(mode));
// A material with a strong backdrop blur catches foreground stacking regressions.
const css='.modal-overlay{isolation:isolate;background:transparent}.modal-overlay::before{content:"";position:absolute;inset:0;z-index:-1;backdrop-filter:blur(16px)}.modal{backdrop-filter:blur(16px)}.surface.panel:not(.modal){position:relative;z-index:0;background:transparent}.surface.panel:not(.modal)::before{content:"";position:absolute;inset:0;z-index:-1;backdrop-filter:blur(16px)}';
await run('window.uiTheme={id:"fixture.glass",css:'+JSON.stringify(css)+',theme:'+JSON.stringify(mode)+'};var s=document.getElementById("skin");if(!s){s=document.createElement("style");s.id="skin";document.head.append(s)}s.textContent='+JSON.stringify('@scope (body[data-lumi-ui]){'+css+'}')+';document.querySelector("iframe").contentWindow.postMessage({protocol:"lumi-extension/1",nonce:"fixture",type:"ui-theme",uiTheme},"*")');
await new Promise(r=>setTimeout(r,1000));
if(!await frame().executeJavaScript('getComputedStyle(document.querySelector(".surface.panel"),"::before").backdropFilter==="none"'))throw Error('embedded blur still enabled');
const rects=await run('["heading","intro","footer"].map(id=>{const r=document.getElementById(id).getBoundingClientRect();return {x:r.x,y:r.y,width:r.width,height:r.height}})');
const inner=await frame().executeJavaScript('(()=>{const r=document.getElementById("inside").getBoundingClientRect();return {x:r.x,y:r.y,width:r.width,height:r.height}})()');
const box=await run('(()=>{const r=document.querySelector("iframe").getBoundingClientRect();return {x:r.x,y:r.y}})()');rects.push({...inner,x:inner.x+box.x,y:inner.y+box.y});
const capture=await win.webContents.capturePage(),bitmap=capture.toBitmap(),size=capture.getSize(),viewport=await run('({width:innerWidth,height:innerHeight})'),scale=size.width/viewport.width;
await run('var baseline=document.createElement("style");baseline.textContent="*,*::before,*::after{backdrop-filter:none!important;filter:none!important}";document.head.append(baseline)');
await new Promise(r=>setTimeout(r,100));const plain=await win.webContents.capturePage(),plainBitmap=plain.toBitmap();await run('baseline.remove()');
const contrast=(pixels,rect)=>{let min=255,max=0;const y=Math.floor((rect.y+rect.height/2)*scale);for(let x=Math.ceil(rect.x*scale);x<Math.floor((rect.x+rect.width)*scale);x++){const value=pixels[(y*size.width+x)*4];min=Math.min(min,value);max=Math.max(max,value)}return max-min};
for(const rect of rects){const reference=contrast(plainBitmap,rect),actual=contrast(bitmap,rect);if(reference<100 || actual<reference*.85){fs.writeFileSync(path.resolve(__dirname,'../codex-sync-glass.png'),capture.toPNG());throw Error('foreground contrast lost '+mode+' '+JSON.stringify({rect,reference,actual}))}}

}
console.log('SETTINGS_GLASS_OK sharp header intro iframe footer light dark');win.destroy();app.exit(0);
}).catch(error=>{console.error(error.stack);app.exit(1)});
`);
  const env={...process.env};delete env.ELECTRON_RUN_AS_NODE;
  const child=spawn(electron,[path.join(directory,'audit.cjs')],{env,windowsHide:true,stdio:['ignore','pipe','pipe']});let output='';child.stdout.on('data',data=>output+=data);child.stderr.on('data',data=>output+=data);
  const timer=setTimeout(()=>child.kill(),15000);const code=await new Promise(resolve=>child.on('close',resolve));clearTimeout(timer);assert.equal(code,0,output);assert.match(output,/SETTINGS_GLASS_OK/);
});
