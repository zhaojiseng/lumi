import test from 'node:test';
import assert from 'node:assert/strict';
import {build} from 'esbuild';
import {mkdir,mkdtemp,readFile,writeFile,rm} from 'node:fs/promises';
import {existsSync} from 'node:fs';
import path from 'node:path';
import {spawn} from 'node:child_process';
import {createRequire} from 'node:module';

test('billing dialogs fit desktop windows and keep Fast pricing independent from context selection',{timeout:40000},async t=>{
  const electron=createRequire(import.meta.url)('electron') as string;
  if(!existsSync(electron))return t.skip('Electron unavailable');
  await mkdir('.test-data',{recursive:true});
  const directory=await mkdtemp(path.resolve('.test-data/billing-ui-'));
  t.after(()=>rm(directory,{recursive:true,force:true,maxRetries:5,retryDelay:100}));
  const output=await build({stdin:{resolveDir:process.cwd(),loader:'tsx',contents:`
import React,{useState} from 'react';import {createRoot} from 'react-dom/client';
window.lumi={modelHealth:async()=>({groups:[]})};
const {AppContext}=await import('./src/context'),{CatalogProvider}=await import('./src/host/catalog'),{RequestDetail}=await import('./src/components/RequestLogs'),{PricingDetailsModal}=await import('./src/components/Pricing'),{default:Models}=await import('./plugins/provider.newapi/renderer/Models'),{DEFAULT_PREFERENCES}=await import('./shared/types'),{applyPreferencePatch}=await import('./shared/selections');
const {modelSelectionKey}=await import('./shared/selections'),{publishedRequestPricing}=await import('./shared/pricing');
const expression='(len <= 272000 ? tier("0_272k",p*2+c*10+cr*.2+cc*2.5) : tier("272k_plus",p*4+c*15+cr*.4+cc*5))|||when(param("service_tier") == "fast") * 2|||when(param("service_tier") == "priority") * 2';
const status={system_name:'Fixture',quota_per_unit:500000},model={model_name:'fixture-model',vendor:'Fixture',quota_type:0,model_ratio:1,model_price:0,completion_ratio:1,enable_groups:['fixture'],supported_endpoint_types:[],billing_mode:'tiered_expr',billing_expr:expression};
const catalog={models:[model],groupRatio:{fixture:.3},usableGroups:{fixture:'优选渠道'},autoGroups:[],vendors:[]},snapshot={catalog,status,warnings:[],loggedIn:true,fetchedAt:Date.now()};
const log={id:1,created_at:Date.now()/1000,type:2,model_name:'fixture-model',token_name:'Lumi-Codex',prompt_tokens:118158,completion_tokens:304,quota:8769,use_time:10,is_stream:true,group:'fixture',request_id:'202610050452065508234768268d9d6IiaU5HJh',other:JSON.stringify({billing_mode:'tiered_expr',expr_b64:btoa(expression),matched_tier:'0_272k',group_ratio:.3,cache_tokens:116736,reasoning_effort:'high',frt:4600,request_path:'/v1/responses',request_rules:[{cond:'param("service_tier") == "fast"',multiplier:2,matched:false},{cond:'param("service_tier") == "priority"',multiplier:2,matched:true}]})};
window.fixture={errors:[],log};addEventListener('error',event=>fixture.errors.push(event.message));addEventListener('unhandledrejection',event=>fixture.errors.push(String(event.reason)));
function App(){const [kind,setKind]=useState('request'),[preferences,setPreferences]=useState(structuredClone(DEFAULT_PREFERENCES));fixture.show=setKind;fixture.preferences=preferences;
const context={preferences,dashboard:null,bootstrap:{desktop:true,configs:[],version:'fixture'},updatePreferences:async patch=>setPreferences(current=>applyPreferencePatch(current,patch)),toast:()=>{},configureModel:()=>{}};
fixture.usePriority=()=>context.updatePreferences({selection:{siteId:preferences.activeSiteId,values:{[modelSelectionKey(model.model_name,'mode')]:publishedRequestPricing(model).rules[1].condition}}});
return <main className="desktop-shell" data-theme="light" style={{display:'block',padding:20}}><AppContext.Provider value={context}><CatalogProvider value={{snapshot,loading:false,error:'',refresh:async()=>{}}}>{kind==='request' ? <RequestDetail log={log} status={status} onClose={()=>{}}/> : kind==='pricing' ? <PricingDetailsModal model={model} catalog={catalog} status={status} snapshot={snapshot} onClose={()=>{}}/> : <Models/>}</CatalogProvider></AppContext.Provider></main>;}
createRoot(document.getElementById('root')).render(<App/>);
`},bundle:true,platform:'browser',format:'esm',target:'chrome140',write:false,loader:{'.css':'empty','.svg':'text'},define:{'process.env.NODE_ENV':'"production"'},logLevel:'silent'});
  await writeFile(path.join(directory,'app.js'),output.outputFiles[0].contents);
  const css=await Promise.all(['styles.css','workbench.css','select.css','theme-tokens.css','theme.css','updates-trends.css','filters-tools-motion.css','platform-logs.css','models-market.css','recent-activity.css','components/billing.css'].map(file=>readFile(path.join('src',file),'utf8')));
  await writeFile(path.join(directory,'style.css'),css.join('\n'));
  await writeFile(path.join(directory,'index.html'),'<html><head><meta charset="utf-8"><link rel="stylesheet" href="style.css"></head><body><div id="root"></div><script type="module" src="app.js"></script></body></html>');
  await writeFile(path.join(directory,'main.cjs'),String.raw`
const {app,BrowserWindow}=require('electron'),fs=require('node:fs'),path=require('node:path');
for(const name of ['userData','sessionData','logs','crashDumps']){const dir=path.join(__dirname,name);fs.mkdirSync(dir,{recursive:true});app.setPath(name,dir);}app.disableHardwareAcceleration();
app.whenReady().then(async()=>{
// Offscreen rendering lets native pointer capture work without an OS-visible test window on Windows.
const win=new BrowserWindow({width:1100,height:720,useContentSize:true,show:false,webPreferences:{sandbox:true,contextIsolation:true,nodeIntegration:false,backgroundThrottling:false,offscreen:true}});await win.loadFile(path.join(__dirname,'index.html'));
win.webContents.on('console-message',event=>{if(event.level==='error')console.error(event.message);});
const run=async kind=>win.webContents.executeJavaScript('('+async function(kind){
  const check=(value,label)=>{if(!value)throw new Error(label);},until=async fn=>{const end=performance.now()+6000;while(!fn()){if(performance.now()>end)throw new Error('Timeout: '+fn+' '+fixture.errors);await new Promise(resolve=>setTimeout(resolve,10));}};
  await until(()=>fixture.show);fixture.show(kind);await until(()=>kind==='market' ? document.querySelector('.model-card') : document.querySelector(kind==='request' ? '.request-detail-modal' : '.pricing-modal'));
  await new Promise(resolve=>setTimeout(resolve,250));document.getAnimations().forEach(animation=>animation.finish());await new Promise(resolve=>requestAnimationFrame(resolve));
  const modal=document.querySelector('[role="dialog"]');
  if(modal){
    check(modal.scrollHeight<=modal.clientHeight+1,kind+' needs vertical scrolling: '+modal.scrollHeight+'/'+modal.clientHeight);
    check(modal.getBoundingClientRect().bottom<=innerHeight,kind+' exceeds viewport');
    for(const table of modal.querySelectorAll('.billing-table-wrap'))check(table.scrollWidth<=table.clientWidth+1,kind+' table overflows horizontally');
  }
  if(kind==='request'){
    check(modal.textContent.includes('$0.017538'),'actual cost changed');check(modal.textContent.includes('Fast（Priority）'),'actual fast mode missing');
    check(modal.querySelectorAll('.billing-rule.matched').length===1,'unmatched fast rule marked active');
    const effective=modal.querySelector('.billing-effective-prices');check(effective.textContent.includes('$1.2') && effective.textContent.includes('$0.12'),'effective prices missed group/request factors');
  }else if(kind==='pricing'){
    check(modal.querySelectorAll('tbody tr').length===2,'context tiers expanded into request combinations');
    const select=document.querySelector('select[aria-label="定价请求条件"]');check(select.options.length===2,'equivalent Fast/Priority options were not merged');select.value=select.options[1].value;select.dispatchEvent(new Event('change',{bubbles:true}));
    await until(()=>modal.textContent.includes('含分组倍率 · Fast ×2'));check(modal.querySelector('tbody').textContent.includes('$1.2'),'Fast mode failed to multiply published unit prices');
  }else{
    const mode=document.querySelector('[aria-label="fixture-model 请求条件"]');check(mode.querySelectorAll('button').length===2,'Fast/Priority has duplicate stops');check(mode.querySelector('[aria-pressed="true"]').textContent.includes('Fast'),'pricing mode was not shared with model card');
    // Font layout and ResizeObserver can commit after the selection on macOS.
    // Wait for the measured thumb while retaining exact position/size assertions.
    const knobOf=async group=>{await until(()=>{const active=group.querySelector('[aria-pressed="true"]'),knob=group.querySelector('.segmented-thumb'),match=knob && /translate\((-?[\d.]+)px,\s*(-?[\d.]+)px\)/.exec(knob.style.transform);return match && Number(match[1])===active.offsetLeft && Number(match[2])===active.offsetTop && parseFloat(knob.style.width)===active.offsetWidth;});const active=group.querySelector('[aria-pressed="true"]'),knob=group.querySelector('.segmented-thumb');check(parseFloat(knob.style.width)===active.offsetWidth,'knob size differs from the stop');return knob.style.transform;},initialKnob=await knobOf(mode);
    mode.querySelector('button').click();await until(()=>document.querySelector('[aria-label="fixture-model 请求条件"] [aria-pressed="true"]').textContent.includes('普通'));
    check(await knobOf(mode)!==initialKnob,'knob did not slide to the ordinary stop');
    check(document.querySelector('.model-card .price-table').textContent.includes('$0.6'),'ordinary price changed after mode selection');
    const tier=document.querySelector('[aria-label="fixture-model 上下文档位"]');check(tier.classList.contains('segmented-switch'),'context tier must use the same slider');check(tier.closest('.model-switch-row'),'context tier not placed beside the slider');tier.querySelectorAll('button')[1].click();await until(()=>document.querySelector('.model-card .price-table').textContent.includes('$4.5'));await knobOf(tier);
  }
  check(fixture.errors.length===0,'renderer errors '+fixture.errors);return {kind,height:modal?.clientHeight,viewport:innerHeight};
}.toString()+')('+JSON.stringify(kind)+')');
for(const kind of ['request','pricing','market']){console.log('BILLING_UI '+JSON.stringify(await run(kind)));await win.webContents.executeJavaScript('document.getAnimations().forEach(animation=>animation.finish())');fs.writeFileSync(path.resolve('.test-data/billing-'+kind+'.png'),(await win.webContents.capturePage()).toPNG());}
const dragSwitch=async(label,price)=>{
  await new Promise(resolve=>setTimeout(resolve,300));
  const stops=await win.webContents.executeJavaScript('('+function(label){
    const group=document.querySelector('[aria-label="'+label+'"]'),active=group.querySelector('[aria-pressed="true"]'),target=[...group.querySelectorAll('button')].find(button=>button!==active),point=button=>{const rect=button.getBoundingClientRect();return {x:Math.round(rect.left+rect.width/2),y:Math.round(rect.top+rect.height/2)};};
    return {start:point(active),end:point(target),before:group.querySelector('.segmented-thumb').style.transform};
  }.toString()+')('+JSON.stringify(label)+')');
  win.webContents.sendInputEvent({type:'mouseMove',...stops.start});win.webContents.sendInputEvent({type:'mouseDown',button:'left',clickCount:1,...stops.start});await new Promise(resolve=>setTimeout(resolve,30));
  win.webContents.sendInputEvent({type:'mouseMove',modifiers:['leftButtonDown'],...stops.end});
  await new Promise(resolve=>setTimeout(resolve,30));
  await win.webContents.executeJavaScript('('+function(label,before){const group=document.querySelector('[aria-label="'+label+'"]');if(!group.hasAttribute('data-dragging') || group.querySelector('.segmented-thumb').style.transform===before)throw new Error('Selected knob did not follow the native drag');}.toString()+')('+JSON.stringify(label)+','+JSON.stringify(stops.before)+')');
  win.webContents.sendInputEvent({type:'mouseUp',button:'left',clickCount:1,...stops.end});
  await win.webContents.executeJavaScript('('+async function(label,price){
    const end=performance.now()+4000;while(!document.querySelector('.model-card .price-table').textContent.includes(price)){if(performance.now()>end)throw new Error('Drag did not select the expected price '+price);await new Promise(resolve=>setTimeout(resolve,10));}
    const group=document.querySelector('[aria-label="'+label+'"]');
    while(true){const active=group.querySelector('[aria-pressed="true"]'),knob=group.querySelector('.segmented-thumb'),position=/translate\((-?[\d.]+)px,\s*(-?[\d.]+)px\)/.exec(knob.style.transform);
      if(!group.hasAttribute('data-dragging') && position && Number(position[1])===active.offsetLeft && Number(position[2])===active.offsetTop && parseFloat(knob.style.width)===active.offsetWidth)break;
      if(performance.now()>end)throw new Error('Dragged knob did not snap to the selected stop');await new Promise(resolve=>setTimeout(resolve,10));
    }
  }.toString()+')('+JSON.stringify(label)+','+JSON.stringify(price)+')');
};
await dragSwitch('fixture-model 请求条件','$9');await dragSwitch('fixture-model 上下文档位','$1.2');
await win.webContents.executeJavaScript('('+function(){document.querySelector('[aria-label="fixture-model 请求条件"] button').focus();}.toString()+')()');win.webContents.sendInputEvent({type:'keyDown',keyCode:'Space'});win.webContents.sendInputEvent({type:'keyUp',keyCode:'Space'});
await win.webContents.executeJavaScript('('+async function(){const end=performance.now()+4000;while(!document.querySelector('.model-card .price-table').textContent.includes('$0.6')){if(performance.now()>end)throw new Error('Native keyboard selection failed after dragging');await new Promise(resolve=>setTimeout(resolve,10));}}.toString()+')()');
await win.webContents.executeJavaScript('('+async function(){
  const card=document.querySelector('.model-card');card.style.width='210px';await new Promise(resolve=>setTimeout(resolve,100));
  const mode=card.querySelector('[aria-label="fixture-model 请求条件"]'),context=card.querySelector('[aria-label="fixture-model 上下文档位"]');
  if(context.getBoundingClientRect().top<mode.getBoundingClientRect().bottom)throw new Error('Context selector must wrap to another row when space is insufficient');
  for(const group of [mode,context])for(const button of group.querySelectorAll('button')){const span=button.querySelector('span');if(span.scrollWidth>span.clientWidth+1 || getComputedStyle(span).textOverflow==='ellipsis')throw new Error('Selector labels were truncated');}
}.toString()+')()');
fs.writeFileSync(path.resolve('.test-data/billing-market-narrow.png'),(await win.webContents.capturePage()).toPNG());await win.webContents.executeJavaScript('document.querySelector(".model-card").style.width=""');
for(const size of [[1280,800],[1000,680]]){win.setContentSize(...size);for(const kind of ['request','pricing'])console.log('BILLING_UI '+JSON.stringify(await run(kind)));}
win.setContentSize(1100,720);await win.webContents.executeJavaScript('document.documentElement.dataset.theme="dark";document.querySelector(".desktop-shell").dataset.theme="dark"');
for(const kind of ['request','pricing']){console.log('BILLING_UI '+JSON.stringify(await run(kind)));fs.writeFileSync(path.resolve('.test-data/billing-'+kind+'-dark.png'),(await win.webContents.capturePage()).toPNG());}
await win.webContents.executeJavaScript('fixture.usePriority()');console.log('BILLING_UI '+JSON.stringify(await run('market')));await dragSwitch('fixture-model 请求条件','$9');await dragSwitch('fixture-model 上下文档位','$1.2');
await win.webContents.executeJavaScript('document.getAnimations().forEach(animation=>animation.finish());new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))');
fs.writeFileSync(path.resolve('.test-data/billing-market-dark.png'),(await win.webContents.capturePage()).toPNG());
win.destroy();app.exit(0);
}).catch(error=>{console.error(error.stack || error);app.exit(1)});
`);
  const env={...process.env};delete env.ELECTRON_RUN_AS_NODE;
  const child=spawn(electron,[path.join(directory,'main.cjs')],{env,windowsHide:true,stdio:['ignore','pipe','pipe'],signal:t.signal});
  let stdout='',stderr='';child.stdout.on('data',chunk=>stdout+=chunk);child.stderr.on('data',chunk=>stderr+=chunk);
  const code=await new Promise<number|null>((resolve,reject)=>{child.on('error',reject);child.on('close',resolve);});
  assert.equal(code,0,stderr+stdout);assert.equal(stdout.split('BILLING_UI ').length-1,10);
});
