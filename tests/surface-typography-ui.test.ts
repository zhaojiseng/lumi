import test from 'node:test';
import assert from 'node:assert/strict';
import {build} from 'esbuild';
import {mkdir,mkdtemp,writeFile,rm} from 'node:fs/promises';
import {existsSync} from 'node:fs';
import {createRequire} from 'node:module';
import {spawn} from 'node:child_process';
import path from 'node:path';
import {nativeMenuBarState} from '../shared/menu-bar';

test('independent tray renderer updates global fonts without remounting controls or clipping actions',{timeout:25000},async t=>{
  const electron=createRequire(import.meta.url)('electron');if(!existsSync(electron))return t.skip('Electron unavailable');
  await mkdir('.test-data',{recursive:true});const root=await mkdtemp(path.resolve('.test-data/tray-font-'));
  t.after(()=>rm(root,{recursive:true,force:true,maxRetries:5,retryDelay:100}));
  const renderer=await build({entryPoints:['src/tray.tsx'],bundle:true,platform:'browser',format:'iife',write:false,outfile:'renderer.js',loader:{'.svg':'text'},define:{'process.env.NODE_ENV':'"production"'},logLevel:'silent'});
  for(const file of renderer.outputFiles)await writeFile(path.join(root,path.basename(file.path)),file.contents);
  const usage={...nativeMenuBarState({phase:'idle'},{days:1,tool:'all'}),phase:'ready',siteName:'隔离字体验证',accountLabel:'Fixture account',balance:'$123.45',cost:'$12.34',tokens:'123.4K',requests:'123',canRefresh:true,chart:Array.from({length:24},(_,i)=>({label:i+':00',value:i+1,cost:'$1.23',tokens:'123',requests:'1'})),models:[1,2,3].map(i=>({name:'long-model-provider-'+i,cost:'$1.23',share:.3})),message:'隔离验证',updatedLabel:'刚刚更新'};
  await writeFile(path.join(root,'index.html'),'<meta charset="utf-8"><link rel="stylesheet" href="renderer.css"><div id="root"></div><script>window.fixtureState='+JSON.stringify({usage,theme:'light',typography:{fontSize:13,fontFamily:'system'}})+';window.fixtureActions=[];const listeners=new Set();window.fixtureEmit=next=>{fixtureState=next;listeners.forEach(f=>f(next))};window.lumiTray={snapshot:async()=>fixtureState,onState:f=>{listeners.add(f);return()=>listeners.delete(f)},action:async e=>fixtureActions.push(e)};</script><script src="renderer.js"></script>');
  await writeFile(path.join(root,'main.cjs'),String.raw`
const {app,BrowserWindow}=require('electron'),fs=require('node:fs'),path=require('node:path');
for(const name of ['userData','sessionData','logs','crashDumps']){const dir=path.join(__dirname,name);fs.mkdirSync(dir,{recursive:true});app.setPath(name,dir);}app.disableHardwareAcceleration();
app.whenReady().then(async()=>{
const win=new BrowserWindow({show:false,frame:false,width:396,height:648,webPreferences:{sandbox:true,contextIsolation:true,nodeIntegration:false,backgroundThrottling:false}});await win.loadFile(path.join(__dirname,'index.html'));
const run=code=>win.webContents.executeJavaScript(code),until=async(fn,label)=>{for(let i=0;i<100;i++){if(await fn())return;await win.webContents.capturePage(undefined,{stayHidden:true,stayAwake:true});await new Promise(r=>setTimeout(r,20));}throw Error(label)};
await until(()=>run('!!document.querySelector(".tray-footer nav button")'),'Tray did not load');await run('window.originalButton=document.querySelector(".tray-footer nav button");originalButton.focus()');
for(const [size,family,theme] of [[24,'serif','light'],[24,'mono','dark'],[11,'sans','light'],[13,'system','dark']]){
await run('fixtureEmit({...fixtureState,theme:'+JSON.stringify(theme)+',typography:{fontSize:'+size+',fontFamily:'+JSON.stringify(family)+'}})');
await until(()=>run('Math.abs(parseFloat(getComputedStyle(document.querySelector(".tray-header strong")).fontSize)-15*'+size+'/13)<.02'),'Tray font did not update');
await until(()=>run('getComputedStyle(document.querySelector(".tray-card")).opacity==="1"'),'Tray entry did not finish');
await until(()=>run('getComputedStyle(document.querySelector(".tray-switch button[aria-checked=true]")).color===getComputedStyle(document.querySelector(".tray-card")).color'),'Tray theme transition did not finish');
await until(()=>run('fixtureActions.some(e=>e.type==="layout")'),'No layout measurement');
const layout=await run('(()=>{const footer=document.querySelector(".tray-footer"),card=document.querySelector(".tray-card").getBoundingClientRect();return {overflow:document.documentElement.scrollWidth>innerWidth,buttons:[...footer.querySelectorAll("nav button")].map(b=>{const r=b.getBoundingClientRect();return r.left>=card.left && r.right<=card.right && r.top>=card.top && r.bottom<=card.bottom}),retained:document.querySelector(".tray-footer nav button")===originalButton && document.activeElement===originalButton,scroll:document.querySelector(".tray-sections").scrollHeight>document.querySelector(".tray-sections").clientHeight,family:getComputedStyle(document.body).fontFamily}})()');
if(layout.overflow || !layout.buttons.every(Boolean) || !layout.retained || size===24 && !layout.scroll)throw Error('Tray large font layout '+JSON.stringify(layout));
if(size===24)fs.writeFileSync(path.join(__dirname,'..','global-font-tray-'+theme+'.png'),(await win.webContents.capturePage(undefined,{stayHidden:true,stayAwake:true})).toPNG());
}
await run('originalButton.click()');if(!await run('fixtureActions.some(e=>e.type==="refresh")'))throw Error('Footer action unavailable');
console.log('SURFACE_TYPOGRAPHY_OK');win.destroy();app.exit(0);
}).catch(e=>{console.error(e.stack);app.exit(1)});`);
  const env={...process.env};delete env.ELECTRON_RUN_AS_NODE;
  const child=spawn(electron,[path.join(root,'main.cjs')],{env,windowsHide:true,stdio:['ignore','pipe','pipe'],signal:t.signal});let output='';child.stdout.on('data',data=>output+=data);child.stderr.on('data',data=>output+=data);
  const code=await new Promise<number|null>((resolve,reject)=>{child.on('error',reject);child.on('close',resolve)});assert.equal(code,0,output);assert.match(output,/SURFACE_TYPOGRAPHY_OK/);
});
