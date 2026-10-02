import test from 'node:test';
import assert from 'node:assert/strict';
import {existsSync} from 'node:fs';
import {mkdir,mkdtemp,writeFile,rm} from 'node:fs/promises';
import path from 'node:path';
import {createRequire} from 'node:module';
import {spawn} from 'node:child_process';
import {build} from 'esbuild';
import {normalizeCodexUsage} from '../plugins/provider.codex/services/normalize';

test('real Workbench and Usage compose independent sources without New API or AppContext',{timeout:20000},async t=>{
  let electron:string;try{electron=createRequire(import.meta.url)('electron');}catch{return t.skip('Electron runtime unavailable');}if(!existsSync(electron))return t.skip('Electron runtime unavailable');
  const base=path.resolve('.test-data');await mkdir(base,{recursive:true});const root=await mkdtemp(path.join(base,'workbench-sources-'));t.after(()=>rm(root,{recursive:true,force:true,maxRetries:5,retryDelay:100}));
  const renderer=await build({stdin:{contents:`
    import React,{useState} from 'react';import {createRoot} from 'react-dom/client';
    import Workbench from './plugins/feature.workbench/renderer/Page';import Usage from './plugins/feature.usage/renderer/Page';
    import {WorkbenchProvider} from './src/host/workbench';import {UsageProvider} from './src/host/usage';
    import {SourcePreferencesProvider} from './src/host/source-preferences';import {workbenchContributions,usageContributions} from './src/host/renderer-registry';
    import {builtinManifests} from './plugins/manifests';
    function Fixture(){
      const [enabled,setEnabled]=useState(true),[site,setSite]=useState('a'),[page,setPage]=useState('workbench');
      const [selections,setSelections]=useState({'feature.usage':{tab:'local'}});
      fixture.enable=setEnabled;fixture.site=setSite;fixture.page=setPage;
      const statuses=builtinManifests.map(manifest=>({manifest,state:manifest.id==='provider.newapi' || manifest.id==='provider.codex' && !enabled ? 'disabled' : 'active'}));
      return <SourcePreferencesProvider value={{selections,desktop:true,onError:message=>fixture.errors.push(message),update:async patch=>{fixture.patches.push(patch);const {sourceId,values}=patch.sourceSelection;setSelections(current=>({...current,[sourceId]:{...current[sourceId],...values}}));}}}><WorkbenchProvider value={{cards:workbenchContributions(statuses),siteScope:site,refreshInterval:0,refreshEpoch:0}}><UsageProvider value={{views:usageContributions(statuses),siteScope:site}}>{page==='workbench' ? <Workbench/> : <Usage/>}</UsageProvider></WorkbenchProvider></SourcePreferencesProvider>;
    }
    createRoot(document.getElementById('root')).render(<Fixture/>);
  `,resolveDir:process.cwd(),loader:'tsx'},bundle:true,platform:'browser',format:'iife',write:false,loader:{'.css':'empty','.svg':'text'},define:{'process.env.NODE_ENV':'"production"'},logLevel:'silent'});
  await writeFile(path.join(root,'renderer.js'),renderer.outputFiles[0].contents);
  const snapshot=normalizeCodexUsage({account:{type:'chatgpt',email:'fixture@example.invalid',planType:'plus'}},{rateLimits:{primary:{usedPercent:20,windowDurationMins:300},secondary:{usedPercent:71,windowDurationMins:10080},credits:{balance:'17.25'}}},'fixture');
  await writeFile(path.join(root,'index.html'),`<!doctype html><html><body><div id="root"></div><script>
    window.fixture={reads:[],localReads:[],patches:[],errors:[],snapshot:${JSON.stringify(snapshot)}};
    window.addEventListener('error',event=>fixture.errors.push(event.message));window.addEventListener('unhandledrejection',event=>fixture.errors.push(String(event.reason)));
    window.lumi={readCodexUsage:input=>new Promise(resolve=>fixture.reads.push({input,resolve})),localUsage:async query=>{fixture.localReads.push(query);return {rows:[],points:[],sessions:[],warnings:[],filesScanned:0,scannedAt:Date.now()};},onLocalUsageProgress:()=>()=>{}};
  </script><script src="renderer.js"></script></body></html>`);
  await writeFile(path.join(root,'audit.cjs'),String.raw`
    const {app,BrowserWindow}=require('electron'),path=require('node:path'),fs=require('node:fs');
    for(const name of ['userData','sessionData','logs','crashDumps']){const directory=path.join(__dirname,name);fs.mkdirSync(directory,{recursive:true});app.setPath(name,directory);}
    app.whenReady().then(async()=>{const win=new BrowserWindow({show:false,webPreferences:{nodeIntegration:false,contextIsolation:true,sandbox:true}});await win.loadFile(path.join(__dirname,'index.html'));
      const result=await win.webContents.executeJavaScript('('+async function(){
        const until=async(predicate,label)=>{const end=performance.now()+4000;while(!predicate()){if(performance.now()>end)throw new Error(label);await new Promise(resolve=>setTimeout(resolve,10));}};
        const check=(condition,label)=>{if(!condition)throw new Error(label);},body=()=>document.getElementById('root').textContent;
        await until(()=>fixture.reads.length===1,'Codex independently reads');fixture.reads[0].resolve(fixture.snapshot);
        await until(()=>body().includes('29%') && body().includes('17.25'),'Weekly and credit cards render without New API login');
        check(body().includes('周限额') && !body().includes('账号密码登录'),'No global New API gate');
        const card=document.querySelector('[aria-label="Codex 订阅用量"]');fixture.site('b');await new Promise(r=>setTimeout(r,50));check(card===document.querySelector('[aria-label="Codex 订阅用量"]') && fixture.reads.length===1,'Site changes retain Codex card and read owner');
        Array.from(document.querySelectorAll('button')).find(button=>button.textContent.includes('刷新用量')).click();await until(()=>fixture.reads.length===2,'Manual refresh started');
        fixture.enable(false);await until(()=>!document.querySelector('[aria-label="Codex 订阅用量"]'),'Provider disabled contribution gone');fixture.reads[1].resolve({...fixture.snapshot,windows:[]});
        fixture.enable(true);await until(()=>fixture.reads.length===3,'Provider reenable creates fresh read');check(!body().includes('17.25'),'Old quota not leaked');fixture.reads[2].resolve(fixture.snapshot);await until(()=>body().includes('17.25'),'New generation shows quota');
        fixture.page('usage');await until(()=>fixture.localReads.length===1 && body().includes('本地模型用量'),'Local UI without Dashboard');
        check(fixture.localReads[0].tokenIds.length===0,'Local source never inherits online token filters');
        fixture.site('c');await new Promise(r=>setTimeout(r,50));check(fixture.localReads.length===1,'Local scan unaffected by site change');
        Array.from(document.querySelectorAll('button')).find(button=>button.textContent==='30 天').click();await until(()=>fixture.localReads.length===2,'Independent range triggers local scan');check(fixture.localReads[1].range===30 && fixture.patches.at(-1).sourceSelection.sourceId==='source.local-sessions','Source scoped persistence');
        check(fixture.errors.length===0,'No renderer errors: '+fixture.errors.join(','));return {codexReads:fixture.reads.length,localReads:fixture.localReads.length};
      }.toString()+')()');console.log('SOURCES_RESULT '+JSON.stringify(result));win.destroy();app.exit(0);
    }).catch(error=>{console.error(error.stack || error);app.exit(1);});
  `);
  const env={...process.env};delete env.ELECTRON_RUN_AS_NODE;
  const child=spawn(electron,[path.join(root,'audit.cjs')],{env,windowsHide:true,stdio:['ignore','pipe','pipe'],signal:t.signal});let stdout='',stderr='';child.stdout.on('data',chunk=>stdout+=chunk);child.stderr.on('data',chunk=>stderr+=chunk);
  const code=await new Promise<number|null>((resolve,reject)=>{child.once('error',reject);child.once('close',resolve);});assert.equal(code,0,stderr);
  const result=stdout.split(/\r?\n/).find(line=>line.startsWith('SOURCES_RESULT '));assert.ok(result,stdout);assert.deepEqual(JSON.parse(result.slice('SOURCES_RESULT '.length)),{codexReads:3,localReads:2});
});
