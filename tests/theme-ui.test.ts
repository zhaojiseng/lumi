import test from 'node:test';
import assert from 'node:assert/strict';
import {build} from 'esbuild';
import {mkdir,mkdtemp,readFile,writeFile,rm} from 'node:fs/promises';
import {existsSync} from 'node:fs';
import {createRequire} from 'node:module';
import path from 'node:path';
import {spawn} from 'node:child_process';

test('Chromium resolves plugin colors in charts, picker overlays, widget and tray without remounting',{timeout:45000},async t=>{
  let electron:string;try{electron=createRequire(import.meta.url)('electron');}catch{return t.skip('Electron unavailable');}if(!existsSync(electron))return t.skip('Electron unavailable');
  await mkdir('.test-data',{recursive:true});const dir=await mkdtemp(path.resolve('.test-data/theme-ui-'));t.after(()=>rm(dir,{recursive:true,force:true,maxRetries:5,retryDelay:100}));
  const bundle=await build({stdin:{resolveDir:process.cwd(),loader:'tsx',contents:`
import React from 'react';import {createRoot} from 'react-dom/client';
import {SURFACE_COLOR_KEYS} from './shared/surface-theme';import {formattedWidget} from './shared/widget';import {nativeMenuBarState} from './shared/menu-bar';
window.fixture={errors:[],listeners:new Set()};addEventListener('error',event=>fixture.errors.push(event.message));addEventListener('unhandledrejection',event=>fixture.errors.push(String(event.reason)));
const kind=location.hash.slice(1),colors=()=>Object.fromEntries(SURFACE_COLOR_KEYS.map(key=>[key,key.startsWith('text') ? [240,230,250,1] : key.startsWith('accent') ? [60,100,210,1] : [35,25,50,1]]));
fixture.emit=palette=>fixture.listeners.forEach(fn=>fn({...fixture.initial,theme:palette ? 'dark' : 'light',palette}));fixture.colors=colors;
if(kind==='widget'){
  fixture.initial=formattedWidget('ready',undefined,{enabled:true,viewKey:'fixture',theme:'light',animation:'none'});
  window.lumiWidget={snapshot:async()=>fixture.initial,onState:fn=>{fixture.listeners.add(fn);return()=>fixture.listeners.delete(fn);},action:async()=>{}};await import('./src/widget');
}else if(kind==='tray'){
  fixture.initial={usage:{...nativeMenuBarState({phase:'ready'},{days:1,tool:'all'}),viewKey:'fixture',chart:[{label:'fixture',value:2,cost:'2',tokens:'10',requests:'1'}]},theme:'light',motion:{id:1,phase:'visible'}};
  window.lumiTray={snapshot:async()=>fixture.initial,onState:fn=>{fixture.listeners.add(fn);return()=>fixture.listeners.delete(fn);},action:async()=>{}};await import('./src/tray');
}else{
  const {TrendChart,ModelDonut}=await import('./src/components/charts'),{Select}=await import('./src/components/select'),{DateTimePicker}=await import('./src/components/DateTimePicker'),{scopedInterfaceSheet}=await import('./src/host/interface'),{TREND_COLORS}=await import('./shared/trends');
  const rows=[{label:'A',cost:1,tokens:5,requests:1,values:{one:1,two:2}},{label:'B',cost:2,tokens:10,requests:2,values:{one:2,two:3}}];
  document.adoptedStyleSheets=[scopedInterfaceSheet({id:'extension.test.theme',css:':scope{--accent:light-dark(rgb(60,100,210),rgb(140,170,250));--panel:light-dark(rgb(250,245,255),rgb(35,25,50));--purple:rgb(140,80,190);--text:light-dark(rgb(50,30,70),rgb(240,230,250));--tooltip-bg:var(--panel);color:var(--text)}'})];
  createRoot(document.getElementById('root')).render(<main className="desktop-shell" data-interface="extension.test.theme" data-theme="light" style={{display:'block',padding:20}}>
    <div id="total"><TrendChart data={rows}/></div><div id="grouped"><TrendChart data={rows} series={[{id:'one',name:'One',color:TREND_COLORS[0]},{id:'two',name:'Two',color:TREND_COLORS[1]}]}/></div>
    <div id="donut"><ModelDonut data={[{name:'One',value:1},{name:'Two',value:2}]} total="3" symbol="$"/></div>
    <div style={{display:'flex',gap:8}}>{['sage','blue','lavender','peach','red','neutral'].map(tone=><Select key={tone} label={tone} tone={tone} value="fixture" onChange={()=>{}}><option data-tone={tone} value="fixture">Fixture</option></Select>)}</div>
    <DateTimePicker label="Fixture date" value="" onChange={()=>{}}/>
  </main>);
}`},bundle:true,platform:'browser',format:'esm',write:false,loader:{'.css':'empty','.svg':'text'},define:{'process.env.NODE_ENV':'"production"'},logLevel:'silent'});
  await writeFile(path.join(dir,'app.js'),bundle.outputFiles[0].contents);
  for(const [kind,files] of Object.entries({charts:['styles.css','workbench.css','select.css','theme-tokens.css','theme.css','updates-trends.css'],widget:['theme-tokens.css','widget.css'],tray:['theme-tokens.css','tray.css']})){
    await writeFile(path.join(dir,kind+'.css'),(await Promise.all(files.map(file=>readFile(path.join('src',file),'utf8')))).join('\n'));
    await writeFile(path.join(dir,kind+'.html'),`<html><head><meta charset="utf-8"><link rel="stylesheet" href="${kind}.css"></head><body><div id="root"></div><script type="module" src="app.js"></script></body></html>`);
  }
  await writeFile(path.join(dir,'main.cjs'),String.raw`
const {app,BrowserWindow}=require('electron'),fs=require('node:fs'),path=require('node:path');
for(const name of ['userData','sessionData','logs','crashDumps']){const directory=path.join(__dirname,name);fs.mkdirSync(directory,{recursive:true});app.setPath(name,directory);}app.disableHardwareAcceleration();app.on('window-all-closed',()=>{});
app.whenReady().then(async()=>{
for(const kind of ['charts','widget','tray']){
 const win=new BrowserWindow({width:kind==='widget' ? 244 : kind==='tray' ? 396 : 850,height:kind==='widget' ? 64 : 720,show:false,webPreferences:{sandbox:true,contextIsolation:true,nodeIntegration:false,offscreen:true,backgroundThrottling:false}});await win.loadFile(path.join(__dirname,kind+'.html'),{hash:kind});
 await win.webContents.executeJavaScript('('+async function(kind){
 const check=(value,label)=>{if(!value)throw new Error(kind+': '+label);},until=async fn=>{const deadline=performance.now()+6000;while(!fn()){if(performance.now()>deadline)throw new Error(kind+': timeout');await new Promise(r=>setTimeout(r,10));}};
 if(kind==='charts'){
   await until(()=>document.querySelector('#total .recharts-area-curve') && document.querySelectorAll('#grouped .recharts-line-curve').length===2 && document.querySelector('.recharts-pie-sector'));
   const shell=document.querySelector('.desktop-shell'),curve=document.querySelector('#total .recharts-area-curve');
   const validate=color=>{
     check(getComputedStyle(curve).stroke===color,'total curve ignored accent');
     const grouped=document.querySelectorAll('#grouped .recharts-line-curve');check(getComputedStyle(grouped[0]).stroke===color && getComputedStyle(grouped[1]).stroke==='rgb(140, 80, 190)','grouped lines lost theme or distinction');
     check(getComputedStyle(document.querySelector('.recharts-pie-sector path')).fill===color,'donut ignored accent');
     check(getComputedStyle(document.querySelector('.legend-dot')).backgroundColor===color,'legend ignored accent');
     for(const [tone,key] of Object.entries({sage:'accent',blue:'blue',lavender:'purple',peach:'orange',red:'red',neutral:'text-secondary'})){
       const control=document.querySelector('select[aria-label="'+tone+'"]'),probe=document.createElement('i');probe.style.color='var(--'+key+')';shell.append(probe);
       check(getComputedStyle(control.closest('.select-wrap'),'::before').backgroundColor===getComputedStyle(probe).color && getComputedStyle(control.closest('.select-wrap').querySelector('svg')).color===getComputedStyle(probe).color,'select tone '+tone+' ignored semantic color');check(getComputedStyle(control).color===getComputedStyle(shell).color,'select lost text color');probe.remove();
     }
   };
   validate('rgb(60, 100, 210)');
   const select=document.querySelector('select[aria-label="sage"]');select.showPicker();await until(()=>select.matches(':open'));
   check(getComputedStyle(select,'::picker(select)').backgroundColor==='rgb(250, 245, 255)','opened picker ignored plugin panel');
   check(getComputedStyle(select.querySelector('option'),'::before').backgroundColor==='rgb(60, 100, 210)','opened option dot ignored plugin accent');
   document.documentElement.dataset.theme='dark';shell.dataset.theme='dark';validate('rgb(140, 170, 250)');
   check(getComputedStyle(select,'::picker(select)').backgroundColor==='rgb(35, 25, 50)','opened picker ignored dark palette');
   document.documentElement.dataset.theme='light';shell.dataset.theme='light';
   document.querySelector('[aria-label="Fixture date"]').click();await until(()=>shell.querySelector('.date-time-modal'));const modal=document.querySelector('.date-time-modal');
   check(getComputedStyle(modal).backgroundColor==='rgb(250, 245, 255)','picker escaped light theme');
   document.documentElement.dataset.theme='dark';shell.dataset.theme='dark';validate('rgb(140, 170, 250)');
   check(document.querySelector('.date-time-modal')===modal && getComputedStyle(modal).backgroundColor==='rgb(35, 25, 50)','picker remounted or escaped dark theme');
   check(document.querySelector('#total .recharts-area-curve')===curve,'theme change remounted chart');
 }else{
   const selector=kind==='widget' ? '.widget-card' : '.tray-card';await until(()=>document.querySelector(selector) && fixture.listeners.size);const card=document.querySelector(selector);fixture.emit(fixture.colors());
   await until(()=>getComputedStyle(card).backgroundColor==='rgb(35, 25, 50)');check(getComputedStyle(card).color==='rgb(240, 230, 250)','foreground ignored palette');
   if(kind==='tray'){
     check(getComputedStyle(document.querySelector('.tray-bar.used')).backgroundColor==='rgb(60, 100, 210)','tray chart ignored accent');
     check(getComputedStyle(document.querySelector('.tray-switch-thumb')).backgroundColor==='rgb(35, 25, 50)','tray selection alias retained default palette');
   }
   fixture.emit(undefined);await until(()=>getComputedStyle(card).backgroundColor==='rgb(255, 255, 255)');check(document.querySelector(selector)===card,'theme change remounted surface');
 }
 check(fixture.errors.length===0,'renderer errors '+fixture.errors);
 }.toString()+')('+JSON.stringify(kind)+')',true);
 if(kind==='charts' && process.env.LUMI_UI_REVIEW==='1'){await win.webContents.executeJavaScript('new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))');const out=path.resolve('.cache/ui-review');fs.mkdirSync(out,{recursive:true});fs.writeFileSync(path.join(out,'theme-charts-dark.png'),(await win.webContents.capturePage()).toPNG());}
 win.destroy();
}
console.log('THEME_UI_OK');app.exit(0);
}).catch(error=>{console.error(error.stack || error);app.exit(1);});`);
  const env={...process.env};delete env.ELECTRON_RUN_AS_NODE;const child=spawn(electron,[path.join(dir,'main.cjs')],{env,windowsHide:true,stdio:['ignore','pipe','pipe'],signal:t.signal});let stdout='',stderr='';child.stdout.on('data',chunk=>stdout+=chunk);child.stderr.on('data',chunk=>stderr+=chunk);
  const code=await new Promise<number|null>((resolve,reject)=>{child.once('error',reject);child.once('close',resolve);});assert.equal(code,0,stderr+stdout);assert.match(stdout,/THEME_UI_OK/);
});
