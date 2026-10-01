import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import {mkdir,mkdtemp,writeFile,readFile,access,symlink,rename,stat} from 'node:fs/promises';
import {renameSync,symlinkSync,existsSync} from 'node:fs';
import {AppCacheService,isolateLumiDataPaths,lumiUpdateCacheRoots,lumiBrowserCacheRoots,type UpdateProtection} from '../electron/services/app-cache';
import {SettingsStore} from '../electron/services/store';

async function fixture(options:{clearBrowser?():Promise<void>;onProtection?():void;}={}){
  await mkdir('.test-data',{recursive:true});
  const base=await mkdtemp(path.resolve('.test-data/app-cache-')),data=path.join(base,'data'),native=path.join(base,'local','lumi-ai-workbench-updater');
  await mkdir(data,{recursive:true});await mkdir(native,{recursive:true});
  let protection:UpdateProtection={busy:false,files:[]},clears=0;
  const service=new AppCacheService({version:'0.4.27',browserRoots:lumiBrowserCacheRoots(data),updateRoots:[{directory:path.join(data,'updates'),base:data},{directory:native,base:path.join(base,'local')}],protection:()=>{options.onProtection?.();return protection;},clearBrowser:async()=>{clears++;await options.clearBrowser?.();}});
  const put=async(file:string,body='cache')=>{await mkdir(path.dirname(file),{recursive:true});await writeFile(file,body);return Buffer.byteLength(body);};
  return {base,data,native,service,put,setProtection:(next:UpdateProtection)=>{protection=next;},get clears(){return clears;}};
}
const exists=async(file:string)=>{try{await access(file);return true;}catch{return false;}};
test('startup removes every installed historical version, legacy installer copies and partial files across Lumi update roots',async()=>{
  const f=await fixture(),files=[...['0.4.17','0.4.20','0.4.25','0.4.27'].map(v=>path.join(f.data,'updates',`Lumi-${v}-arm64.dmg`)),path.join(f.native,'installer.exe'),path.join(f.native,'current.blockmap'),path.join(f.native,'pending','Lumi-0.4.27-x64.exe'),path.join(f.native,'old','2-temp-Lumi-0.4.22-x64.exe'),path.join(f.data,'updates','ec793fa0-0f1e-4e57-a79e-0a712d731263.part')];
  for(const file of files)await f.put(file);
  await f.put(path.join(f.native,'pending','update-info.json'),JSON.stringify({fileName:'Lumi-0.4.27-x64.exe'}));
  const result=await f.service.cleanupInstalled();assert.ok(result.freedBytes>0);assert.deepEqual(result.warnings,[]);
  for(const file of files)assert.equal(await exists(file),false,file);
  assert.equal((await f.service.snapshot()).updateBytes,0);assert.equal(f.clears,0);
});
test('cache totals count HTTP/code/GPU files and update packages, retaining account settings and model history',async()=>{
  const f=await fixture();let browserBytes=0;
  for(const name of ['Cache','Code Cache','GPUCache'])browserBytes+=await f.put(path.join(f.data,name,'entry'),'cached response');
  const updateBytes=await f.put(path.join(f.native,'pending','Lumi-0.4.25-x64.exe'),'installer bytes');
  const persistent=['settings.json','Cookies','Local Storage/leveldb/catalog-history','backups/config','IndexedDB/usage'];
  for(const name of persistent)await f.put(path.join(f.data,name),'preserve');
  const before=await f.service.snapshot();assert.equal(before.browserBytes,browserBytes);assert.equal(before.updateBytes,updateBytes);assert.equal(before.totalBytes,browserBytes+updateBytes);
  const after=await f.service.clear();assert.equal(after.freedBytes,before.totalBytes);assert.equal(after.cache.totalBytes,0);assert.equal(f.clears,1);
  for(const name of persistent)assert.equal(await readFile(path.join(f.data,name),'utf8'),'preserve');
});
test('newer downloaded installers and their pending metadata/blockmap survive startup and manual cache clearing',async()=>{
  const f=await fixture(),future=path.join(f.native,'pending','Lumi-0.4.28-x64.exe'),metadata=path.join(f.native,'pending','update-info.json'),blockmap=path.join(f.native,'pending','current.blockmap'),old=path.join(f.native,'pending','Lumi-0.4.20-x64.exe');
  await f.put(future);await f.put(metadata,JSON.stringify({fileName:path.basename(future)}));await f.put(blockmap);await f.put(old);
  const staleTemporary=path.join(f.native,'pending','temp-Lumi-0.4.28-x64.exe');await f.put(staleTemporary);
  await f.service.cleanupInstalled();assert.equal(await exists(old),false);
  assert.equal(await exists(staleTemporary),false,'an inactive temporary download is not an installable future package');
  const result=await f.service.clear();assert.ok(result.cache.protectedBytes>0);assert.equal(result.cache.updateBytes,result.cache.protectedBytes);
  for(const file of [future,metadata,blockmap])assert.equal(await exists(file),true);
});
test('active updates protect ALL updater files, and an explicit ready file remains protected',async()=>{
  const f=await fixture(),file=path.join(f.native,'installer.exe');await f.put(file);await f.put(path.join(f.data,'Cache','entry'));
  f.setProtection({busy:true,files:[]});const busy=await f.service.clear();assert.equal(await exists(file),true);assert.equal(busy.cache.browserBytes,0);assert.equal(busy.cache.protectedBytes,5);
  f.setProtection({busy:false,files:[file]});assert.equal((await f.service.clear()).cache.protectedBytes,5);
  f.setProtection({busy:false,files:[]});assert.equal((await f.service.clear()).cache.updateBytes,0);
});
test('unknown metadata, unrelated files and invalid version names are preserved without throwing',async()=>{
  const f=await fixture(),files=[path.join(f.native,'pending','update-info.json'),path.join(f.native,'pending','installer.exe'),path.join(f.native,'pending','custom-tool.exe'),path.join(f.native,'Lumi-00.4.20-x64.exe')];
  await f.put(files[0],'invalid json');for(const file of files.slice(1))await f.put(file);
  const result=await f.service.clear();assert.ok(result.cache.warnings.length);for(const file of files)assert.equal(await exists(file),true);
});
test('directory junctions and paths escaping a cache root cannot reach unrelated data',async()=>{
  const f=await fixture(),outside=path.join(f.base,'outside'),secret=path.join(outside,'settings.json');await f.put(secret,'preserve');
  await symlink(outside,path.join(f.data,'Cache'),process.platform==='win32' ? 'junction' : 'dir');
  const cache=await f.service.snapshot();assert.equal(cache.browserBytes,0);assert.ok(cache.warnings.length);await f.service.clear();assert.equal(f.clears,0,'unsafe paths must also block the native session APIs');assert.equal(await readFile(secret,'utf8'),'preserve');
  const invalid=new AppCacheService({version:'0.4.27',browserRoots:[{directory:outside,base:f.data}],updateRoots:[],protection:()=>({busy:false,files:[]})});
  assert.ok((await invalid.clear()).cache.warnings.length);assert.equal(await readFile(secret,'utf8'),'preserve');
});
test('base and ancestor junctions preserve outside browser and update files and block native clearing',async()=>{
  const f=await fixture(),outside=path.join(f.base,'outside'),cache=path.join(outside,'data','Cache','entry'),installer=path.join(outside,'data','updates','Lumi-0.4.20-x64.exe');
  await f.put(cache,'outside browser');await f.put(installer,'outside installer');
  const link=path.join(f.base,'linked');await symlink(outside,link,process.platform==='win32' ? 'junction' : 'dir');
  for(const data of [link,path.join(link,'data')]){
    let clears=0;
    const service=new AppCacheService({version:'0.4.27',browserRoots:lumiBrowserCacheRoots(data),updateRoots:[{directory:path.join(data,'updates'),base:data}],protection:()=>({busy:false,files:[]}),clearBrowser:async()=>{clears++;}});
    const result=await service.clear();assert.equal(clears,0);assert.equal(result.freedBytes,0);assert.ok(result.cache.warnings.length);
  }
  assert.equal(await readFile(cache,'utf8'),'outside browser');assert.equal(await readFile(installer,'utf8'),'outside installer');
});
test('nested code-cache links block the native APIs even when safe sibling files can be removed',async()=>{
  const f=await fixture(),outside=path.join(f.base,'outside'),entry=path.join(outside,'entry');await f.put(entry,'outside code');
  await mkdir(path.join(f.data,'Code Cache'),{recursive:true});await symlink(outside,path.join(f.data,'Code Cache','js'),process.platform==='win32' ? 'junction' : 'dir');
  const safe=path.join(f.data,'Cache','entry');await f.put(safe);
  await f.service.clear();assert.equal(f.clears,0);assert.equal(await exists(safe),false);assert.equal(await readFile(entry,'utf8'),'outside code');
});
test('a junction introduced after inventory blocks native clearing and path-based deletion',async()=>{
  let switched=false;const f=await fixture({onProtection:()=>{
    if(switched)return;switched=true;renameSync(path.join(f.data,'Cache'),path.join(f.data,'original-cache'));
    symlinkSync(path.join(f.base,'outside'),path.join(f.data,'Cache'),process.platform==='win32' ? 'junction' : 'dir');
  }});
  await f.put(path.join(f.data,'Cache','entry'),'original');await f.put(path.join(f.base,'outside','entry'),'outside');
  const result=await f.service.clear();assert.equal(f.clears,0);assert.ok(result.cache.warnings.length);
  assert.equal(await readFile(path.join(f.base,'outside','entry'),'utf8'),'outside');assert.equal(await readFile(path.join(f.data,'original-cache','entry'),'utf8'),'original');
});
test('base and parent replacements during clearing preserve new files at the old paths',async()=>{
  for(const replaceBase of [false,true]){
    const f=await fixture({clearBrowser:async()=>{
      const directory=replaceBase ? f.data : path.join(f.data,'Cache');await rename(directory,directory+'-original');
      await f.put(path.join(f.data,'Cache','entry'),'replacement');
    }});
    await f.put(path.join(f.data,'Cache','entry'),'original');
    const result=await f.service.clear();assert.equal(f.clears,1);assert.ok(result.cache.warnings.length);
    assert.equal(await readFile(path.join(f.data,'Cache','entry'),'utf8'),'replacement');
    assert.equal(await readFile(replaceBase ? path.join(f.data+'-original','Cache','entry') : path.join(f.data,'Cache-original','entry'),'utf8'),'original');
  }
});
test('future temp packages and orphan blockmaps do not keep old installer auxiliaries for a second cleanup',async()=>{
  for(const cleanup of ['cleanupInstalled','clear'] as const){
    const f=await fixture(),pending=path.join(f.native,'pending'),files=['temp-Lumi-0.4.28-x64.exe','2-temp-Lumi-0.4.29-x64.exe','Lumi-0.4.30-x64.exe.blockmap','installer.exe','current.blockmap','ec793fa0-0f1e-4e57-a79e-0a712d731263.part'];
    for(const name of files)await f.put(path.join(pending,name));
    const metadata=path.join(pending,'update-info.json');await f.put(metadata,JSON.stringify({fileName:'Lumi-0.4.27-x64.exe'}));
    await f.service[cleanup]();
    for(const name of files.filter(name=>!name.endsWith('.blockmap') || name==='current.blockmap'))assert.equal(await exists(path.join(pending,name)),false,name);
    assert.equal(await exists(metadata),false);assert.equal(await exists(path.join(pending,'Lumi-0.4.30-x64.exe.blockmap')),true);
  }
});
test('future pending metadata protects a ready installer even when the versioned package is absent',async()=>{
  const f=await fixture(),pending=path.join(f.native,'pending');
  for(const name of ['installer.exe','current.blockmap'])await f.put(path.join(pending,name));
  await f.put(path.join(pending,'update-info.json'),JSON.stringify({fileName:'Lumi-0.4.28-x64.exe'}));
  await f.service.cleanupInstalled();const result=await f.service.clear();assert.equal(result.freedBytes,0);assert.equal(result.cache.protectedBytes,result.cache.updateBytes);
  for(const name of ['installer.exe','current.blockmap','update-info.json'])assert.equal(await exists(path.join(pending,name)),true);
});
test('development and smoke create separate data directories before path overrides; explicit test data wins and packaged defaults stay untouched',async()=>{
  const f=await fixture(),appData=path.join(f.base,'appData'),installed=path.join(appData,'Lumi');
  await f.put(path.join(installed,'Cache','entry'),'installed cache');await f.put(path.join(installed,'updates','Lumi-0.4.20-x64.exe'),'installed package');await f.put(path.join(installed,'settings.json'),'installed settings');
  const fakeApp=(isPackaged:boolean)=>{
    const paths={userData:installed,sessionData:installed};let gets=0,sets=0;
    return {paths,isPackaged,getPath:(_name:'appData')=>{gets++;return appData;},setPath:(name:'userData'|'sessionData',directory:string)=>{assert.ok(existsSync(directory),'Electron requires the override directory to exist');paths[name]=directory;sets++;},get gets(){return gets;},get sets(){return sets;}};
  };
  const dev=fakeApp(false);assert.ok(isolateLumiDataPaths(dev,{}));assert.equal(dev.paths.userData,path.join(appData,'Lumi-development'));assert.equal(dev.paths.sessionData,dev.paths.userData);
  assert.ok((await stat(dev.paths.userData)).isDirectory());
  const store=new SettingsStore(dev.paths.userData,{available:()=>true,encrypt:text=>text,decrypt:text=>text});await store.load();assert.ok(store.activeSite());assert.deepEqual(store.credentials(),{});
  const developmentFile=path.join(dev.paths.userData,'Cache','entry');await f.put(developmentFile,'development cache');
  const isolatedCache=new AppCacheService({version:'0.4.27',browserRoots:lumiBrowserCacheRoots(dev.paths.sessionData),updateRoots:lumiUpdateCacheRoots(dev.paths.userData,'win32',{LOCALAPPDATA:appData},f.base,true),protection:()=>({busy:false,files:[]})});
  await isolatedCache.clear();assert.equal(await exists(developmentFile),false);
  const smoke=fakeApp(true);assert.ok(isolateLumiDataPaths(smoke,{LUMI_SMOKE:'1'}));assert.equal(smoke.paths.sessionData,path.join(appData,'Lumi-smoke'));
  for(const isPackaged of [false,true]){
    const explicit=fakeApp(isPackaged),testData=path.join(f.base,'fresh-test-data-'+isPackaged);
    assert.ok(isolateLumiDataPaths(explicit,{LUMI_SMOKE:'1',LUMI_TEST_DATA:testData}));assert.deepEqual(explicit.paths,{userData:testData,sessionData:testData});assert.equal(explicit.gets,0);
  }
  const packaged=fakeApp(true);assert.equal(isolateLumiDataPaths(packaged,{}),false);assert.equal(packaged.gets,0);assert.equal(packaged.sets,0);assert.deepEqual(packaged.paths,{userData:installed,sessionData:installed});
  for(const [name,body] of [['Cache/entry','installed cache'],['updates/Lumi-0.4.20-x64.exe','installed package'],['settings.json','installed settings']])assert.equal(await readFile(path.join(installed,name),'utf8'),body);
});
test('missing directories are zero bytes and concurrent cleanups serialize without negative freed sizes',async()=>{
  const f=await fixture();assert.equal((await f.service.snapshot()).totalBytes,0);await f.put(path.join(f.data,'Cache','entry'),'1234567890');
  const [first,second]=await Promise.all([f.service.clear(),f.service.clear()]);assert.equal(first.freedBytes,10);assert.equal(second.freedBytes,0);assert.deepEqual(first.cache.warnings,[]);
});
test('updater roots match historical NSIS cache and macOS DMGs while test/development roots remain isolated',()=>{
  const data=path.resolve('.test-data/root-paths'),home=path.resolve('.test-data/home-paths'),local=path.resolve('.test-data/local-paths');
  const windows=lumiUpdateCacheRoots(data,'win32',{LOCALAPPDATA:local},home);assert.ok(windows.some(r=>r.directory===path.join(local,'lumi-ai-workbench-updater')));
  const mac=lumiUpdateCacheRoots(data,'darwin',{},home);assert.ok(mac.some(r=>r.directory===path.join(data,'updates')));
  for(const root of lumiUpdateCacheRoots(data,'win32',{LOCALAPPDATA:local},home,true))assert.equal(root.base,data);
});
