import test from 'node:test';
import assert from 'node:assert/strict';
import {build} from 'esbuild';
import {createRequire} from 'node:module';
import {existsSync} from 'node:fs';
import {mkdir,mkdtemp,readFile,writeFile,rm} from 'node:fs/promises';
import {spawn} from 'node:child_process';
import path from 'node:path';

test('Chromium keeps donut totals on the actual pie center and trend selects vertically centered', {timeout:20000},async t=>{
  let electron:string;
  try{electron=createRequire(import.meta.url)('electron');}catch{return t.skip('Electron runtime unavailable');}
  if(!existsSync(electron))return t.skip('Electron runtime unavailable');
  await mkdir('.test-data',{recursive:true});
  const root=await mkdtemp(path.resolve('.test-data/overview-layout-'));
  t.after(async()=>{
    const relative=path.relative(path.resolve('.test-data'),root);
    assert.ok(relative && !relative.startsWith('..') && !path.isAbsolute(relative));
    await rm(root,{recursive:true,force:true,maxRetries:5,retryDelay:100});
  });
  const renderer=await build({stdin:{contents:`
    import React from 'react';
    import {createRoot} from 'react-dom/client';
    import {ModelDonut} from './src/components/charts';
    import {Select} from './src/components/Select';
    createRoot(document.getElementById('root')).render(<>
      <section className="surface panel distribution-panel" style={{height:340,width:224}}>
        <div className="section-heading"><h3>模型分布</h3></div>
        <div className="distribution-content"><ModelDonut data={[{name:'one',value:1},{name:'two',value:1}]} total="$12.34" symbol="$"/></div>
        <button className="panel-bottom-link">探索用量详情</button>
      </section>
      <div className="trend-controls">
        <Select label="分组" value="model" decorated={false} onChange={()=>{}}><option value="model">按模型</option></Select>
        <Select label="系列" value="all" decorated={false} onChange={()=>{}}><option value="all">全部模型</option></Select>
      </div>
    </>);`,resolveDir:process.cwd(),sourcefile:'fixture.tsx',loader:'tsx'},bundle:true,platform:'browser',format:'iife',write:false,
    define:{'process.env.NODE_ENV':'"production"'},logLevel:'silent'});
  await writeFile(path.join(root,'renderer.js'),renderer.outputFiles[0].contents);
  const css=await Promise.all(['src/styles.css','src/workbench.css','src/select.css','src/theme.css','src/updates-trends.css','src/filters-tools-motion.css','src/platform-logs.css'].map(file=>readFile(file,'utf8')));
  await writeFile(path.join(root,'fixture.css'),css.join('\n')+'\n:root{--border:#ccc;--panel:#fff;--text:#222;--line:#eee}body{min-width:0;overflow:auto}');
  await writeFile(path.join(root,'fixture.html'),'<!doctype html><html><head><meta charset="utf-8"><link rel="stylesheet" href="fixture.css"></head><body><div id="root"></div><script src="renderer.js"></script></body></html>');
  await writeFile(path.join(root,'audit.cjs'),String.raw`
const {app,BrowserWindow}=require('electron');
const path=require('node:path'),fs=require('node:fs');
for(const name of ['userData','sessionData','logs','crashDumps']){const folder=path.join(__dirname,name);fs.mkdirSync(folder,{recursive:true});app.setPath(name,folder);}
app.disableHardwareAcceleration();
app.whenReady().then(async()=>{
  const win=new BrowserWindow({width:1000,height:720,useContentSize:true,show:false,webPreferences:{sandbox:true,contextIsolation:true,nodeIntegration:false,offscreen:true,backgroundThrottling:false}});
  await win.loadFile(path.join(__dirname,'fixture.html'));
  const audit='('+async function audit(){
    const until=async predicate=>{const deadline=performance.now()+3000;while(!predicate()){if(performance.now()>deadline)throw new Error('Layout did not settle');await new Promise(r=>setTimeout(r,10));}};
    await until(()=>document.querySelector('.recharts-pie-sector'));
    const center=node=>{const r=node.getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2,width:r.width,height:r.height};};
    const panel=document.querySelector('.distribution-panel'),chart=document.querySelector('.donut-chart');
    const layouts=[];
    for(const [height,width] of [[340,224],[520,224],[520,310]]){
      panel.style.height=height+'px';panel.style.width=width+'px';
      await until(()=>Math.abs(document.querySelector('.recharts-surface').getBoundingClientRect().width-chart.getBoundingClientRect().width)<1);
      layouts.push({height,width,pie:center(document.querySelector('.recharts-pie')),label:center(document.querySelector('.donut-label')),chart:center(chart),
        bottom:panel.getBoundingClientRect().bottom-document.querySelector('.panel-bottom-link').getBoundingClientRect().bottom});
    }
    const selects=[...document.querySelectorAll('select')].map(select=>{const style=getComputedStyle(select);return {box:center(select),arrow:center(select.parentElement.querySelector('svg')),display:style.display,align:style.alignItems,lineHeight:style.lineHeight,appearance:style.appearance,value:select.value};});
    return {layouts,selects,customizable:CSS.supports('appearance','base-select')};
  }.toString()+')()';
  const audits=[];
  for(const width of [1400,1000,900]){win.setContentSize(width,720);audits.push(await win.webContents.executeJavaScript(audit));}
  const results=audits.at(-1);results.layouts=audits.flatMap(result=>result.layouts);
  win.webContents.debugger.attach('1.3');
  const tree=await win.webContents.debugger.sendCommand('DOM.getDocument',{depth:-1,pierce:true});
  const selected=[];
  // Measure the browser's displayed value, not the hidden option in its picker.
  function visit(node){if(node.nodeName==='SELECTEDCONTENT' || (node.attributes || []).includes('-internal-select-inner-element'))selected.push(node);for(const child of [...(node.children || []),...(node.shadowRoots || [])])visit(child);}
  visit(tree.root);
  results.selectedBoxes=[];
  for(const node of selected){const {model}=await win.webContents.debugger.sendCommand('DOM.getBoxModel',{backendNodeId:node.backendNodeId});results.selectedBoxes.push(model.content);}
  console.log('OVERVIEW_LAYOUT_RESULT '+JSON.stringify(results));win.destroy();app.exit(0);
}).catch(error=>{console.error(error.stack || error);app.exit(1);});
`);
  const env={...process.env};delete env.ELECTRON_RUN_AS_NODE;
  const child=spawn(electron,[path.join(root,'audit.cjs')],{env,windowsHide:true,stdio:['ignore','pipe','pipe'],signal:t.signal});
  let stdout='',stderr='';child.stdout.on('data',chunk=>stdout+=chunk);child.stderr.on('data',chunk=>stderr+=chunk);
  const code=await new Promise<number|null>((resolve,reject)=>{child.once('error',reject);child.once('close',resolve);});
  assert.equal(code,0,stderr);
  const line=stdout.split(/\r?\n/).find(line=>line.startsWith('OVERVIEW_LAYOUT_RESULT '));assert.ok(line,stdout+stderr);
  const {layouts,selects,customizable,selectedBoxes}=JSON.parse(line.slice('OVERVIEW_LAYOUT_RESULT '.length));
  for(const layout of layouts){
    assert.ok(Math.abs(layout.pie.x-layout.label.x)<1,JSON.stringify(layout));
    assert.ok(Math.abs(layout.pie.y-layout.label.y)<1,JSON.stringify(layout));
    assert.equal(layout.chart.height,166);assert.ok(Math.abs(layout.bottom-1)<1,JSON.stringify(layout));
  }
  for(const select of selects){
    assert.equal(select.box.height,32);assert.ok(Math.abs(select.box.y-select.arrow.y)<1);
    assert.equal(select.lineHeight,'20px');
    if(customizable){assert.equal(select.display,'flex');assert.equal(select.align,'center');assert.equal(select.appearance,'base-select');}
  }
  assert.deepEqual(selects.map((select:any)=>select.value),['model','all']);
  if(customizable){
    assert.equal(selectedBoxes.length,2);
    selectedBoxes.forEach((box:number[],index:number)=>assert.ok(Math.abs((box[1]+box[5])/2-selects[index].box.y)<1,JSON.stringify({box,select:selects[index]})));
  }
});
