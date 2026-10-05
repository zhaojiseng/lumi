import test from 'node:test';
import assert from 'node:assert/strict';
import {build} from 'esbuild';
import {mkdir,mkdtemp,readFile,writeFile,rm} from 'node:fs/promises';
import {existsSync} from 'node:fs';
import {createRequire} from 'node:module';
import path from 'node:path';
import {spawn} from 'node:child_process';

test('model distribution tooltip follows real mouse coordinates, fits viewport and retains scoped colors/keyboard control',{timeout:45000},async t=>{
  const electron=createRequire(import.meta.url)('electron') as string;if(!existsSync(electron))return t.skip('Electron unavailable');
  await mkdir('.test-data',{recursive:true});const dir=await mkdtemp(path.resolve('.test-data/model-donut-pointer-'));t.after(()=>rm(dir,{recursive:true,force:true,maxRetries:5,retryDelay:100}));
  const bundle=await build({stdin:{resolveDir:process.cwd(),loader:'tsx',contents:`
import React from 'react';import {createRoot} from 'react-dom/client';import {ModelDonut} from './src/components/charts';import {scopedInterfaceSheet} from './src/host/interface';
window.fixture={errors:[]};addEventListener('error',event=>fixture.errors.push(event.message));addEventListener('unhandledrejection',event=>fixture.errors.push(String(event.reason)));
document.adoptedStyleSheets=[scopedInterfaceSheet({id:'extension.fixture.palette',css:':scope{--panel:light-dark(rgb(250,245,255),rgb(35,25,50));--text:light-dark(rgb(50,30,70),rgb(240,230,250));--accent:light-dark(rgb(60,100,210),rgb(140,170,250))}'})];
createRoot(document.getElementById('root')).render(<main className="desktop-shell" data-interface="extension.fixture.palette" data-theme="light" style={{display:'block'}}><div id="model" style={{position:'fixed',left:120,top:80,width:270}}><ModelDonut data={[{name:'fixture-model-with-an-extremely-long-name-for-visible-pointer-tooltip-wrapping',value:2},{name:'Second model',value:1}]} total="$3.00" symbol="$"/></div></main>);`},bundle:true,platform:'browser',format:'esm',target:'chrome140',write:false,loader:{'.css':'empty','.svg':'text'},define:{'process.env.NODE_ENV':'"production"'},logLevel:'silent'});
  await writeFile(path.join(dir,'app.js'),bundle.outputFiles[0].contents);await writeFile(path.join(dir,'style.css'),(await Promise.all(['styles.css','workbench.css','theme-tokens.css','theme.css','updates-trends.css'].map(file=>readFile(path.join('src',file),'utf8')))).join('\n'));
  await writeFile(path.join(dir,'index.html'),'<html><head><meta charset="utf-8"><link rel="stylesheet" href="style.css"></head><body><div id="root"></div><script type="module" src="app.js"></script></body></html>');
  await writeFile(path.join(dir,'main.cjs'),String.raw`
const {app,BrowserWindow}=require('electron'),fs=require('node:fs'),path=require('node:path');
for(const name of ['userData','sessionData','logs','crashDumps']){const directory=path.join(__dirname,name);fs.mkdirSync(directory,{recursive:true});app.setPath(name,directory);}app.disableHardwareAcceleration();
app.whenReady().then(async()=>{
const win=new BrowserWindow({width:760,height:460,useContentSize:true,show:false,webPreferences:{sandbox:true,contextIsolation:true,nodeIntegration:false,backgroundThrottling:false}});await win.loadFile(path.join(__dirname,'index.html'));
const run=async(stage,value)=>win.webContents.executeJavaScript('('+async function(stage,value){
 const check=(value,label)=>{if(!value)throw new Error(label);},until=async fn=>{const deadline=performance.now()+6000;while(!fn()){if(performance.now()>deadline)throw new Error('Timeout '+fn+' '+fixture.errors);await new Promise(resolve=>setTimeout(resolve,10));}};
 await until(()=>document.querySelector('.recharts-pie-sector'));
 if(stage==='place'){
  const box=document.querySelector('#model');box.style.left=(value==='edge' ? innerWidth-270 : value==='top-left' ? -55 : 120)+'px';box.style.top=(value==='edge' ? innerHeight-166 : value==='top-left' ? -70 : 80)+'px';
  await new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)));
  const rect=document.querySelector('.recharts-surface').getBoundingClientRect(),cx=rect.left+rect.width/2,cy=rect.top+rect.height/2;
  return value==='top-left' ? [{x:Math.round(cx-66),y:Math.round(cy)}] : [{x:Math.round(cx+66),y:Math.round(cy)},{x:Math.round(cx+60),y:Math.round(cy+25)}];
 }
 if(stage==='hover'){
  const expected=(anchor,size,limit)=>Math.max(8,Math.min(anchor+12+size<=limit-8 ? anchor+12 : anchor-size-12,limit-size-8));
  await until(()=>{const tooltip=document.querySelector('.donut-tooltip');if(!tooltip || getComputedStyle(tooltip).visibility!=='visible')return false;const rect=tooltip.getBoundingClientRect();return Math.abs(rect.left-expected(value.x,rect.width,innerWidth))<1.1 && Math.abs(rect.top-expected(value.y,rect.height,innerHeight))<1.1;});
  await new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)));
  const tooltip=document.querySelector('.donut-tooltip'),rect=tooltip.getBoundingClientRect();check(rect.left>=7.9 && rect.top>=7.9 && rect.right<=innerWidth-7.9 && rect.bottom<=innerHeight-7.9,'tooltip exceeds viewport '+JSON.stringify(rect));check(rect.width>200 && tooltip.scrollHeight<=tooltip.clientHeight+1,'tooltip collapsed or clipped long model name');
  check(tooltip.closest('.desktop-shell'),'tooltip escaped scoped overlay');check(tooltip.textContent.includes('$2.00'),'incorrect hovered slice value');check(getComputedStyle(tooltip).backgroundColor===(value.dark ? 'rgb(35, 25, 50)' : 'rgb(250, 245, 255)'),'tooltip ignored plugin palette');check(getComputedStyle(tooltip).pointerEvents==='none','tooltip intercepts the pointer');
  check(fixture.errors.length===0,'renderer errors '+fixture.errors);return {left:rect.left,top:rect.top,width:rect.width,height:rect.height};
 }
 if(stage==='leave'){
  // Hidden Electron surfaces do not consistently synthesize pointerout when a mouseMove crosses nodes.
  // Dispatch the browser event explicitly after the real within-sector movement checks above.
  document.querySelector('.donut-chart').dispatchEvent(new PointerEvent('pointerout',{bubbles:true,relatedTarget:document.body}));
 }else if(stage==='keyboard'){
  const surface=document.querySelector('.recharts-surface');surface.focus();check(document.activeElement===surface,'chart cannot receive keyboard focus');
 }else if(stage==='keyboard-visible'){
  await until(()=>document.querySelector('.donut-tooltip') && getComputedStyle(document.querySelector('.donut-tooltip')).visibility==='visible');const tooltip=document.querySelector('.donut-tooltip'),rect=tooltip.getBoundingClientRect();check(rect.left>=8 && rect.right<=innerWidth-8 && rect.top>=8 && rect.bottom<=innerHeight-8,'keyboard tooltip exceeds viewport');return {text:tooltip.textContent};
 }else if(stage==='hidden'){
  await until(()=>!document.querySelector('.donut-tooltip') || getComputedStyle(document.querySelector('.donut-tooltip')).visibility==='hidden');
 }
}.toString()+')('+JSON.stringify(stage)+','+JSON.stringify(value)+')');
const move=position=>win.webContents.sendInputEvent({type:'mouseMove',...position}),shot=async name=>fs.writeFileSync(path.resolve('.test-data/model-donut-'+name+'.png'),(await win.webContents.capturePage(undefined,{stayHidden:true,stayAwake:true})).toPNG());
const positions=await run('place','normal');move(positions[0]);const first=await run('hover',positions[0]);move(positions[1]);const second=await run('hover',positions[1]);if(Math.abs(second.top-first.top)<20)throw new Error('Tooltip stayed anchored to sector center instead of following mouse');console.log('DONUT_POINTER '+JSON.stringify({first,second}));await shot('pointer');
for(const size of [[760,460],[340,230]]){win.setContentSize(...size);const position=(await run('place','edge'))[0];move(position);console.log('DONUT_EDGE '+JSON.stringify(await run('hover',position)));await shot('edge-'+size.join('x'));}
const topLeft=(await run('place','top-left'))[0];move(topLeft);console.log('DONUT_TOP_LEFT '+JSON.stringify(await run('hover',topLeft)));await shot('top-left');
win.setContentSize(760,460);const dark=(await run('place','normal'))[0];await win.webContents.executeJavaScript('document.documentElement.dataset.theme="dark";document.querySelector(".desktop-shell").dataset.theme="dark"');move(dark);console.log('DONUT_DARK '+JSON.stringify(await run('hover',{...dark,dark:true})));await shot('dark');
move({x:2,y:2});await run('leave');await run('hidden');await run('keyboard');win.webContents.sendInputEvent({type:'keyDown',keyCode:'ArrowRight'});win.webContents.sendInputEvent({type:'keyUp',keyCode:'ArrowRight'});console.log('DONUT_KEYBOARD '+JSON.stringify(await run('keyboard-visible')));await shot('keyboard');win.webContents.sendInputEvent({type:'keyDown',keyCode:'Escape'});win.webContents.sendInputEvent({type:'keyUp',keyCode:'Escape'});await run('hidden');
win.destroy();app.exit(0);
}).catch(error=>{console.error(error.stack || error);app.exit(1)});`);
  const env={...process.env};delete env.ELECTRON_RUN_AS_NODE;const child=spawn(electron,[path.join(dir,'main.cjs')],{env,windowsHide:true,stdio:['ignore','pipe','pipe'],signal:t.signal});let stdout='',stderr='';child.stdout.on('data',chunk=>stdout+=chunk);child.stderr.on('data',chunk=>stderr+=chunk);
  const code=await new Promise<number|null>((resolve,reject)=>{child.on('error',reject);child.on('close',resolve);});await writeFile(path.resolve('.test-data/model-donut-pointer-ui.log'),stdout+stderr);assert.equal(code,0,stderr+stdout);assert.match(stdout,/DONUT_POINTER/);assert.match(stdout,/DONUT_KEYBOARD/);
});
