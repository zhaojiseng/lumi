import {createHash,randomUUID} from 'node:crypto';
import {createReadStream} from 'node:fs';
import {mkdir,open,rename,rm,lstat} from 'node:fs/promises';
import path from 'node:path';
import type {UpdateState} from '../../shared/types';

const REPOSITORY='zhaojiseng/lumi';
const API='https://api.github.com/repos/'+REPOSITORY+'/releases/latest';
const MAX_PACKAGE=512*1024*1024;
interface Asset {name:string;size:number;browser_download_url:string;digest?:string;}
interface Release {tag_name:string;draft:boolean;prerelease:boolean;html_url:string;assets:Asset[];}
function versionParts(value:string){
  const match=/^v?(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.exec(value);
  if(!match)throw new Error('GitHub 返回的版本号无效。');
  const parts=match.slice(1).map(Number);
  if(parts.some(n=>!Number.isSafeInteger(n)))throw new Error('GitHub 返回的版本号无效。');
  return parts;
}
export function newerVersion(candidate:string,current:string){
  const a=versionParts(candidate),b=versionParts(current);
  for(let i=0;i<3;i++)if(a[i]!==b[i])return a[i]>b[i];
  return false;
}
function safeAsset(asset:Asset,tag:string,name:string){
  if(!asset || asset.name!==name || !Number.isSafeInteger(asset.size) || asset.size<=0 || asset.size>MAX_PACKAGE)throw new Error('Release 更新附件无效。');
  const expected='https://github.com/'+REPOSITORY+'/releases/download/'+tag+'/'+name;
  if(asset.browser_download_url!==expected)throw new Error('Release 更新附件地址不属于 Lumi 仓库。');
  if(asset.digest && !/^sha256:[a-f0-9]{64}$/.test(asset.digest))throw new Error('Release 更新附件的校验信息无效。');
  return asset;
}
async function smallBody(response:Response,limit:number){
  if(!response.body)throw new Error('GitHub 返回了空数据。');
  const chunks:Uint8Array[]=[];let size=0;
  for await(const chunk of response.body){size+=chunk.length;if(size>limit)throw new Error('GitHub 返回的数据过大。');chunks.push(chunk);}
  return Buffer.concat(chunks).toString('utf8');
}
async function fileDigest(file:string){
  const stat=await lstat(file);if(!stat.isFile() || stat.isSymbolicLink())throw new Error('更新文件无效，请重新下载。');
  const hash=createHash('sha256');for await(const chunk of createReadStream(file))hash.update(chunk);
  return {size:stat.size,hash:hash.digest('hex')};
}
export class UpdateService {
  private state:UpdateState;
  private release?:{version:string;package:Asset;sums:Asset;};
  private checked?:Promise<UpdateState>;
  private downloading?:Promise<UpdateState>;
  private controller?:AbortController;
  private ready?:{file:string;hash:string;size:number;};
  private listeners=new Set<(state:UpdateState)=>void>();
  constructor(private options:{version:string;directory:string;platform?:string;arch?:string;fetch?:typeof fetch;enabled?:boolean;}){
    versionParts(options.version);
    this.state={phase:options.enabled===false ? 'unsupported' : 'idle',currentVersion:options.version,received:0,total:0};
  }
  snapshot(){return structuredClone(this.state);}
  subscribe(listener:(state:UpdateState)=>void){this.listeners.add(listener);return ()=>{this.listeners.delete(listener);};}
  private set(patch:Partial<UpdateState>){this.state={...this.state,...patch};for(const listener of this.listeners)listener(this.snapshot());}
  private async request(url:string,signal:AbortSignal,asset=false){
    const transport=this.options.fetch || fetch;
    for(let redirects=0;redirects<=5;redirects++){
      const parsed=new URL(url);
      const allowed=asset ? ['github.com','release-assets.githubusercontent.com','objects.githubusercontent.com'] : ['api.github.com'];
      if(parsed.protocol!=='https:' || parsed.port || parsed.username || parsed.password || !allowed.includes(parsed.hostname))throw new Error('更新服务器重定向地址无效。');
      const response=await transport(url,{signal,redirect:'manual',headers:{Accept:asset ? 'application/octet-stream' : 'application/vnd.github+json','User-Agent':'Lumi/'+this.options.version,'Cache-Control':'no-cache'}});
      if(response.status>=300 && response.status<400){
        const location=response.headers.get('location');await response.body?.cancel();
        if(!asset || !location)throw new Error('更新服务器重定向无效。');
        url=new URL(location,url).href;continue;
      }
      if(!response.ok){await response.body?.cancel();throw new Error(response.status===403 || response.status===429 ? 'GitHub 请求受限，请稍后重试。' : '无法获取更新（HTTP '+response.status+'）。');}
      return response;
    }
    throw new Error('更新服务器重定向次数过多。');
  }
  check():Promise<UpdateState>{
    if(this.options.enabled===false || this.downloading || this.state.phase==='ready')return Promise.resolve(this.snapshot());
    if(this.checked)return this.checked;
    const job=this.performCheck();this.checked=job;
    return job.finally(()=>{if(this.checked===job)this.checked=undefined;});
  }
  private async performCheck(){
    this.set({phase:'checking',error:undefined});
    try{
      const response=await this.request(API,AbortSignal.timeout(20000));
      const release:Release=JSON.parse(await smallBody(response,512*1024));
      const version=versionParts(release.tag_name).join('.');
      if(release.draft || release.prerelease || release.tag_name!=='v'+version || release.html_url!=='https://github.com/'+REPOSITORY+'/releases/tag/v'+version)throw new Error('GitHub 未返回有效的正式版本。');
      this.release=undefined;
      if(!newerVersion(version,this.options.version))this.set({phase:'current',version:undefined,releaseUrl:release.html_url,checkedAt:Date.now(),received:0,total:0});
      else if((this.options.platform || process.platform)!=='win32' || (this.options.arch || process.arch)!=='x64')this.set({phase:'unsupported',version,releaseUrl:release.html_url,checkedAt:Date.now()});
      else{
        const assets=Array.isArray(release.assets) ? release.assets : [];
        const name='Lumi-'+version+'-x64.exe';
        const packageAsset=safeAsset(assets.find(a=>a.name===name)!,release.tag_name,name);
        const sums=safeAsset(assets.find(a=>a.name==='SHA256SUMS.txt')!,release.tag_name,'SHA256SUMS.txt');
        if(sums.size>64*1024)throw new Error('Release 校验文件过大。');
        this.release={version,package:packageAsset,sums};
        this.set({phase:'available',version,releaseUrl:release.html_url,checkedAt:Date.now(),received:0,total:packageAsset.size});
      }
    }catch(e){this.set({phase:'error',error:e instanceof Error && !['TimeoutError','TypeError'].includes(e.name) ? e.message : '更新检查失败，请检查网络后重试。'});}
    return this.snapshot();
  }
  download():Promise<UpdateState>{
    if(this.downloading)return this.downloading;
    if(!this.release || !['available','error'].includes(this.state.phase))return Promise.reject(new Error('请先检查可用更新。'));
    this.controller=new AbortController();
    const job=this.performDownload(this.release,this.controller);this.downloading=job;
    return job.finally(()=>{if(this.downloading===job){this.downloading=undefined;this.controller=undefined;}});
  }
  private async performDownload(release:NonNullable<UpdateService['release']>,controller:AbortController){
    const signal=AbortSignal.any([controller.signal,AbortSignal.timeout(30*60*1000)]);
    const directory=path.resolve(this.options.directory,release.version);
    const target=path.join(directory,release.package.name),partial=path.join(directory,randomUUID()+'.part');
    this.ready=undefined;this.set({phase:'downloading',received:0,total:release.package.size,error:undefined});
    try{
      const sums=await smallBody(await this.request(release.sums.browser_download_url,signal,true),64*1024);
      const matches=sums.split(/\r?\n/).map(line=>/^([a-f0-9]{64})\s+[ *]?([^\r\n]+)$/.exec(line)).filter(match=>match?.[2]===release.package.name);
      if(matches.length!==1 || release.package.digest && release.package.digest!=='sha256:'+matches[0]![1])throw new Error('Release 校验值缺失或不一致。');
      const expected=matches[0]![1];
      await mkdir(directory,{recursive:true});
      const response=await this.request(release.package.browser_download_url,signal,true);
      const length=response.headers.get('content-length');
      if(length && Number(length)!==release.package.size){await response.body?.cancel();throw new Error('更新文件大小与 Release 不一致。');}
      if(!response.body)throw new Error('更新服务器未返回文件。');
      const handle=await open(partial,'wx',0o600);const hash=createHash('sha256');let received=0,lastProgress=0;
      try{
        for await(const chunk of response.body){
          signal.throwIfAborted();received+=chunk.length;
          if(received>release.package.size)throw new Error('更新文件大小与 Release 不一致。');
          hash.update(chunk);let offset=0;
          while(offset<chunk.length){const written=await handle.write(chunk,offset,chunk.length-offset);if(!written.bytesWritten)throw new Error('无法写入更新文件。');offset+=written.bytesWritten;}
          if(Date.now()-lastProgress>=100){lastProgress=Date.now();this.set({received});}
        }
        await handle.sync();
      }finally{await handle.close();}
      this.set({phase:'verifying',received});signal.throwIfAborted();
      if(received!==release.package.size || hash.digest('hex')!==expected)throw new Error('更新文件校验失败，请重新下载。');
      await rm(target,{force:true});await rename(partial,target);
      this.ready={file:target,hash:expected,size:received};this.set({phase:'ready',error:undefined});
    }catch(e){
      await rm(partial,{force:true}).catch(()=>{});
      this.set(controller.signal.aborted ? {phase:'available',received:0,error:undefined} : {phase:'error',error:e instanceof Error && !['TimeoutError','TypeError'].includes(e.name) ? e.message : '更新下载失败，请检查网络后重试。'});
    }
    return this.snapshot();
  }
  cancel(){this.controller?.abort();}
  async readyFile(){
    if(!this.ready || this.state.phase!=='ready')throw new Error('更新文件尚未下载完成。');
    const checked=await fileDigest(this.ready.file);
    if(checked.size!==this.ready.size || checked.hash!==this.ready.hash){this.ready=undefined;this.set({phase:'error',error:'更新文件已变更，请重新下载。'});throw new Error(this.state.error);}
    return this.ready.file;
  }
}
