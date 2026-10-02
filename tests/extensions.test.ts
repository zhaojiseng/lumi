import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,cp,writeFile,readFile,rm,symlink} from 'node:fs/promises';
import path from 'node:path';
import {ExtensionHost} from '../electron/extensions/host';
import {readExtensionPackage,scanExtensionPackages} from '../electron/extensions/packages';
import {parseExtensionManifest} from '../shared/extension-manifest';
import {publicExtensionAddress,extensionNetworkRead} from '../electron/extensions/network';
import {build} from 'esbuild';
import {runInNewContext} from 'node:vm';
import {EventEmitter} from 'node:events';
import {registerExternalRenderers} from '../src/host/extensions-registry';
import {workbenchContributions,settingsTabContributions,connectionContributions,rendererNavigation,validateRendererRegistry,allRendererContributions} from '../src/host/renderer-registry';
const cipher={available:()=>true,encrypt:(value:string)=>Buffer.from(value).toString('base64'),decrypt:(value:string)=>Buffer.from(value,'base64').toString()};
const id='extension.lumi.notes';
async function fixture(t:test.TestContext,read:()=>Promise<unknown>=async()=>({balance:'12'})){
  await mkdir('.test-data',{recursive:true});const root=await mkdtemp(path.resolve('.test-data/extensions-'));t.after(()=>rm(root,{recursive:true,force:true,maxRetries:5,retryDelay:100}));
  const directory=path.join(root,'packages'),pkg=path.join(directory,id);await cp('extensions/packages/'+id,pkg,{recursive:true});let scope='site-a';
  const options={directory,settingsDirectory:root,cipher,sdk:await readFile('public/lumi-extension-sdk.js'),context:()=>({theme:'light' as const,locale:'zh-CN' as const,site:{id:'a',name:'Fixture',url:'https://fixture.invalid'}}),scope:()=>scope,read};
  const host=new ExtensionHost(options);await host.start();t.after(()=>host.dispose());
  return {root,pkg,host,options,scope:(value:string)=>{scope=value;},request:(method:any,input?:unknown)=>host.request({id,generation:host.statuses()[0].generation!,view:'card',method,input})};
}
test('external packages validate independent assets and reject undeclared/privileged entries',async t=>{
  const {pkg}=await fixture(t),p=await readExtensionPackage(pkg);assert.equal(p.manifest.id,id);assert.match(p.digest,/^[a-f0-9]{64}$/);
  assert.throws(()=>parseExtensionManifest({...p.manifest,main:'main.cjs'}));assert.throws(()=>parseExtensionManifest({...p.manifest,id:'provider.newapi'}));
  assert.throws(()=>parseExtensionManifest({...p.manifest,hostApiVersion:2}));assert.throws(()=>parseExtensionManifest({...p.manifest,contributions:[{...p.manifest.contributions[0],entry:'../index.html'}]}));
  assert.throws(()=>parseExtensionManifest({...p.manifest,contributions:[{...p.manifest.contributions[0],switch:'unknown'}]}));
  await writeFile(path.join(pkg,'lumi-sdk.js'),'override');await assert.rejects(readExtensionPackage(pkg),/覆盖/);
});
test('independent flags, settings, encrypted secrets and permission checks survive restart',async t=>{
  const f=await fixture(t);assert.equal(f.host.statuses()[0].state,'disabled');await assert.rejects(f.request('context.read'),/停用/);
  await f.host.setEnabled(id,true);await f.request('storage.write',{key:'note',value:'draft'});assert.equal(await f.request('storage.read',{key:'note'}),'draft');
  await assert.rejects(f.request('codex.usage.read'),/权限/);await assert.rejects(f.request('secret.set',{key:'api',value:'fake'}),/权限/);await assert.rejects(f.request('storage.write',{key:'constructor',value:'x'}));
  await f.host.setView(id,'workbench',false);await assert.rejects(f.request('storage.read',{key:'note'}),/停用/);await f.host.setView(id,'workbench',true);
  const restarted=new ExtensionHost(f.options);await restarted.start();t.after(()=>restarted.dispose());assert.equal(restarted.statuses()[0].state,'active');
  assert.equal(await restarted.request({id,generation:restarted.statuses()[0].generation!,view:'card',method:'storage.read',input:{key:'note'}}),'draft');
  const raw=JSON.parse(await readFile(path.join(f.pkg,'plugin.json'),'utf8'));raw.permissions.push('secrets');await writeFile(path.join(f.pkg,'plugin.json'),JSON.stringify(raw));await f.host.reload();assert.equal(f.host.statuses()[0].state,'disabled');
  await f.host.setEnabled(id,true);await f.request('secret.set',{key:'api',value:'fake-secret-only'});assert.equal(await f.request('secret.has',{key:'api'}),true);
  const bytes=await readFile(path.join(f.root,'extension-settings.json'),'utf8');assert.ok(!bytes.includes('fake-secret-only'));assert.ok(!bytes.includes('accessToken'));
});
test('disable, reload, account changes and child withdrawal reject old results and assets',async t=>{
  let resolve!:(value:unknown)=>void;const f=await fixture(t,()=>new Promise(r=>{resolve=r;})),raw=JSON.parse(await readFile(path.join(f.pkg,'plugin.json'),'utf8'));raw.permissions.push('workbench.read');await writeFile(path.join(f.pkg,'plugin.json'),JSON.stringify(raw));await f.host.reload();await f.host.setEnabled(id,true);
  const generation=f.host.statuses()[0].generation!,url=`lumi-extension://${id}/${generation}/index.html`;assert.ok(f.host.asset(url));assert.match(f.host.asset(url)!.csp,/connect-src 'none'/);assert.ok(!f.host.asset(`lumi-extension://${id}/${generation}/%2e%2e/secrets.json`));
  const old=f.request('workbench.read'),rejected=assert.rejects(old,/停用/);await f.host.setEnabled(id,false);resolve({balance:'old'});await rejected;assert.equal(f.host.asset(url),undefined);
  await f.host.setEnabled(id,true);assert.equal(f.host.asset(url),undefined);const next=f.request('workbench.read'),changed=assert.rejects(next,/上下文/);f.scope('site-b');resolve({balance:'stale'});await changed;
  await f.host.reload();assert.equal(f.host.statuses()[0].state,'active');await writeFile(path.join(f.pkg,'app.js'),'// updated independent plugin');await f.host.reload();assert.equal(f.host.statuses()[0].state,'disabled');
});
test('malformed packages isolate diagnostics and symlinks are never followed',async t=>{
  const f=await fixture(t),bad=path.join(f.options.directory,'bad');await mkdir(bad);await writeFile(path.join(bad,'plugin.json'),'{}');
  const result=await scanExtensionPackages([f.options.directory]);assert.equal(result.packages.length,1);assert.equal(result.diagnostics.length,1);
  if(process.platform!=='win32'){await symlink(path.join(f.root,'outside'),path.join(f.pkg,'linked'));await assert.rejects(readExtensionPackage(f.pkg),/符号链接/);}
});
test('external manifest registers all interface slots and withdraws without altering builtin registry',async t=>{
  const f=await fixture(t);registerExternalRenderers(f.host.inventory().plugins);t.after(()=>registerExternalRenderers([]));validateRendererRegistry(allRendererContributions());
  await f.host.setEnabled(id,true);const statuses=f.host.statuses();assert.equal(workbenchContributions(statuses).length,1);assert.equal(connectionContributions(statuses).length,1);assert.equal(settingsTabContributions(statuses).length,1);assert.equal(rendererNavigation([],statuses)[0].label,'便笺');
  await f.host.setView(id,'workbench',false);assert.equal(workbenchContributions(f.host.statuses()).length,0);assert.equal(settingsTabContributions(f.host.statuses()).length,1);
  await f.host.setEnabled(id,false);assert.equal(connectionContributions(f.host.statuses()).length,0);assert.equal(rendererNavigation([],f.host.statuses()).length,0);
});
test('network port only permits declared public HTTPS destinations and never follows redirects',async()=>{
  for(const address of ['127.0.0.1','10.0.0.1','172.16.0.1','192.168.1.1','169.254.169.254','100.64.0.1','::1','::ffff:127.0.0.1','fc00::1','fe80::1'])assert.equal(publicExtensionAddress(address),false,address);
  assert.equal(publicExtensionAddress('8.8.8.8'),true);assert.equal(publicExtensionAddress('2606:4700::1111'),true);
  await assert.rejects(extensionNetworkRead({url:'https://127.0.0.1/test'},['https://127.0.0.1'],new AbortController().signal,()=>undefined),/私有/);
  await assert.rejects(extensionNetworkRead({url:'https://fixture.invalid/test'},[],new AbortController().signal,()=>undefined),/未声明/);
  await assert.rejects(extensionNetworkRead({url:'http://127.0.0.1/test'},[],new AbortController().signal,()=>undefined),/HTTPS/);
});
test('HTTPS broker pins public DNS and rejects redirects and oversized responses without credential exposure',async()=>{
  const code=(await build({entryPoints:['electron/extensions/network.ts'],bundle:true,platform:'node',format:'cjs',write:false,logLevel:'silent'})).outputFiles[0].text;
  let mode='success',requestOptions:any,calls=0;
  const module={exports:{} as {extensionNetworkRead:typeof extensionNetworkRead}};
  runInNewContext(code,{module,exports:module.exports,Buffer,URL,AbortSignal,require:(name:string)=>{
    if(name==='node:net')return {isIP:(address:string)=>address.includes(':') ? 6 : 4};
    if(name==='node:dns/promises')return {lookup:async()=>[{address:'8.8.8.8',family:4}]};
    if(name==='node:https')return {default:{request},request};
    throw new Error('Unexpected import '+name);
    function request(url:URL,options:any,callback:(response:any)=>void){calls++;requestOptions=options;assert.equal(url.origin,'https://fixture.invalid');const response=Object.assign(new EventEmitter(),{statusCode:mode==='redirect' ? 302 : 200,destroy(){}});const req=Object.assign(new EventEmitter(),{end(){callback(response);if(mode==='redirect')return;response.emit('data',Buffer.alloc(mode==='large' ? 1024*1024+1 : 2));if(mode==='large')response.emit('error',new Error('too large'));else response.emit('end');}});return req;}
  }});
  const read=()=>module.exports.extensionNetworkRead({url:'https://fixture.invalid/usage',secret:{key:'api',header:'Authorization'}},['https://fixture.invalid'],new AbortController().signal,()=> 'fixture-secret');
  const result=await read();assert.equal(result.status,200);assert.equal(requestOptions.headers.Authorization,'Bearer fixture-secret');assert.notEqual(requestOptions.rejectUnauthorized,false);
  let pinned='';requestOptions.lookup('fixture.invalid',{},(_error:unknown,address:string)=>{pinned=address;});assert.equal(pinned,'8.8.8.8');
  mode='redirect';await assert.rejects(read(),/重定向/);assert.equal(calls,2);
  mode='large';await assert.rejects(read(),/失败/);
});
