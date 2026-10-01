import {lstat,readdir,realpath,readFile,rm} from 'node:fs/promises';
import {mkdirSync,type BigIntStats} from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import type {AppCacheInfo,AppCacheClearResult} from '../../shared/types';
import {newerVersion} from './updates';

export interface CacheRoot {directory:string;base:string;}
export interface UpdateProtection {busy:boolean;files:readonly string[];}
const BROWSER_CACHES=['Cache','Code Cache','GPUCache','DawnWebGPUCache','DawnGraphiteCache','ShaderCache','GrShaderCache','GraphiteDawnCache','Shared Dictionary'];
const packagePattern=/^(?:(?:\d+-)?temp-)?Lumi-(\d+\.\d+\.\d+)-(?:x64\.exe|arm64\.dmg)(?:\.blockmap)?$/i;
const auxiliaryPattern=/^(?:installer\.exe|package\.7z|current\.blockmap|update-info\.json|(?:\d+-)?temp-installer\.exe|package-\d+\.\d+\.\d+\.7z|[a-f0-9-]{36}\.part)$/i;
const inside=(file:string,root:string)=>{const relative=path.relative(root,file);return !relative.startsWith('..'+path.sep) && relative!=='..' && !path.isAbsolute(relative);};
const key=(file:string)=>process.platform==='win32' ? path.resolve(file).toLowerCase() : path.resolve(file);
interface DirectoryIdentity {directory:string;dev:bigint;ino:bigint;birthtimeNs:bigint;}
interface CheckedPath {original:string;canonical:string;stat:BigIntStats;parents:DirectoryIdentity[];}
interface CacheFile {file:string;root:CacheRoot;size:number;checked:CheckedPath;version?:string;temporary?:boolean;}

/** Must run before Electron's ready event/default session creation. Explicit test data always wins. */
export function isolateLumiDataPaths(application:{isPackaged:boolean;getPath(name:'appData'):string;setPath(name:'userData'|'sessionData',directory:string):void;},env:NodeJS.ProcessEnv=process.env):boolean {
  const directory=env.LUMI_TEST_DATA ? path.resolve(env.LUMI_TEST_DATA) : env.LUMI_SMOKE==='1' ? path.join(application.getPath('appData'),'Lumi-smoke') : !application.isPackaged ? path.join(application.getPath('appData'),'Lumi-development') : undefined;
  if(!directory)return false;
  mkdirSync(directory,{recursive:true});application.setPath('userData',directory);application.setPath('sessionData',directory);return true;
}

/** The historical NSIS cache name is generated from package.name, not productName. */
export function lumiUpdateCacheRoots(data:string,platform=process.platform,env:NodeJS.ProcessEnv=process.env,home=os.homedir(),isolated=false):CacheRoot[] {
  if(isolated)return [{directory:path.join(data,'updates'),base:data},{directory:path.join(data,'updater-cache'),base:data}];
  const base=platform==='win32' ? env.LOCALAPPDATA || path.join(home,'AppData','Local') : platform==='darwin' ? path.join(home,'Library','Caches') : env.XDG_CACHE_HOME || path.join(home,'.cache');
  return [{directory:path.join(data,'updates'),base:data},...['lumi-ai-workbench-updater','Lumi'].map(name=>({directory:path.join(base,name),base}))];
}
export function lumiBrowserCacheRoots(sessionData:string):CacheRoot[]{return BROWSER_CACHES.map(name=>({directory:path.join(sessionData,name),base:sessionData}));}

const sameIdentity=(stat:BigIntStats,identity:Pick<DirectoryIdentity,'dev'|'ino'|'birthtimeNs'>)=>stat.dev===identity.dev && stat.ino===identity.ino && stat.birthtimeNs===identity.birthtimeNs;
async function recheckDirectories(directories:Iterable<DirectoryIdentity>){
  for(const identity of directories){const stat=await lstat(identity.directory,{bigint:true});if(stat.isSymbolicLink() || !stat.isDirectory() || !sameIdentity(stat,identity))throw new Error('Cache directory changed');}
}
/** Reject existing links, including the base and its ancestors. These path checks are best effort, not atomic against hostile filesystem replacement. */
async function checked(file:string,root:CacheRoot,directories?:Map<string,DirectoryIdentity>):Promise<CheckedPath>{
  const base=path.resolve(root.base),directory=path.resolve(root.directory),target=path.resolve(file);
  if(key(directory)===key(base) || !inside(directory,base) || !inside(target,directory))throw new Error('Invalid cache boundary');
  let cursor=path.parse(target).root,stat:BigIntStats;const parents:DirectoryIdentity[]=[];
  const parts=['',...path.relative(cursor,target).split(path.sep)];
  for(const part of parts){
    cursor=path.join(cursor,part);stat=await lstat(cursor,{bigint:true});
    if(stat.isSymbolicLink())throw new Error('Cache link skipped');
    if(stat.isDirectory()){
      const identity={directory:cursor,dev:stat.dev,ino:stat.ino,birthtimeNs:stat.birthtimeNs},previous=directories?.get(key(cursor));
      if(previous && !sameIdentity(stat,previous))throw new Error('Cache directory changed');
      parents.push(identity);directories?.set(key(cursor),identity);
    }else if(key(cursor)!==key(target))throw new Error('Invalid cache parent');
  }
  const baseReal=await realpath(base),directoryReal=await realpath(directory),canonical=await realpath(target);
  if(key(directoryReal)===key(baseReal) || !inside(directoryReal,baseReal) || !inside(canonical,directoryReal))throw new Error('Cache boundary changed');
  const current=await lstat(canonical,{bigint:true});if(current.isSymbolicLink() || !sameIdentity(current,stat!))throw new Error('Cache file changed');
  return {original:target,canonical,stat:current,parents};
}
async function rechecked(previous:CheckedPath){
  await recheckDirectories(previous.parents);
  if(key(await realpath(previous.original))!==key(previous.canonical))throw new Error('Cache path changed');
  const stat=await lstat(previous.canonical,{bigint:true});if(stat.isSymbolicLink() || !sameIdentity(stat,previous.stat))throw new Error('Cache file changed');
  const parent=previous.parents.at(-1);if(parent && !sameIdentity(await lstat(path.dirname(previous.canonical),{bigint:true}),parent))throw new Error('Cache parent changed');
  return stat;
}
async function filesIn(root:CacheRoot,warnings:Set<string>,category:string,directories=new Map<string,DirectoryIdentity>()){
  const files:CacheFile[]=[];let safe=true;
  async function walk(directory:string,depth=0){
    try{
      const current=await checked(directory,root,directories);if(!current.stat.isDirectory() || depth>32)throw new Error('Invalid cache directory');
      for(const entry of await readdir(directory,{withFileTypes:true})){
        const file=path.join(directory,entry.name);
        if(entry.isSymbolicLink()){safe=false;warnings.add(category+'中有链接，已跳过。');continue;}
        if(entry.isDirectory())await walk(file,depth+1);
        else if(entry.isFile()){try{const current=await checked(file,root,directories);if(current.stat.isFile())files.push({file,root,size:Number(current.stat.size),checked:current});}catch(e:any){if(e.code!=='ENOENT'){safe=false;warnings.add(category+'部分文件无法读取。');}}}
      }
    }catch(e:any){if(e.code!=='ENOENT'){safe=false;warnings.add(category+'部分目录无法读取或超出安全边界。');}}
  }
  await walk(path.resolve(root.directory));return {files,safe};
}
export class AppCacheService {
  private pending:Promise<unknown>=Promise.resolve();
  constructor(private options:{version:string;browserRoots:CacheRoot[];updateRoots:CacheRoot[];protection():UpdateProtection;clearBrowser?():Promise<void>;}){
    newerVersion(options.version,options.version);
  }
  private serialize<T>(work:()=>Promise<T>):Promise<T>{const next=this.pending.then(work);this.pending=next.catch(()=>{});return next;}
  private async inventory(includeBrowser=true){
    const warnings=new Set<string>(),seen=new Set<string>(),browserDirectories=new Map<string,DirectoryIdentity>();
    const collect=async(roots:CacheRoot[],category:string,directories?:Map<string,DirectoryIdentity>)=>{const rows:CacheFile[]=[];let safe=true;for(const root of roots){const result=await filesIn(root,warnings,category,directories);safe &&=result.safe;for(const file of result.files){const id=key(file.file);if(!seen.has(id)){seen.add(id);rows.push(file);}}}return {rows,safe};};
    const browserScan=includeBrowser ? await collect(this.options.browserRoots,'网页缓存',browserDirectories) : {rows:[],safe:true};
    const browser=browserScan.rows,updates=(await collect(this.options.updateRoots,'更新缓存')).rows.filter(file=>{
      const name=path.basename(file.file),match=packagePattern.exec(name);
      file.temporary=/^(?:\d+-)?temp-/i.test(name) || /\.part$/i.test(name);
      if(match){try{newerVersion(match[1],this.options.version);file.version=match[1];return true;}catch{return false;}}
      return auxiliaryPattern.test(name);
    });
    // Unknown metadata is kept; only our bounded, known fileName schema grants deletion of auxiliary pending files.
    const futureDirectories=new Set<string>(),unknownDirectories=new Set<string>();
    for(const file of updates){
      if(file.version && !file.temporary && !/\.blockmap$/i.test(file.file) && newerVersion(file.version,this.options.version))futureDirectories.add(key(path.dirname(file.file)));
      if(path.basename(file.file)==='update-info.json'){
        try{
          if(file.size>64000)throw new Error('Large metadata');
          await rechecked(file.checked);
          const info=JSON.parse(await readFile(file.checked.canonical,'utf8')),version=typeof info.fileName==='string' ? packagePattern.exec(info.fileName)?.[1] : undefined;
          if(!version)unknownDirectories.add(key(path.dirname(file.file)));else if(newerVersion(version,this.options.version))futureDirectories.add(key(path.dirname(file.file)));
        }catch{unknownDirectories.add(key(path.dirname(file.file)));warnings.add('部分待安装更新信息不可读，已保留。');}
      }
    }
    const protection=this.options.protection(),protectedPaths=new Set(protection.files.map(key));
    const protectedFile=(file:CacheFile)=>protection.busy || protectedPaths.has(key(file.file)) || !file.temporary && ((file.version ? newerVersion(file.version,this.options.version) : futureDirectories.has(key(path.dirname(file.file))) || unknownDirectories.has(key(path.dirname(file.file)))) || [...protectedPaths].some(p=>key(path.dirname(p))===key(path.dirname(file.file)) && !file.version));
    return {browser,updates,warnings,protectedFile,browserSafe:browserScan.safe,browserDirectories};
  }
  private info(data:Awaited<ReturnType<AppCacheService['inventory']>>):AppCacheInfo {
    const sum=(rows:CacheFile[])=>rows.reduce((total,file)=>total+file.size,0),browserBytes=sum(data.browser),updateBytes=sum(data.updates);
    return {totalBytes:browserBytes+updateBytes,browserBytes,updateBytes,protectedBytes:sum(data.updates.filter(data.protectedFile)),scannedAt:Date.now(),warnings:[...data.warnings]};
  }
  snapshot():Promise<AppCacheInfo>{return this.serialize(async()=>this.info(await this.inventory()));}
  private async canClearBrowser(data:Awaited<ReturnType<AppCacheService['inventory']>>){
    if(!data.browserSafe || !this.options.browserRoots.length)return false;
    try{
      await recheckDirectories(data.browserDirectories.values());
      // Re-scan just before the native APIs, including previously missing roots and new links.
      for(const root of this.options.browserRoots)if(!(await filesIn(root,data.warnings,'网页缓存',data.browserDirectories)).safe)return false;
      await recheckDirectories(data.browserDirectories.values());return true;
    }catch{return false;}
  }
  private async remove(files:CacheFile[],warnings:Set<string>,category:string){
    let freed=0;
    for(const file of files)try{
      const stat=await rechecked(file.checked);if(!stat.isFile())throw new Error('Cache type changed');
      // Use the verified canonical path after identity checks; a final malicious replacement can still race this call.
      await rm(file.checked.canonical,{force:true});freed+=Number(stat.size);
    }catch(e:any){if(e.code!=='ENOENT')warnings.add(category+'部分文件正在使用或无法删除，将在下次清理时重试。');}
    return freed;
  }
  /** Runs on every launch: remove ALL installed-version packages and updater leftovers, not just the latest download. */
  cleanupInstalled():Promise<{freedBytes:number;warnings:string[]}>{return this.serialize(async()=>{
    const before=await this.inventory(false);await this.remove(before.updates.filter(file=>!before.protectedFile(file)),before.warnings,'更新缓存');
    const after=await this.inventory(false);before.warnings.forEach(w=>after.warnings.add(w));
    return {freedBytes:Math.max(0,this.info(before).updateBytes-this.info(after).updateBytes),warnings:[...after.warnings]};
  });}
  clear():Promise<AppCacheClearResult>{return this.serialize(async()=>{
    const before=await this.inventory();
    if(this.options.clearBrowser){
      if(await this.canClearBrowser(before)){try{await this.options.clearBrowser();}catch{before.warnings.add('部分网页缓存正在使用，未能全部清理。');}}
      else before.warnings.add('网页缓存路径无法确认安全，已跳过系统缓存清理。');
    }
    await this.remove(before.browser,before.warnings,'网页缓存');await this.remove(before.updates.filter(file=>!before.protectedFile(file)),before.warnings,'更新缓存');
    const after=await this.inventory();before.warnings.forEach(w=>after.warnings.add(w));const cache=this.info(after);
    return {cache,freedBytes:Math.max(0,this.info(before).totalBytes-cache.totalBytes)};
  });}
}
