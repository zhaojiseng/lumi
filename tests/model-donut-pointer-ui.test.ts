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
const resize=async(width,height)=>{
 win.setContentSize(width,height);
 await win.webContents.executeJavaScript('('+async function(width,height){
  await document.fonts.ready;const end=performance.now()+6000;
  while(innerWidth!==width || innerHeight!==height){if(performance.now()>end)throw new Error('Donut viewport did not settle: '+innerWidth+'x'+innerHeight+' expected '+width+'x'+height);await new Promise(resolve=>requestAnimationFrame(resolve));}
  await new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)));
 }.toString()+')('+width+','+height+')');
};
await resize(760,460);
const run=async(stage,value)=>win.webContents.executeJavaScript('('+async function(stage,value){
 const check=(value,label)=>{if(!value)throw new Error(label);},until=async(fn,diagnostic)=>{const deadline=performance.now()+6000;while(!fn()){if(performance.now()>deadline)throw new Error('Timeout '+fn+' '+fixture.errors+(diagnostic ? ' '+JSON.stringify(diagnostic()) : ''));await new Promise(resolve=>setTimeout(resolve,10));}};
 await document.fonts.ready;
 await until(()=>document.querySelector('.recharts-pie-sector'));
 if(stage==='place'){
  const box=document.querySelector('#model');box.style.left=(value==='edge' ? innerWidth-270 : value==='top-left' ? -55 : 120)+'px';box.style.top=(value==='edge' ? innerHeight-166 : value==='top-left' ? -70 : 80)+'px';
  await new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)));
  const rect=document.querySelector('.recharts-surface').getBoundingClientRect(),cx=rect.left+rect.width/2,cy=rect.top+rect.height/2;
  // The first model covers 240 degrees clockwise from the top. Its left horizontal point
  // belongs to the second model; use the lower-left interior for the near-origin scenario.
  const positions=value==='top-left' ? [{x:Math.round(cx-47),y:Math.round(cy+47)}] : [{x:Math.round(cx+66),y:Math.round(cy)},{x:Math.round(cx+60),y:Math.round(cy+25)}];
  for(const position of positions){const hit=document.elementFromPoint(position.x,position.y),sectorIndex=[...document.querySelectorAll('.recharts-pie-sector')].findIndex(sector=>sector.contains(hit));check(sectorIndex===0,'Fixture pointer must hit the long-model sector '+JSON.stringify({stage:value,position,sectorIndex,hit:hit?.tagName,viewport:[innerWidth,innerHeight],surface:rect.toJSON(),fonts:document.fonts.status}));}
  return positions;
 }
 if(stage==='hover'){
  const expected=(anchor,size,limit)=>Math.max(8,Math.min(anchor+12+size<=limit-8 ? anchor+12 : anchor-size-12,limit-size-8));
  const inspect=()=>{const tooltip=document.querySelector('.donut-tooltip'),hit=document.elementFromPoint(value.x,value.y),sectorIndex=[...document.querySelectorAll('.recharts-pie-sector')].findIndex(sector=>sector.contains(hit));if(!tooltip)return {anchor:value,viewport:[innerWidth,innerHeight],sectorIndex,tooltip:null};const rect=tooltip.getBoundingClientRect(),style=getComputedStyle(tooltip);return {anchor:value,viewport:[innerWidth,innerHeight],rect:rect.toJSON(),client:[tooltip.clientWidth,tooltip.clientHeight],scroll:[tooltip.scrollWidth,tooltip.scrollHeight],name:tooltip.querySelector('strong')?.textContent,text:tooltip.textContent,sectorIndex,hit:hit?.tagName,font:{family:style.fontFamily,size:style.fontSize,lineHeight:style.lineHeight,status:document.fonts.status},surface:document.querySelector('.recharts-surface').getBoundingClientRect().toJSON()};};
  await until(()=>{const tooltip=document.querySelector('.donut-tooltip');if(!tooltip || getComputedStyle(tooltip).visibility!=='visible' || tooltip.querySelector('strong')?.textContent!=='fixture-model-with-an-extremely-long-name-for-visible-pointer-tooltip-wrapping')return false;const rect=tooltip.getBoundingClientRect();return Math.abs(rect.left-expected(value.x,rect.width,innerWidth))<1.1 && Math.abs(rect.top-expected(value.y,rect.height,innerHeight))<1.1;},inspect);
  await new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)));
  const tooltip=document.querySelector('.donut-tooltip'),rect=tooltip.getBoundingClientRect(),title=tooltip.querySelector('strong'),hit=document.elementFromPoint(value.x,value.y);
  const sectorIndex=[...document.querySelectorAll('.recharts-pie-sector')].findIndex(sector=>sector.contains(hit));
  const diagnostic=JSON.stringify(inspect());
  check(sectorIndex===0,'pointer left the long-model sector '+diagnostic);
  check(title?.textContent==='fixture-model-with-an-extremely-long-name-for-visible-pointer-tooltip-wrapping','hovered wrong model '+diagnostic);
  check(rect.left>=7.9 && rect.top>=7.9 && rect.right<=innerWidth-7.9 && rect.bottom<=innerHeight-7.9,'tooltip exceeds viewport '+diagnostic);
  check(rect.width>200 && tooltip.scrollWidth<=tooltip.clientWidth+1 && tooltip.scrollHeight<=tooltip.clientHeight+1,'tooltip collapsed or clipped long model name '+diagnostic);
  const nameRange=document.createRange();nameRange.selectNodeContents(title);for(const line of nameRange.getClientRects())check(line.left>=rect.left+1 && line.right<=rect.right-1 && line.top>=rect.top+1 && line.bottom<=rect.bottom-1,'tooltip clips a rendered model-name line '+JSON.stringify({line:line.toJSON(),tooltip:inspect()}));
  check(tooltip.closest('.desktop-shell'),'tooltip escaped scoped overlay');check(tooltip.textContent.includes('$2.00'),'incorrect hovered slice value');check(getComputedStyle(tooltip).backgroundColor===(value.dark ? 'rgb(35, 25, 50)' : 'rgb(250, 245, 255)'),'tooltip ignored plugin palette');check(getComputedStyle(tooltip).pointerEvents==='none','tooltip intercepts the pointer');
  check(fixture.errors.length===0,'renderer errors '+fixture.errors);return {left:rect.left,top:rect.top,width:rect.width,height:rect.height,name:title.textContent,sectorIndex};
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
for(const size of [[760,460],[340,230]]){await resize(...size);const position=(await run('place','edge'))[0];move(position);console.log('DONUT_EDGE '+JSON.stringify(await run('hover',position)));await shot('edge-'+size.join('x'));}
const topLeft=(await run('place','top-left'))[0];move(topLeft);console.log('DONUT_TOP_LEFT '+JSON.stringify(await run('hover',topLeft)));await shot('top-left');
await resize(760,460);const dark=(await run('place','normal'))[0];await win.webContents.executeJavaScript('document.documentElement.dataset.theme="dark";document.querySelector(".desktop-shell").dataset.theme="dark"');move(dark);console.log('DONUT_DARK '+JSON.stringify(await run('hover',{...dark,dark:true})));await shot('dark');
move({x:2,y:2});await run('leave');await run('hidden');await run('keyboard');win.webContents.sendInputEvent({type:'keyDown',keyCode:'ArrowRight'});win.webContents.sendInputEvent({type:'keyUp',keyCode:'ArrowRight'});console.log('DONUT_KEYBOARD '+JSON.stringify(await run('keyboard-visible')));await shot('keyboard');win.webContents.sendInputEvent({type:'keyDown',keyCode:'Escape'});win.webContents.sendInputEvent({type:'keyUp',keyCode:'Escape'});await run('hidden');
win.destroy();app.exit(0);
}).catch(error=>{console.error(error.stack || error);app.exit(1)});`);
  const env={...process.env};delete env.ELECTRON_RUN_AS_NODE;const child=spawn(electron,[path.join(dir,'main.cjs')],{env,windowsHide:true,stdio:['ignore','pipe','pipe'],signal:t.signal});let stdout='',stderr='';child.stdout.on('data',chunk=>stdout+=chunk);child.stderr.on('data',chunk=>stderr+=chunk);
  const code=await new Promise<number|null>((resolve,reject)=>{child.on('error',reject);child.on('close',resolve);});await writeFile(path.resolve('.test-data/model-donut-pointer-ui.log'),stdout+stderr);assert.equal(code,0,stderr+stdout);assert.match(stdout,/DONUT_POINTER/);assert.match(stdout,/DONUT_KEYBOARD/);
});
