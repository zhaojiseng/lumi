import test from 'node:test';
import assert from 'node:assert/strict';
import {build} from 'esbuild';
import {mkdir,mkdtemp,writeFile,readFile,rm} from 'node:fs/promises';
import {existsSync} from 'node:fs';
import path from 'node:path';
import {spawn} from 'node:child_process';
import {createRequire} from 'node:module';

test('real dialogs animate dismissal, retain nested focus, reopen safely and revoke old scope immediately',{timeout:30000},async t=>{
  let electron:string;try{electron=createRequire(import.meta.url)('electron');}catch{return t.skip('Electron unavailable');}if(!existsSync(electron))return t.skip('Electron unavailable');
  await mkdir('.test-data',{recursive:true});const directory=await mkdtemp(path.resolve('.test-data/modal-close-'));t.after(()=>rm(directory,{recursive:true,force:true,maxRetries:5,retryDelay:100}));
  const output=await build({stdin:{resolveDir:process.cwd(),loader:'tsx',contents:`import React,{useState} from 'react';import {createRoot} from 'react-dom/client';import {flushSync} from 'react-dom';import {Modal,Button} from './src/components/ui';import {ModalPresence,ModalScope} from './src/components/ModalPresence';
window.fixture={reduced:false,errors:[],act:flushSync};const media=window.matchMedia.bind(window);window.matchMedia=query=>query.includes('prefers-reduced-motion') ? {matches:fixture.reduced} : media(query);window.addEventListener('error',event=>fixture.errors.push(event.message));
function App(){const [open,setOpen]=useState(false),[nested,setNested]=useState(false),[scope,setScope]=useState('account-a');fixture.revoke=()=>{setScope('account-b');setOpen(false);};return <ModalScope scope={scope}><Button id="trigger" onClick={()=>setOpen(true)}>Open</Button><ModalPresence>{open && <Modal title="Parent" onClose={()=>setOpen(false)}><input aria-label="Draft" defaultValue="private fixture"/><Button id="nested-trigger" onClick={()=>setNested(true)}>Nested</Button><Button id="cancel" onClick={()=>setOpen(false)}>Cancel</Button><ModalPresence>{nested && <Modal title="Nested" onClose={()=>setNested(false)}><input aria-label="Nested draft"/></Modal>}</ModalPresence></Modal>}</ModalPresence></ModalScope>;}createRoot(document.getElementById('root')).render(<App/>);`},bundle:true,platform:'browser',format:'esm',write:false,loader:{'.svg':'text'},define:{'process.env.NODE_ENV':'"production"'},logLevel:'silent'});
  await writeFile(path.join(directory,'app.js'),output.outputFiles[0].contents);
  const styles=await Promise.all(['styles.css','theme-tokens.css','theme.css','filters-tools-motion.css'].map(file=>readFile(path.resolve('src',file),'utf8')));await writeFile(path.join(directory,'style.css'),styles.join('\n'));
  await writeFile(path.join(directory,'index.html'),'<html><head><meta charset="UTF-8"><link rel="stylesheet" href="style.css"></head><body><div id="root"></div><script type="module" src="app.js"></script></body></html>');
  await writeFile(path.join(directory,'main.cjs'),String.raw`
const {app,BrowserWindow}=require('electron'),fs=require('node:fs'),path=require('node:path');for(const name of ['userData','sessionData','logs','crashDumps']){const dir=path.join(__dirname,name);fs.mkdirSync(dir,{recursive:true});app.setPath(name,dir);}app.disableHardwareAcceleration();app.whenReady().then(async()=>{
const win=new BrowserWindow({width:1100,height:800,show:false,webPreferences:{sandbox:true,contextIsolation:true,nodeIntegration:false,backgroundThrottling:false}});await win.loadFile(path.join(__dirname,'index.html'));
const result=await win.webContents.executeJavaScript('('+async function(){
const check=(value,label)=>{if(!value)throw new Error(label);},until=async fn=>{const end=performance.now()+5000;while(!fn()){if(performance.now()>end)throw new Error('Dialog timeout: '+fn);await new Promise(resolve=>setTimeout(resolve,10));}},settle=()=>new Promise(resolve=>setTimeout(resolve,20));
await until(()=>document.querySelector('#trigger'));const trigger=document.querySelector('#trigger'),open=async()=>{trigger.focus();trigger.click();await until(()=>document.querySelector('[aria-label="Parent"]'));await new Promise(resolve=>setTimeout(resolve,200));};
await open();const nestedTrigger=document.querySelector('#nested-trigger');nestedTrigger.focus();nestedTrigger.click();await until(()=>document.activeElement?.closest('[aria-label="Nested"]'));
fixture.act(()=>document.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true})));
const nested=document.querySelector('[aria-label="Nested"]');check(nested?.closest('[data-modal-phase="exiting"]')?.inert,'Nested dialog disappeared before exit or remained interactive');
await until(()=>!document.querySelector('[aria-label="Nested"]'));check(document.activeElement===nestedTrigger,'Nested dismissal lost parent focus');
fixture.act(()=>document.querySelector('#cancel').click());const closing=document.querySelector('[aria-label="Parent"]')?.closest('[data-modal-phase="exiting"]');check(closing?.inert,'Cancel button bypassed dismissal animation');
const animations=closing.getAnimations();check(animations.length>0,'Dismissal has no animation');animations.forEach(animation=>{animation.pause();animation.currentTime=80;});check(Number(getComputedStyle(closing).opacity)>0 && Number(getComputedStyle(closing).opacity)<1,'Dismissal did not render intermediate opacity');
fixture.act(()=>trigger.click());await until(()=>document.querySelector('[aria-label="Parent"]')?.closest('[data-modal-phase="open"]'));await new Promise(resolve=>setTimeout(resolve,300));check(document.querySelector('[aria-label="Parent"]'),'Old exit removed a reopened dialog');
document.querySelector('[aria-label="Parent"] [aria-label="关闭弹窗"]').click();await until(()=>!document.querySelector('[aria-label="Parent"]'));check(document.activeElement===trigger,'Header dismissal lost trigger focus');
await open();document.querySelector('[aria-label="Parent"]').closest('.modal-overlay').dispatchEvent(new MouseEvent('mousedown',{bubbles:true}));await until(()=>document.querySelector('[data-modal-phase="exiting"]'));await until(()=>!document.querySelector('[role="dialog"]'));check(document.activeElement===trigger,'Backdrop dismissal lost trigger focus');
await open();fixture.act(()=>fixture.revoke());check(!document.querySelector('[role="dialog"]'),'Account revocation retained private content');
await open();fixture.reduced=true;document.querySelector('#cancel').click();await settle();check(!document.querySelector('[role="dialog"]'),'Reduced motion retained dialog');fixture.reduced=false;
await open();const css=document.createElement('style');css.textContent='*{animation:none!important}';document.head.append(css);document.querySelector('#cancel').click();await settle();check(!document.querySelector('[role="dialog"]'),'Disabled animations left an inert overlay');
check(fixture.errors.length===0,'Renderer errors '+fixture.errors);return {nested:true,reopened:true,revoked:true,reduced:true};
}.toString()+')()');console.log('MODAL_RESULT '+JSON.stringify(result));win.destroy();app.exit(0);}).catch(error=>{console.error(error.stack || error);app.exit(1)});`);
  const env={...process.env};delete env.ELECTRON_RUN_AS_NODE;const child=spawn(electron,[path.join(directory,'main.cjs')],{env,windowsHide:true,stdio:['ignore','pipe','pipe'],signal:t.signal});let stdout='',stderr='';child.stdout.on('data',chunk=>stdout+=chunk);child.stderr.on('data',chunk=>stderr+=chunk);
  const code=await new Promise<number|null>((resolve,reject)=>{child.on('error',reject);child.on('close',resolve);});assert.equal(code,0,stderr+stdout);assert.match(stdout,/MODAL_RESULT.*"nested":true.*"reopened":true.*"revoked":true.*"reduced":true/);
});
