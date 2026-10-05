import test from 'node:test';
import assert from 'node:assert/strict';
import {build} from 'esbuild';
import {mkdir,mkdtemp,writeFile,readFile,rm} from 'node:fs/promises';
import {existsSync} from 'node:fs';
import path from 'node:path';
import {spawn} from 'node:child_process';
import {createRequire} from 'node:module';

test('native dropdowns animate both directions, wrap complete labels and keep compact searchable filters usable',{timeout:40000},async t=>{
  const electron=createRequire(import.meta.url)('electron') as string;
  if(!existsSync(electron))return t.skip('Electron unavailable');
  await mkdir('.test-data',{recursive:true});
  const directory=await mkdtemp(path.resolve('.test-data/select-ui-'));
  t.after(()=>rm(directory,{recursive:true,force:true,maxRetries:5,retryDelay:100}));
  const output=await build({stdin:{resolveDir:process.cwd(),loader:'tsx',contents:`
import React,{useState} from 'react';import {createRoot} from 'react-dom/client';import {Select} from './src/components/Select';import {ChannelSelect} from './src/components/ChannelSelect';import {MultiSelect} from './src/components/StatisticsFilter';import {scopedInterfaceSheet} from './src/host/interface';
window.fixture={errors:[],changes:[],escapes:0,motionClicks:0};addEventListener('error',event=>fixture.errors.push(event.message));addEventListener('unhandledrejection',event=>fixture.errors.push(String(event.reason)));addEventListener('keydown',event=>{if(event.key==='Escape')fixture.escapes++;});
// Older interface packages make options as tall/wide as their single-line trigger.
// Exercise the actual scoped CSS cascade instead of only the default styles.
fixture.theme=enabled=>{document.querySelector('.desktop-shell').dataset.fixtureTheme=enabled ? 'glass' : '';document.adoptedStyleSheets=enabled ? [scopedInterfaceSheet({id:'extension.fixture.glass',css:':scope{--accent:light-dark(#8055ce,#c5a8ff);--panel:light-dark(#f6f1ff,#21182e);--accent-soft:light-dark(#e8dcfa,#48375f);--text:light-dark(#302443,#f6efff)} @supports (appearance:base-select){.select-wrap select::picker(select){inline-size:anchor-size(width);min-inline-size:anchor-size(width);max-inline-size:anchor-size(width);scrollbar-width:none;padding:0;border-width:0;font:inherit;backdrop-filter:blur(12px)} :scope .select-wrap select option{box-sizing:border-box;inline-size:100%;block-size:max(40px,calc(1lh + 22px));min-block-size:40px;line-height:inherit;padding:10px 34px 10px 14px;gap:10px;margin:0;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}}'})] : [];};
const options=[['master','用户分组 (MASTER) · ×1'],['openai','OAI 特供 · ×1'],['claude','claude_kiro · ×0.6'],['default','用户分组，无模型筛选 (default) · ×1'],['gemini','gemini · ×0.8'],['long','astra 价格独立。使用前最好先查看模型详细计费规则与可用渠道，避免选择错误的分组 · ×0.3'],['gpt','gpt 官方 pro · ×0.3'],...Array.from({length:16},(_,i)=>['tail'+i,'备用渠道 '+i+' · ×0.5'])];
const catalog={models:[],vendors:[],autoGroups:[],usableGroups:Object.fromEntries(options.map(([key,label])=>[key,label.replace(/ · ×[\\d.]+$/,'')])),groupRatio:Object.fromEntries(options.map(([key,label])=>[key,Number(label.split('×').at(-1))]))};
function App(){const [value,setValue]=useState('master'),[kind,setKind]=useState('normal');fixture.show=setKind;fixture.value=value;
const change=next=>{fixture.changes.push(next);setValue(next);};
const select=kind==='normal' ? <ChannelSelect label="渠道 / 倍率" catalog={catalog} groups={options.map(item=>item[0])} value={value} onChange={change}/> : <Select label="渠道 / 倍率" className={kind==='site' ? 'site-switch' : ''} decorated={kind!=='plain'} value={value} onChange={change}>{options.map(([key,label])=><option key={key} value={key} disabled={key==='tail15'}>{label}</option>)}</Select>;
return <main className="desktop-shell" data-interface="extension.fixture.glass" style={{display:'block',padding:0}}><h1 style={{fontSize:18,margin:0}}>渠道 / 倍率</h1><button id="motion-click-target" tabIndex={-1} aria-label="动画后面的操作" style={{position:'fixed',left:35,top:110,width:150,height:35,opacity:0}} onClick={()=>fixture.motionClicks++}/><div className={kind==='site' ? 'sidebar-site fixture-control site' : 'fixture-control '+kind}>{kind==='site' ? <><span/><div>{select}</div></> : kind==='multi' ? <MultiSelect label="模型" options={options.map(([value,label])=>({value,label}))} value={[value]} onApply={values=>{fixture.applied=values;}}/> : select}</div></main>;}
createRoot(document.getElementById('root')).render(<App/>);
`},bundle:true,platform:'browser',format:'esm',write:false,loader:{'.css':'empty','.svg':'text'},define:{'process.env.NODE_ENV':'"production"'},logLevel:'silent'});
  await writeFile(path.join(directory,'app.js'),output.outputFiles[0].contents);
  const css=await Promise.all(['styles.css','workbench.css','select.css','theme-tokens.css','theme.css','updates-trends.css','filters-tools-motion.css','platform-logs.css'].map(file=>readFile(path.join('src',file),'utf8')));
  await writeFile(path.join(directory,'style.css'),css.join('\n')+'\nbody{margin:0;min-width:0;padding:20px}main{display:block}.fixture-control{position:fixed;width:260px;left:20px;top:55px}.fixture-control>.select-wrap{width:100%}.fixture-control.edge,.fixture-control.multi{width:160px;left:auto;top:auto;right:12px;bottom:12px}.fixture-control.site{width:180px;top:auto;bottom:20px;display:grid;grid-template-columns:0 1fr;gap:0}.fixture-control.plain{width:76px}.desktop-shell[data-fixture-theme=glass] .fixture-control.normal{width:144px}');
  await writeFile(path.join(directory,'index.html'),'<html><head><meta charset="utf-8"><link rel="stylesheet" href="style.css"></head><body><div id="root"></div><script type="module" src="app.js"></script></body></html>');
  await writeFile(path.join(directory,'main.cjs'),String.raw`
const {app,BrowserWindow}=require('electron'),fs=require('node:fs'),path=require('node:path');
for(const name of ['userData','sessionData','logs','crashDumps']){const dir=path.join(__dirname,name);fs.mkdirSync(dir,{recursive:true});app.setPath(name,dir);}app.disableHardwareAcceleration();
app.whenReady().then(async()=>{
const win=new BrowserWindow({width:1100,height:720,useContentSize:true,show:false,webPreferences:{sandbox:true,contextIsolation:true,nodeIntegration:false,offscreen:true,backgroundThrottling:false}});win.webContents.on('console-message',event=>console.log('RENDERER '+event.message));await win.loadFile(path.join(__dirname,'index.html'));
const run=async(kind,screenshot)=>{
await win.webContents.executeJavaScript('('+async function(kind){const until=async fn=>{const end=performance.now()+5000;while(!fn()){if(performance.now()>end)throw new Error('Timeout '+fn+' '+fixture.errors);await new Promise(resolve=>setTimeout(resolve,10));}};await until(()=>fixture.show);fixture.show(kind);await new Promise(resolve=>setTimeout(resolve,50));const select=document.querySelector('select');select.focus();select.showPicker();}.toString()+')('+JSON.stringify(kind)+')',true);
await new Promise(resolve=>setTimeout(resolve,250));
const result=await win.webContents.executeJavaScript('('+function(kind){
const check=(value,label)=>{if(!value)throw new Error(label);},select=document.querySelector('select'),options=[...select.options],picker=getComputedStyle(select,'::picker(select)'),first=options[0].getBoundingClientRect(),long=select.querySelector('option[value="long"]'),label=long.querySelector('.select-option-label'),rect=long.getBoundingClientRect();
document.getAnimations().forEach(animation=>animation.finish());
check(CSS.supports('appearance','base-select'),'Customizable selects unavailable');check(select.matches(':open'),'Picker did not open');
check(picker.opacity==='1','Dropdown is transparent');
check(first.left>=0 && first.right<=innerWidth,'Dropdown overflows viewport horizontally: '+JSON.stringify(first));
check(first.top>=0 && first.bottom<=innerHeight,'Dropdown failed to flip above viewport edge: '+JSON.stringify(first));
check(parseFloat(picker.maxBlockSize)<=Math.min(320,innerHeight-24),'Dropdown is too tall');
check(label.scrollWidth<=label.clientWidth+1,'Long label clipped horizontally: '+label.scrollWidth+'/'+label.clientWidth);check(label.scrollHeight<=label.clientHeight+1,'Long label clipped vertically');
const labelStyle=getComputedStyle(label),lineHeight=parseFloat(labelStyle.lineHeight) || parseFloat(labelStyle.fontSize)*1.2;
check(label.getBoundingClientRect().height>lineHeight*1.5,'Long label did not wrap');
for(const option of options){const text=option.querySelector('.select-option-label'),box=option.getBoundingClientRect(),content=text.getBoundingClientRect();check(content.top>=box.top && content.bottom<=box.bottom+1,'Option crops wrapped text: '+option.value+' '+JSON.stringify({box:box.toJSON(),content:content.toJSON()}));for(const child of text.querySelectorAll('.channel-label > *')){const bounds=child.getBoundingClientRect();check(bounds.left>=content.left && bounds.right<=content.right+1 && bounds.bottom<=box.bottom+1,'Channel label or ratio cropped: '+option.value);}}
// Native scrollbar/border rounding can reduce the option box by one CSS pixel on macOS.
if(kind==='normal')check(first.width+1>=Math.min(260,innerWidth-36),'Dropdown compresses normal channel labels: '+first.width);
check(getComputedStyle(long,'::checkmark').gridColumnStart==='-2','Checkmark lost its separate column');
check(select.title.includes('MASTER'),'Closed control lacks full selected text');if(kind!=='normal')check(options[options.length-1].disabled,'Disabled option lost semantics');
check(document.documentElement.scrollWidth<=innerWidth,'Page widened after popup');check(fixture.errors.length===0,'Renderer errors '+fixture.errors);
return {kind,viewport:[innerWidth,innerHeight],first:[first.x,first.y,first.width,first.height],longHeight:rect.height,pickerHeight:picker.maxBlockSize};
}.toString()+')('+JSON.stringify(kind)+')');console.log('SELECT_UI '+JSON.stringify(result));
if(screenshot)fs.writeFileSync(path.resolve('.test-data/'+screenshot+'.png'),(await win.webContents.capturePage(undefined,{stayHidden:true,stayAwake:true})).toPNG());
win.webContents.sendInputEvent({type:'keyDown',keyCode:'Escape'});win.webContents.sendInputEvent({type:'keyUp',keyCode:'Escape'});
await new Promise(resolve=>setTimeout(resolve,50));
await win.webContents.executeJavaScript('if(document.querySelector("select").matches(":open"))throw new Error("Escape did not close picker");if(fixture.escapes)throw new Error("Picker Escape reached its parent");');
};
for(const kind of ['normal','edge','site','plain'])await run(kind,kind==='normal' ? 'select-channel' : undefined);
for(const size of [[520,420],[320,380]]){win.setContentSize(...size);for(const kind of ['normal','edge','site'])await run(kind);}
win.setContentSize(1100,720);await win.webContents.executeJavaScript('document.documentElement.dataset.theme="dark"');await run('normal','select-channel-dark');
await win.webContents.executeJavaScript('fixture.theme(true);document.documentElement.dataset.theme="light"');
await run('normal','select-channel-glass');
await win.webContents.executeJavaScript('document.documentElement.dataset.theme="dark"');await run('normal','select-channel-glass-dark');
win.setContentSize(320,380);await run('normal','select-channel-glass-small');
win.setContentSize(1100,720);await win.webContents.executeJavaScript('fixture.theme(false)');
win.webContents.debugger.attach('1.3');await win.webContents.debugger.sendCommand('Emulation.setEmulatedMedia',{features:[{name:'prefers-reduced-motion',value:'no-preference'}]});
await win.webContents.executeJavaScript('new Promise(r=>setTimeout(r,150)).then(()=>{const select=document.querySelector("select"),style=getComputedStyle(select,"::picker(select)");if(!style.transitionProperty.includes("overlay") || !style.transitionProperty.includes("display"))throw new Error("Native picker cannot retain its top layer during exit");select.style.setProperty("--popup-enter-duration","600ms");select.style.setProperty("--popup-exit-duration","600ms");})');
await win.webContents.executeJavaScript('document.querySelector("select").focus();document.querySelector("select").showPicker();',true);
await win.webContents.executeJavaScript('('+async function(){
await new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)));const select=document.querySelector('select'),value=Number(getComputedStyle(select,'::picker(select)').opacity);if(value<=0 || value>=1)throw new Error('Native picker opening does not interpolate: '+value);const end=performance.now()+1200;while(getComputedStyle(select,'::picker(select)').opacity!=='1'){if(performance.now()>end)throw new Error('Native picker opening never settles');await new Promise(r=>requestAnimationFrame(r));}
}.toString()+')()');
win.webContents.sendInputEvent({type:'keyDown',keyCode:'Escape'});win.webContents.sendInputEvent({type:'keyUp',keyCode:'Escape'});
const behind=await win.webContents.executeJavaScript('('+async function(){
await new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)));const select=document.querySelector('select'),style=getComputedStyle(select,'::picker(select)'),value=Number(style.opacity),rect=select.options[0].getBoundingClientRect();if(select.matches(':open') || value<=0 || value>=1 || rect.height<=0 || style.pointerEvents!=='none')throw new Error('Native closing picker was removed early or remains interactive: '+value);const point={x:Math.round(rect.left+30),y:Math.round(rect.top+rect.height/2)};if(document.elementFromPoint(point.x,point.y)?.id!=='motion-click-target')throw new Error('Closing native picker intercepts hit testing');return point;
}.toString()+')()');
win.webContents.sendInputEvent({type:'mouseDown',...behind,button:'left',clickCount:1});win.webContents.sendInputEvent({type:'mouseUp',...behind,button:'left',clickCount:1});
await win.webContents.executeJavaScript('('+async function(){const select=document.querySelector('select'),end=performance.now()+1200;while(select.options[0].getBoundingClientRect().height>0){if(performance.now()>end)throw new Error('Native picker remains in the top layer after closing');await new Promise(r=>requestAnimationFrame(r));}if(fixture.motionClicks!==1)throw new Error('Closing native picker swallowed the underlying click');}.toString()+')()');
await win.webContents.executeJavaScript('document.querySelector("select").focus();document.querySelector("select").showPicker();',true);
await win.webContents.executeJavaScript('new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)))');
win.webContents.sendInputEvent({type:'keyDown',keyCode:'Escape'});win.webContents.sendInputEvent({type:'keyUp',keyCode:'Escape'});
await win.webContents.executeJavaScript('new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)))');
await win.webContents.executeJavaScript('document.querySelector("select").showPicker();',true);
await win.webContents.executeJavaScript('('+async function(){const select=document.querySelector('select');await new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)));if(!select.matches(':open') || select.options[0].getBoundingClientRect().height<=0)throw new Error('Rapid native reopen lost its picker');const end=performance.now()+1200;while(getComputedStyle(select,'::picker(select)').opacity!=='1'){if(performance.now()>end)throw new Error('Rapid native reopen never settles');await new Promise(r=>requestAnimationFrame(r));}if(select.value!=='master' || fixture.changes.length)throw new Error('Rapid native reopen changed the selected value');}.toString()+')()');
win.webContents.sendInputEvent({type:'keyDown',keyCode:'Escape'});win.webContents.sendInputEvent({type:'keyUp',keyCode:'Escape'});
await win.webContents.executeJavaScript('new Promise(r=>setTimeout(r,650))');
await win.webContents.debugger.sendCommand('Emulation.setEmulatedMedia',{features:[{name:'prefers-reduced-motion',value:'reduce'}]});
await win.webContents.executeJavaScript('document.querySelector("select").showPicker();',true);
await win.webContents.executeJavaScript('new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r))).then(()=>{const select=document.querySelector("select"),style=getComputedStyle(select,"::picker(select)");if(style.opacity!=="1" || style.transitionDuration!=="0s")throw new Error("Reduced motion still animates native picker opening");})');
win.webContents.sendInputEvent({type:'keyDown',keyCode:'Escape'});win.webContents.sendInputEvent({type:'keyUp',keyCode:'Escape'});
await win.webContents.executeJavaScript('new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r))).then(()=>{if(document.querySelector("select").options[0].getBoundingClientRect().height>0)throw new Error("Reduced motion delays native picker closing");})');
await win.webContents.debugger.sendCommand('Emulation.setEmulatedMedia',{features:[{name:'prefers-reduced-motion',value:'no-preference'}]});
await win.webContents.executeJavaScript('document.querySelector("select").style.removeProperty("--popup-enter-duration");document.querySelector("select").style.removeProperty("--popup-exit-duration");');
await win.webContents.executeJavaScript('fixture.show("normal");document.querySelector("select").focus();document.querySelector("select").showPicker();',true);
await new Promise(resolve=>setTimeout(resolve,50));
win.webContents.sendInputEvent({type:'keyDown',keyCode:'Down'});win.webContents.sendInputEvent({type:'keyUp',keyCode:'Down'});
await new Promise(resolve=>setTimeout(resolve,50));
win.webContents.sendInputEvent({type:'keyDown',keyCode:'Enter'});win.webContents.sendInputEvent({type:'keyUp',keyCode:'Enter'});
await new Promise(resolve=>setTimeout(resolve,50));
await win.webContents.executeJavaScript('if(fixture.value!=="openai" || fixture.changes.length!==1)throw new Error("Native ArrowDown failed to update React value: "+fixture.value+" "+fixture.changes+" "+document.activeElement?.outerHTML);');
for(const size of [[1100,720],[320,240]]){
win.setContentSize(...size);await win.webContents.executeJavaScript('fixture.show("multi")');await new Promise(resolve=>setTimeout(resolve,50));
await win.webContents.executeJavaScript('document.querySelector(".multi-trigger").click()');await win.webContents.executeJavaScript('('+async function(){await new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)));const panel=document.querySelector('.multi-popover'),animation=panel.getAnimations().find(item=>item.animationName==='picker-open');if(!animation)throw new Error('Multiselect does not animate opening');animation.pause();animation.currentTime=60;await new Promise(r=>requestAnimationFrame(r));const opacity=Number(getComputedStyle(panel).opacity);if(opacity<=0 || opacity>=1)throw new Error('Multiselect opening does not interpolate');animation.finish();}.toString()+')()');await new Promise(resolve=>setTimeout(resolve,50));
fs.writeFileSync(path.resolve('.test-data/'+(size[0]===1100 ? 'select-multi' : 'select-multi-short')+'.png'),(await win.webContents.capturePage(undefined,{stayHidden:true,stayAwake:true})).toPNG());
const result=await win.webContents.executeJavaScript('('+function(){
const check=(value,label)=>{if(!value)throw new Error(label);},popup=document.querySelector('.multi-popover'),rect=popup.getBoundingClientRect();
check(rect.top>=7 && rect.left>=7 && rect.bottom<=innerHeight-7 && rect.right<=innerWidth-7,'Multiselect exceeds viewport: '+JSON.stringify(rect));
check(popup.scrollHeight<=popup.clientHeight+1,'Multiselect footer clipped by viewport');
const search=popup.querySelector('.search-input'),input=search.querySelector('input'),searchBox=search.getBoundingClientRect(),inputBox=input.getBoundingClientRect();check(Math.abs(searchBox.height-34)<1,'Multiselect search field changed height: '+searchBox.height);check(searchBox.left>=rect.left && searchBox.right<=rect.right && inputBox.right<=searchBox.right && input.scrollWidth<=input.clientWidth+1,'Multiselect search input exceeds its container');
const labels=[...popup.querySelectorAll('.multi-options label>span:last-child')];check(labels.every(label=>label.scrollWidth<=label.clientWidth+1),'Multiselect labels clipped');
check(labels.some(label=>label.textContent.includes('astra') && label.getBoundingClientRect().height>parseFloat(getComputedStyle(label).lineHeight)),'Multiselect long label did not wrap');
check(document.activeElement===popup.querySelector('input[type="text"],.search-input input'),'Multiselect failed to focus search');
popup.querySelector('input[type="checkbox"]').click();popup.querySelector('.multi-actions .button').click();
check(fixture.applied.includes('master'),'Multiselect apply lost checked value');return {viewport:[innerWidth,innerHeight],bounds:[rect.x,rect.y,rect.width,rect.height]};
}.toString()+')()');console.log('MULTI_UI '+JSON.stringify(result));
await win.webContents.executeJavaScript('('+async function(){await new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)));const panel=document.querySelector('.multi-popover'),animation=panel?.getAnimations().find(item=>item.animationName==='picker-close');if(!panel || !animation || !panel.inert || panel.getAttribute('aria-hidden')!=='true')throw new Error('Multiselect closing was removed early or remains interactive');animation.pause();animation.currentTime=50;await new Promise(r=>requestAnimationFrame(r));const opacity=Number(getComputedStyle(panel).opacity);if(opacity<=0 || opacity>=1)throw new Error('Multiselect closing does not interpolate');animation.finish();}.toString()+')()');
await new Promise(resolve=>setTimeout(resolve,180));await win.webContents.executeJavaScript('document.querySelector(".multi-trigger").click()');await new Promise(resolve=>setTimeout(resolve,50));
await win.webContents.executeJavaScript('('+async function(){
const input=document.querySelector('.multi-popover .search-input input'),setValue=Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set;
for(const query of ['MASTER','astra']){setValue.call(input,query);input.dispatchEvent(new Event('input',{bubbles:true}));await new Promise(resolve=>setTimeout(resolve,50));const popup=document.querySelector('.multi-popover'),rect=popup.getBoundingClientRect();if(popup.querySelectorAll('.multi-options label').length!==1)throw new Error('Multiselect search failed');if(rect.bottom>innerHeight-7 || rect.top<7)throw new Error('Multiselect failed to reposition after equally sized search results changed row heights: '+query+' '+JSON.stringify(rect));if(Math.abs(input.parentElement.getBoundingClientRect().height-34)>1 || input.getBoundingClientRect().right>rect.right)throw new Error('Searching changed field height or caused horizontal overflow');}
}.toString()+')()');
win.webContents.sendInputEvent({type:'keyDown',keyCode:'Escape'});win.webContents.sendInputEvent({type:'keyUp',keyCode:'Escape'});await new Promise(resolve=>setTimeout(resolve,180));
await win.webContents.executeJavaScript('if(document.querySelector(".multi-popover") || fixture.escapes)throw new Error("Multiselect Escape did not close only the picker");if(document.activeElement!==document.querySelector(".multi-trigger"))throw new Error("Multiselect dismissal lost trigger focus");');
}
await win.webContents.debugger.sendCommand('Emulation.setEmulatedMedia',{features:[{name:'prefers-reduced-motion',value:'reduce'}]});
await win.webContents.executeJavaScript('document.querySelector(".multi-trigger").click();new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r))).then(()=>{const panel=document.querySelector(".multi-popover");if(!panel || panel.getAnimations().length || getComputedStyle(panel).opacity!=="1")throw new Error("Reduced motion animates multiselect opening");document.querySelector(".multi-trigger").click();})');
await win.webContents.executeJavaScript('new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r))).then(()=>{if(document.querySelector(".multi-popover"))throw new Error("Reduced motion delays multiselect unmount");})');
win.destroy();app.exit(0);
}).catch(error=>{console.error(error.stack || error);app.exit(1)});
`);
  const env={...process.env};delete env.ELECTRON_RUN_AS_NODE;
  const child=spawn(electron,[path.join(directory,'main.cjs')],{env,windowsHide:true,stdio:['ignore','pipe','pipe'],signal:t.signal});
  let stdout='',stderr='';child.stdout.on('data',chunk=>stdout+=chunk);child.stderr.on('data',chunk=>stderr+=chunk);
  const code=await new Promise<number|null>((resolve,reject)=>{child.on('error',reject);child.on('close',resolve);});
  assert.equal(code,0,stderr+stdout);assert.equal(stdout.split('SELECT_UI ').length-1,14);assert.equal(stdout.split('MULTI_UI ').length-1,2);
});
