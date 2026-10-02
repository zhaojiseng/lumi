import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdir,mkdtemp,readFile,writeFile,rm} from 'node:fs/promises';
import {existsSync} from 'node:fs';
import path from 'node:path';
import {Script} from 'node:vm';
import {createRequire} from 'node:module';
import {spawn,execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {build} from 'esbuild';
import {readExtensionPackage} from '../electron/extensions/packages';

async function documentExamples(t:test.TestContext){
  const doc=await readFile('docs/PLUGIN_DEVELOPMENT.md','utf8');
  const blocks=[...doc.matchAll(/```(\w+)\r?\n([\s\S]*?)```/g)].map(m=>({language:m[1],text:m[2]}));
  const of=(language:string)=>blocks.filter(b=>b.language===language).map(b=>b.text);
  const manifests=of('json').map(text=>JSON.parse(text)),html=of('html'),js=of('js'),css=of('css');
  const license=of('text').find(text=>text.startsWith('MIT License'))!;
  assert.ok(license.includes('THE SOFTWARE IS PROVIDED "AS IS"'));assert.equal(manifests.length,3);
  assert.doesNotMatch(doc,/\]\((?:\.\.\/|[^:#)]+\.ts(?:x)?\))/,'Guide must not require repository source links');
  await mkdir('.test-data',{recursive:true});const directory=await mkdtemp(path.resolve('.test-data/plugin-doc-'));
  t.after(()=>rm(directory,{recursive:true,force:true,maxRetries:5,retryDelay:100}));
  const packages=path.join(directory,'packages');
  const definitions=[
    {manifest:manifests[0],assets:{'index.html':html[0],'app.js':js[0],'style.css':css[0]}},
    {manifest:manifests[1],assets:{'index.html':html[1],'app.js':js[1],'style.css':css[0]}},
    {manifest:manifests[2],assets:{'interface.css':css[1]}},
    {manifest:{...manifests[0],id:'extension.author.balance',permissions:['workbench.read']},assets:{'index.html':html[0],'app.js':js[2],'style.css':css[0]}},
  ];
  for(const {manifest,assets} of definitions){const folder=path.join(packages,manifest.id);await mkdir(folder,{recursive:true});
    await writeFile(path.join(folder,'plugin.json'),JSON.stringify(manifest));await writeFile(path.join(folder,'LICENSE'),license);
    for(const [name,text] of Object.entries(assets)){if(text===undefined)continue;assert.doesNotMatch(text,/\b(?:import|require)\s*\(/,'Example must be self-contained');if(name.endsWith('.js'))new Script(text);await writeFile(path.join(folder,name),text);}
    const pkg=await readExtensionPackage(folder);assert.equal(pkg.manifest.id,manifest.id);assert.ok(!pkg.files.has('lumi-sdk.js'));
  }
  return {directory,packages,doc,types:of('ts')};
}

test('guide alone supplies complete valid plugin packages and independently typechecks its SDK examples',async t=>{
  const {directory,types}=await documentExamples(t),declaration=types.find(text=>text.includes('export interface LumiExtensionSdk'))!;
  assert.doesNotMatch(declaration,/\bimport\b/);assert.equal(declaration.trim(),(await readFile('extensions/sdk/lumi-extension.d.ts','utf8')).trim());
  await writeFile(path.join(directory,'lumi-extension.d.ts'),declaration);
  await writeFile(path.join(directory,'example.ts'),types.find(text=>text.includes('async function inspectTypes'))!);
  await writeFile(path.join(directory,'tsconfig.json'),JSON.stringify({compilerOptions:{target:'ES2022',module:'ESNext',moduleResolution:'Bundler',strict:true,noEmit:true,types:[],lib:['ES2022','DOM']},files:['lumi-extension.d.ts','example.ts']}));
  await promisify(execFile)(process.execPath,[path.resolve('node_modules/typescript/bin/tsc'),'--project',path.join(directory,'tsconfig.json')],{timeout:15000,windowsHide:true});
});

test('document-only plugin files run in real sandbox frames with host SDK, shared storage and secret controls',{timeout:30000},async t=>{
  let electron:string;try{electron=createRequire(import.meta.url)('electron');}catch{return t.skip('Electron unavailable');}if(!existsSync(electron))return t.skip('Electron unavailable');
  const {directory,packages}=await documentExamples(t);
  const sdk=await readFile('public/lumi-extension-sdk.js','utf8');
  const bundled=(await build({stdin:{resolveDir:process.cwd(),loader:'ts',contents:`
import {app,BrowserWindow,protocol,ipcMain} from 'electron';
import {mkdirSync} from 'node:fs';import path from 'node:path';
import {ExtensionHost} from './electron/extensions/host';
for(const name of ['userData','sessionData','logs','crashDumps'] as const){const dir=path.join(__dirname,name);mkdirSync(dir,{recursive:true});app.setPath(name,dir);}
protocol.registerSchemesAsPrivileged([{scheme:'lumi-extension',privileges:{standard:true,secure:true}}]);app.disableHardwareAcceleration();
const context={theme:'light' as const,locale:'zh-CN' as const,site:{id:'fixture',name:'Fixture',url:'https://fixture.invalid'}};
app.whenReady().then(async()=>{
 const host=new ExtensionHost({directory:${JSON.stringify(packages)},settingsDirectory:path.join(__dirname,'store'),cipher:{available:()=>true,encrypt:value=>Buffer.from(value).toString('base64'),decrypt:value=>Buffer.from(value,'base64').toString()},sdk:Buffer.from(${JSON.stringify(sdk)}),context:()=>context,scope:()=>context.site.id,read:async()=>({siteName:'Fixture',balance:'¥ 12.00',message:'mock display'})});
 await host.start();for(const item of host.statuses())await host.setEnabled(item.manifest.id,true);
 protocol.handle('lumi-extension',request=>{const asset=host.asset(request.url);return asset ? new Response(new Uint8Array(asset.body),{headers:{'Content-Type':asset.type,'Content-Security-Policy':asset.csp,'X-Content-Type-Options':'nosniff'}}) : new Response('',{status:404});});
 ipcMain.handle('doc-read',()=>host.statuses().map(status=>({id:status.manifest.id,generation:status.generation})));
 ipcMain.handle('doc-request',(_event,input)=>host.request(input));
 const win=new BrowserWindow({show:false,width:900,height:650,webPreferences:{sandbox:true,contextIsolation:true,nodeIntegration:false,backgroundThrottling:false,preload:path.join(__dirname,'preload.cjs')}});
 await win.loadFile(path.join(__dirname,'index.html'));
 const frames=async()=>win.webContents.mainFrame.frames.filter(frame=>frame.url.startsWith('lumi-extension:'));
 const until=async(fn:()=>Promise<boolean>)=>{const end=Date.now()+5000;while(!await fn()){if(Date.now()>end)throw new Error('Documentation fixture timeout');await new Promise(r=>setTimeout(r,20));}};
 await until(async()=> (await frames()).length===5);
 const frame=(view:string)=>{const result=win.webContents.mainFrame.frames.find(f=>f.url.endsWith('#'+view));if(!result)throw new Error('Missing doc frame '+view);return result;};
 const notes=frame('notes-card');await until(()=>notes.executeJavaScript("!document.querySelector('#save').disabled"));
 await notes.executeJavaScript("document.querySelector('#note').value='from documentation';document.querySelector('#save').click()");
 await until(()=>notes.executeJavaScript("document.querySelector('#status').textContent==='已保存'"));
 const shared=await frame('notes-page').executeJavaScript("lumiExtension.storage.read('note')");if(shared!=='from documentation')throw new Error('Document storage sample failed');
 const connection=frame('service-connection');await until(()=>connection.executeJavaScript("!document.querySelector('#save').disabled"));
 await connection.executeJavaScript("document.querySelector('#api').value='fake-doc-secret';document.querySelector('#save').click()");
 await until(()=>connection.executeJavaScript("document.querySelector('#result').textContent.startsWith('已保存') && document.querySelector('#api').value===''") );
 const service=frame('service-card');if(!await service.executeJavaScript("lumiExtension.secrets.has('api')"))throw new Error('Document secret sharing failed');
 await connection.executeJavaScript("document.querySelector('#remove').click()");await until(()=>connection.executeJavaScript("document.querySelector('#result').textContent==='已删除密钥'"));
 if(await service.executeJavaScript("lumiExtension.secrets.has('api')"))throw new Error('Document secret removal failed');
 const balance=frame('balance');await until(()=>balance.executeJavaScript("document.querySelector('#status').textContent.includes('¥ 12.00')"));
 const isolated=await notes.executeJavaScript("(()=>{let denied=false;try{void parent.document.body}catch{denied=true}return denied && typeof require==='undefined' && typeof lumi==='undefined'})()");if(!isolated)throw new Error('Example escaped sandbox');
 const layout=await win.webContents.executeJavaScript("document.fixtureSheetReady && getComputedStyle(document.querySelector('.sidebar')).width==='164px' && getComputedStyle(document.querySelector('#outside')).color==='rgb(0, 0, 0)'");if(!layout)throw new Error('Document interface sample failed');
 console.log('DOCUMENT_EXAMPLES_RESULT '+JSON.stringify({notes:true,connection:true,balance:true,isolated:true,layout:true}));win.destroy();host.dispose();app.exit(0);
}).catch(error=>{console.error(error.stack || error);app.exit(1)});
`},bundle:true,platform:'node',format:'cjs',write:false,external:['electron'],logLevel:'silent'})).outputFiles[0].contents;
  await writeFile(path.join(directory,'main.cjs'),bundled);
  await writeFile(path.join(directory,'preload.cjs'),"const {contextBridge,ipcRenderer}=require('electron');contextBridge.exposeInMainWorld('fixtureHost',{statuses:()=>ipcRenderer.invoke('doc-read'),request:input=>ipcRenderer.invoke('doc-request',input)});");
  const layoutCSS=await readFile(path.join(packages,'extension.author.layout/interface.css'),'utf8');
  const layoutBundle=(await build({stdin:{resolveDir:process.cwd(),loader:'ts',contents:`import {scopedInterfaceSheet} from './src/host/interface';document.adoptedStyleSheets=[scopedInterfaceSheet({id:'extension.author.layout',css:${JSON.stringify(layoutCSS+'\n#outside{color:red!important}')}})];(document as any).fixtureSheetReady=true;`},bundle:true,platform:'browser',format:'iife',write:false,loader:{'.svg':'text','.css':'empty'},logLevel:'silent'})).outputFiles[0].contents;
  await writeFile(path.join(directory,'interface.js'),layoutBundle);
  await writeFile(path.join(directory,'index.html'),`<!doctype html><html><body><div id="outside" style="color:black">Outside</div><div class="desktop-shell" data-interface="extension.author.layout"><aside class="sidebar" style="width:var(--sidebar-width)"></aside></div><script src="interface.js"></script><script>
const protocol='lumi-extension/1';fixtureHost.statuses().then(statuses=>{
 const definitions=[['notes-card','extension.author.notes','card','workbench'],['notes-page','extension.author.notes','page','sidebar'],['service-connection','extension.author.service','connection','connection'],['service-card','extension.author.service','card','workbench'],['balance','extension.author.balance','card','workbench']];
 const frames=definitions.map(([name,id,view,slot])=>{const frame=document.createElement('iframe');frame.sandbox='allow-scripts';const generation=statuses.find(s=>s.id===id).generation,nonce=crypto.randomUUID();frame.src='lumi-extension://'+id+'/'+generation+'/index.html#'+name;document.body.append(frame);return {frame,id,generation,view,slot,nonce};});
 window.addEventListener('message',event=>{const item=frames.find(f=>f.frame.contentWindow===event.source),message=event.data;if(!item || message.protocol!==protocol)return;const send=value=>event.source.postMessage({protocol,nonce:item.nonce,...value},'*');
  if(message.type==='ready'){send({type:'init',context:{theme:'light',locale:'zh-CN',site:{id:'fixture',name:'Fixture',url:'https://fixture.invalid'}},view:{id:item.view,slot:item.slot}});return;}
  if(message.nonce!==item.nonce || message.type!=='request')return;
  fixtureHost.request({id:item.id,generation:item.generation,view:item.view,method:message.method,input:message.input}).then(data=>send({type:'response',id:message.id,ok:true,data}),error=>send({type:'response',id:message.id,ok:false,error:error.message}));
 });
});</script></body></html>`);
  const env={...process.env};delete env.ELECTRON_RUN_AS_NODE;
  const child=spawn(electron,[path.join(directory,'main.cjs')],{env,windowsHide:true,stdio:['ignore','pipe','pipe'],signal:t.signal});let out='',error='';child.stdout.on('data',b=>out+=b);child.stderr.on('data',b=>error+=b);
  const code=await new Promise<number|null>((resolve,reject)=>{child.on('error',reject);child.on('close',resolve);});assert.equal(code,0,error+out);assert.match(out,/DOCUMENT_EXAMPLES_RESULT.*"notes":true.*"connection":true.*"balance":true.*"isolated":true/);
});
