import test from 'node:test';
import assert from 'node:assert/strict';
import {build} from 'esbuild';
import {mkdir,mkdtemp,writeFile,rm} from 'node:fs/promises';
import {existsSync} from 'node:fs';
import {createRequire} from 'node:module';
import {spawn} from 'node:child_process';
import path from 'node:path';

test('host-owned SDK refraction renders in opaque frames with production CSP and survives theme and document lifecycles',{timeout:45000},async t=>{
  const electron=createRequire(import.meta.url)('electron');if(!existsSync(electron))return t.skip('Electron unavailable');
  const helpers=await import(new URL('../scripts/extension-ui.mjs',import.meta.url).href);
  const sdk:string=await helpers.extensionSdkRuntime();
  await mkdir('.test-data',{recursive:true});const directory=await mkdtemp(path.resolve('.test-data/extension-refraction-'));
  t.after(()=>rm(directory,{recursive:true,force:true,maxRetries:5,retryDelay:100}));
  const id='extension.fixture.refraction',packageDirectory=path.join(directory,'packages',id);await mkdir(packageDirectory,{recursive:true});
  await writeFile(path.join(packageDirectory,'plugin.json'),JSON.stringify({schemaVersion:1,id,name:'折射链路夹具',version:'1.0.0',hostApiVersion:1,description:'隔离 UI 回归',author:'Fixture',license:'MIT',permissions:[],contributions:['normal','early','late'].map(name=>({id:name,slot:'sidebar',title:name,entry:name+'.html'}))}));
  await writeFile(path.join(packageDirectory,'LICENSE'),'MIT License\nPermission is hereby granted, free of charge, to use this test fixture.');
  const setup=`window.fixture={errors:[],violations:[],resizes:0};addEventListener('error',e=>fixture.errors.push(e.message));addEventListener('unhandledrejection',e=>fixture.errors.push(String(e.reason)));addEventListener('securitypolicyviolation',e=>fixture.violations.push(e.violatedDirective));const nativeMedia=matchMedia.bind(window);fixture.media=new Map();window.matchMedia=query=>{if(!['(prefers-reduced-transparency: reduce)','(forced-colors: active)'].includes(query))return nativeMedia(query);if(!fixture.media.has(query))fixture.media.set(query,{matches:false,listeners:new Set(),addEventListener:(_type,fn)=>fixture.media.get(query).listeners.add(fn),removeEventListener:(_type,fn)=>fixture.media.get(query).listeners.delete(fn)});return fixture.media.get(query)};fixture.setMedia=(query,value)=>{const media=matchMedia(query);media.matches=value;for(const fn of media.listeners)fn()};`;
  await writeFile(path.join(packageDirectory,'setup.js'),setup);
  await writeFile(path.join(packageDirectory,'slow.js'),'// Hold parsing before the body so ready/init can arrive first.');
  await writeFile(path.join(packageDirectory,'late.js'),`addEventListener('DOMContentLoaded',()=>{const script=document.createElement('script');script.src='lumi-sdk.js';document.head.append(script)});`);
  const markup='<main id="background"><h2>项目会话</h2><article><h3>更新文件改动摘要</h3><p>README.md · 新增 14 行 · 删除 3 行</p><p>模型已完成回复，继续查看上一轮用户输入。</p><pre>function updateMessage() {\n  return nextRevision;\n}</pre></article><article><h3>下一轮用户消息</h3><p>优化窗口尺寸下的对话布局与渲染管线。</p></article></main><aside id="preview" class="donut-tooltip"><strong id="foreground">用户消息预览</strong><p>显示对应位置的用户输入</p></aside>';
  for(const name of ['normal','early','late']){
    const scripts=name==='early' ? '<script src="lumi-sdk.js"></script><script src="slow.js"></script>' : name==='late' ? '<script src="late.js" defer></script>' : '<script src="lumi-sdk.js" defer></script>';
    await writeFile(path.join(packageDirectory,name+'.html'),'<!doctype html><html><head><meta charset="UTF-8"><link rel="stylesheet" href="lumi-ui.css" data-lumi-ui><script src="setup.js"></script>'+scripts+'</head><body data-lumi-ui>'+markup+'</body></html>');
  }
  const skin=`:scope{--lumi-glass-distortion:8;--ink:#111827;--page:#eef2f7;--card:#fff;--glass:rgb(255 255 255 / .24);color:var(--ink);background:var(--page)}:scope[data-theme="dark"]{--ink:#f4f6fc;--page:#111827;--card:#243247;--glass:rgb(20 28 44 / .24)}:scope[data-appearance-transparency="solid"]{--lumi-glass-distortion:0;--glass:var(--card)}.donut-tooltip{position:absolute;left:130px;top:65px;width:240px;height:130px;border-radius:16px;isolation:isolate;z-index:1;padding:28px 24px;color:var(--ink)}.donut-tooltip::before{content:"";position:absolute;inset:0;z-index:-1;border-radius:inherit;background:var(--glass);backdrop-filter:var(--lumi-glass-filter,blur(0px)) blur(.5px)}`;
  const uiCss='*{box-sizing:border-box}body{margin:0;min-width:0;font:14px/1.5 sans-serif}#background{padding:16px;background:var(--page);min-height:520px}h2,h3,p{margin:0 0 8px}article{padding:12px 16px;margin:12px 0;background:var(--card);border:1px solid #7b8799;border-radius:12px}pre{margin:6px 0;background:#77899e22;padding:8px;font:13px monospace}.donut-tooltip p{margin-top:12px;font-size:12px}#foreground{position:relative;z-index:1;font-size:16px}';
  const childMain=(await build({stdin:{resolveDir:process.cwd(),loader:'ts',contents:`
import {app,BrowserWindow,protocol} from 'electron';
import {mkdirSync,writeFileSync} from 'node:fs';import path from 'node:path';
import {ExtensionHost} from './electron/extensions/host';
for(const name of ['userData','sessionData','logs','crashDumps']){const target=path.join(__dirname,name);mkdirSync(target,{recursive:true});app.setPath(name,target)}
protocol.registerSchemesAsPrivileged([{scheme:'lumi-extension',privileges:{standard:true,secure:true,supportFetchAPI:true}}]);if(process.env.LUMI_GLASS_HARDWARE!=='1')app.disableHardwareAcceleration();app.commandLine.appendSwitch('force-device-scale-factor','1');
app.whenReady().then(async()=>{
 const host=new ExtensionHost({directory:${JSON.stringify(path.join(directory,'packages'))},settingsDirectory:path.join(__dirname,'store'),cipher:{available:()=>true,encrypt:value=>value,decrypt:value=>value},sdk:Buffer.from(${JSON.stringify(sdk)}),uiCss:Buffer.from(${JSON.stringify(uiCss)}),context:()=>({theme:'light',locale:'zh-CN',site:{id:'fixture',name:'Fixture',url:'https://fixture.invalid'}}),scope:()=>'',read:async()=>null});
 await host.start();await host.setEnabled(${JSON.stringify(id)},true);const generation=host.statuses()[0].generation;
 protocol.handle('lumi-extension',async request=>{const asset=host.asset(request.url);if(request.url.endsWith('/slow.js'))await new Promise(r=>setTimeout(r,250));return asset ? new Response(new Uint8Array(asset.body),{headers:{'Content-Type':asset.type,'Content-Security-Policy':asset.csp,'Cache-Control':'no-store','Access-Control-Allow-Origin':'*','X-Content-Type-Options':'nosniff'}}) : new Response('Unavailable',{status:404})});
 const win=new BrowserWindow({show:process.platform==='darwin',width:620,height:600,webPreferences:{sandbox:true,contextIsolation:true,nodeIntegration:false,backgroundThrottling:false}});await win.loadFile(path.join(__dirname,'index.html'));
 const run=code=>win.webContents.executeJavaScript(code),frame=()=>win.webContents.mainFrame.frames.find(f=>f.url.startsWith('lumi-extension:'));
 const until=async(fn,label)=>{const end=Date.now()+6000;while(!await fn()){if(Date.now()>end)throw Error(label);await new Promise(r=>setTimeout(r,20))}},check=async(code,label)=>{if(!await frame().executeJavaScript(code))throw Error(label)};
 const theme=(mode='light',appearance={})=>run('fixture.send({type:"ui-theme",uiTheme:'+JSON.stringify({id:'fixture.glass',css:${JSON.stringify(skin)},theme:mode,appearance})+'})');
 await run('fixture.start('+JSON.stringify('lumi-extension://${id}/'+generation+'/normal.html')+')');
 await until(()=>frame()?.executeJavaScript('!!document.querySelector("[data-lumi-glass-defs] filter")'),'SDK bundle did not attach a document-local filter');
 await check('getComputedStyle(document.querySelector("#preview"),"::before").backdropFilter.includes("url(")','Pseudo-layer did not consume the runtime filter');
 await check('document.querySelector("feImage").getAttribute("href").startsWith("data:image/png") && fixture.violations.length===0','Production CSP blocked the displacement texture');
 await check('(()=>{let isolated=false;try{void parent.document.body}catch{isolated=true}return isolated && typeof require==="undefined" && typeof lumi==="undefined"})()','SDK escaped its opaque sandbox');
 let changedPixels=0;
 for(const mode of ['light','dark']){
  await theme(mode);await until(()=>frame().executeJavaScript('document.body.dataset.theme==='+JSON.stringify(mode)+' && !!document.querySelector("[data-lumi-glass-defs] filter")'),'Theme did not reach frame');
  await frame().executeJavaScript('new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)))');
  const warped=await win.webContents.capturePage({x:130,y:65,width:240,height:130});
  await frame().executeJavaScript('document.body.style.setProperty("--lumi-glass-distortion","0")');await until(()=>frame().executeJavaScript('!document.querySelector("[data-lumi-glass-defs] filter")'),'Disabled distortion retained filters');
  await frame().executeJavaScript('new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)))');
  const plain=await win.webContents.capturePage({x:130,y:65,width:240,height:130});const a=warped.toBitmap(),b=plain.toBitmap();let changed=0;
  for(let offset=0;offset<a.length;offset+=4)if(Math.abs(a[offset]-b[offset])+Math.abs(a[offset+1]-b[offset+1])+Math.abs(a[offset+2]-b[offset+2])>8)changed++;
  if(changed<20){writeFileSync(path.join(__dirname,'pixel-'+mode+'.png'),warped.toPNG());throw Error('Rendered '+mode+' refraction has only '+changed+' changed pixels')};changedPixels+=changed;
  // The foreground is a separate paint layer. Its exact ink pixels must remain
  // fixed even when the backdrop immediately behind them is displaced.
  const ink=mode==='dark' ? [252,246,244] : [39,24,17],size=warped.getSize(),sx=size.width/240,sy=size.height/130;let inkPixels=0,movedInk=0;
  for(let y=Math.ceil(28*sy);y<Math.floor(53*sy);y++)for(let x=Math.ceil(24*sx);x<Math.floor(204*sx);x++){
    const offset=(y*size.width+x)*4,first=ink.every((v,c)=>a[offset+c]===v),second=ink.every((v,c)=>b[offset+c]===v);if(first)inkPixels++;if(first!==second)movedInk++;
  }
  if(inkPixels<40 || movedInk>5)throw Error('Foreground '+mode+' moved or blurred: '+JSON.stringify({inkPixels,movedInk}));
  await frame().executeJavaScript('document.body.style.removeProperty("--lumi-glass-distortion")');await until(()=>frame().executeJavaScript('!!document.querySelector("[data-lumi-glass-defs] filter")'),'Distortion did not restore');
 }
 const blurMetrics=[];
 for(const mode of ['light','dark']){
  await theme(mode);
  await frame().executeJavaScript('window.blurProbe=document.createElement("style");blurProbe.textContent="#preview>*{visibility:hidden}#preview::before{backdrop-filter:blur(var(--fixture-blur,6px)) var(--lumi-glass-filter,blur(0px))}";document.head.append(blurProbe)');
  const capture=async(strength,blur,order='before')=>{
   await frame().executeJavaScript('document.body.style.setProperty("--lumi-glass-distortion",'+JSON.stringify(String(strength))+');document.body.style.setProperty("--fixture-blur",'+JSON.stringify(blur+'px')+');blurProbe.textContent='+JSON.stringify('#preview>*{visibility:hidden}#preview::before{backdrop-filter:'+ (order==='before' ? 'blur(var(--fixture-blur)) var(--lumi-glass-filter,blur(0px))' : 'var(--lumi-glass-filter,blur(0px)) blur(var(--fixture-blur))') +'}'));
   await until(()=>frame().executeJavaScript(strength ? '!!document.querySelector("[data-lumi-glass-defs] filter")' : '!document.querySelector("[data-lumi-glass-defs] filter")'),'Blur audit strength not applied');
   await frame().executeJavaScript('new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)))');return win.webContents.capturePage({x:180,y:105,width:140,height:40});
  };
  const before=await capture(8,6),after=await capture(8,6,'after'),blurOnly=await capture(0,6),plain=await capture(0,0),difference=(a,b)=>{const first=a.toBitmap(),second=b.toBitmap();let total=0,changed=0;for(let i=0;i<first.length;i+=4){const sum=Math.abs(first[i]-second[i])+Math.abs(first[i+1]-second[i+1])+Math.abs(first[i+2]-second[i+2]);total+=sum;if(sum>8)changed++}return {mean:total/(first.length/4*3),changed}};
  // Sample real background message text well inside the neutral center, beyond
  // both the bevel and the blur kernel. No synthetic texture or foreground
  // content can make an absent blur appear to pass this comparison.
  const metrics={mode,blurBeforeSvgVsBlurOnly:difference(before,blurOnly),svgBeforeBlurVsBlurOnly:difference(after,blurOnly),blurOnlyVsPlain:difference(blurOnly,plain)};
  if(metrics.blurBeforeSvgVsBlurOnly.mean>1 || metrics.svgBeforeBlurVsBlurOnly.mean>1)throw Error('SVG bypassed or changed the '+mode+' backdrop blur: '+JSON.stringify(metrics));
  if(metrics.blurOnlyVsPlain.mean<5 || metrics.blurOnlyVsPlain.changed<500)throw Error('Backdrop blur did not change real '+mode+' message pixels: '+JSON.stringify(metrics));blurMetrics.push(metrics);
  await frame().executeJavaScript('blurProbe.remove();document.body.style.removeProperty("--fixture-blur");document.body.style.removeProperty("--lumi-glass-distortion")');
 }
 console.log('BLUR_PIPELINE_OK '+JSON.stringify(blurMetrics));
 await theme('dark',{transparency:'solid'});await until(()=>frame().executeJavaScript('!document.querySelector("[data-lumi-glass-defs] filter")'),'Solid appearance retained refraction');await theme('dark');
 await until(()=>frame().executeJavaScript('!!document.querySelector("[data-lumi-glass-defs] filter")'),'Glass did not restore after solid');
 for(const query of ['(prefers-reduced-transparency: reduce)','(forced-colors: active)']){
  await frame().executeJavaScript('fixture.setMedia('+JSON.stringify(query)+',true)');await until(()=>frame().executeJavaScript('!document.querySelector("[data-lumi-glass-defs] filter")'),'Accessibility mode retained filter');
  await frame().executeJavaScript('fixture.setMedia('+JSON.stringify(query)+',false)');await until(()=>frame().executeJavaScript('!!document.querySelector("[data-lumi-glass-defs] filter")'),'Accessibility change did not restore filter');
 }
 await frame().executeJavaScript('document.querySelector("#preview").hidden=true');await until(()=>frame().executeJavaScript('!document.querySelector("[data-lumi-glass-defs] filter")'),'Hidden surface retained allocation');
 await frame().executeJavaScript('document.querySelector("#preview").hidden=false');await until(()=>frame().executeJavaScript('!!document.querySelector("[data-lumi-glass-defs] filter")'),'Unhidden surface did not restore filter');
 for(let cycle=0;cycle<3;cycle++){
  await frame().executeJavaScript('dispatchEvent(new PageTransitionEvent("pagehide"))');await check('!document.querySelector("[data-lumi-glass-defs]") && !document.querySelector("#preview").style.getPropertyValue("--lumi-glass-filter")','Pagehide retained resources');
  await frame().executeJavaScript('dispatchEvent(new PageTransitionEvent("pageshow"))');await until(()=>frame().executeJavaScript('document.querySelectorAll("[data-lumi-glass-defs]").length===1 && !!document.querySelector("[data-lumi-glass-defs] filter")'),'Pageshow duplicated or failed to restore resources');
 }
 await run('fixture.send({type:"ui-theme",uiTheme:{id:"interface.default",css:"",theme:"light",appearance:{}}})');await until(()=>frame().executeJavaScript('!document.querySelector("[data-lumi-glass-defs] filter") && !document.querySelector("#preview").style.getPropertyValue("--lumi-glass-filter")'),'Default skin retained filter references');
 for(const name of ['early','late']){
  await run('fixture.start('+JSON.stringify('lumi-extension://${id}/'+generation+'/'+name+'.html')+')');
  await until(()=>frame()?.url.endsWith('/'+name+'.html') && frame().executeJavaScript('!!document.querySelector("[data-lumi-glass-defs] filter")'),'SDK '+name+' load lost theme/runtime');
  await check('fixture.errors.length===0 && fixture.violations.length===0','SDK '+name+' produced browser/CSP errors');
  const before=await run('fixture.resizes');await frame().executeJavaScript('document.querySelector("#background").style.minHeight="900px"');await until(async()=>await run('fixture.resizes')>before,'SDK '+name+' did not observe content resize');
 }
 await check('fetch("https://fixture.invalid/denied").then(()=>false,()=>true)','Production CSP allowed a direct network request');
 await until(()=>frame().executeJavaScript('fixture.violations.includes("connect-src")'),'Expected connect-src denial was not recorded');
 console.log('EXTENSION_REFRACTION_OK opaque CSP pixels='+changedPixels+' sharp light dark solid accessibility hidden lifecycle early late hardware='+String(process.env.LUMI_GLASS_HARDWARE==='1'));win.destroy();host.dispose();app.exit(0);
}).catch(error=>{console.error(error.stack || error);app.exit(1)});
`},bundle:true,platform:'node',format:'cjs',write:false,external:['electron'],logLevel:'silent'})).outputFiles[0].contents;
  await writeFile(path.join(directory,'main.cjs'),childMain);
  await writeFile(path.join(directory,'index.html'),'<!doctype html><html><head><style>body{margin:0}iframe{display:block;width:600px;height:560px;border:0}</style></head><body><script>window.fixture={resizes:0};fixture.send=value=>document.querySelector("iframe").contentWindow.postMessage({protocol:"lumi-extension/1",nonce:"fixture",...value},"*");addEventListener("message",e=>{if(e.source!==document.querySelector("iframe")?.contentWindow || e.data?.protocol!=="lumi-extension/1")return;if(e.data.type==="ready")fixture.send({type:"init",context:{},view:{id:"normal",slot:"sidebar"},uiTheme:'+JSON.stringify({id:'fixture.glass',css:skin,theme:'light',appearance:{}})+'});if(e.data.type==="resize")fixture.resizes++});fixture.start=url=>{document.querySelector("iframe")?.remove();const iframe=document.createElement("iframe");iframe.sandbox="allow-scripts";iframe.src=url;document.body.append(iframe)};</script></body></html>');
  const env={...process.env};delete env.ELECTRON_RUN_AS_NODE;
  const child=spawn(electron,[path.join(directory,'main.cjs')],{env,windowsHide:true,stdio:['ignore','pipe','pipe'],signal:t.signal});let output='';child.stdout.on('data',data=>output+=data);child.stderr.on('data',data=>output+=data);
  const code=await new Promise<number|null>((resolve,reject)=>{child.on('error',reject);child.on('close',resolve)});assert.equal(code,0,output);assert.match(output,/EXTENSION_REFRACTION_OK/);t.diagnostic(output.match(/EXTENSION_REFRACTION_OK[^\r\n]*/)![0]);t.diagnostic(output.match(/BLUR_PIPELINE_OK[^\r\n]*/)![0]);
});
