import test from 'node:test';
import assert from 'node:assert/strict';
import {build} from 'esbuild';
import {mkdir,mkdtemp,readFile,writeFile,rm} from 'node:fs/promises';
import {existsSync} from 'node:fs';
import path from 'node:path';
import {spawn} from 'node:child_process';
import {createRequire} from 'node:module';

test('speed display selections persist, separate request timing and show weighted total/net trends with unknown gaps',{timeout:60000},async t=>{
  const electron=createRequire(import.meta.url)('electron') as string;
  if(!existsSync(electron))return t.skip('Electron unavailable');
  await mkdir('.test-data',{recursive:true});
  const directory=await mkdtemp(path.resolve('.test-data/net-speed-ui-'));
  t.after(()=>rm(directory,{recursive:true,force:true,maxRetries:5,retryDelay:100}));
  const output=await build({stdin:{resolveDir:process.cwd(),loader:'tsx',contents:`
import React,{useState} from 'react';import {createRoot} from 'react-dom/client';
import {AppContext} from './src/context';import {LogColumnsControl,RequestLogTable,RequestDetail} from './src/components/RequestLogs';
import {RecentActivity} from './src/components/RecentActivity';import {UsageTrend} from './src/components/UsageTrend';
import {DEFAULT_PREFERENCES} from './shared/types';import {applyPreferencePatch} from './shared/selections';import {tokenPoints} from './shared/trends';
const now=new Date(2024,0,2,12),start=new Date(2024,0,1,12).getTime()/1000,end=start+3599;
const status={system_name:'Fixture',quota_per_unit:500000},catalog={models:[],groupRatio:{fixture:.3},usableGroups:{fixture:'Fixture'},autoGroups:[],vendors:[]};
const row=(id,model,token,offset,output,duration,other)=>({id,model_name:model,token_id:token,token_name:'token-'+token,created_at:start+offset,type:2,prompt_tokens:100,completion_tokens:output,quota:1000,use_time:duration,is_stream:true,group:'fixture',other:JSON.stringify(other)});
const logs=[row(1,'alpha',1,20,50,1,{frt:500}),row(2,'alpha',1,30,150,10,{frt:2500}),row(3,'beta',2,1200,40,1,{frt:500}),row(4,'gamma',3,2400,900,1,{}),row(5,'beta',2,900,500,1,{frt:0,status_code:500}),row(6,'outside',4,-1,1000000,1,{frt:0})];
const expression='(len <= 272000 ? tier("0_272k",p*2+c*10+cr*.2+cc*2.5) : tier("272k_plus",p*4+c*15+cr*.4+cc*5))|||when(param("service_tier") == "fast") * 2|||when(param("service_tier") == "priority") * 2';
const detail={...logs[0],model_name:'fixture-model',token_name:'Lumi-Codex',prompt_tokens:118158,completion_tokens:304,quota:8769,use_time:10,request_id:'202610050452065508234768268d9d6IiaU5HJh',other:JSON.stringify({billing_mode:'tiered_expr',expr_b64:btoa(expression),matched_tier:'0_272k',group_ratio:.3,cache_tokens:116736,reasoning_effort:'high',frt:4600,request_path:'/v1/responses',request_rules:[{cond:'param("service_tier") == "fast"',multiplier:2,matched:false},{cond:'param("service_tier") == "priority"',multiplier:2,matched:true}]})};
const points=tokenPoints(logs,{start_timestamp:start,end_timestamp:end});
// Older/partial snapshots may have only one half of a timing pair. Neither fragment is a valid sample.
const unknown=points.find(point=>point.model_name==='gamma');unknown.netOutputTokens=9999;unknown.netSpeedSamples=1;
points.push({...unknown,created_at:start+2401,quota:0,token_used:0,count:0,outputTokens:undefined,durationSeconds:undefined,speedSamples:undefined,netOutputTokens:undefined,subsequentDurationSeconds:9999});
// Invalid total-timing fragments must not contaminate the independently weighted total-speed summary.
points.push({...unknown,created_at:start+2402,quota:0,token_used:0,count:0,outputTokens:9999,durationSeconds:undefined,speedSamples:1,netOutputTokens:undefined});
points.push({...unknown,created_at:start+2403,quota:0,token_used:0,count:0,outputTokens:undefined,durationSeconds:9999,speedSamples:1,netOutputTokens:undefined});
const dashboard={status,catalog,user:{id:1},logs:{items:logs.slice(0,5),total:5,page:1,pageSize:15},series:points,range:{startDate:'2024-01-01',endDate:'2024-01-01',startTime:'12:00',endTime:'12:59'},days:1,detailed:true,fetchedAt:now.getTime(),warnings:[],tokens:[],stat:null};
window.fixture={errors:[],patches:[]};addEventListener('error',event=>fixture.errors.push(event.message));addEventListener('unhandledrejection',event=>fixture.errors.push(String(event.reason)));
fixture.frame=()=>new Promise((resolve,reject)=>{const timeout=setTimeout(()=>{cancelAnimationFrame(frame);reject(new Error('Animation frame did not arrive within 6000ms'));},6000),frame=requestAnimationFrame(()=>{clearTimeout(timeout);resolve();});});
fixture.fontsReady=async()=>{let timeout;try{await Promise.race([document.fonts.ready,new Promise((_,reject)=>{timeout=setTimeout(()=>reject(new Error('Fonts did not settle within 6000ms: '+document.fonts.status)),6000);})]);}finally{clearTimeout(timeout);}};
function App(){const [page,setPage]=useState('requests'),[preferences,setPreferences]=useState({...structuredClone(DEFAULT_PREFERENCES),activeSiteId:'fixture-site',logColumns:['model','duration','speed'],dataRefreshAnimation:'none'});fixture.show=setPage;fixture.preferences=preferences;
const context={preferences,dashboard,updatePreferences:async patch=>{fixture.patches.push(patch);setPreferences(current=>applyPreferencePatch(current,patch));},toast:message=>fixture.errors.push(message)};
return <main className="desktop-shell" data-theme="light" style={{display:'block',padding:24}}><AppContext.Provider value={context}>{page==='requests' ? <section className="panel"><LogColumnsControl/><RequestLogTable logs={dashboard.logs} busy={false} page={1} onPage={()=>{}} onDetail={()=>setPage('detail')} status={status} catalog={catalog}/><RecentActivity logs={logs.slice(0,4)} columns={['model','timing','netSpeed']} status={status} catalog={catalog}/></section> : page==='detail' ? <RequestDetail log={detail} status={status} onClose={()=>setPage('requests')}/> : <section className="panel"><UsageTrend dashboard={dashboard} preferenceKey="overview.trend"/></section>}</AppContext.Provider></main>;}
createRoot(document.getElementById('root')).render(<App/>);
`},bundle:true,platform:'browser',format:'esm',target:'chrome140',write:false,loader:{'.css':'empty','.svg':'text'},define:{'process.env.NODE_ENV':'"production"'},logLevel:'silent'});
  await writeFile(path.join(directory,'app.js'),output.outputFiles[0].contents);
  const css=await Promise.all(['components/segmented-switch.css','styles.css','workbench.css','select.css','theme-tokens.css','theme.css','updates-trends.css','filters-tools-motion.css','platform-logs.css','recent-activity.css','components/billing.css'].map(file=>readFile(path.join('src',file),'utf8')));
  await writeFile(path.join(directory,'style.css'),css.join('\n'));
  await writeFile(path.join(directory,'index.html'),'<html><head><meta charset="utf-8"><link rel="stylesheet" href="style.css"></head><body><div id="root"></div><script type="module" src="app.js"></script></body></html>');
  await writeFile(path.join(directory,'main.cjs'),String.raw`
const {app,BrowserWindow}=require('electron'),fs=require('node:fs'),path=require('node:path');
for(const name of ['userData','sessionData','logs','crashDumps']){const dir=path.join(__dirname,name);fs.mkdirSync(dir,{recursive:true});app.setPath(name,dir);}
app.commandLine.appendSwitch('force-prefers-reduced-motion');
if(process.platform==='linux')app.disableHardwareAcceleration();
const started=Date.now();let stage='startup',win;
const diagnostic=()=>({stage,elapsedMs:Date.now()-started,...win && !win.isDestroyed() ? {visible:win.isVisible(),contentSize:win.getContentSize(),loading:win.webContents.isLoading(),rendererDestroyed:win.webContents.isDestroyed()} : {windowDestroyed:!!win}});
const bounded=async(name,operation,ms=8000)=>{stage=name;console.log('NET_SPEED_PHASE '+JSON.stringify({name,state:'start',elapsedMs:Date.now()-started}));let timeout;try{const result=await Promise.race([Promise.resolve().then(operation),new Promise((_,reject)=>{timeout=setTimeout(()=>reject(new Error('Electron operation timed out after '+ms+'ms: '+JSON.stringify(diagnostic()))),ms);})]);console.log('NET_SPEED_PHASE '+JSON.stringify({name,state:'done',elapsedMs:Date.now()-started}));return result;}finally{clearTimeout(timeout);}};
// A stalled native operation must report its last stage before the outer test aborts.
const watchdog=setTimeout(()=>{console.error('NET_SPEED_WATCHDOG '+JSON.stringify(diagnostic()));app.exit(1);},45000);
bounded('app-ready',()=>app.whenReady()).then(async()=>{
// Use the production compositor: software offscreen surfaces can disappear during macOS resize.
stage='create-window';console.log('NET_SPEED_PHASE '+JSON.stringify({name:stage,state:'start',elapsedMs:Date.now()-started}));
// Xvfb can leave a hidden native X11 window without a paint surface. Offscreen
// rendering supplies frames on Linux; macOS keeps its production resize compositor.
win=new BrowserWindow({width:1100,height:720,useContentSize:true,show:false,webPreferences:{sandbox:true,contextIsolation:true,nodeIntegration:false,backgroundThrottling:false,offscreen:process.platform==='linux'}});
console.log('NET_SPEED_PHASE '+JSON.stringify({name:stage,state:'done',elapsedMs:Date.now()-started}));
win.webContents.on('render-process-gone',(_event,details)=>{console.error('NET_SPEED_RENDERER_GONE '+JSON.stringify({diagnostic:diagnostic(),details}));app.exit(1);});
await bounded('load-file',()=>win.loadFile(path.join(__dirname,'index.html')));
const evaluate=async(name,expression,ms=8000)=>bounded(name,async()=>{const result=await win.webContents.executeJavaScript('(async()=>{try{return {ok:true,value:await ('+expression+')}}catch(error){return {ok:false,error:error.stack||String(error)}}})()');if(!result.ok)throw new Error(name+': '+result.error);return result.value;},ms);
const waitForPaint=async(size=win.getContentSize())=>evaluate('viewport-paint:'+size.join('x'),'('+async function(width,height){
  const frame=fixture.frame,end=performance.now()+6000;await fixture.fontsReady();
  while(innerWidth!==width || innerHeight!==height){if(performance.now()>end)throw new Error('Viewport did not settle: '+innerWidth+'x'+innerHeight+' expected '+width+'x'+height);await frame();}
  await frame();await frame();return {width:innerWidth,height:innerHeight,scale:devicePixelRatio};
}.toString()+')('+size.join(',')+')');
const resize=async(width,height)=>bounded('resize:'+width+'x'+height,async()=>{win.setContentSize(width,height);await waitForPaint([width,height]);});
// Reapply content size after native construction to normalize fractional display scaling.
await resize(1100,720);
const run=async(stage,value)=>evaluate('renderer:'+stage,'('+async function(stage,value){
  const check=(value,label)=>{if(!value)throw new Error(label);},until=async fn=>{const end=performance.now()+6000;while(!fn()){if(performance.now()>end)throw new Error('Timeout: '+fn+' '+fixture.errors);await new Promise(resolve=>setTimeout(resolve,10));}};
  // This fixture disables motion. Wait for committed React choices and layout,
  // rather than repeatedly paying hidden-window RAF throttling after every choice.
  const settle=async()=>{await new Promise(resolve=>setTimeout(resolve,0));document.getAnimations().forEach(animation=>animation.finish());const shell=document.querySelector('.desktop-shell');check(shell.getBoundingClientRect().width>0 && getComputedStyle(shell).display!=='none','Fixture layout unavailable');};
  const select=async(label,value)=>{const control=document.querySelector('select[aria-label="'+label+'"]'),key={'趋势指标':'overview.metric','曲线分组':'overview.trend.group','曲线模型':'overview.trend.model','曲线令牌':'overview.trend.token'}[label];check(control && key,'Missing control '+label);control.value=value;control.dispatchEvent(new Event('change',{bubbles:true}));await until(()=>fixture.preferences.viewSelections['fixture-site']?.[key]===value && document.querySelector('select[aria-label="'+label+'"]')?.value===value);await settle();};
  await until(()=>fixture.show);
  if(stage==='columns'){
    await until(()=>document.querySelector('.request-log-table'));
    check(!fixture.preferences.logColumns.includes('netSpeed'),'net speed became a default request column');
    [...document.querySelectorAll('button')].find(button=>button.textContent.startsWith('显示列')).click();await until(()=>document.querySelector('.log-columns-modal'));
    const label=[...document.querySelectorAll('.log-columns-grid label')].find(label=>label.textContent==='净速率');check(label,'net speed option unavailable');label.querySelector('input').click();
    [...document.querySelectorAll('.log-columns-modal button')].find(button=>button.textContent==='应用显示项目').click();await until(()=>fixture.preferences.logColumns.includes('netSpeed'));
    await until(()=>!document.querySelector('.log-columns-modal'));await settle();
    const table=document.querySelector('.request-log-table');check([...table.querySelectorAll('th')].map(th=>th.textContent).join('|')==='模型|首字 / 后续|Token 速度|净速率|详情','request columns not updated');
    const rows=[...table.querySelectorAll('tbody tr')].map(row=>[...row.querySelectorAll('td')].map(cell=>cell.textContent));
    check(rows[0][1]==='0.5s / 0.5s' && rows[0][2]==='50 t/s' && rows[0][3]==='100 t/s','first-token and net-speed display disagree');
    check(rows[1][1]==='2.5s / 7.5s' && rows[1][3]==='20 t/s','fractional subsequent duration lost');
    check(rows[3][1]==='— / —' && rows[3][3]==='—','missing timings became zero');
    const recent=document.querySelector('.recent-activity-table');check(recent.textContent.includes('净速率') && recent.textContent.includes('100 t/s'),'recent activity net speed unavailable');
    check([...recent.querySelectorAll('tbody tr')][3].textContent.includes('— / —'),'recent activity invented missing timing');
    fixture.show('trend');await until(()=>document.querySelector('.trend-heading'));fixture.show('requests');await until(()=>document.querySelector('.request-log-table th[title^="净速率"]'));check(fixture.preferences.logColumns.includes('netSpeed'),'column choice lost on remount');
  }else if(stage==='detail'){
    fixture.show('detail');await until(()=>document.querySelector('.request-detail-modal'));await settle();
    const modal=document.querySelector('.request-detail-modal'),values=Object.fromEntries([...modal.querySelectorAll('.detail-grid>div')].map(cell=>[cell.querySelector('span').textContent,cell.querySelector('strong').textContent]));
    check(values['首字等待']==='4.6s' && values['后续耗时']==='5.4s','request detail timing mismatch');check(values['Token 速度']==='30.4 t/s' && values['净速率']==='56.3 t/s','detail net speed incorrect');
    check(modal.scrollHeight<=modal.clientHeight+1,'detail needs vertical scrolling '+modal.scrollHeight+'/'+modal.clientHeight);check(modal.getBoundingClientRect().bottom<=innerHeight,'detail exceeds viewport');
  }else if(stage==='trend'){
    fixture.show('trend');await until(()=>document.querySelector('.trend-heading'));await select('趋势指标','netSpeed');
    await until(()=>document.querySelector('.trend-summary strong')?.textContent==='28.2 t/s');check(document.querySelector('.chart-note').textContent.includes('有效 3/5 次请求'),'sample coverage incorrect');
    check(fixture.preferences.viewSelections['fixture-site']['overview.metric']==='netSpeed','trend metric not saved for site');
    check(fixture.patches.some(patch=>patch.selection?.siteId==='fixture-site' && patch.selection.values['overview.metric']==='netSpeed'),'trend selection escaped site scope');
    await until(()=>document.querySelectorAll('.recharts-line-dot').length===2);check([...document.querySelectorAll('.recharts-cartesian-axis-tick-value')].some(tick=>tick.textContent.includes('t/s')),'axis omits net speed units');
    const dot=document.querySelector('.recharts-line-dot').getBoundingClientRect();return {x:Math.round(dot.left+dot.width/2),y:Math.round(dot.top+dot.height/2)};
  }else if(stage==='speed'){
    fixture.show('trend');await until(()=>document.querySelector('.trend-heading'));await select('趋势指标','speed');await select('曲线分组','total');
    check([...document.querySelector('select[aria-label="趋势指标"]').options].map(option=>option.textContent).includes('净速率'),'total speed replaced net speed');
    await until(()=>document.querySelector('.trend-summary strong')?.textContent==='87.7 t/s');check(document.querySelector('.chart-note').textContent.includes('有效 4/5 次请求'),'total speed coverage incorrect');
    check(document.querySelector('.chart-note').textContent.includes('总耗时（含首字）'),'total speed definition ambiguous');
    check(fixture.preferences.viewSelections['fixture-site']['overview.metric']==='speed' && fixture.patches.some(patch=>patch.selection?.siteId==='fixture-site' && patch.selection.values['overview.metric']==='speed'),'speed metric escaped site scope');
    await select('曲线分组','token');await select('曲线令牌','id:2');await until(()=>document.querySelector('.trend-summary strong')?.textContent==='40.0 t/s');check(document.querySelector('.chart-note').textContent.includes('有效 1/2 次请求'),'speed token coverage not filtered');
    await select('曲线分组','model');await select('曲线模型','gamma');await until(()=>document.querySelector('.trend-summary strong')?.textContent==='900.0 t/s');
    await select('曲线模型','alpha');await until(()=>document.querySelector('.trend-summary strong')?.textContent==='18.2 t/s');check(document.querySelector('.chart-note').textContent.includes('有效 2/2 次请求'),'speed model coverage incorrect');
    fixture.show('requests');await until(()=>document.querySelector('.request-log-table'));fixture.show('trend');await until(()=>document.querySelector('select[aria-label="趋势指标"]')?.value==='speed');
    await until(()=>document.querySelector('.trend-summary strong')?.textContent==='18.2 t/s');await until(()=>document.querySelectorAll('.recharts-line-dot').length===1);await settle();
    const dot=document.querySelector('.recharts-line-dot').getBoundingClientRect();return {x:Math.round(dot.left+dot.width/2),y:Math.round(dot.top+dot.height/2)};
  }else if(stage==='tooltip'){
    await until(()=>document.querySelector('.recharts-tooltip-item-value')?.textContent===(value || '25 t/s'));
    await until(()=>{const tooltip=document.querySelector('.recharts-tooltip-wrapper');return tooltip && getComputedStyle(tooltip).visibility==='visible' && tooltip.getBoundingClientRect().width>0;});await settle();
    await until(()=>{const value=document.querySelector('.recharts-tooltip-item-value');return value && getComputedStyle(value).visibility==='visible' && value.getBoundingClientRect().width>0;});
    await new Promise(resolve=>setTimeout(resolve,100));
    const item=document.querySelector('.recharts-tooltip-item-value');return {stage,text:item.textContent,color:getComputedStyle(item).color,visibility:getComputedStyle(item).visibility,rect:item.getBoundingClientRect().toJSON()};
  }else if(stage==='grouping'){
    await select('曲线分组','model');await select('曲线模型','alpha');await until(()=>document.querySelector('.trend-summary strong')?.textContent==='25.0 t/s');check(document.querySelector('.chart-note').textContent.includes('有效 2/2 次请求'),'model coverage not filtered');
    await select('曲线模型','gamma');await until(()=>document.querySelector('.trend-summary strong')?.textContent==='—');check(document.querySelector('.chart-note').textContent.includes('有效 0/1 次请求'),'unknown coverage changed');check(document.querySelectorAll('.recharts-line-dot').length===0,'unknown rate plotted as zero');
    await select('曲线分组','token');await select('曲线令牌','id:2');await until(()=>document.querySelector('.trend-summary strong')?.textContent==='80.0 t/s');check(document.querySelector('.chart-note').textContent.includes('有效 1/2 次请求'),'token coverage counted failed timing');
    fixture.show('requests');await until(()=>document.querySelector('.request-log-table'));fixture.show('trend');await until(()=>document.querySelector('select[aria-label="趋势指标"]')?.value==='netSpeed');check(document.querySelector('select[aria-label="曲线分组"]').value==='token' && document.querySelector('select[aria-label="曲线令牌"]').value==='id:2','group selection lost on remount');
    await until(()=>document.querySelector('.trend-summary strong')?.textContent==='80.0 t/s');
  }else if(stage==='unknown'){
    await select('曲线分组','model');await select('曲线模型','gamma');await until(()=>document.querySelector('.trend-summary strong')?.textContent==='—');await settle();
  }
  check(fixture.errors.length===0,'renderer errors '+fixture.errors);return {stage,viewport:innerWidth+'x'+innerHeight};
}.toString()+')('+JSON.stringify(stage)+','+JSON.stringify(value)+')',10000);
const shot=async name=>{
  let image,viewport;
  for(let attempt=1;attempt<=3;attempt++){
    viewport=await waitForPaint();
    try{image=await bounded('capture:'+name+':'+attempt,()=>win.webContents.capturePage(undefined,{stayHidden:true,stayAwake:true}));break;}
    catch(error){if(error?.message!=='UnknownVizError' || attempt===3)throw error;console.warn('Retrying transient capture '+name+' ('+attempt+'/3): '+error.message);}
  }
  // Normal-window captures contain device pixels, including Retina/fractional Windows scale.
  const expected=[Math.round(viewport.width*viewport.scale),Math.round(viewport.height*viewport.scale)],actual=image.getSize();
  if(image.isEmpty() || actual.width!==expected[0] || actual.height!==expected[1])throw new Error('Invalid capture '+name+': '+JSON.stringify(actual)+' expected '+expected.join('x'));
  if(win.isVisible())throw new Error('Capture showed the hidden fixture');
  fs.writeFileSync(path.resolve('.test-data/net-speed-'+name+'.png'),image.toPNG());
};
console.log('NET_SPEED_UI '+JSON.stringify(await run('columns')));await shot('requests');
for(const size of [[1100,720],[1000,680]]){await resize(...size);console.log('NET_SPEED_UI '+JSON.stringify(await run('detail')));}await shot('detail');
await resize(1100,720);const position=await run('trend');win.webContents.sendInputEvent({type:'mouseMove',...position});console.log('NET_SPEED_UI '+JSON.stringify(await run('tooltip')));await shot('trend');
console.log('NET_SPEED_UI '+JSON.stringify(await run('grouping')));console.log('NET_SPEED_UI '+JSON.stringify(await run('unknown')));await shot('unknown');
const speedPosition=await run('speed');console.log('NET_SPEED_UI '+JSON.stringify({stage:'speed',...speedPosition}));win.webContents.sendInputEvent({type:'mouseMove',...speedPosition});console.log('NET_SPEED_UI '+JSON.stringify(await run('tooltip','18.2 t/s')));await shot('speed');
await evaluate('theme:dark','(()=>{document.documentElement.dataset.theme="dark";document.querySelector(".desktop-shell").dataset.theme="dark"})()');console.log('NET_SPEED_UI '+JSON.stringify(await run('detail')));await shot('detail-dark');
clearTimeout(watchdog);win.destroy();app.exit(0);
}).catch(error=>{console.error('NET_SPEED_FAILURE '+JSON.stringify(diagnostic())+'\n'+(error.stack || error));app.exit(1)});
`);
  const env={...process.env};delete env.ELECTRON_RUN_AS_NODE;
  const child=spawn(electron,[path.join(directory,'main.cjs')],{env,windowsHide:true,stdio:['ignore','pipe','pipe'],signal:t.signal});
  let stdout='',stderr='';child.stdout.on('data',chunk=>stdout+=chunk);child.stderr.on('data',chunk=>stderr+=chunk);
  const reportAbort=()=>t.diagnostic('Electron child aborted; captured phases:\n'+(stdout+stderr || '(no child output)'));
  t.signal.addEventListener('abort',reportAbort,{once:true});
  let code:number|null;
  try{code=await new Promise<number|null>((resolve,reject)=>{child.once('error',reject);child.once('close',resolve);});}
  finally{t.signal.removeEventListener('abort',reportAbort);await writeFile(path.resolve('.test-data/net-speed-ui.log'),stdout+stderr);}
  assert.equal(code,0,stderr+stdout);assert.equal(stdout.split('NET_SPEED_UI ').length-1,9);
});
