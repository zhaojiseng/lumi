import test from 'node:test';
import assert from 'node:assert/strict';
import {build} from 'esbuild';
import {mkdir,mkdtemp,readFile,writeFile,rm} from 'node:fs/promises';
import {existsSync} from 'node:fs';
import path from 'node:path';
import {spawn} from 'node:child_process';
import {createRequire} from 'node:module';

test('Codex service tier follows the selected model, site and settings through the real preview form',{timeout:30000},async t=>{
  const electron=createRequire(import.meta.url)('electron') as string;
  if(!existsSync(electron))return t.skip('Electron unavailable');
  await mkdir('.test-data',{recursive:true});
  const directory=await mkdtemp(path.resolve('.test-data/codex-tier-ui-'));
  t.after(()=>rm(directory,{recursive:true,force:true,maxRetries:5,retryDelay:100}));
  const output=await build({stdin:{resolveDir:process.cwd(),loader:'tsx',contents:`
import React,{useState} from 'react';import {createRoot} from 'react-dom/client';
import {AppContext} from './src/context';import {DEFAULT_PREFERENCES} from './shared/types';import {applyPreferencePatch} from './shared/selections';
window.fixture={requests:[],errors:[]};
window.lumi={toolRuntimes:async()=>[],onToolRuntime:()=>()=>{},onConfigProgress:()=>()=>{},previewConfig:input=>new Promise(resolve=>{fixture.requests.push(input);fixture.resolvePreview=()=>resolve({id:'preview',tool:input.tool,files:[{path:'fixture/config.toml',before:'',after:input.serviceTier ? 'service_tier = "'+input.serviceTier+'"' : ''}],changes:[input.serviceTier ? '服务等级：'+input.serviceTier : '服务等级：关闭（删除 service_tier）'],expiresAt:Date.now()+600000});})};
addEventListener('error',event=>fixture.errors.push(event.message));addEventListener('unhandledrejection',event=>fixture.errors.push(String(event.reason)));
const {default:Tools}=await import('./src/pages/Tools'),{codexConfigView}=await import('./plugins/adapter.tool.codex/renderer'),{claudeConfigView}=await import('./plugins/adapter.tool.claude/renderer'),{ToolConfigViewsProvider}=await import('./src/host/tool-config'),{ToolPluginSettings}=await import('./src/host/ToolPluginSettings');
const expression='(len <= 272000 ? tier("0_272k", p * 2 + cr * 0.2 + cc * 2.5 + c * 10) : tier("272k_plus", p * 4 + cr * 0.4 + cc * 5 + c * 15)) * (param("service_tier") == "fast" ? 2 : 1) * (param("service_tier") == "priority" ? 2 : 1) * (param("service_tier") == "ultrafast" ? 8 : 1)';
const prefs=structuredClone(DEFAULT_PREFERENCES);prefs.sites=[{...prefs.sites[0],id:'one',url:'https://fixture.invalid',userId:1,accessTokenConfigured:true},{...prefs.sites[0],id:'two',url:'https://other.invalid',userId:2,accessTokenConfigured:true}];prefs.activeSiteId='one';prefs.bindings=[{tool:'codex',siteId:'one',model:'tiered',group:'standard',tokenName:'fixture',serviceTier:'priority'},{tool:'codex',siteId:'two',model:'tiered',group:'standard',tokenName:'other',serviceTier:'default'}];
prefs.viewSelections={one:{'codex.model':'tiered','codex.group':'standard','claude.model':'plain','claude.group':'standard'},two:{'codex.model':'tiered','codex.group':'standard','claude.model':'plain','claude.group':'standard'}};
const base={quota_type:0,model_ratio:1,model_price:0,completion_ratio:1,enable_groups:['standard'],supported_endpoint_types:[]};
function App(){
  const [preferences,setPreferences]=useState(prefs),[page,setPage]=useState('tools'),[formula,setFormula]=useState(expression);fixture.preferences=preferences;fixture.page=setPage;fixture.formula=setFormula;
  fixture.site=id=>setPreferences(current=>({...current,activeSiteId:id}));
  const dashboard={status:{system_name:'Fixture',quota_per_unit:500000},user:{id:1},fetchedAt:1,catalog:{models:[{...base,model_name:'tiered',billing_mode:'tiered_expr',billing_expr:formula},{...base,model_name:'plain'},{...base,model_name:'variant',billing_plugin_variants:[{plugin_key:'flex',plugin_name:'Flex provider',billing_expr:'p*(param("service_tier")=="flex" ? .5 : 1)'}]}],groupRatio:{standard:.3},usableGroups:{standard:'测试渠道'},autoGroups:[],vendors:[]}};
  const context={preferences,configs:[],dashboard,bootstrap:{preferences,desktop:true,version:'fixture'},page,setPage,updatePreferences:async patch=>setPreferences(current=>applyPreferencePatch(current,patch)),reloadBootstrap:async()=>{},toast:()=>{},openLogin:()=>{}};
  return <AppContext.Provider value={context}><ToolConfigViewsProvider value={[codexConfigView,claudeConfigView]}>{page==='settings' ? <ToolPluginSettings definition={codexConfigView}/> : <Tools/>}</ToolConfigViewsProvider></AppContext.Provider>;
}
createRoot(document.getElementById('root')).render(<App/>);
`},bundle:true,platform:'browser',format:'esm',target:'chrome140',write:false,loader:{'.css':'empty','.svg':'text'},define:{'process.env.NODE_ENV':'"production"'},logLevel:'silent'});
  await writeFile(path.join(directory,'app.js'),output.outputFiles[0].contents);
  const css=await Promise.all(['components/segmented-switch.css','styles.css','workbench.css','select.css','theme-tokens.css','theme.css','updates-trends.css','filters-tools-motion.css','platform-logs.css','tools-progress.css','models-market.css'].map(file=>readFile(path.join('src',file),'utf8')));
  await writeFile(path.join(directory,'style.css'),css.join('\n')+'\n.desktop-shell{display:block;padding:24px;height:100vh;overflow:auto}*{animation:none!important;transition:none!important}');
  await writeFile(path.join(directory,'index.html'),'<html data-theme="light"><head><meta charset="utf-8"><link rel="stylesheet" href="style.css"></head><body><main class="desktop-shell" data-theme="light"><div id="root"></div></main><script type="module" src="app.js"></script></body></html>');
  await writeFile(path.join(directory,'main.cjs'),String.raw`
const {app,BrowserWindow}=require('electron'),fs=require('node:fs'),path=require('node:path');
for(const name of ['userData','sessionData','logs','crashDumps']){const dir=path.join(__dirname,name);fs.mkdirSync(dir,{recursive:true});app.setPath(name,dir);}app.disableHardwareAcceleration();
app.whenReady().then(async()=>{
  const win=new BrowserWindow({width:1180,height:900,show:false,webPreferences:{sandbox:true,contextIsolation:true,nodeIntegration:false,backgroundThrottling:false}});
  await win.loadFile(path.join(__dirname,'index.html'));
  await win.webContents.executeJavaScript('('+async function(){
    const check=(value,label)=>{if(!value)throw Error(label);},until=async fn=>{const end=performance.now()+5000;while(!fn()){if(performance.now()>end)throw Error('Timeout '+fn+' '+fixture.errors);await new Promise(resolve=>setTimeout(resolve,10));}};
    const tier=()=>document.querySelector('select[aria-label="Codex 服务等级"]'),model=()=>document.querySelector('select[aria-label="codex 目标模型"]'),values=()=>[...tier().options].map(option=>option.value).join(','),choose=(select,value)=>{select.value=value;select.dispatchEvent(new Event('change',{bubbles:true}));};
    await until(()=>tier() && model());check(values()===',fast,priority,ultrafast','exact advertised tiers missing');check(tier().options[0].textContent==='关闭','off option missing');check(tier().value==='priority','applied binding tier was not restored');
    choose(tier(),'ultrafast');await until(()=>tier().value==='ultrafast');
    choose(model(),'plain');await until(()=>values()==='');check(tier().value==='','plain model inherited old tier');
    choose(model(),'tiered');await until(()=>values().includes('ultrafast'));check(tier().value==='ultrafast','model-scoped selection was not restored');
    choose(model(),'variant');await until(()=>values()===',flex');choose(tier(),'flex');await until(()=>tier().value==='flex');
    choose(model(),'tiered');await until(()=>tier().value==='ultrafast');
    choose(document.querySelector('select[aria-label="Codex 上下文窗口"]'),'1000000');
    model().closest('form').requestSubmit();await until(()=>fixture.requests.length===1);check(fixture.requests[0].serviceTier==='ultrafast' && fixture.requests[0].contextWindow===1000000,'preview lost service tier or context');check(tier().disabled,'service tier not locked during preview');
    fixture.resolvePreview();await until(()=>document.querySelector('.tool-config-preview'));check(document.querySelector('.code-preview').textContent.includes('service_tier = "ultrafast"'),'preview omitted config value');
    [...document.querySelector('.tool-config-preview').querySelectorAll('button')].find(button=>button.textContent==='取消').click();await until(()=>!document.querySelector('.tool-config-preview'));
    choose(tier(),'');await until(()=>tier().value==='');model().closest('form').requestSubmit();await until(()=>fixture.requests.length===2);check(!Object.hasOwn(fixture.requests[1],'serviceTier'),'off option must omit serviceTier from request');
    fixture.resolvePreview();await until(()=>document.querySelector('.tool-config-preview'));check(document.querySelector('.tool-config-preview').textContent.includes('删除 service_tier') && !document.querySelector('.code-preview').textContent.includes('service_tier'),'off preview did not remove field');
    [...document.querySelector('.tool-config-preview').querySelectorAll('button')].find(button=>button.textContent==='取消').click();await until(()=>!document.querySelector('.tool-config-preview'));choose(tier(),'ultrafast');await until(()=>tier().value==='ultrafast');
    fixture.page('settings');await until(()=>document.querySelector('.plugin-tool-options'));check(tier().value==='ultrafast' && values().includes('ultrafast'),'plugin settings lost selected model context');choose(tier(),'fast');await until(()=>tier().value==='fast');
    fixture.page('tools');await until(()=>model());check(tier().value==='fast','settings and tool form did not share draft');
    fixture.site('two');await until(()=>fixture.preferences.activeSiteId==='two' && tier().value==='');
    fixture.site('one');await until(()=>fixture.preferences.activeSiteId==='one' && tier().value==='fast');
    fixture.formula('p*2');await until(()=>values()==='');check(tier().value==='','removed formula tier remained selectable');
    fixture.formula('(p*2)*(param("service_tier")=="ultrafast" ? 8 : 1)');await until(()=>values()===',ultrafast');check(tier().value==='','invalid saved fast tier was used after formula changed');choose(tier(),'ultrafast');await until(()=>tier().value==='ultrafast');
    check(!document.querySelector('select[aria-label="Claude 服务等级"]'),'Codex service tier leaked into Claude');check(fixture.errors.length===0,fixture.errors.join(','));
  }.toString()+')()');
  for(const mode of ['light','dark']){
    await win.webContents.executeJavaScript('document.documentElement.dataset.theme='+JSON.stringify(mode)+';document.querySelector(".desktop-shell").dataset.theme='+JSON.stringify(mode));
    await win.webContents.capturePage(undefined,{stayHidden:true,stayAwake:true});
    await win.webContents.executeJavaScript('('+function(){const select=document.querySelector('select[aria-label="Codex 服务等级"]'),card=select.closest('.tool-config-card'),a=select.getBoundingClientRect(),b=card.getBoundingClientRect();if(a.left<b.left || a.right>b.right || select.value!=='ultrafast')throw Error('Service tier layout/selection failed');}.toString()+')()');
    fs.writeFileSync(path.resolve('.test-data/codex-service-tier-'+mode+'.png'),(await win.webContents.capturePage(undefined,{stayHidden:true,stayAwake:true})).toPNG());
  }
  win.destroy();app.exit(0);
}).catch(error=>{console.error(error.stack||error);app.exit(1)});
`);
  const env={...process.env};delete env.ELECTRON_RUN_AS_NODE;
  const child=spawn(electron,[path.join(directory,'main.cjs')],{env,windowsHide:true,stdio:['ignore','pipe','pipe'],signal:t.signal});
  let outputText='';child.stdout.on('data',chunk=>outputText+=chunk);child.stderr.on('data',chunk=>outputText+=chunk);
  const code=await new Promise<number|null>((resolve,reject)=>{child.on('error',reject);child.on('close',resolve);});
  assert.equal(code,0,outputText);
});
