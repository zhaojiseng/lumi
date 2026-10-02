import test from 'node:test';
import assert from 'node:assert/strict';
import {build} from 'esbuild';
import {createRequire} from 'node:module';
import {existsSync} from 'node:fs';
import {mkdir,mkdtemp,readFile,writeFile,rm} from 'node:fs/promises';
import {spawn} from 'node:child_process';
import path from 'node:path';

test('Chromium renders bounded local sessions and isolates deferred detail reads across real React scope changes',{timeout:20000},async t=>{
  let electron:string;try{electron=createRequire(import.meta.url)('electron');}catch{return t.skip('Electron runtime unavailable');}
  if(!existsSync(electron))return t.skip('Electron runtime unavailable');
  const base=path.resolve('.test-data');await mkdir(base,{recursive:true});const root=await mkdtemp(path.join(base,'local-session-renderer-'));
  t.after(async()=>{const relative=path.relative(base,root);assert.ok(relative && !relative.startsWith('..') && !path.isAbsolute(relative));await rm(root,{recursive:true,force:true,maxRetries:5,retryDelay:100});});
  const renderer=await build({stdin:{contents:`
    import React,{useState} from 'react';
    import {createRoot} from 'react-dom/client';
    import {LocalSessions} from './src/components/LocalSessions';
    import {LocalSessionDetails} from './src/components/LocalSessionDetails';
    import {LocalUsageProgress} from './src/components/LocalUsageProgress';
    const summary={id:'session-a',tool:'codex',model:'gpt-5',startedAt:1790816700,updatedAt:1790816760,inputTokens:11,outputTokens:7,cacheReadTokens:5,cacheWriteTokens:3,requests:2};
    function Fixture(){
      const [scope,setScope]=useState({session:summary,query:{range:7},accountKey:'a'}),[open,setOpen]=useState(false);
      window.fixture.changeScope=patch=>setScope(previous=>({...previous,...patch}));
      window.fixture.open=()=>setOpen(true);window.fixture.close=()=>setOpen(false);
      return <main><LocalUsageProgress progress={{requestId:'uuid',phase:'read',filesDone:1,filesTotal:100,bytesRead:600,bytesTotal:1000}}/>
        <LocalSessions sessions={Array.from({length:65},(_,i)=>({...summary,id:'summary-'+i,updatedAt:summary.updatedAt+i}))} tool="all" scope="list" busy={false} stale={false} onOpen={()=>setOpen(true)}/>
        {open && <LocalSessionDetails {...scope} onClose={()=>setOpen(false)}/>}</main>;
    }
    createRoot(document.getElementById('root')).render(<Fixture/>);
  `,resolveDir:process.cwd(),sourcefile:'local-session-fixture.tsx',loader:'tsx'},bundle:true,platform:'browser',format:'iife',write:false,loader:{'.svg':'text'},define:{'process.env.NODE_ENV':'"production"'},logLevel:'silent'});
  await writeFile(path.join(root,'renderer.js'),renderer.outputFiles[0].contents);
  const css=await Promise.all(['src/styles.css','src/workbench.css','src/theme.css','src/local-usage.css'].map(file=>readFile(file,'utf8')));
  await writeFile(path.join(root,'fixture.css'),css.join('\n')+'\nbody{min-width:0;overflow:auto}main{padding:20px}');
  await writeFile(path.join(root,'fixture.html'),`<!doctype html><html><head><meta charset="utf-8"><link rel="stylesheet" href="fixture.css"></head><body><div id="root"></div><script>
    window.fixture={requests:[]};window.lumi={localSessionDetails:input=>new Promise((resolve,reject)=>window.fixture.requests.push({input,resolve,reject}))};
  </script><script src="renderer.js"></script></body></html>`);
  await writeFile(path.join(root,'audit.cjs'),String.raw`
const {app,BrowserWindow}=require('electron'),path=require('node:path'),fs=require('node:fs');
for(const name of ['userData','sessionData','logs','crashDumps']){const folder=path.join(__dirname,name);fs.mkdirSync(folder,{recursive:true});app.setPath(name,folder);}
app.disableHardwareAcceleration();
app.whenReady().then(async()=>{
  const win=new BrowserWindow({width:900,height:720,useContentSize:true,show:false,webPreferences:{sandbox:true,contextIsolation:true,nodeIntegration:false,offscreen:true,backgroundThrottling:false}});
  await win.loadFile(path.join(__dirname,'fixture.html'));
  const result=await win.webContents.executeJavaScript('('+async function audit(){
    const check=(value,message)=>{if(!value)throw new Error(message);};
    const until=async predicate=>{const deadline=performance.now()+3500;while(!predicate()){if(performance.now()>deadline)throw new Error('Local UI did not settle');await new Promise(resolve=>setTimeout(resolve,10));}};
    const click=label=>{const button=[...document.querySelectorAll('button')].find(node=>node.textContent===label);check(button,'Missing '+label);button.click();};
    const rows=()=>document.querySelectorAll('.local-session-records tbody tr');
    const record=i=>({id:'r-'+i,created_at:1790816700+i,model:'model-'+i,inputTokens:11,outputTokens:7,cacheReadTokens:5,cacheWriteTokens:3,contextTokens:128000,reasoning:'high'});
    const resolve=(index,items,nextCursor)=>fixture.requests[index].resolve({items,nextCursor,scannedBytes:(index+1)*1024,totalBytes:8192});
    await until(()=>document.querySelectorAll('.local-sessions tbody tr').length===20);
    const bar=document.querySelector('.local-usage-progress-track'),fill=bar.querySelector('i');check(Math.abs(fill.getBoundingClientRect().width/bar.getBoundingClientRect().width-.6)<.01,'Progress must use bytes');
    click('再显示 20 条');await until(()=>document.querySelectorAll('.local-sessions tbody tr').length===40);
    click('查看用量');await until(()=>fixture.requests.length===1);
    resolve(0,[record(1)],'cursor-1');await until(()=>rows().length===1);
    const modal=document.querySelector('.local-session-details').getBoundingClientRect();check(modal.left>=0 && modal.right<=innerWidth,'Modal fits viewport');
    click('继续读取');await until(()=>fixture.requests.length===2);fixture.changeScope({accountKey:'b'});await until(()=>fixture.requests.length===3);
    check(rows().length===0,'Account switch clears old rows');resolve(1,[record(999)]);resolve(2,[record(2)],'cursor-2');await until(()=>rows().length===1);
    check(!document.querySelector('.local-session-details').textContent.includes('model-999'),'Late account response is ignored');
    click('继续读取');await until(()=>fixture.requests.length===4);fixture.changeScope({query:{range:1}});await until(()=>fixture.requests.length===5);
    check(rows().length===0,'Query switch clears old rows');resolve(3,[record(998)]);resolve(4,[record(3)],'cursor-3');await until(()=>rows().length===1);
    click('继续读取');await until(()=>fixture.requests.length===6);fixture.changeScope({session:{id:'session-b',tool:'claude',model:'claude-sonnet',startedAt:1790816700,updatedAt:1790816760}});await until(()=>fixture.requests.length===7);
    check(rows().length===0,'Session switch clears old rows');fixture.requests[5].reject(new Error('Late failed page'));
    resolve(6,Array.from({length:50},(_,i)=>record(i)),'cursor-7');await until(()=>rows().length===50);
    for(let i=1;i<5;i++){click('继续读取');await until(()=>fixture.requests.length===7+i);resolve(6+i,Array.from({length:50},(_,j)=>record(i*50+j)),i<4 ? 'cursor-'+(7+i) : undefined);await until(()=>rows().length===Math.min(200,(i+1)*50) && rows()[rows().length-1].textContent.includes('model-'+((i+1)*50-1)));}
    const details=document.querySelector('.local-session-details');check(details.textContent.includes('仅显示最近 200 条调用'),'Window cap is explained');check(!details.textContent.includes('model-998'),'Late query response is ignored');check(!details.textContent.includes('Late failed page'),'Late session error is ignored');
    const bounded=rows().length,scroll=document.querySelector('.local-session-records').getBoundingClientRect();check(scroll.height<=460,'Table has a bounded scroll region');
    fixture.close();await until(()=>!document.querySelector('[role="dialog"]'));
    return {initial:20,expanded:40,bounded,modalWidth:modal.width,scrollHeight:scroll.height,requestCount:fixture.requests.length};
  }.toString()+')()');
  console.log('LOCAL_SESSION_RENDERER_RESULT '+JSON.stringify(result));win.destroy();app.exit(0);
}).catch(error=>{console.error(error.stack || error);app.exit(1);});
`);
  const env={...process.env};delete env.ELECTRON_RUN_AS_NODE;
  const child=spawn(electron,[path.join(root,'audit.cjs')],{env,windowsHide:true,stdio:['ignore','pipe','pipe'],signal:t.signal});
  let stdout='',stderr='';child.stdout.on('data',chunk=>stdout+=chunk);child.stderr.on('data',chunk=>stderr+=chunk);
  const code=await new Promise<number|null>((resolve,reject)=>{child.once('error',reject);child.once('close',resolve);});assert.equal(code,0,stderr);
  const line=stdout.split(/\r?\n/).find(line=>line.startsWith('LOCAL_SESSION_RENDERER_RESULT '));assert.ok(line,stdout+stderr);
  const result=JSON.parse(line.slice('LOCAL_SESSION_RENDERER_RESULT '.length));assert.equal(result.bounded,200);assert.equal(result.requestCount,11);
});
