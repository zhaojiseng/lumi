import {createHash} from 'node:crypto';
import {createReadStream} from 'node:fs';
import {lstat} from 'node:fs/promises';
import type {UpdateState} from '../../shared/types';

const REPOSITORY='zhaojiseng/lumi',MAX_PACKAGE=512*1024*1024;
export interface NativeUpdateInfo {version:string;tag?:string;files:{url:string;sha512?:string;sha256?:string;size?:number}[];packages?:unknown;}
export interface UpdateEngine {
  check():Promise<NativeUpdateInfo|null>;
  download(signal:AbortSignal,progress:(received:number,total:number)=>void):Promise<string>;
  install():void;
  onError(listener:(error:Error)=>void):()=>void;
}
function versionParts(value:string){
  const match=/^v?(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.exec(value);
  if(!match)throw new Error('更新版本号无效。');
  const parts=match.slice(1).map(Number);if(parts.some(n=>!Number.isSafeInteger(n)))throw new Error('更新版本号无效。');return parts;
}
export function newerVersion(candidate:string,current:string){const a=versionParts(candidate),b=versionParts(current);for(let i=0;i<3;i++)if(a[i]!==b[i])return a[i]>b[i];return false;}
export function validateUpdate(info:NativeUpdateInfo,target:'windows'|'mac-arm64'='windows'){
  const version=versionParts(info.version).join('.'),name='Lumi-'+version+(target==='windows' ? '-x64.exe' : '-arm64.dmg');
  if(info.version!==version || info.tag!==undefined && info.tag!=='v'+version || info.packages || !Array.isArray(info.files) || info.files.length!==1)throw new Error('更新元数据无效。');
  const file=info.files[0],url='https://github.com/'+REPOSITORY+'/releases/download/v'+version+'/'+name;
  const size=file?.size;
  const hash=target==='windows' ? file?.sha512 : file?.sha256;
  const validHash=typeof hash==='string' && (target==='windows' ? Buffer.from(hash,'base64').length===64 && Buffer.from(hash,'base64').toString('base64')===hash : /^[a-f0-9]{64}$/.test(hash));
  if(!file || ![name,url].includes(file.url) || typeof size!=='number' || !Number.isSafeInteger(size) || size<=0 || size>MAX_PACKAGE || !validHash)throw new Error('更新附件或校验值无效。');
  return {version,size,hash:hash!,algorithm:target==='windows' ? 'sha512' as const : 'sha256' as const,releaseUrl:'https://github.com/'+REPOSITORY+'/releases/tag/v'+version};
}
async function verifyFile(file:string,expected:{size:number;hash:string;algorithm:'sha512'|'sha256'}){
  const stat=await lstat(file);if(!stat.isFile() || stat.isSymbolicLink() || stat.size!==expected.size)throw new Error('更新文件大小不一致，请重新下载。');
  const hash=createHash(expected.algorithm);for await(const chunk of createReadStream(file))hash.update(chunk);
  if(hash.digest(expected.algorithm==='sha512' ? 'base64' : 'hex')!==expected.hash)throw new Error('更新文件校验失败，请重新下载。');
}
export class UpdateService {
  private state:UpdateState;private release?:ReturnType<typeof validateUpdate>;private ready?:string;
  private checking?:Promise<UpdateState>;private downloading?:Promise<UpdateState>;private installing?:Promise<void>;private controller?:AbortController;
  private listeners=new Set<(state:UpdateState)=>void>();private stopError?:()=>void;
  constructor(private options:{version:string;enabled:boolean;engine?:UpdateEngine;target?:'windows'|'mac-arm64';}){
    versionParts(options.version);this.state={phase:options.enabled ? 'idle' : 'unsupported',currentVersion:options.version,received:0,total:0,installMode:options.target==='mac-arm64' ? 'replace' : 'restart'};
    this.stopError=options.engine?.onError(()=>{if(this.state.phase==='installing')this.set({phase:'error',error:'更新安装未能启动，请重试。'});});
  }
  snapshot(){return structuredClone(this.state);}
  subscribe(listener:(state:UpdateState)=>void){this.listeners.add(listener);return()=>{this.listeners.delete(listener);};}
  private set(patch:Partial<UpdateState>){this.state={...this.state,...patch};for(const listener of this.listeners)listener(this.snapshot());}
  check():Promise<UpdateState>{
    if(!this.options.enabled || this.downloading || this.state.phase==='ready' || this.state.phase==='installing')return Promise.resolve(this.snapshot());
    if(this.checking)return this.checking;const job=this.performCheck();this.checking=job;return job.finally(()=>{if(this.checking===job)this.checking=undefined;});
  }
  private async performCheck(){
    this.release=undefined;this.set({phase:'checking',error:undefined,version:undefined,received:0,total:0});
    try{
      const info=await this.options.engine!.check();if(!info)throw new Error('更新检查暂不可用。');
      const version=versionParts(info.version).join('.');this.release=undefined;
      if(!newerVersion(version,this.options.version))this.set({phase:'current',version:undefined,received:0,total:0,checkedAt:Date.now()});
      else{this.release=validateUpdate(info,this.options.target);this.set({phase:'available',version:this.release.version,releaseUrl:this.release.releaseUrl,received:0,total:this.release.size,checkedAt:Date.now()});}
    }catch(e){this.set({phase:'error',error:e instanceof Error && /^更新/.test(e.message) ? e.message : '更新检查失败，请检查网络后重试。'});}
    return this.snapshot();
  }
  download():Promise<UpdateState>{
    if(this.downloading)return this.downloading;
    if(!this.release || !['available','error'].includes(this.state.phase))return Promise.reject(new Error('请先检查可用更新。'));
    this.controller=new AbortController();const job=this.performDownload(this.controller);this.downloading=job;return job.finally(()=>{if(this.downloading===job){this.downloading=undefined;this.controller=undefined;}});
  }
  private async performDownload(controller:AbortController){
    const release=this.release!;this.ready=undefined;this.set({phase:'downloading',received:0,total:release.size,error:undefined});
    try{
      const file=await this.options.engine!.download(controller.signal,(received,_total)=>{if(!controller.signal.aborted && Number.isFinite(received) && received>=0)this.set({received:Math.min(received,release.size),total:release.size});});
      controller.signal.throwIfAborted();this.set({phase:'verifying',received:release.size});await verifyFile(file,release);controller.signal.throwIfAborted();
      this.ready=file;this.set({phase:'ready'});
    }catch(e){this.set(controller.signal.aborted ? {phase:'available',received:0,error:undefined} : {phase:'error',error:e instanceof Error && /^更新/.test(e.message) ? e.message : '更新下载失败，请检查网络后重试。'});}
    return this.snapshot();
  }
  cancel(){this.controller?.abort();}
  close(){this.cancel();this.stopError?.();}
  async readyFile(){
    if(!this.ready || !this.release || this.state.phase!=='ready')throw new Error('更新尚未下载完成。');
    try{await verifyFile(this.ready,this.release);return this.ready;}catch{this.ready=undefined;this.set({phase:'error',error:'更新文件已变更，请重新下载。'});throw new Error(this.state.error);}
  }
  restart():Promise<void>{
    if(this.options.target==='mac-arm64')return Promise.reject(new Error('macOS 更新请打开已下载的 DMG，并替换 Applications 中的 Lumi。'));
    if(this.installing)return this.installing;
    const job=(async()=>{await this.readyFile();this.set({phase:'installing',error:undefined});try{this.options.engine!.install();}catch{this.set({phase:'error',error:'更新安装未能启动，请重试。'});throw new Error(this.state.error);}})();
    this.installing=job;return job.finally(()=>{if(this.installing===job)this.installing=undefined;});
  }
}
