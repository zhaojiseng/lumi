import test from 'node:test';
import assert from 'node:assert/strict';
import {build} from 'esbuild';
import {mkdir,mkdtemp,writeFile,readFile,rm} from 'node:fs/promises';
import {existsSync} from 'node:fs';
import path from 'node:path';
import {spawn} from 'node:child_process';
import {createRequire} from 'node:module';

test('real plugin pages retain section gaps and fit the shell at wide/narrow sizes, signed in and out',{timeout:30000},async t=>{
  let electron:string;try{electron=createRequire(import.meta.url)('electron');}catch{return t.skip('Electron runtime unavailable');}if(!existsSync(electron))return t.skip('Electron runtime unavailable');
  const base=path.resolve('.test-data');await mkdir(base,{recursive:true});const root=await mkdtemp(path.join(base,'plugin-layout-'));t.after(()=>rm(root,{recursive:true,force:true,maxRetries:5,retryDelay:100}));
  const out=await build({stdin:{contents:`import React from 'react';import {createRoot} from 'react-dom/client';import {DEFAULT_PREFERENCES} from './shared/types';import {builtinManifests} from './plugins/manifests';
const originalMatchMedia=window.matchMedia.bind(window);window.matchMedia=query=>query.includes('prefers-reduced-motion') ? {...originalMatchMedia(query),matches:true} : originalMatchMedia(query);
const prefs=structuredClone(DEFAULT_PREFERENCES);prefs.sites[0].name='测试站点';prefs.sites[0].url='https://fixture.invalid';prefs.sites[0].userId=1;prefs.sites[0].accessTokenConfigured=true;
const dashboard={status:{system_name:'Fixture',quota_per_unit:500000,display_in_currency:true,usd_exchange_rate:1},user:{id:1,username:'fixture',display_name:'测试账户',quota:50000000,used_quota:100000,request_count:10,group:'default'},logs:{items:[],total:0,page:1,pageSize:15},series:[],stat:{quota:100000,token_used:123456,rpm:0,tpm:0},catalog:{models:[{model_name:'gpt-fixture',quota_type:0,model_ratio:1,model_price:0,completion_ratio:2,enable_groups:['default'],supported_endpoint_types:['openai']}],groupRatio:{default:1},usableGroups:{default:'默认渠道'},autoGroups:[],vendors:[]},tokens:[],warnings:[],fetchedAt:Date.now(),days:7,range:{startDate:'2026-09-26',endDate:'2026-10-02'}};
const stub=()=>()=>{};
const statuses=()=>builtinManifests.map(manifest=>({manifest,state:manifest.configurable && prefs.pluginEnabled[manifest.id]===false ? 'disabled' : 'active',views:prefs.pluginViews[manifest.id]}));
window.lumi={bootstrap:async()=>({preferences:prefs,desktop:true,platform:'win32',version:'fixture',configs:[],secureStorage:true}),inspectConfigs:async()=>[],dashboard:async()=>dashboard,listPlugins:async()=>builtinManifests.map(manifest=>({manifest,state:'active'})),readCatalog:async input=>({...input,loggedIn:true,catalog:dashboard.catalog,status:dashboard.status,warnings:[],fetchedAt:Date.now()}),readCodexUsage:async()=>({sourceId:'provider.codex',state:'ready',account:{id:'fixture',label:'fixture@example.invalid',plan:'plus'},windows:[{id:'codex',label:'Codex',primary:{usedPercent:10,remainingPercent:90,durationMinutes:300,resetsAt:Date.now()+10000000},secondary:{usedPercent:30,remainingPercent:70,durationMinutes:10080,resetsAt:Date.now()+30000000},credits:{remaining:12.5,unlimited:false,hasCredits:true}}],fetchedAt:Date.now()}),onRefresh:stub,onNavigate:stub,onWidgetVisibility:stub,onUpdate:stub,onReviewUpdate:stub,onToolRuntime:stub,onConfigProgress:stub,onAppLog:stub,toolRuntimes:async()=>[],appLogs:async()=>({startedAt:Date.now(),entries:[],dropped:0}),appCache:async()=>({categories:[],totalBytes:0,browserBytes:0,updateBytes:0,warnings:[],scannedAt:Date.now()}),backups:async()=>[],updateStatus:async()=>({phase:'unsupported',currentVersion:'fixture'}),loginInfo:async()=>({enabled:true}),updatePreferences:async patch=>Object.assign(prefs,patch),openExternal:async()=>{},windowControl:async()=>{},localUsage:async()=>({rows:[],points:[],sessions:[],warnings:[],filesScanned:0,scannedAt:Date.now()}),onLocalUsageProgress:stub,tokenUsage:async()=>({points:[],quality:{requestCount:0,cacheSamples:0,speedSamples:0,inputTokens:0,cacheReadTokens:0,outputTokens:0,durationSeconds:0,cacheHitRate:null,averageTokenSpeed:null,fetchedAt:Date.now()},logCount:0,fetchedAt:Date.now()}),usageQuality:async()=>({requestCount:0,cacheSamples:0,speedSamples:0,inputTokens:0,cacheReadTokens:0,outputTokens:0,durationSeconds:0,cacheHitRate:null,averageTokenSpeed:null,fetchedAt:Date.now()}),logs:async()=>dashboard.logs};
window.lumi.listPlugins=async()=>statuses();window.lumi.setPluginEnabled=async(id,enabled)=>{prefs.pluginEnabled[id]=enabled;return statuses();};window.lumi.setPluginView=async(id,view,enabled)=>{prefs.pluginViews[id]={...prefs.pluginViews[id],[view]:enabled};return statuses();};
window.fixture={widgetListeners:new Set(),errors:[],logout:()=>{prefs.sites[0].accessTokenConfigured=false;dashboard.user=null;}};window.lumi.onWidgetVisibility=fn=>{fixture.widgetListeners.add(fn);return()=>fixture.widgetListeners.delete(fn);};window.addEventListener('error',event=>fixture.errors.push(event.message));window.addEventListener('unhandledrejection',event=>fixture.errors.push(String(event.reason)));
const {default:App}=await import('./src/App');createRoot(document.getElementById('root')).render(<App/>);`,resolveDir:process.cwd(),loader:'tsx'},bundle:true,platform:'browser',format:'esm',write:false,loader:{'.svg':'text','.css':'empty'},define:{'process.env.NODE_ENV':'"production"'},logLevel:'silent'});
await writeFile(path.join(root,'renderer.js'),out.outputFiles.find(f=>f.path.endsWith('.js'))?.contents || out.outputFiles[0].contents);
const styles=await Promise.all(['styles.css','workbench.css','select.css','theme-tokens.css','theme.css','updates-trends.css','filters-tools-motion.css','platform-logs.css','local-usage.css','tools-progress.css','models-market.css','app-cache.css','recent-activity.css'].map(file=>readFile(path.resolve('src',file),'utf8')));await writeFile(path.join(root,'style.css'),styles.join('\n')+'\n*{animation:none!important;transition:none!important}');
await writeFile(path.join(root,'index.html'),'<html><head><meta charset="UTF-8"><link rel="stylesheet" href="style.css"></head><body><div id="root"></div><script type="module" src="renderer.js"></script></body></html>');

  await writeFile(path.join(root,'audit.cjs'),String.raw`
    const {app,BrowserWindow}=require('electron'),path=require('node:path'),fs=require('node:fs');
    for(const name of ['userData','sessionData','logs','crashDumps']){const dir=path.join(__dirname,name);fs.mkdirSync(dir,{recursive:true});app.setPath(name,dir);}
    app.whenReady().then(async()=>{
      const win=new BrowserWindow({show:false,webPreferences:{offscreen:true,nodeIntegration:false,contextIsolation:true,sandbox:true,backgroundThrottling:false}});await win.loadFile(path.join(__dirname,'index.html'));
      let checks=0;
      for(const width of [1280,1100]){win.setContentSize(width,850);for(const page of ['工作台','用量分析','模型广场','工具配置','API 令牌','设置']){
        await win.webContents.executeJavaScript('('+async function(label){
          const until=async(fn)=>{const end=performance.now()+4000;while(!fn()){if(performance.now()>end)throw new Error('Page not ready: '+label);await new Promise(r=>setTimeout(r,10));}};
          await until(()=>document.querySelectorAll('.nav-item').length>=6);Array.from(document.querySelectorAll('.nav-item')).find(e=>e.textContent.trim().startsWith(label)).click();
          await until(()=>document.querySelector('.breadcrumb strong').textContent===label && !document.querySelector('.skeleton'));
          await new Promise(r=>setTimeout(r,250));
          const body=document.querySelector('.content-scroll').textContent;
          if(body.includes('页面遇到问题') || body.includes('此来源暂时无法显示') || fixture.errors.length)throw new Error('Page failure: '+label+' '+fixture.errors.join(','));
          const area=document.querySelector('.content-scroll');if(area.scrollWidth>area.clientWidth+2)throw new Error('Outer overflow: '+label+' '+area.scrollWidth+'/'+area.clientWidth);
          const header=document.querySelector('.titlebar').getBoundingClientRect(),side=document.querySelector('.sidebar').getBoundingClientRect();
          if(side.top<header.bottom || side.left<=0 || side.bottom>=innerHeight || parseFloat(getComputedStyle(document.querySelector('.sidebar')).borderTopLeftRadius)<10)throw new Error('Sidebar lost floating inset');
          const containers=document.querySelectorAll('.provider-usage-section,.plugin-content');
          for(const container of containers){
            const css=getComputedStyle(container),children=Array.from(container.children).filter(e=>e.getBoundingClientRect().height>0);
            if(children.length<2)continue;
            if(css.display!=='flex' || css.flexDirection!=='column' || parseFloat(css.rowGap)<14)throw new Error('Provider spacing lost: '+label+' '+container.className);
            for(let i=1;i<children.length;i++)if(children[i].getBoundingClientRect().top-children[i-1].getBoundingClientRect().bottom<13)throw new Error('Sections overlap: '+label);
          }
          if(label==='工具配置' && document.querySelectorAll('.tool-config-card').length!==2)throw new Error('Tool adapters absent');
          return true;
        }.toString()+')('+JSON.stringify(page)+')');checks++;
      }}
      await win.webContents.executeJavaScript('fixture.logout();Array.from(document.querySelectorAll(".nav-item")).find(e=>e.textContent.trim().startsWith("工作台")).click();document.querySelector(".refresh-button").click();new Promise(r=>setTimeout(r,400))');
      const independent=await win.webContents.executeJavaScript('document.querySelector(".content-scroll").textContent.includes("周限额") && document.querySelector(".content-scroll").textContent.includes("剩余积分") && !document.querySelector(".content-scroll").textContent.includes("页面遇到问题")');if(!independent)throw new Error('Logged-out workbench lost independent provider');
      await win.webContents.executeJavaScript('('+async function(){
        const until=async(fn)=>{const end=performance.now()+4000;while(!fn()){if(performance.now()>end)throw new Error('Grouped plugin UI');await new Promise(r=>setTimeout(r,10));}};
        const nav=label=>Array.from(document.querySelectorAll('.nav-item')).find(e=>e.textContent.trim().startsWith(label));
        nav('设置').click();await until(()=>document.querySelectorAll('.plugin-settings-overview [data-plugin] [role=switch]').length===7);
        const root=document.querySelector('.settings-page'),groups=Array.from(document.querySelectorAll('.plugin-settings-group[data-plugin]'));
        if(groups.map(e=>e.dataset.plugin).join(',')!=='provider.newapi,provider.codex,provider.codex-bridge,surface.widget,surface.tray,adapter.tool.codex,adapter.tool.claude')throw new Error('Wrong product grouping');
        for(const group of groups){const box=group.getBoundingClientRect();for(const control of group.querySelectorAll('[role=switch]')){const c=control.getBoundingClientRect();if(c.left<box.left || c.right>box.right+1 || c.width<40)throw new Error('Switch overflow');}}
        const tab=label=>Array.from(document.querySelectorAll('.settings-subnav button')).find(b=>b.textContent===label);
        if(!tab('托盘') || !tab('浮窗') || !document.querySelector('[aria-label=连接]') || document.body.textContent.includes('站点连接'))throw new Error('Plugin settings registration missing');
        tab('浮窗').click();await until(()=>document.querySelector('[aria-label=浮窗数据源]'));
        await window.lumi.setPluginEnabled('surface.widget',false);fixture.widgetListeners.forEach(fn=>fn(false));await until(()=>!tab('浮窗') && document.querySelector('.plugin-settings'));
        if(document.querySelector('.settings-page')!==root || document.querySelector('[aria-label=浮窗数据源]'))throw new Error('Revoked Settings tab retained content or remounted shell');
        document.querySelector('[aria-label="启用托盘"]').click();await until(()=>!tab('托盘'));
        document.querySelector('[aria-label="启用NewAPI"]').click();await until(()=>!nav('模型广场') && !nav('API 令牌'));
        if(document.querySelector('.site-list'))throw new Error('NewAPI connection remains after disable');
        if(document.querySelector('.settings-page')!==root || !nav('工作台') || !nav('用量分析') || !nav('工具配置'))throw new Error('Provider toggle destroyed system or Settings');
        document.querySelector('[data-plugin="provider.newapi"] .plugin-settings-button').click();await until(()=>document.querySelector('.plugin-details-modal:not([aria-hidden])'));
        const child=document.querySelector('[data-plugin-details="provider.newapi"] [aria-label="显示NewAPI 模型广场"]');if(child.getAttribute('aria-checked')!=='true' || child.getAttribute('aria-disabled')!=='true')throw new Error('Disabled parent lost child choice');
        document.querySelector('.plugin-details-modal:not([aria-hidden]) [aria-label="关闭弹窗"]').click();await until(()=>!document.querySelector('.plugin-details-modal:not([aria-hidden])'));
        document.querySelector('[data-plugin="provider.codex"] .plugin-settings-button').click();await until(()=>document.querySelector('.plugin-details-modal:not([aria-hidden])'));
        document.querySelector('[data-plugin-details="provider.codex"] [aria-label="显示Codex 工作台"]').click();await until(()=>!nav('工作台'));
        document.querySelector('.plugin-details-modal:not([aria-hidden]) [aria-label="关闭弹窗"]').click();await until(()=>!document.querySelector('.plugin-details-modal:not([aria-hidden])'));
        document.querySelector('[aria-label="启用NewAPI"]').click();await until(()=>nav('模型广场'));
        if(document.querySelector('.settings-page')!==root || fixture.errors.length)throw new Error('Restart lost Settings');
      }.toString()+')()');
      console.log('LAYOUT_RESULT '+JSON.stringify({checks,loggedOut:true}));win.destroy();app.exit(0);
    }).catch(error=>{console.error(error.stack || error);app.exit(1);});
  `);
  const env={...process.env};delete env.ELECTRON_RUN_AS_NODE;const child=spawn(electron,[path.join(root,'audit.cjs')],{env,windowsHide:true,stdio:['ignore','pipe','pipe'],signal:t.signal});let stdout='',stderr='';child.stdout.on('data',chunk=>stdout+=chunk);child.stderr.on('data',chunk=>stderr+=chunk);
  const code=await new Promise<number|null>((resolve,reject)=>{child.on('error',reject);child.on('close',resolve);});assert.equal(code,0,stderr+stdout);
  const line=stdout.split(/\r?\n/).find(line=>line.startsWith('LAYOUT_RESULT '));assert.ok(line,stdout);assert.deepEqual(JSON.parse(line.slice('LAYOUT_RESULT '.length)),{checks:12,loggedOut:true});
});
