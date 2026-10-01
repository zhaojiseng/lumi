import {createRequire} from 'node:module';
import {readFile,readdir} from 'node:fs/promises';
import {createReadStream} from 'node:fs';
import {createHash} from 'node:crypto';
import path from 'node:path';
const require=createRequire(import.meta.url);
/** electron-builder does not expose portable.script. Override only its portable final-script hook. */
export async function portableBuild(root,splashPath) {
  const {NsisTarget}=require('app-builder-lib/out/targets/nsis/NsisTarget.js');
  const original=NsisTarget.prototype.computeFinalScript;
  const originalBuild=NsisTarget.prototype.buildInstaller;
  const script=await readFile(path.join(root,'build/portable.nsi'),'utf8');
  NsisTarget.prototype.computeFinalScript=async function(raw,installer,archs) {
    if(this.name==='portable' && installer) {
      if(!raw.includes('extractEmbeddedAppPackage') || !raw.includes('PORTABLE_EXECUTABLE_FILE'))throw new Error('electron-builder portable template changed; review the custom launcher.');
      raw=script;
    }
    return original.call(this,raw,installer,archs);
  };
  NsisTarget.prototype.buildInstaller=async function(archs){
    if(this.name==='portable'){
      const ids=await Promise.all([...archs.entries()].sort(([a],[b])=>a-b).map(([arch,dir])=>portableCacheIdentity(dir,arch)));
      this.options.unpackDirName='app-'+createHash('sha256').update(ids.join(':')).digest('hex').slice(0,24);
    }
    return originalBuild.call(this,archs);
  };
  return {options:{splashImage:splashPath},restore:()=>{NsisTarget.prototype.computeFinalScript=original;NsisTarget.prototype.buildInstaller=originalBuild;}};
}
export async function portableCacheIdentity(appOutDir,arch) {
  const hash=createHash('sha256');
  async function add(dir){for(const entry of (await readdir(dir,{withFileTypes:true})).sort((a,b)=>a.name.localeCompare(b.name))){const file=path.join(dir,entry.name);if(entry.isDirectory())await add(file);else if(entry.isFile()){hash.update(path.relative(appOutDir,file).replaceAll('\\','/'));for await(const chunk of createReadStream(file))hash.update(chunk);}}}
  await add(appOutDir);
  hash.update(String(arch));return 'app-'+hash.digest('hex').slice(0,24);
}
