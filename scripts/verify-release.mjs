import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {readFile,readdir,writeFile,mkdir,mkdtemp,rm} from 'node:fs/promises';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {load} from 'js-yaml';
import {unsignedMachOCode} from './mach-o-code.mjs';

const pkg=JSON.parse(await readFile('package.json','utf8'));
const releaseDir=process.env.LUMI_RELEASE_DIR ? path.resolve(process.env.LUMI_RELEASE_DIR) : path.resolve('release');
const require=createRequire(import.meta.url),asar=require('@electron/asar');
const mac=process.platform==='darwin';
assert.ok(mac || process.platform==='win32','Release verification supports Windows x64 and macOS ARM64');
const appDirectory=mac ? path.join(releaseDir,'mac-arm64/Lumi.app/Contents') : path.join(releaseDir,'win-unpacked');
const resources=path.join(appDirectory,mac ? 'Resources' : 'resources');
const archive=path.join(resources,'app.asar');
const listing=asar.listPackage(archive).map(f=>f.replaceAll('\\','/'));
const bundledFiles=listing.filter(name=>!asar.statFile(archive,name.slice(1).split('/').join(path.sep)).files);
const extract=name=>asar.extractFile(archive,name.split('/').join(path.sep));
assert.equal(JSON.parse(extract('package.json')).version,pkg.version);
for(const file of ['dist/widget.html','dist-electron/widget-preload.cjs'])assert.ok(listing.includes('/'+file),'Missing floating widget entry: '+file);
async function files(directory){
  const result=[];
  for(const entry of await readdir(directory,{withFileTypes:true})){const file=path.join(directory,entry.name);if(entry.isDirectory())result.push(...await files(file));else if(entry.isFile())result.push(file.replaceAll('\\','/'));}
  return result.sort();
}
let matched=0;
for(const directory of ['dist','dist-electron']){
  const local=await files(directory),bundled=bundledFiles.filter(name=>name.startsWith('/'+directory+'/')).map(name=>name.slice(1)).sort();
  assert.deepEqual(bundled,local,'Archive must contain the current build only: '+directory);
  for(const file of local){assert.deepEqual(extract(file),await readFile(file),'Stale archive file: '+file);matched++;}
}
for(const name of ['Lumi-LICENSE.txt','dependencies-LICENSES.txt','THIRD_PARTY_NOTICES.md','lobe-icons-LICENSE.txt','cc-switch-LICENSE.txt','codexbar-LICENSE.txt','victory-vendor-LICENSE.txt','electron-builder-LICENSE.txt'])assert.ok(extract('dist/third-party/'+name).length>100,'Missing license notice: '+name);
for(const name of ['LICENSE.electron.txt','LICENSES.chromium.html'])assert.ok((await readFile(path.join(mac ? path.join(resources,'licenses') : appDirectory,name))).length>100,'Missing runtime license notice: '+name);
assert.ok(!listing.some(name=>/\/(?:\.test-data|\.research|\.cache|node_modules|tests)(\/|$)/.test(name)),'Local data or source dependencies must not ship');
assert.ok(!listing.some(name=>/\/(?:extensions|extension\.lumi\.notes)(\/|$)/.test(name)),'External plugin packages must remain separate from the EXE');
const {tsImport}=await import('tsx/esm/api');
const {scanExtensionPackages}=await tsImport('../electron/extensions/packages.ts',import.meta.url);
const sourceExtensions=await scanExtensionPackages(['extensions/packages']);
const releaseExtensions=await scanExtensionPackages([path.join(releaseDir,'extensions')]);
assert.deepEqual(sourceExtensions.diagnostics,[]);assert.deepEqual(releaseExtensions.diagnostics,[]);
assert.deepEqual(releaseExtensions.packages.map(p=>[p.manifest.id,p.digest]),sourceExtensions.packages.map(p=>[p.manifest.id,p.digest]),'Independent plugin packages must match repository bytes');
const text=(await files('dist')).filter(f=>/\.(?:js|css|html)$/.test(f)).concat(await files('dist-electron')).map(file=>extract(file).toString()).join('\n');
// Removing a legacy preference is migration code, not an enabled demo feature.
const activeText=text.replace(/\bdelete\s+this\.preferences\.demoMode\s*;/g,'');
assert.ok(!/\b(?:demoMode|inferenceGatewayApiKey|claude_desktop_config|instructions_template|base_instructions)\b/.test(activeText),'Obsolete integrations must not ship');
assert.ok(text.includes('data-lobe-icon') && text.includes('https://api.example.com'),'Public defaults and local brand icons must be packaged');
const updaterConfig=load(await readFile(path.join(resources,'app-update.yml'),'utf8'));
assert.equal(updaterConfig.provider,'github');assert.equal(updaterConfig.owner,'zhaojiseng');assert.equal(updaterConfig.repo,'lumi');
const releaseFiles=await readdir(releaseDir);
const packages=releaseFiles.filter(name=>name==='Lumi-'+pkg.version+(mac ? '-arm64.dmg' : '-x64.exe'));
assert.equal(packages.length,1,'Current installer is missing');
if(mac){
  assert.equal(process.arch,'arm64','Verify macOS releases on an ARM64 host');
  assert.deepEqual(pkg.build.mac.target,[{target:'dmg',arch:['arm64']}]);
  const exec=(file,...args)=>execFileSync(file,args,{encoding:'utf8'}).trim();
  assert.equal(exec('/usr/bin/plutil','-extract','CFBundleShortVersionString','raw','-o','-',path.join(appDirectory,'Info.plist')),pkg.version);
  assert.equal(exec('/usr/bin/plutil','-extract','CFBundleIdentifier','raw','-o','-',path.join(appDirectory,'Info.plist')),pkg.build.appId);
  for(const file of ['MacOS/Lumi','Frameworks/Electron Framework.framework/Versions/A/Electron Framework','Resources/native/lumi-menu-bar'])assert.equal(exec('/usr/bin/lipo','-archs',path.join(appDirectory,file)),'arm64','App, helper and Electron must all be ARM64');
  // electron-builder re-signs embedded executables and changes LINKEDIT allocation.
  // Compare all non-signature bytes, then verify actual signatures separately below.
  await mkdir('.test-data',{recursive:true});
  const nativeCheck=await mkdtemp(path.resolve('.test-data/native-verify-'));
  try{
    const normalized=[];
    for(const [index,file] of [path.join(resources,'native/lumi-menu-bar'),'dist-native/lumi-menu-bar'].entries()){
      const copy=path.join(nativeCheck,'helper-'+index);await writeFile(copy,await readFile(file),{mode:0o755});
      normalized.push(createHash('sha256').update(unsignedMachOCode(await readFile(copy))).digest('hex'));
    }
    assert.equal(normalized[0],normalized[1],'Native usage card code must match the current build after normalizing signatures');
  }finally{await rm(nativeCheck,{recursive:true,force:true});}
  exec('/usr/bin/codesign','--verify','--strict',path.join(resources,'native/lumi-menu-bar'));
  exec('/usr/bin/codesign','--verify','--deep','--strict',path.dirname(appDirectory));
  exec('/usr/bin/hdiutil','verify',path.join(releaseDir,packages[0]));
}else{
assert.deepEqual(pkg.build.win.target,['nsis'],'Windows release must use an installed application');
assert.equal(pkg.build.nsis.deleteAppDataOnUninstall,false,'Account data must be preserved');
const updateInfo=load(await readFile(path.join(releaseDir,'latest.yml'),'utf8'));
assert.equal(updateInfo.version,pkg.version);
assert.equal(updateInfo.files.length,1);
assert.equal(updateInfo.files[0].url,packages[0]);
const installer=await readFile(path.join(releaseDir,packages[0]));
assert.equal(updateInfo.files[0].size,installer.length);
assert.equal(updateInfo.files[0].sha512,createHash('sha512').update(installer).digest('base64'));
assert.equal(updateInfo.sha512,updateInfo.files[0].sha512);
assert.ok(!updateInfo.packages,'Web installer metadata must not ship');
packages.push('latest.yml');
const blockmap=packages[0]+'.blockmap';
assert.ok(releaseFiles.includes(blockmap),'Update blockmap is missing');packages.push(blockmap);
}
const sourceName='Lumi-'+pkg.version+'-source.zip';
if(!mac && releaseFiles.includes(sourceName))packages.push(sourceName);
const sums=[];
for(const name of packages){const file=await readFile(path.join(releaseDir,name));sums.push(createHash('sha256').update(file).digest('hex')+'  '+name);}
await writeFile(path.join(releaseDir,'SHA256SUMS.txt'),sums.join('\n')+'\n');
console.log(JSON.stringify({version:pkg.version,platform:mac ? 'macOS ARM64' : 'Windows x64',matchedFiles:matched,externalPlugins:releaseExtensions.packages.length,fullLicenses:true,noLocalData:true,sha256:sums},null,2));
