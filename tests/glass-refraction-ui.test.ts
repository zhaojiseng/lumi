import test from 'node:test';
import assert from 'node:assert/strict';
import {build} from 'esbuild';
import {mkdir,mkdtemp,writeFile,rm} from 'node:fs/promises';
import {existsSync} from 'node:fs';
import {createRequire} from 'node:module';
import {spawn} from 'node:child_process';
import path from 'node:path';

test('glass runtime follows explicit surfaces, visibility, popup priority, texture reuse and disposal',{timeout:60000},async t=>{
  let electron:string;try{electron=createRequire(import.meta.url)('electron');}catch{return t.skip('Electron unavailable');}
  if(!existsSync(electron))return t.skip('Electron unavailable');
  await mkdir('.test-data',{recursive:true});const directory=await mkdtemp(path.resolve('.test-data/glass-runtime-ui-'));
  t.after(()=>rm(directory,{recursive:true,force:true,maxRetries:5,retryDelay:100}));
  const script=await build({stdin:{resolveDir:process.cwd(),loader:'ts',contents:`
import {installGlassRefraction} from './src/host/glass-refraction';
const fixture=window.fixture={errors:[],encodes:0,frames:0};
addEventListener('error',event=>fixture.errors.push(event.message));
addEventListener('unhandledrejection',event=>fixture.errors.push(String(event.reason)));
const encode=HTMLCanvasElement.prototype.toDataURL;HTMLCanvasElement.prototype.toDataURL=function(...args){fixture.encodes++;return encode.apply(this,args)};
const raf=window.requestAnimationFrame.bind(window);window.requestAnimationFrame=fn=>{fixture.frames++;return raf(fn)};
const media=new Map();window.matchMedia=query=>{if(!media.has(query))media.set(query,{matches:false,listeners:new Set(),addEventListener(_type,fn){this.listeners.add(fn)},removeEventListener(_type,fn){this.listeners.delete(fn)}});return media.get(query)};
fixture.setMedia=(query,value)=>{const item=media.get(query);item.matches=value;item.listeners.forEach(fn=>fn())};
fixture.dispose=installGlassRefraction(document.getElementById('shell'));
`},bundle:true,platform:'browser',format:'iife',write:false,logLevel:'silent'});
  await writeFile(path.join(directory,'app.js'),script.outputFiles[0].contents);
  await writeFile(path.join(directory,'index.html'),`<!doctype html><meta charset="UTF-8"><style>
html,body{margin:0;width:100%;height:100%;overflow:hidden}#shell{position:relative;width:100%;height:100%;--lumi-glass-distortion:6}
@keyframes glass-enter{from{opacity:0}to{opacity:1}}
.glass{position:absolute;left:20px;top:20px;width:100px;height:50px;border-radius:12px;backdrop-filter:var(--lumi-glass-filter,blur(0px))}
.background{isolation:isolate;backdrop-filter:none}.background::before{content:'';position:absolute;inset:0;border-radius:inherit;z-index:-1;backdrop-filter:var(--lumi-glass-filter,blur(0px))}
[hidden]{display:none!important}
</style><div id="shell"><div id="zone"></div></div><script src="app.js"></script>`);
  await writeFile(path.join(directory,'audit.cjs'),String.raw`
const {app,BrowserWindow}=require('electron'),fs=require('node:fs'),path=require('node:path');
for(const name of ['userData','sessionData','logs','crashDumps']){const dir=path.join(__dirname,name);fs.mkdirSync(dir,{recursive:true});app.setPath(name,dir)}
app.disableHardwareAcceleration();app.commandLine.appendSwitch('force-device-scale-factor','1');
const watchdog=setTimeout(()=>{console.error('Glass runtime contract timed out');app.exit(1)},55000);
app.whenReady().then(async()=>{
const win=new BrowserWindow({show:process.platform==='darwin',width:900,height:650,webPreferences:{sandbox:true,contextIsolation:true,nodeIntegration:false,backgroundThrottling:false}});await win.loadFile(path.join(__dirname,'index.html'));
const wake=setInterval(()=>{if(!win.isDestroyed())void win.webContents.capturePage(undefined,{stayHidden:true,stayAwake:true}).catch(()=>{})},100);
win.webContents.on('console-message',event=>console.log('GLASS_BROWSER '+event.message));
const result=await win.webContents.executeJavaScript('('+async function(){
const check=(value,label)=>{if(!value)throw Error(label)};
const delay=ms=>new Promise(resolve=>setTimeout(resolve,ms));
const until=async(fn,label)=>{const end=performance.now()+5000;while(!fn()){if(performance.now()>end)throw Error(label+'; errors='+fixture.errors.join(';'));await delay(10)}};
const shell=document.getElementById('shell'),zone=document.getElementById('zone');
const ref=node=>node.style.getPropertyValue('--lumi-glass-filter');
const has=node=>ref(node).includes('url(');
const count=()=>shell.querySelectorAll('[data-lumi-glass-defs] filter').length;
const make=(kind='background',classes='')=>{const node=document.createElement('div');node.className='glass '+classes;node.dataset.lumiGlass=kind;return node};
const reset=async()=>{zone.replaceChildren();await until(()=>count()===0,'Detached surfaces retained filters')};
const paint=()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)));

// Named classes are retained for existing skins; new plugin elements can opt in
// without copying the host's private selector inventory.
const explicit=make('background','background');zone.append(explicit);
await until(()=>has(explicit),'Explicit background surface did not receive refraction');
check(getComputedStyle(explicit).backdropFilter==='none' && getComputedStyle(explicit,'::before').backdropFilter.includes('url('),'Background glass reference did not reach its separate paint layer');
const excluded=document.createElement('div');excluded.className='surface panel';excluded.style.cssText='width:40px;height:20px;--lumi-glass-surface:0;backdrop-filter:var(--lumi-glass-filter,blur(0px))';explicit.append(excluded);
await paint();await delay(30);check(!has(excluded) && !getComputedStyle(excluded).backdropFilter.includes('url('),'Excluded child inherited an unrelated ancestor displacement map');
check(getComputedStyle(explicit,'::before').backdropFilter.includes('url('),'Descendant reference reset broke the originating background pseudo-element');
await reset();
const surface=make('surface');zone.append(surface);await until(()=>has(surface),'Explicit surface did not receive refraction');await reset();
const lens=make('lens');zone.append(lens);await until(()=>has(lens),'Explicit lens did not receive refraction');await reset();

// Token model selections already consume the skin's local glass variable.
// Only the selected, visible control owns a filter; plain skins stay unchanged.
const choice=document.createElement('button');choice.className='glass model-choice';choice.textContent='Selected model';zone.append(choice);
await paint();check(!has(choice),'Unselected model choice allocated refraction');
choice.classList.add('selected');await until(()=>has(choice),'Selected model choice did not receive refraction');
check(getComputedStyle(choice).backdropFilter.includes('url('),'Selected model choice did not consume its own filter');
check(getComputedStyle(choice).filter==='none','Selected model choice applied a filter to its foreground text');
const selectedFilter=ref(choice);
choice.classList.remove('selected');await until(()=>!has(choice) && count()===0,'Deselected model choice retained a filter');
choice.classList.add('selected');await until(()=>has(choice),'Reselected model choice did not restore refraction');
check(ref(choice)!==selectedFilter,'Reselected model choice reused a released filter reference');
choice.hidden=true;await until(()=>!has(choice) && count()===0,'Hidden model choice retained refraction');
choice.hidden=false;await until(()=>has(choice),'Visible model choice did not restore refraction');
choice.style.backdropFilter='none';await until(()=>!has(choice),'Plain model choice skin allocated an unused filter');
choice.style.removeProperty('backdrop-filter');await until(()=>has(choice),'Restored model choice glass did not attach');
await reset();check(!has(choice),'Detached model choice retained an inline filter reference');

// A hidden node still has a layout box for visibility:hidden. Neither it nor a
// viewport-clipped node may spend a live filter slot.
const hidden=make();hidden.hidden=true;
const invisible=make();invisible.style.visibility='hidden';
const offscreen=make();offscreen.style.top='2000px';
const hiddenParent=document.createElement('div');hiddenParent.style.display='none';const nested=make();hiddenParent.append(nested);
zone.append(hidden,invisible,offscreen,hiddenParent);await paint();await delay(40);
check(!has(hidden) && !has(invisible) && !has(offscreen) && !has(nested) && count()===0,'Invisible surfaces allocated refraction');
hidden.hidden=false;await until(()=>has(hidden),'Programmatic hidden removal did not attach refraction');
hidden.hidden=true;await until(()=>!has(hidden),'Programmatic hidden addition did not remove refraction');
hiddenParent.style.display='block';await until(()=>has(nested),'Ancestor visibility change did not attach refraction');
hiddenParent.style.visibility='hidden';await until(()=>!has(nested),'Ancestor visibility change did not release refraction');
await reset();

// Popups have to work even after a crowded visible page has used the ordinary
// surface budget. Small separate boxes keep every candidate inside the viewport.
for(let i=0;i<110;i++){const node=make('lens','segmented-thumb');node.style.cssText='width:8px;height:8px;left:'+(20+i%22*20)+'px;top:'+(20+Math.floor(i/22)*20)+'px';zone.append(node)}
const popover=make();popover.dataset.popupKind='popover';popover.style.left='200px';
const modal=make('background','modal');modal.style.left='350px';
const toast=make('background','toast surface panel');toast.removeAttribute('data-lumi-glass');toast.style.cssText='left:500px;--lumi-glass-surface:0';zone.append(popover,modal,toast);
await until(()=>has(popover) && has(modal) && has(toast),'Crowded page starved popup refraction, or container surface flag excluded a toast');
check(count()<=96,'Live glass allocation exceeded its bounded budget');
await reset();

// Equivalent geometry shares the expensive raster encoding. Strength changes
// only alter SVG scale, and removing/readding a surface can reuse its texture.
const encodedBefore=fixture.encodes,nodes=Array.from({length:12},()=>make('surface'));
zone.append(...nodes);await until(()=>nodes.every(has),'Equivalent surfaces did not all attach');
await paint();check(fixture.encodes-encodedBefore<=1,'Equivalent surfaces encoded duplicate displacement textures');
const encodedAfter=fixture.encodes;
shell.style.setProperty('--lumi-glass-distortion','10');await paint();await delay(30);
check(fixture.encodes===encodedAfter,'Strength change rerasterized geometry');
await reset();const remounted=make('surface');zone.append(remounted);await until(()=>has(remounted),'Remounted surface missing refraction');
check(fixture.encodes===encodedAfter,'Remounted geometry bypassed texture cache');
remounted.style.width='117px';await until(()=>fixture.encodes>encodedAfter,'Geometry change reused a stale texture');
await paint();await delay(80);const idleFrames=fixture.frames;await delay(80);
check(fixture.frames===idleFrames,'Idle refraction runtime kept scheduling animation frames');

// SDK theme updates replace a stylesheet in head rather than a descendant of
// the glass root. They must refresh filters without an incidental body change.
const inlineStrength=shell.style.getPropertyValue('--lumi-glass-distortion'),inlineStrengthPriority=shell.style.getPropertyPriority('--lumi-glass-distortion');
shell.style.removeProperty('--lumi-glass-distortion');
const themeSheet=document.createElement('style');themeSheet.textContent='#shell{--lumi-glass-distortion:6}';document.head.append(themeSheet);await paint();
themeSheet.textContent='#shell{--lumi-glass-distortion:0}';await until(()=>count()===0 && !has(remounted),'Head stylesheet replacement did not disable refraction');
themeSheet.textContent='#shell{--lumi-glass-distortion:6}';await until(()=>has(remounted),'Head stylesheet replacement did not restore refraction');
themeSheet.remove();shell.style.setProperty('--lumi-glass-distortion',inlineStrength,inlineStrengthPriority);await paint();

// Regression: an opacity-zero entrance receives its geometry before
// the first painted visible frame. Paused and delayed finite animations need
// no permanent RAF polling; permanent hidden states and exits stay excluded.
await reset();
const paused=make('surface');paused.style.opacity='0';zone.append(paused);
const pausedMotion=paused.animate([{opacity:0},{opacity:1}],{duration:1000,fill:'both'});pausedMotion.pause();pausedMotion.currentTime=0;
await until(()=>has(paused),'Paused opacity entrance did not pre-register');
for(const progress of [.1,.5,.9]){pausedMotion.currentTime=progress*1000;await paint();check(has(paused),'Paused entrance lost filter at '+progress)}
pausedMotion.cancel();await until(()=>!has(paused),'Cancelled entrance retained an opacity-zero filter');
await reset();

const delayed=make('surface');delayed.style.cssText='opacity:0;animation:glass-enter 1s 10s both';zone.append(delayed);
await until(()=>has(delayed),'Finite delayed opacity entrance did not pre-register');
delayed.style.animation='none';await until(()=>!has(delayed),'Removed delayed entrance retained a filter');
const infinite=make('surface');infinite.style.opacity='0';zone.append(infinite);
const infiniteMotion=infinite.animate([{opacity:0},{opacity:1}],{duration:1000,iterations:Infinity,fill:'both'});infiniteMotion.pause();infiniteMotion.currentTime=0;
await paint();await delay(50);check(!has(infinite),'Infinite opacity animation allocated a hidden filter');
const outgoing=make('surface');outgoing.style.opacity='0';zone.append(outgoing);
const exitMotion=outgoing.animate([{opacity:1},{opacity:0}],{duration:1000,fill:'both'});exitMotion.pause();exitMotion.currentTime=1000;
await paint();await delay(50);check(!has(outgoing),'Opacity-zero exit allocated a filter');
const reverseExit=make('surface');reverseExit.style.opacity='0';zone.append(reverseExit);
const reverseMotion=reverseExit.animate([{opacity:0},{opacity:1}],{duration:1000,fill:'both',direction:'reverse'});reverseMotion.pause();reverseMotion.currentTime=1000;
await paint();await delay(50);check(!has(reverseExit),'Reversed entrance ending at zero allocated a filter');
const pseudo=make('surface');pseudo.style.opacity='0';zone.append(pseudo);
const pseudoMotion=pseudo.animate([{opacity:0},{opacity:1}],{duration:1000,fill:'both',pseudoElement:'::before'});pseudoMotion.pause();pseudoMotion.currentTime=0;
await paint();await delay(50);check(!has(pseudo),'Pseudo-element entrance bypassed its permanently hidden parent');
infiniteMotion.cancel();exitMotion.cancel();reverseMotion.cancel();pseudoMotion.cancel();await reset();

const enteringParent=document.createElement('div');enteringParent.style.cssText='opacity:0;animation:glass-enter 1s 10s both';
const enteringChild=make('surface');enteringParent.append(enteringChild);zone.append(enteringParent);
await until(()=>has(enteringChild),'Finite ancestor entrance did not pre-register child');
enteringParent.style.animation='none';await until(()=>!has(enteringChild),'Cancelled ancestor entrance retained hidden child');
await reset();

// Candidate membership must be refreshed on class changes and DOM replacement,
// while equivalent scroll frames can reuse the existing inventory.
const classChoice=document.createElement('div');classChoice.className='glass';zone.append(classChoice);await paint();
check(!has(classChoice),'Plain node allocated a class target');
classChoice.classList.add('model-choice','selected');await until(()=>has(classChoice),'Class-created target was absent from cached candidates');
classChoice.classList.remove('selected');await until(()=>!has(classChoice),'Class-removed target retained refraction');
classChoice.classList.add('selected');await until(()=>has(classChoice),'Class-restored target did not register');
await reset();

// A background pseudo-element can follow its containing block even when its
// owner's observed box remains unchanged. Scrolling must reuse correct geometry.
const parentBox=document.createElement('div');parentBox.style.cssText='position:relative;width:220px;height:90px';
const pseudoBox=make('background','background');pseudoBox.style.cssText='position:static;width:100px;height:50px';
parentBox.append(pseudoBox);zone.append(parentBox);await until(()=>has(pseudoBox),'Containing-block background did not register');
const imageFor=node=>document.getElementById(ref(node).match(/#([^"]+)/)[1]).querySelector('feImage');
await until(()=>Number(imageFor(pseudoBox).getAttribute('width'))===220,'Initial pseudo geometry used the owner box');
parentBox.style.width='280px';shell.dispatchEvent(new Event('scroll'));
await until(()=>Number(imageFor(pseudoBox).getAttribute('width'))===280,'Containing-block resize left stale pseudo geometry');
await reset();

// ResizeObserver detects layout changes while the entrance remains paused.
// A transform-only preview moves the same geometry without rebuilding its map.
const moving=make('lens');zone.append(moving);await until(()=>has(moving),'Moving lens did not register');
const encodesBeforeMove=fixture.encodes;moving.style.transform='translate(30px,5px)';await paint();await delay(30);
check(has(moving) && fixture.encodes===encodesBeforeMove,'Transform-only preview rerasterized geometry');
const widthMotion=moving.animate([{width:'100px'},{width:'180px'}],{duration:1000,fill:'both'});widthMotion.pause();widthMotion.currentTime=500;
await until(()=>Number(imageFor(moving).getAttribute('width'))===140,'Paused width motion left stale geometry');
widthMotion.currentTime=900;await until(()=>Number(imageFor(moving).getAttribute('width'))===172,'Width motion second frame left stale geometry');
widthMotion.cancel();await until(()=>Number(imageFor(moving).getAttribute('width'))===100,'Cancelled width motion left stale geometry');
await paint();await delay(80);const idleFramesAfterMotion=fixture.frames;await delay(80);
check(fixture.frames===idleFramesAfterMotion,'Glass runtime added idle RAF polling');
await reset();

// Accessibility disabling is reversible; there must be no stale SVG URL after
// the definitions have been released.
zone.append(remounted);await until(()=>has(remounted),'Accessibility fixture did not remount');
fixture.setMedia('(prefers-reduced-transparency: reduce)',true);await until(()=>count()===0 && !has(remounted),'Reduced transparency retained displacement');
fixture.setMedia('(prefers-reduced-transparency: reduce)',false);await until(()=>has(remounted),'Reduced transparency restoration did not attach');
fixture.setMedia('(forced-colors: active)',true);await until(()=>count()===0 && !has(remounted),'Forced colors retained displacement');
fixture.setMedia('(forced-colors: active)',false);await until(()=>has(remounted),'Forced colors restoration did not attach');

const original=make('surface');original.style.setProperty('--lumi-glass-filter','blur(1px)');zone.append(original);await until(()=>has(original),'Original inline-property fixture did not attach');
const disposalEntrance=make('surface');disposalEntrance.style.opacity='0';zone.append(disposalEntrance);const disposalMotion=disposalEntrance.animate([{opacity:0},{opacity:1}],{duration:1000,fill:'both'});disposalMotion.pause();disposalMotion.currentTime=0;await until(()=>has(disposalEntrance),'Disposal entrance was not registered');
fixture.dispose();check(count()===0 && !shell.querySelector('[data-lumi-glass-defs]') && !has(remounted),'Disposal retained definitions or dangling references');
check(original.style.getPropertyValue('--lumi-glass-filter')==='blur(1px)','Disposal discarded the original inline filter value');
const afterDispose=fixture.frames;disposalMotion.cancel();zone.append(make());await delay(80);check(fixture.frames===afterDispose,'Disposed runtime retained observers or entrance listeners');
check(!fixture.errors.length,'Glass runtime renderer errors '+fixture.errors.join(';'));
return {explicit:true,modelChoices:true,visibility:true,popupPriority:true,textureReuse:true,idle:true,stylesheetRefresh:true,accessibility:true,disposal:true,pausedEntrance:true,delayedEntrance:true,hiddenInfiniteExit:true,ancestorEntrance:true,classCandidateRefresh:true,pseudoGeometry:true,movingGeometry:true};
}.toString()+')()');console.log('GLASS_RUNTIME_UI_OK '+JSON.stringify(result));clearInterval(wake);clearTimeout(watchdog);win.destroy();app.exit(0);
}).catch(error=>{console.error(error.stack||error);app.exit(1)});
`);
  const env={...process.env};delete env.ELECTRON_RUN_AS_NODE;
  const child=spawn(electron,[path.join(directory,'audit.cjs')],{env,windowsHide:true,stdio:['ignore','pipe','pipe'],signal:t.signal});
  let output='';child.stdout.on('data',data=>{output+=data;process.stdout.write(data)});child.stderr.on('data',data=>{output+=data;process.stderr.write(data)});
  const code=await new Promise<number|null>((resolve,reject)=>{child.on('error',reject);child.on('close',resolve)});
  assert.equal(code,0,output);assert.match(output,/GLASS_RUNTIME_UI_OK/);
});
