import test from 'node:test';
import assert from 'node:assert/strict';
import {build} from 'esbuild';
import {createRequire} from 'node:module';
import {runInNewContext} from 'node:vm';
import * as React from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import {formatBytes,updateDownloadDisplay} from '../shared/bytes';
import {DEFAULT_PREFERENCES,type UpdateState} from '../shared/types';

const KB=1024,MB=KB*1024,GB=MB*1024;
type DisplayState=UpdateState & {packageSize?:number};
function state(patch:Partial<DisplayState>={}):DisplayState {
  return {phase:'downloading',currentVersion:'0.4.27',version:'0.4.28',received:1.75*MB,total:3.5*MB,packageSize:144*MB,...patch};
}

test('byte formatting uses binary B/KB/MB/GB with readable precision for small downloads',()=>{
  for(const [bytes,label] of [
    [0,'0 B'],[1,'1 B'],[4,'4 B'],[43,'43 B'],[1023,'1023 B'],
    [KB,'1 KB'],[1.25*KB,'1.25 KB'],[1.5*KB,'1.5 KB'],[12.5*KB,'12.5 KB'],[128*KB,'128 KB'],
    [MB,'1 MB'],[1.75*MB,'1.75 MB'],[12.5*MB,'12.5 MB'],[144*MB,'144 MB'],
    [GB,'1 GB'],[1.25*GB,'1.25 GB'],[2*GB,'2 GB'],[1024*GB,'1024 GB'],
  ] as const)assert.equal(formatBytes(bytes),label);
  assert.equal(formatBytes(MB-1),'1 MB');
  for(const bytes of [-1,NaN,Infinity,-Infinity])assert.equal(formatBytes(bytes),'0 B');
});

test('a real differential transfer uses 3.5 MB of network data for a 144 MB installer',()=>{
  const display=updateDownloadDisplay(state());
  assert.equal(display.percent,50);
  assert.equal(display.downloadLabel,'已下载 1.75 MB / 需下载 3.5 MB');
  assert.equal(display.packageLabel,'增量下载 · 安装包 144 MB');
  assert.equal(display.isDifferential,true);
});

test('small and full downloads retain the actual transfer bytes without a differential label',()=>{
  const small=updateDownloadDisplay(state({received:4,total:43,packageSize:43}));
  assert.equal(small.percent,4/43*100);
  assert.equal(small.downloadLabel,'已下载 4 B / 需下载 43 B');
  assert.equal(small.packageLabel,'安装包 43 B');
  assert.equal(small.isDifferential,false);
  const full=updateDownloadDisplay(state({received:64*MB,total:128*MB,packageSize:128*MB}));
  assert.equal(full.percent,50);
  assert.equal(full.downloadLabel,'已下载 64 MB / 需下载 128 MB');
  assert.equal(full.packageLabel,'安装包 128 MB');
  assert.equal(full.isDifferential,false);
});

test('verification preserves the network transfer size while describing the full installer separately',()=>{
  const differential=updateDownloadDisplay(state({phase:'verifying',received:3.5*MB}));
  assert.equal(differential.percent,100);
  assert.equal(differential.downloadLabel,'已下载 3.5 MB / 需下载 3.5 MB');
  assert.equal(differential.packageLabel,'增量下载 · 安装包 144 MB');
  const full=updateDownloadDisplay(state({phase:'verifying',received:128*MB,total:128*MB,packageSize:128*MB}));
  assert.equal(full.percent,100);
  assert.equal(full.downloadLabel,'已下载 128 MB / 需下载 128 MB');
  assert.equal(full.packageLabel,'安装包 128 MB');
});

test('unknown totals never substitute package size or manufacture a completion percentage',()=>{
  for(const phase of ['downloading','verifying','ready'] as const)for(const total of [0,-1,NaN,Infinity]){
    const display=updateDownloadDisplay(state({phase,total}));
    assert.equal(display.percent,null);
    assert.equal(display.downloadLabel,'已下载 1.75 MB / 总量未知');
    assert.equal(display.packageLabel,'安装包 144 MB');
    assert.equal(display.isDifferential,false);
  }
  assert.equal(updateDownloadDisplay(state({received:0})).percent,0);
  assert.equal(updateDownloadDisplay(state({received:10*MB})).percent,100);
  for(const received of [-1,NaN,Infinity]){
    const display=updateDownloadDisplay(state({received}));
    assert.equal(display.percent,0);
    assert.equal(display.downloadLabel,'已下载 0 B / 需下载 3.5 MB');
  }
});

test('legacy states without packageSize still show full package sizes and honest unknown totals',()=>{
  for(const phase of ['available','downloading','verifying','ready'] as const){
    const legacy:UpdateState={phase,currentVersion:'0.4.27',version:'0.4.28',received:64*MB,total:128*MB};
    const display=updateDownloadDisplay(legacy);
    assert.equal(display.percent,50);
    assert.equal(display.packageLabel,'安装包 128 MB');
    assert.equal(display.isDifferential,false);
  }
  const unknown=updateDownloadDisplay(state({packageSize:undefined,total:0}));
  assert.equal(unknown.percent,null);
  assert.equal(unknown.packageLabel,'安装包 大小未知');
  for(const packageSize of [0,-1,NaN,Infinity])assert.equal(updateDownloadDisplay(state({packageSize})).packageLabel,'安装包 大小未知');
});

// Render both real components in memory. Effects and bridge actions never run.
const rendererBundle=build({
  stdin:{contents:"export {UpdateDialogProvider} from './src/components/UpdateDialog'; export {UpdateNotice} from './src/components/UpdateNotice'; export {AppContext} from './src/context';",resolveDir:process.cwd(),loader:'tsx'},
  bundle:true,platform:'node',format:'cjs',write:false,external:['react','react/jsx-runtime'],loader:{'.svg':'text'},logLevel:'silent',
});
async function renderUpdate(current:DisplayState){
  const result=await rendererBundle,nodeRequire=createRequire(import.meta.url);
  let stateCalls=0;
  const react={...React,useState:(initial:unknown)=>{
    const call=stateCalls++;
    return React.useState(call===0 ? current : call===1 ? true : initial);
  }};
  const module={exports:{} as Record<string,any>};
  runInNewContext(result.outputFiles[0].text,{module,exports:module.exports,structuredClone,window:{lumi:{}},require:(name:string)=>name==='react' ? react : nodeRequire(name)});
  const {UpdateDialogProvider,UpdateNotice,AppContext}=module.exports;
  const html=renderToStaticMarkup(React.createElement(AppContext.Provider,{value:{preferences:DEFAULT_PREFERENCES,updatePreferences:async()=>{},toast:()=>{}}},React.createElement(UpdateDialogProvider,null,React.createElement(UpdateNotice))));
  const modalStart=html.indexOf('<div class="modal-overlay"');
  assert.ok(modalStart>0);
  return {notice:html.slice(0,modalStart),dialog:html.slice(modalStart)};
}

test('sidebar and release dialog show the same differential transfer and installer sizes',async()=>{
  const rendered=await renderUpdate(state());
  for(const html of Object.values(rendered)){
    assert.ok(html.includes('已下载 1.75 MB / 需下载 3.5 MB'));
    assert.ok(html.includes('增量下载 · 安装包 144 MB'));
    assert.ok(html.includes('aria-valuenow="50"'));
    assert.ok(html.includes('width:50%'));
  }
  assert.ok(rendered.notice.includes('class="update-download-details"'));
  assert.ok(rendered.dialog.includes('class="release-download-details"'));
});

test('both UIs keep byte-sized and full downloads readable',async()=>{
  for(const [current,downloadLabel,packageLabel] of [
    [state({received:4,total:43,packageSize:43}),'已下载 4 B / 需下载 43 B','安装包 43 B'],
    [state({received:64*MB,total:128*MB,packageSize:128*MB}),'已下载 64 MB / 需下载 128 MB','安装包 128 MB'],
  ] as const)for(const html of Object.values(await renderUpdate(current))){
    assert.ok(html.includes(downloadLabel));
    assert.ok(html.includes(packageLabel));
    assert.ok(!html.includes('增量下载') && !html.includes('0.0 MB'));
  }
});

test('unknown transfers are indeterminate in both UIs and have no numeric percentage',async()=>{
  for(const html of Object.values(await renderUpdate(state({total:0})))){
    assert.ok(html.includes('已下载 1.75 MB / 总量未知'));
    assert.ok(html.includes('安装包 144 MB'));
    assert.ok(html.includes('class="update-progress indeterminate"'));
    assert.ok(!html.includes('aria-valuenow='));
    assert.ok(!/下载(?:中)?\s*\d+%/.test(html));
    assert.ok(!html.includes('width:100%'));
  }
});

test('verification says installer verification and does not present a download progress bar',async()=>{
  for(const current of [state({phase:'verifying',received:3.5*MB}),state({phase:'verifying',total:0})]){
    for(const html of Object.values(await renderUpdate(current))){
      assert.ok(html.includes('正在校验安装包'));
      assert.ok(html.includes('安装包 144 MB'));
      assert.ok(!html.includes('已下载 144 MB'));
      assert.ok(!html.includes('role="progressbar"'));
      assert.ok(!html.includes('100%'));
    }
  }
});

test('available updates display installer size in the sidebar and release dialog, including legacy states',async()=>{
  for(const current of [state({phase:'available',received:0,total:0}),state({phase:'available',received:0,total:144*MB,packageSize:undefined})]){
    for(const html of Object.values(await renderUpdate(current))){
      assert.ok(html.includes('安装包 144 MB'));
      assert.ok(!html.includes('已下载') && !html.includes('增量下载'));
      assert.ok(!html.includes('role="progressbar"'));
    }
  }
});

test('a ready differential update keeps the transfer and reconstructed package sizes separate',async()=>{
  const rendered=await renderUpdate(state({phase:'ready',received:3.5*MB}));
  assert.ok(rendered.notice.includes('已校验'));
  assert.ok(rendered.dialog.includes('已下载 3.5 MB / 需下载 3.5 MB'));
  for(const html of Object.values(rendered)){
    assert.ok(html.includes('增量下载 · 安装包 144 MB'));
    assert.ok(!html.includes('role="progressbar"'));
  }
});

test('a reused local installer without progress shows package verification instead of zero-byte download',async()=>{
  for(const phase of ['verifying','ready'] as const){
    const current=state({phase,received:0,total:0}),display=updateDownloadDisplay(current);
    assert.equal(display.percent,null);
    assert.equal(display.showTransfer,false);
    assert.equal(display.packageLabel,'安装包 144 MB');
    const rendered=await renderUpdate(current);
    for(const html of Object.values(rendered)){
      assert.ok(html.includes('安装包 144 MB'));
      assert.ok(html.includes(phase==='verifying' ? '正在校验安装包' : '已校验'));
      assert.ok(!html.includes('已下载') && !html.includes('需下载') && !html.includes('总量未知'));
      assert.ok(!html.includes('role="progressbar"') && !html.includes('aria-valuenow='));
      assert.ok(!html.includes('0 B') && !html.includes('0%'));
    }
  }
});
