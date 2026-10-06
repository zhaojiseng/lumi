import test from 'node:test';
import assert from 'node:assert/strict';
import {build} from 'esbuild';
import {mkdir,mkdtemp,readFile,writeFile,rm} from 'node:fs/promises';
import {createRequire} from 'node:module';
import {existsSync} from 'node:fs';
import path from 'node:path';
import {spawn} from 'node:child_process';

test('background tree uploads a local image, changes priorities and paints all fits at resized viewports',{timeout:30000},async t=>{
  const electron:string=createRequire(import.meta.url)('electron');if(!existsSync(electron))return t.skip('Electron unavailable');
  await mkdir('.test-data',{recursive:true});const root=await mkdtemp(path.resolve('.test-data/background-ui-'));t.after(()=>rm(root,{recursive:true,force:true,maxRetries:5,retryDelay:100}));
  const built=await build({stdin:{resolveDir:process.cwd(),loader:'tsx',contents:`
import React,{useState} from 'react';import {createRoot} from 'react-dom/client';
import {AppContext} from './src/context';import {PluginSettingsProvider} from './src/host/plugins';
import {InterfaceStyleSettings} from './src/host/interface-style-settings';import {UserBackgroundLayer} from './src/host/background';
import {DEFAULT_PREFERENCES} from './shared/types';import {backgroundInterfaceManifest} from './plugins/interface.background/manifest';import {applyPreferencePatch} from './shared/selections';
window.fixture={errors:[],writes:[],fail:false};addEventListener('error',event=>fixture.errors.push(event.message));
function Fixture(){const [preferences,setPreferences]=useState(structuredClone(DEFAULT_PREFERENCES)),[enabled,setEnabled]=useState(false);
fixture.preferences=preferences;const updatePreferences=async patch=>{if(fixture.fail)throw new Error('fixture write failed');fixture.writes.push(patch);setPreferences(previous=>applyPreferencePatch(previous,patch));};
return <AppContext.Provider value={{preferences,updatePreferences,toast:message=>fixture.errors.push(message)}}><PluginSettingsProvider value={{items:[],statuses:[{manifest:backgroundInterfaceManifest,state:enabled ? 'active' : 'disabled'}],extensions:{plugins:[],diagnostics:[],directory:'fixture'},loading:false,busyId:null,error:'',setEnabled:async(_id,value)=>setEnabled(value),setView:async()=>{},refreshInterface:async()=>{}}}><div className="desktop-shell"><UserBackgroundLayer/></div><InterfaceStyleSettings/></PluginSettingsProvider></AppContext.Provider>;}
createRoot(document.getElementById('root')).render(<Fixture/>);`},bundle:true,platform:'browser',format:'esm',write:false,loader:{'.css':'empty','.svg':'text'},define:{'process.env.NODE_ENV':'"production"'},logLevel:'silent'});
  await writeFile(path.join(root,'app.js'),built.outputFiles[0].contents);
  await writeFile(path.join(root,'style.css'),await readFile('src/host/background.css','utf8')+'\nbody{margin:0}.desktop-shell{position:relative;width:400px;height:300px;background:rgb(20,20,20)}');
  await writeFile(path.join(root,'index.html'),'<html><head><meta charset="UTF-8"><link rel="stylesheet" href="style.css"></head><body><div id="root"></div><script type="module" src="app.js"></script></body></html>');
  await writeFile(path.join(root,'main.cjs'),String.raw`
const {app,BrowserWindow}=require('electron'),fs=require('node:fs'),path=require('node:path');
for(const name of ['userData','sessionData','logs','crashDumps']){const dir=path.join(__dirname,name);fs.mkdirSync(dir,{recursive:true});app.setPath(name,dir);}app.disableHardwareAcceleration();
app.whenReady().then(async()=>{const win=new BrowserWindow({width:900,height:850,show:process.platform==='darwin',frame:process.platform!=='darwin',webPreferences:{sandbox:true,contextIsolation:true,nodeIntegration:false,backgroundThrottling:false}});await win.loadFile(path.join(__dirname,'index.html'));win.webContents.debugger.attach('1.3');await win.webContents.debugger.sendCommand('Emulation.setEmulatedMedia',{features:[{name:'prefers-reduced-motion',value:'no-preference'}]});
const run=fn=>win.webContents.executeJavaScript('('+fn.toString()+')()'),check=(ok,label)=>{if(!ok)throw new Error(label);};
await run(async()=>{const until=async fn=>{const end=performance.now()+3000;while(!fn()){if(performance.now()>end)throw new Error('Background UI timeout '+fn+'; '+JSON.stringify(fixture.writes)+'; errors='+fixture.errors);await new Promise(resolve=>setTimeout(resolve,10));}};
await until(()=>document.querySelector('[data-interface-style="interface.background"]'));const row=document.querySelector('[data-interface-style="interface.background"]');row.querySelector('.plugin-settings-button').click();await until(()=>document.querySelector('[data-interface-details="interface.background"]'));const details=document.querySelector('[data-interface-details="interface.background"]');
const canvas=document.createElement('canvas');canvas.width=200;canvas.height=100;const context=canvas.getContext('2d');context.fillStyle='rgb(230,30,40)';context.fillRect(0,0,100,100);context.fillStyle='rgb(30,210,60)';context.fillRect(100,0,100,100);
const blob=await new Promise(resolve=>canvas.toBlob(resolve,'image/png')),file=new File([blob],'fixture.png',{type:'image/png'}),transfer=new DataTransfer();transfer.items.add(file);const input=details.querySelector('input[type=file]');input.files=transfer.files;input.dispatchEvent(new Event('change',{bubbles:true}));
await until(()=>fixture.preferences.background.image.startsWith('data:image/webp;base64,'));details.querySelector('[role=switch]').click();await until(()=>document.querySelector('.user-background-layer img')?.complete);fixture.until=until;
fixture.fit=async value=>{const select=details.querySelector('select');select.value=value;select.dispatchEvent(new Event('change',{bubbles:true}));await until(()=>fixture.preferences.background.fit===value);await new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)));};
fixture.details=details;fixture.row=row;fixture.until=until;
const dialog=details.closest('[role=dialog]');fixture.dialog=dialog;const close=()=>dialog.querySelector('button').click();close();await until(()=>dialog.closest('[hidden],[inert]'));
row.querySelector('.plugin-row-button').click();await until(()=>!dialog.closest('[hidden],[inert]'));if(document.querySelector('[data-interface-details="interface.background"]')!==details)throw new Error('Details remounted on row click');close();await until(()=>dialog.closest('[hidden],[inert]'));
if(document.querySelector('.interface-style-settings input[type=number]'))throw new Error('Numeric priority remains');
window.scrollTo(0,0);
});
const positions=()=>run(async()=>{await fixture.until(()=>!document.querySelector('.interface-sort-tree').getAnimations({subtree:true}).length);const rect=id=>{const node=document.querySelector('[data-interface-style="'+id+'"]'),handle=node.querySelector('.interface-sort-handle').getBoundingClientRect(),box=node.getBoundingClientRect();return {x:Math.round(handle.left+handle.width/2),y:Math.round(handle.top+handle.height/2),top:Math.round(box.top)};};return {background:rect('interface.background'),default:rect('interface.default')};});
let checkedAnimation=false;
async function drag(id,target){const p=await positions(),from=p[id],to=p[target];win.webContents.focus();win.webContents.sendInputEvent({type:'mouseMove',x:from.x,y:from.y});win.webContents.sendInputEvent({type:'mouseDown',button:'left',clickCount:1,x:from.x,y:from.y});win.webContents.sendInputEvent({type:'mouseMove',modifiers:['leftButtonDown'],x:from.x,y:to.top+2});await run(()=>fixture.until(()=>document.querySelector('.sorting')));
if(!checkedAnimation){
  await run(async()=>{const animations=document.querySelector('.interface-sort-tree').getAnimations({subtree:true}).filter(animation=>animation.effect.getKeyframes().some(frame=>frame.transform));if(animations.length!==2)throw new Error('Reorder did not animate both rows');fixture.movements=animations;for(const animation of animations){animation.pause();animation.currentTime=45;}await new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)));});
  const early=(await win.webContents.capturePage()).toBitmap();
  await run(async()=>{for(const animation of fixture.movements)animation.currentTime=165;await new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)));});
  const later=(await win.webContents.capturePage()).toBitmap();let difference=0;for(let i=0;i<early.length;i++)if(early[i]!==later[i])difference++;check(difference>100,'Reorder painted no intermediate movement');
  await run(()=>{for(const animation of fixture.movements)animation.finish();});checkedAnimation=true;
}else if(await run(()=>matchMedia('(prefers-reduced-motion: reduce)').matches))check(await run(()=>!document.querySelector('.interface-sort-tree').getAnimations({subtree:true}).length),'Reduced motion still animates');
win.webContents.sendInputEvent({type:'mouseUp',button:'left',clickCount:1,x:from.x,y:to.top+2});}
await drag('default','background');await run(()=>fixture.until(()=>fixture.preferences.interfacePriorities['interface.default']>fixture.preferences.interfacePriorities['interface.background'] && document.querySelector('.user-background-layer')));
await win.webContents.debugger.sendCommand('Emulation.setEmulatedMedia',{features:[{name:'prefers-reduced-motion',value:'reduce'}]});await drag('background','default');await run(async()=>{await fixture.until(()=>fixture.preferences.interfacePriorities['interface.background']>fixture.preferences.interfacePriorities['interface.default'] && document.querySelector('.user-background-layer img')?.complete);if(fixture.writes.filter(p=>p.interfaceOrder).length!==2)throw new Error('Drag did not persist exactly once per release');});
// Cancel a native drag before releasing; it must not write or change the winner.
{const p=await positions();win.webContents.sendInputEvent({type:'mouseDown',button:'left',clickCount:1,x:p.default.x,y:p.default.y});win.webContents.sendInputEvent({type:'mouseMove',modifiers:['leftButtonDown'],x:p.default.x,y:p.background.top+2});win.webContents.sendInputEvent({type:'keyDown',keyCode:'Escape'});win.webContents.sendInputEvent({type:'keyUp',keyCode:'Escape'});win.webContents.sendInputEvent({type:'mouseUp',button:'left',clickCount:1,x:p.default.x,y:p.background.top+2});}
await run(async()=>{await new Promise(resolve=>setTimeout(resolve,50));if(fixture.writes.filter(p=>p.interfaceOrder).length!==2 || !document.querySelector('.user-background-layer'))throw new Error('Cancelled drag persisted');});
await run(()=>{fixture.fail=true;document.querySelector('[data-interface-style="interface.default"] .interface-sort-handle').dispatchEvent(new KeyboardEvent('keydown',{key:'Home',bubbles:true}));});
await run(async()=>{await fixture.until(()=>fixture.errors.includes('fixture write failed') && document.querySelector('.interface-sort-tree').getAttribute('aria-busy')==='false');if(document.querySelector('.interface-sort-tree').firstElementChild.dataset.interfaceStyle!=='interface.background')throw new Error('Failed order did not restore');fixture.fail=false;fixture.errors=[];
const handle=document.querySelector('[data-interface-style="interface.default"] .interface-sort-handle');handle.focus();handle.dispatchEvent(new KeyboardEvent('keydown',{key:'Home',bubbles:true}));await fixture.until(()=>fixture.preferences.interfacePriorities['interface.default']>fixture.preferences.interfacePriorities['interface.background'] && document.querySelector('.user-background-layer') && document.activeElement===handle);handle.dispatchEvent(new KeyboardEvent('keydown',{key:'End',bubbles:true}));await fixture.until(()=>document.querySelector('.user-background-layer img')?.complete && document.activeElement===handle);window.scrollTo(0,0);});
const pixel=async(x,y)=>{const img=await win.webContents.capturePage({x,y,width:1,height:1});const b=img.toBitmap();return [b[2],b[1],b[0]];},red=p=>p[0]>180 && p[1]<70,green=p=>p[1]>160 && p[0]<70,empty=p=>p.every(c=>Math.abs(c-20)<3);
for(const mode of ['light','dark']){await win.webContents.executeJavaScript('document.documentElement.dataset.theme='+JSON.stringify(mode));
await run(()=>fixture.fit('stretch'));check(red(await pixel(30,30)) && green(await pixel(370,270)),'Stretch did not fill');
await run(()=>fixture.fit('contain'));check(empty(await pixel(30,30)) && red(await pixel(30,100)) && green(await pixel(370,200)),'Contain did not preserve whole image');
await run(()=>fixture.fit('cover'));check(red(await pixel(30,30)) && green(await pixel(370,270)),'Cover did not crop to fill');
await run(()=>fixture.fit('natural'));check(empty(await pixel(30,150)) && red(await pixel(120,150)) && green(await pixel(280,150)),'Natural dimensions changed');}
await run(async()=>{document.querySelector('.desktop-shell').style.width='300px';document.querySelector('.desktop-shell').style.height='400px';await fixture.fit('contain');});
check(empty(await pixel(20,20)) && red(await pixel(20,160)) && green(await pixel(280,240)),'Resized background geometry failed');
await run(async()=>{document.querySelector('[data-interface-style="interface.background"] [role=switch]').click();await fixture.until(()=>!document.querySelector('.user-background-layer'));if(fixture.errors.length)throw new Error(fixture.errors.join(','));});
console.log('BACKGROUND_UI_OK');win.destroy();app.exit(0);}).catch(error=>{console.error(error.stack || error);app.exit(1);});`);
  const env={...process.env};delete env.ELECTRON_RUN_AS_NODE;const child=spawn(electron,[path.join(root,'main.cjs')],{env,windowsHide:true,stdio:['ignore','pipe','pipe'],signal:t.signal});let output='';child.stdout.on('data',chunk=>output+=chunk);child.stderr.on('data',chunk=>output+=chunk);const code=await new Promise<number|null>((resolve,reject)=>{child.on('error',reject);child.on('close',resolve);});assert.equal(code,0,output);assert.match(output,/BACKGROUND_UI_OK/);
});
