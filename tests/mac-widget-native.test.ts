import test from 'node:test';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {execFile,spawn} from 'node:child_process';
import {promisify} from 'node:util';
import {mkdir,mkdtemp,writeFile,rm} from 'node:fs/promises';
import path from 'node:path';

test('macOS native glass loads, follows theme changes, and survives repeated window lifecycles',{skip:process.platform!=='darwin',timeout:60000},async t=>{
  const build=await promisify(execFile)(process.execPath,['scripts/build-native-widget-glass.mjs'],{cwd:process.cwd()});
  assert.match(build.stdout,/Built signed native macOS widget glass/);
  const electron:string=createRequire(import.meta.url)('electron');
  await mkdir('.test-data',{recursive:true});const dir=await mkdtemp(path.resolve('.test-data/mac-widget-native-'));
  t.after(()=>rm(dir,{recursive:true,force:true,maxRetries:5,retryDelay:100}));
  await writeFile(path.join(dir,'main.cjs'),String.raw`
const {app,BrowserWindow}=require('electron'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
for(const name of ['userData','sessionData','logs','crashDumps']){const directory=path.join(__dirname,name);fs.mkdirSync(directory,{recursive:true});app.setPath(name,directory);}
app.on('window-all-closed',()=>{});
app.whenReady().then(async()=>{
 const glass=require(process.argv[2]),supported=Number(process.getSystemVersion().split('.')[0])>=26;
 for(let lifecycle=0;lifecycle<3;lifecycle++){
   const win=new BrowserWindow({width:244,height:64,show:false,frame:false,transparent:true,backgroundColor:'#00000000',webPreferences:{sandbox:true,contextIsolation:true,nodeIntegration:false}});
   await win.loadURL('data:text/html,<html><body style="background:transparent">fixture</body></html>');
   const handle=win.getNativeWindowHandle();
   assert.throws(()=>glass.apply('bad',false));assert.throws(()=>glass.apply(Buffer.alloc(0),false));assert.throws(()=>glass.apply(handle,'dark'));
   for(let i=0;i<20;i++)assert.equal(glass.apply(handle,i%2===1),supported);
   const isolated=await win.webContents.executeJavaScript("typeof require==='undefined' && typeof window.lumi==='undefined'");assert.ok(isolated);
   assert.equal(win.isVisible(),false,'material must not show or focus the window');
   glass.remove(handle);glass.remove(handle);assert.equal(glass.apply(handle,false),supported);glass.remove(handle);
   win.destroy();
 }
 console.log('MAC_WIDGET_NATIVE_OK');app.exit(0);
}).catch(error=>{console.error(error.stack || error);app.exit(1);});`);
  const env={...process.env};delete env.ELECTRON_RUN_AS_NODE;
  const child=spawn(electron,[path.join(dir,'main.cjs'),path.resolve('dist-native/lumi-widget-glass.node')],{env,windowsHide:true,stdio:['ignore','pipe','pipe'],signal:t.signal});
  let output='';child.stdout.on('data',chunk=>output+=chunk);child.stderr.on('data',chunk=>output+=chunk);
  const code=await new Promise<number|null>((resolve,reject)=>{child.once('error',reject);child.once('close',resolve);});
  assert.equal(code,0,output);assert.match(output,/MAC_WIDGET_NATIVE_OK/);
});
