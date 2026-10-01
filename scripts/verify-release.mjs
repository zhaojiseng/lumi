import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {readFile,readdir,writeFile} from 'node:fs/promises';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {load} from 'js-yaml';

const pkg=JSON.parse(await readFile('package.json','utf8'));
const releaseDir=process.env.LUMI_RELEASE_DIR ? path.resolve(process.env.LUMI_RELEASE_DIR) : path.resolve('release');
const require=createRequire(import.meta.url),asar=require('@electron/asar');
const archive=path.join(releaseDir,'win-unpacked/resources/app.asar');
const listing=asar.listPackage(archive).map(f=>f.replaceAll('\\','/'));
const bundledFiles=listing.filter(name=>!asar.statFile(archive,name.slice(1).split('/').join(path.sep)).files);
const extract=name=>asar.extractFile(archive,name.split('/').join(path.sep));
assert.equal(JSON.parse(extract('package.json')).version,pkg.version);
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
for(const name of ['Lumi-LICENSE.txt','dependencies-LICENSES.txt','THIRD_PARTY_NOTICES.md','lobe-icons-LICENSE.txt','cc-switch-LICENSE.txt','victory-vendor-LICENSE.txt','electron-builder-LICENSE.txt'])assert.ok(extract('dist/third-party/'+name).length>100,'Missing license notice: '+name);
for(const name of ['LICENSE.electron.txt','LICENSES.chromium.html'])assert.ok((await readFile(path.join(releaseDir,'win-unpacked',name))).length>100,'Missing runtime license notice: '+name);
assert.ok(!listing.some(name=>/\/(?:\.test-data|\.research|\.cache|node_modules|tests)(\/|$)/.test(name)),'Local data or source dependencies must not ship');
const text=(await files('dist')).filter(f=>/\.(?:js|css|html)$/.test(f)).concat(await files('dist-electron')).map(file=>extract(file).toString()).join('\n');
// Removing a legacy preference is migration code, not an enabled demo feature.
const activeText=text.replace(/\bdelete\s+this\.preferences\.demoMode\s*;/g,'');
assert.ok(!/\b(?:demoMode|inferenceGatewayApiKey|claude_desktop_config|instructions_template|base_instructions)\b/.test(activeText),'Obsolete integrations must not ship');
assert.ok(text.includes('data-lobe-icon') && text.includes('https://api.example.com'),'Public defaults and local brand icons must be packaged');
assert.deepEqual(pkg.build.win.target,['nsis'],'Windows release must use an installed application');
assert.equal(pkg.build.nsis.deleteAppDataOnUninstall,false,'Account data must be preserved');
const updaterConfig=load(await readFile(path.join(releaseDir,'win-unpacked/resources/app-update.yml'),'utf8'));
assert.equal(updaterConfig.provider,'github');assert.equal(updaterConfig.owner,'zhaojiseng');assert.equal(updaterConfig.repo,'lumi');
const releaseFiles=await readdir(releaseDir);
const packages=releaseFiles.filter(name=>name==='Lumi-'+pkg.version+'-x64.exe');
assert.equal(packages.length,1,'Current installer is missing');
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
const sourceName='Lumi-'+pkg.version+'-source.zip';
if(releaseFiles.includes(sourceName))packages.push(sourceName);
const sums=[];
for(const name of packages){const file=await readFile(path.join(releaseDir,name));sums.push(createHash('sha256').update(file).digest('hex')+'  '+name);}
await writeFile(path.join(releaseDir,'SHA256SUMS.txt'),sums.join('\n')+'\n');
console.log(JSON.stringify({version:pkg.version,matchedFiles:matched,fullLicenses:true,noLocalData:true,sha256:sums},null,2));
