import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdir,mkdtemp,cp,readFile,writeFile,rm} from 'node:fs/promises';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {ExtensionHost} from '../electron/extensions/host';
import {ExtensionMarket,marketPackageFiles,readMarketResource,type MarketRead} from '../electron/extensions/market';
import {readExtensionPackage,scanExtensionPackages} from '../electron/extensions/packages';
import {EXTENSION_MARKET_REPOSITORY,compareExtensionVersions} from '../shared/contracts/extension-market';
import {PluginResource} from '../src/host/plugin-resource';

const notes='extension.lumi.notes',compact='extension.lumi.compact',revision='1'.repeat(40);
const cipher={available:()=>true,encrypt:(value:string)=>Buffer.from(value).toString('base64'),decrypt:(value:string)=>Buffer.from(value,'base64').toString()};
const blob=(bytes:Buffer)=>createHash('sha1').update('blob '+bytes.length+'\0').update(bytes).digest('hex');
async function fixture(t:test.TestContext){
  await mkdir('.test-data',{recursive:true});const root=await mkdtemp(path.resolve('.test-data/market-'));t.after(()=>rm(root,{recursive:true,force:true,maxRetries:5,retryDelay:100}));
  const directory=path.join(root,'extensions'),shipped=path.join(root,'shipped');
  await cp('extensions/packages',shipped,{recursive:true});
  const host=new ExtensionHost({directory,roots:[shipped],settingsDirectory:root,cipher,sdk:Buffer.from(''),context:()=>({theme:'light',locale:'zh-CN',site:{id:'fixture',name:'Fixture',url:'https://fixture.invalid'}}),scope:()=>'',read:async()=>null});
  await host.start();t.after(()=>host.dispose());
  const pkg=await readExtensionPackage(path.join(shipped,notes)),files=new Map(pkg.files);
  const manifest={...pkg.manifest,version:'2.0.0'};files.set('plugin.json',Buffer.from(JSON.stringify(manifest)));files.set('app.js',Buffer.from('// isolated market fixture'));
  return {host,files,root,directory,shipped};
}
function remote(files:Map<string,Buffer>,id=notes){
  const tree=[...files].map(([name,bytes])=>({path:'plugins/'+id+'/'+name,type:'blob',mode:'100644',size:bytes.length,sha:blob(bytes)}));
  let current=revision,corrupt='',failure='',calls:string[]=[];
  const transport:MarketRead=async(url,limit,signal)=>{
    calls.push(url);assert.equal(signal.aborted,false);
    if(url.includes(failure) && failure)throw new Error('fixture offline');
    if(url.endsWith('/commits/main'))return Buffer.from(JSON.stringify({sha:current}));
    if(url.includes('/git/trees/'))return Buffer.from(JSON.stringify({truncated:false,tree}));
    const prefix='https://raw.githubusercontent.com/'+EXTENSION_MARKET_REPOSITORY+'/'+current+'/plugins/'+id+'/';assert.ok(url.startsWith(prefix),url);
    const name=url.slice(prefix.length),value=files.get(name);assert.ok(value,'unexpected remote file '+name);assert.ok(value.length<=limit);
    return name===corrupt ? Buffer.from('corrupt') : value;
  };
  return {tree,transport,calls,revision:(value:string)=>{current=value;},corrupt:(name:string)=>{corrupt=name;},fail:(value:string)=>{failure=value;}};
}
test('market catalogs pin commit/blob identities, cache reads and include isolated theme previews',async t=>{
  const f=await fixture(t),theme=(await readExtensionPackage(path.join(f.shipped,compact))).files,r=remote(theme,compact),market=new ExtensionMarket(f.host,r.transport);t.after(()=>market.dispose());
  const result=await market.read();assert.equal(result.revision,revision);assert.equal(result.plugins[0].manifest.id,compact);assert.match(result.plugins[0].preview!.css,/sidebar/);assert.equal(result.diagnostics.length,0);
  const count=r.calls.length;result.plugins[0].manifest.name='modified caller';const cached=await market.read();assert.equal(r.calls.length,count);assert.notEqual(cached.plugins[0].manifest.name,'modified caller');
  r.revision('2'.repeat(40));await market.read({force:true});await assert.rejects(market.install({id:compact,revision}),/已更新/);
  assert.equal(f.host.inventory().interfaceStyle,undefined);
});
test('market installation overrides a shipped sample, disables only its target and retains storage on update/removal',async t=>{
  const f=await fixture(t),r=remote(f.files),market=new ExtensionMarket(f.host,r.transport);t.after(()=>market.dispose());
  await f.host.setEnabled(notes,true);await f.host.setEnabled(compact,true);const generation=f.host.statuses().find(s=>s.manifest.id===notes)!.generation!;
  await f.host.request({id:notes,generation,view:'card',method:'storage.write',input:{key:'note',value:'preserved draft'}});
  const compactGeneration=f.host.statuses().find(s=>s.manifest.id===compact)!.generation;
  await market.read();const inventory=await market.install({id:notes,revision});
  assert.equal(inventory.diagnostics.length,0);assert.equal(inventory.plugins.find(pkg=>pkg.manifest.id===notes)!.manifest.version,'2.0.0');assert.equal(inventory.plugins.find(pkg=>pkg.manifest.id===notes)!.removable,true);
  assert.equal(f.host.statuses().find(s=>s.manifest.id===notes)!.state,'disabled');assert.equal(f.host.statuses().find(s=>s.manifest.id===compact)!.generation,compactGeneration);assert.equal(f.host.inventory().interfaceStyle?.id,compact);
  assert.equal(f.host.asset(`lumi-extension://${notes}/${generation}/index.html`),undefined);
  await f.host.setEnabled(notes,true);const newGeneration=f.host.statuses().find(s=>s.manifest.id===notes)!.generation!;
  assert.equal(await f.host.request({id:notes,generation:newGeneration,view:'card',method:'storage.read',input:{key:'note'}}),'preserved draft');
  const removed=await f.host.remove(notes);assert.equal(removed.plugins.find(pkg=>pkg.manifest.id===notes)!.removable,false);assert.equal(f.host.statuses().find(s=>s.manifest.id===notes)!.state,'disabled');
  await f.host.setEnabled(notes,true);assert.equal(await f.host.request({id:notes,generation:f.host.statuses().find(s=>s.manifest.id===notes)!.generation!,view:'card',method:'storage.read',input:{key:'note'}}),'preserved draft');
  await assert.rejects(f.host.remove(compact),/只能卸载/);
});
test('failed or corrupt downloads and undeclared IDs never replace an active installed plugin',async t=>{
  const f=await fixture(t),r=remote(f.files),market=new ExtensionMarket(f.host,r.transport);t.after(()=>market.dispose());await f.host.setEnabled(notes,true);
  await market.read();const original=f.host.inventory().plugins.find(pkg=>pkg.manifest.id===notes)!.digest;
  await assert.rejects(market.install({id:'extension.attacker.unknown',revision}),/已更新/);
  r.corrupt('app.js');await assert.rejects(market.install({id:notes,revision}),/校验失败/);assert.equal(f.host.inventory().plugins.find(pkg=>pkg.manifest.id===notes)!.digest,original);
  r.corrupt('');r.fail('/app.js');await assert.rejects(market.install({id:notes,revision}),/fixture offline/);assert.equal(f.host.statuses().find(s=>s.manifest.id===notes)!.state,'active');
  market.dispose();await assert.rejects(market.read(),/正在退出/);await assert.rejects(market.install({id:notes,revision}),/正在退出/);
});
test('install and uninstall roll back files and running state when settings cannot persist',async t=>{
  const f=await fixture(t);await f.host.installFiles(notes,f.files);await f.host.setEnabled(notes,true);
  const original=f.host.inventory().plugins.find(pkg=>pkg.manifest.id===notes)!,generation=f.host.statuses().find(s=>s.manifest.id===notes)!.generation!;
  const storage=(f.host as unknown as {store:{change:(...args:unknown[])=>Promise<void>}}).store,change=storage.change;storage.change=async()=>{throw new Error('fixture settings failure');};
  const replacement=new Map(f.files);replacement.set('app.js',Buffer.from('// update that must roll back'));
  await assert.rejects(f.host.installFiles(notes,replacement),/fixture settings failure/);await assert.rejects(f.host.remove(notes),/fixture settings failure/);storage.change=change;
  assert.equal((await readExtensionPackage(path.join(f.directory,notes))).digest,original.digest);assert.equal(f.host.statuses().find(s=>s.manifest.id===notes)!.generation,generation);assert.ok(f.host.asset(`lumi-extension://${notes}/${generation}/index.html`));
  const invalid=new Map(f.files);invalid.set('../escape.txt',Buffer.from('blocked'));await assert.rejects(f.host.installFiles(notes,invalid),/路径无效/);
  invalid.delete('../escape.txt');invalid.delete('LICENSE');await assert.rejects(f.host.installFiles(notes,invalid),/LICENSE/);
});
test('market directories reject links, path traversal, duplicates, partial trees and excessive sizes',()=>{
  const node={path:'plugins/'+notes+'/plugin.json',type:'blob',mode:'100644',size:20,sha:revision},tree={truncated:false,tree:[node]};assert.equal(marketPackageFiles(tree).size,1);
  for(const input of [{...tree,truncated:true},{...tree,tree:[{...node,mode:'120000'}]},{...tree,tree:[{...node,type:'commit'}]},{...tree,tree:[{...node,path:'plugins/'+notes+'/../escape'}]},{...tree,tree:[node,node]},{...tree,tree:[{...node,size:2*1024*1024+1}]}])assert.throws(()=>marketPackageFiles(input));
});
test('incompatible plugin manifests become diagnostics and cannot be installed',async t=>{
  const f=await fixture(t),manifest=JSON.parse(f.files.get('plugin.json')!.toString());manifest.hostApiVersion=99;f.files.set('plugin.json',Buffer.from(JSON.stringify(manifest)));
  const r=remote(f.files),market=new ExtensionMarket(f.host,r.transport);t.after(()=>market.dispose());const catalog=await market.read();assert.equal(catalog.plugins.length,0);assert.match(catalog.diagnostics[0].error,/不兼容/);await assert.rejects(market.install({id:notes,revision}),/已更新/);
});
test('market transport restricts origins, refuses redirects, bounds responses and reports rate limits',async t=>{
  const original=globalThis.fetch;t.after(()=>{globalThis.fetch=original;});let options:RequestInit|undefined;
  globalThis.fetch=async(_url,input)=>{options=input;return new Response('bounded fixture');};
  await assert.rejects(readMarketResource('https://fixture.invalid/data',1024,new AbortController().signal),/来源无效/);
  assert.equal((await readMarketResource('https://api.github.com/fixture',1024,new AbortController().signal)).toString(),'bounded fixture');assert.equal(options?.redirect,'error');assert.ok(!(options?.headers as Record<string,string>).Authorization);
  await assert.rejects(readMarketResource('https://api.github.com/fixture',3,new AbortController().signal),/超过大小/);
  globalThis.fetch=async()=>new Response('rate limited',{status:403});await assert.rejects(readMarketResource('https://api.github.com/fixture',1024,new AbortController().signal),/额度/);
});
test('market updates never downgrade newer local versions and compare prereleases numerically',async t=>{
  for(const [a,b,expected] of [['1.10.0','1.9.0',1],['1.0.0','1.0.0-beta',1],['1.0.0-beta.2','1.0.0-beta.11',-1],['1.0.0-alpha-1','1.0.0-alpha-2',-1],['1.0.0','1.0.0',0]] as const)assert.equal(compareExtensionVersions(a,b),expected);
  const f=await fixture(t);await f.host.installFiles(notes,f.files);const older=new Map(f.files),manifest=JSON.parse(older.get('plugin.json')!.toString());manifest.version='1.0.0';older.set('plugin.json',Buffer.from(JSON.stringify(manifest)));
  const market=new ExtensionMarket(f.host,remote(older).transport);t.after(()=>market.dispose());await market.read();await assert.rejects(market.install({id:notes,revision}),/降级/);
});
test('package overrides are scoped to lower-priority roots and same-root duplicate IDs remain diagnostics',async t=>{
  const f=await fixture(t);await cp(path.join(f.shipped,notes),path.join(f.directory,notes),{recursive:true});let scanned=await scanExtensionPackages([f.directory,f.shipped]);assert.equal(scanned.diagnostics.length,0);assert.equal(scanned.packages.length,2);
  await cp(path.join(f.directory,notes),path.join(f.directory,'duplicate'),{recursive:true});scanned=await scanExtensionPackages([f.directory,f.shipped]);assert.equal(scanned.diagnostics.length,1);
});
test('renderer package operations publish new contributions without a bootstrap reload',async()=>{
  let installed=false,registered=0,resolve!:(value:void)=>void;const inventory=()=>({directory:'fixture',plugins:[],diagnostics:[]});
  const resource=new PluginResource({listPlugins:async()=>[],setPluginEnabled:async()=>[],setPluginView:async()=>[],extensionInventory:async()=>inventory(),installExtension:async()=>{await new Promise<void>(r=>{resolve=r;});installed=true;return inventory();},removeExtension:async()=>{installed=false;return inventory();}},()=>{registered++;});
  await resource.load();const install=resource.installExtension({id:notes,revision});assert.equal(resource.getState().busyId,'extensions:'+notes);await assert.rejects(resource.removeExtension(notes),/正在更新/);resolve();await install;
  assert.equal(installed,true);assert.equal(resource.getState().busyId,null);assert.equal(registered,2);await resource.removeExtension(notes);assert.equal(installed,false);assert.equal(registered,3);
});
