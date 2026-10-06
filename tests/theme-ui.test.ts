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
fixture.emit=(palette,material)=>fixture.listeners.forEach(fn=>fn({...fixture.initial,theme:palette ? 'dark' : 'light',palette,material}));fixture.colors=colors;
if(kind==='widget'){
  fixture.initial=formattedWidget('ready',undefined,{enabled:true,viewKey:'fixture',theme:'light',animation:'none'});
  window.lumiWidget={snapshot:async()=>fixture.initial,onState:fn=>{fixture.listeners.add(fn);return()=>fixture.listeners.delete(fn);},action:async()=>{}};await import('./src/widget');
}else if(kind==='tray'){
  fixture.initial={usage:{...nativeMenuBarState({phase:'ready'},{days:1,tool:'all'}),viewKey:'fixture',chart:[{label:'fixture',value:2,cost:'2',tokens:'10',requests:'1'}]},theme:'light',motion:{id:1,phase:'visible'}};
  window.lumiTray={snapshot:async()=>fixture.initial,onState:fn=>{fixture.listeners.add(fn);return()=>fixture.listeners.delete(fn);},action:async()=>{}};await import('./src/tray');
}else{
  const {TrendChart,ModelDonut}=await import('./src/components/charts'),{Select}=await import('./src/components/Select'),{DateTimePicker}=await import('./src/components/DateTimePicker'),{scopedInterfaceSheet}=await import('./src/host/interface'),{TREND_COLORS}=await import('./shared/trends');
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
  for(const [kind,files] of Object.entries({charts:['components/segmented-switch.css','styles.css','workbench.css','select.css','theme-tokens.css','theme.css','updates-trends.css'],widget:['theme-tokens.css','widget.css'],tray:['theme-tokens.css','tray.css']})){
    await writeFile(path.join(dir,kind+'.css'),(await Promise.all(files.map(file=>readFile(path.join('src',file),'utf8')))).join('\n'));
    await writeFile(path.join(dir,kind+'.html'),`<html><head><meta charset="utf-8"><link rel="stylesheet" href="${kind}.css"></head><body><div id="root"></div><script type="module" src="app.js"></script></body></html>`);
  }
  await writeFile(path.join(dir,'main.cjs'),String.raw`
const {app,BrowserWindow}=require('electron'),fs=require('node:fs'),path=require('node:path');
for(const name of ['userData','sessionData','logs','crashDumps']){const directory=path.join(__dirname,name);fs.mkdirSync(directory,{recursive:true});app.setPath(name,directory);}app.disableHardwareAcceleration();app.on('window-all-closed',()=>{});
app.whenReady().then(async()=>{
for(const kind of ['charts','widget','tray']){
 const win=new BrowserWindow({width:kind==='widget' ? 244 : kind==='tray' ? 396 : 850,height:kind==='widget' ? 64 : 720,show:false,transparent:kind!=='charts',backgroundColor:kind==='charts' ? '#ffffff' : '#00000000',webPreferences:{sandbox:true,contextIsolation:true,nodeIntegration:false,offscreen:true,backgroundThrottling:false}});await win.loadFile(path.join(__dirname,kind+'.html'),{hash:kind});
 await win.webContents.executeJavaScript('('+async function(kind){
 const check=(value,label)=>{if(!value)throw new Error(kind+': '+label);},until=async(fn,label=()=> 'timeout')=>{const deadline=performance.now()+6000;while(!fn()){if(performance.now()>deadline)throw new Error(kind+': '+label());await new Promise(r=>setTimeout(r,10));}};
 const canvas=document.createElement('canvas');canvas.width=canvas.height=1;const context=canvas.getContext('2d',{willReadFrequently:true});
 const rgba=value=>{context.clearRect(0,0,1,1);context.fillStyle='transparent';context.fillStyle=value;context.fillRect(0,0,1,1);return [...context.getImageData(0,0,1,1).data].join(',');};
 const sameColor=(actual,expected)=>rgba(actual)===rgba(expected);
 const waitColor=(read,expected,label)=>until(()=>sameColor(read(),expected),()=>label+': '+read()+' expected '+expected);
 if(kind==='charts'){
   await until(()=>document.querySelector('#total .recharts-area-curve') && document.querySelectorAll('#grouped .recharts-line-curve').length===2 && document.querySelector('.recharts-pie-sector'));
   const shell=document.querySelector('.desktop-shell'),curve=document.querySelector('#total .recharts-area-curve');
   const validate=async color=>{
     // Root theme state can precede descendant style invalidation in hidden Chromium windows.
     await new Promise(resolve=>requestAnimationFrame(resolve));
     await waitColor(()=>getComputedStyle(curve).stroke,color,'total curve ignored accent');
     const grouped=document.querySelectorAll('#grouped .recharts-line-curve');
     await waitColor(()=>getComputedStyle(grouped[0]).stroke,color,'grouped line ignored accent');
     await waitColor(()=>getComputedStyle(grouped[1]).stroke,'rgb(140, 80, 190)','grouped line lost distinction');
     await waitColor(()=>getComputedStyle(document.querySelector('.recharts-pie-sector path')).fill,color,'donut ignored accent');
     await waitColor(()=>getComputedStyle(document.querySelector('.legend-dot')).backgroundColor,color,'legend ignored accent');
     for(const [tone,key] of Object.entries({sage:'accent',blue:'blue',lavender:'purple',peach:'orange',red:'red',neutral:'text-secondary'})){
       const control=document.querySelector('select[aria-label="'+tone+'"]'),probe=document.createElement('i');probe.style.color='var(--'+key+')';shell.append(probe);
       await waitColor(()=>getComputedStyle(control.closest('.select-wrap'),'::before').backgroundColor,getComputedStyle(probe).color,'select tone '+tone+' ignored semantic color');
       await waitColor(()=>getComputedStyle(control.closest('.select-wrap').querySelector('svg')).color,getComputedStyle(probe).color,'select icon '+tone+' ignored semantic color');
       await waitColor(()=>getComputedStyle(control).color,getComputedStyle(shell).color,'select lost text color');probe.remove();
     }
   };
   await validate('rgb(60, 100, 210)');
   const select=document.querySelector('select[aria-label="sage"]');select.showPicker();await until(()=>select.matches(':open'));
   await waitColor(()=>getComputedStyle(select,'::picker(select)').backgroundColor,'rgb(250, 245, 255)','opened picker ignored plugin panel');
   await waitColor(()=>getComputedStyle(select.querySelector('option'),'::before').backgroundColor,'rgb(60, 100, 210)','opened option dot ignored plugin accent');
   document.documentElement.dataset.theme='dark';shell.dataset.theme='dark';await validate('rgb(140, 170, 250)');
   await waitColor(()=>getComputedStyle(select,'::picker(select)').backgroundColor,'rgb(35, 25, 50)','opened picker ignored dark palette');
   document.documentElement.dataset.theme='light';shell.dataset.theme='light';
   document.querySelector('[aria-label="Fixture date"]').click();await until(()=>shell.querySelector('.date-time-modal'));const modal=document.querySelector('.date-time-modal');
   await waitColor(()=>getComputedStyle(modal).backgroundColor,'rgb(250, 245, 255)','picker escaped light theme');
   document.documentElement.dataset.theme='dark';shell.dataset.theme='dark';await validate('rgb(140, 170, 250)');
   await waitColor(()=>getComputedStyle(modal).backgroundColor,'rgb(35, 25, 50)','picker escaped dark theme');
   check(document.querySelector('.date-time-modal')===modal,'picker remounted');
   check(document.querySelector('#total .recharts-area-curve')===curve,'theme change remounted chart');
 }else{
   const selector=kind==='widget' ? '.widget-card' : '.tray-card';await until(()=>document.querySelector(selector) && fixture.listeners.size);const card=document.querySelector(selector);fixture.emit(fixture.colors());
   for(const element of [document.documentElement,document.body,document.getElementById('root')])check(rgba(getComputedStyle(element).backgroundColor).endsWith(',0'),'transparent surface painted a rectangular document background');
   await waitColor(()=>getComputedStyle(card).backgroundColor,'rgb(35, 25, 50)','surface ignored panel');
   await waitColor(()=>getComputedStyle(card).color,'rgb(240, 230, 250)','foreground ignored palette');
   if(kind==='tray'){
     await waitColor(()=>getComputedStyle(document.querySelector('.tray-bar.used')).backgroundColor,'rgb(60, 100, 210)','tray chart ignored accent');
     await waitColor(()=>getComputedStyle(document.querySelector('.tray-switch-thumb')).backgroundColor,'rgb(35, 25, 50)','tray selection alias retained default palette');
   }
   fixture.emit(undefined);await waitColor(()=>getComputedStyle(card).backgroundColor,'rgb(255, 255, 255)','surface did not restore default panel');check(document.querySelector(selector)===card,'theme change remounted surface');
 }
 check(fixture.errors.length===0,'renderer errors '+fixture.errors);
 }.toString()+')('+JSON.stringify(kind)+')',true);
 if(kind!=='charts'){
   for(const mode of ['light','dark'])for(const custom of [false,true]){
     await win.webContents.executeJavaScript('('+async function(mode,custom){
       const palette=custom ? fixture.colors() : undefined;if(palette)palette.panel[3]=.42;
       fixture.emit(palette);await new Promise(r=>setTimeout(r,250));document.documentElement.dataset.theme=mode;
       await new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)));
     }.toString()+')('+JSON.stringify(mode)+','+custom+')');
     const capture=await win.webContents.capturePage(),pixels=capture.toBitmap(),{width,height}=capture.getSize();
     for(const [x,y] of [[0,0],[width-1,0],[0,height-1],[width-1,height-1]])if(pixels[(y*width+x)*4+3]>8)throw new Error(kind+' painted a rectangular corner in '+mode+' custom='+custom);
     if(!pixels[(Math.floor(height/2)*width+Math.floor(width/2))*4+3])throw new Error(kind+' transparency fix erased the card');
     if(process.env.LUMI_UI_REVIEW==='1'){const out=path.resolve('.cache/ui-review');fs.mkdirSync(out,{recursive:true});fs.writeFileSync(path.join(out,kind+'-'+mode+'-'+custom+'.png'),capture.toPNG());}
   }
   await win.webContents.executeJavaScript('('+async function(kind){
     fixture.emit(fixture.colors(),'acrylic');await new Promise(r=>setTimeout(r,250));
     const card=document.querySelector(kind==='widget' ? '.widget-card' : '.tray-card'),bounds=card.getBoundingClientRect();
     if(bounds.x!==0 || bounds.y!==0 || bounds.width!==innerWidth || bounds.height!==innerHeight)throw new Error(kind+' acrylic card does not fill its native rounded window');
     if(getComputedStyle(card).borderRadius!=='8px')throw new Error(kind+' acrylic surface does not match the native rounded corners');
     const canvas=document.createElement('canvas');canvas.width=canvas.height=1;const context=canvas.getContext('2d');
     for(const mode of ['light','dark'])for(const alpha of [.42,1]){
       const palette=fixture.colors();palette.panel=[35,25,50,alpha];fixture.emit(palette,'acrylic');await new Promise(r=>setTimeout(r,50));document.documentElement.dataset.theme=mode;
       await new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)));
       context.clearRect(0,0,1,1);context.fillStyle=getComputedStyle(card).backgroundColor;context.fillRect(0,0,1,1);
       const color=[...context.getImageData(0,0,1,1).data],expected=mode==='light' ? [35,25,50,199] : [107,97,122,173];
       if(color.some((value,index)=>Math.abs(value-expected[index])>1))throw new Error(kind+' acrylic tint is too dim or applies theme opacity twice: '+color+' expected '+expected);
     }
     if(document.documentElement.scrollWidth>innerWidth || document.documentElement.scrollHeight>innerHeight)throw new Error(kind+' acrylic layout overflows');
   }.toString()+')('+JSON.stringify(kind)+')');
   if(kind==='widget')await win.webContents.executeJavaScript('('+async function(){
     const card=document.querySelector('.widget-card'),data=document.querySelector('.widget-data');
     const canvas=document.createElement('canvas');canvas.width=canvas.height=1;const context=canvas.getContext('2d');
     for(const material of ['liquid-glass','vibrancy','opaque'])for(const mode of ['light','dark'])for(const panelAlpha of [.42,1]){
       const palette=fixture.colors();palette.panel=[35,25,50,panelAlpha];fixture.emit(palette,material);
       await new Promise(r=>setTimeout(r,50));document.documentElement.dataset.theme=mode;
       await new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)));
       const expectedAlpha=material==='liquid-glass' ? mode==='light' ? .18 : .28 : material==='vibrancy' ? mode==='light' ? .45 : .55 : 1;
       context.clearRect(0,0,1,1);context.fillStyle=getComputedStyle(card).backgroundColor;context.fillRect(0,0,1,1);
       const actual=[...context.getImageData(0,0,1,1).data];
       // Compare equally premultiplied pixels: small alpha quantizes RGB channels.
       context.clearRect(0,0,1,1);context.fillStyle='rgba(35,25,50,'+expectedAlpha+')';context.fillRect(0,0,1,1);
       const expected=[...context.getImageData(0,0,1,1).data];
       if(actual.some((value,index)=>Math.abs(value-expected[index])>1))throw new Error('widget '+material+' lost theme tint or obscures native glass: '+actual);
       if(getComputedStyle(card).color!=='rgb(240, 230, 250)')throw new Error('widget glass lost theme text');
       const bounds=card.getBoundingClientRect();
       if(bounds.x!==2 || bounds.y!==2 || bounds.width!==innerWidth-4 || bounds.height!==innerHeight-4)throw new Error('widget glass and native inset disagree');
       if(getComputedStyle(card).borderRadius!=='8px')throw new Error('widget glass and native corner radius disagree');
       if(getComputedStyle(card).getPropertyValue('-webkit-app-region')!=='drag')throw new Error('widget glass lost dragging');
       if(document.querySelector('.widget-data')!==data)throw new Error('widget material switch remounted data');
       if(document.documentElement.scrollWidth>innerWidth || document.documentElement.scrollHeight>innerHeight)throw new Error('widget glass layout overflows');
     }
     if(fixture.errors.length)throw new Error('widget glass renderer errors '+fixture.errors);
   }.toString()+')()');
 }
 if(kind==='charts' && process.env.LUMI_UI_REVIEW==='1'){await win.webContents.executeJavaScript('new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))');const out=path.resolve('.cache/ui-review');fs.mkdirSync(out,{recursive:true});fs.writeFileSync(path.join(out,'theme-charts-dark.png'),(await win.webContents.capturePage()).toPNG());}
 win.destroy();
}
console.log('THEME_UI_OK');app.exit(0);
}).catch(error=>{console.error(error.stack || error);app.exit(1);});`);
  const env={...process.env};delete env.ELECTRON_RUN_AS_NODE;const child=spawn(electron,[path.join(dir,'main.cjs')],{env,windowsHide:true,stdio:['ignore','pipe','pipe'],signal:t.signal});let stdout='',stderr='';child.stdout.on('data',chunk=>stdout+=chunk);child.stderr.on('data',chunk=>stderr+=chunk);
  const code=await new Promise<number|null>((resolve,reject)=>{child.once('error',reject);child.once('close',resolve);});assert.equal(code,0,stderr+stdout);assert.match(stdout,/THEME_UI_OK/);
});
