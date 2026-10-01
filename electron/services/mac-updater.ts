import {mkdir,open,rename,rm} from 'node:fs/promises';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {validateUpdate,type NativeUpdateInfo,type UpdateEngine} from './updates';
const ROOT='https://github.com/zhaojiseng/lumi/releases/download/';
export function macReleaseInfo(value:unknown):NativeUpdateInfo {
  const data=value as {tag_name?:string;body?:unknown;draft?:boolean;prerelease?:boolean;assets?:{name?:string;size?:number;digest?:string;browser_download_url?:string}[]};
  if(!data || data.draft!==false || data.prerelease!==false || typeof data.tag_name!=='string' || !/^v\d+\.\d+\.\d+$/.test(data.tag_name) || !Array.isArray(data.assets))throw new Error('更新 Release 元数据无效。');
  const version=data.tag_name.slice(1),name=`Lumi-${version}-arm64.dmg`,matches=data.assets.filter(a=>a.name===name);
  if(matches.length!==1 || matches[0].browser_download_url!==ROOT+data.tag_name+'/'+name)throw new Error('更新 macOS ARM64 附件无效。');
  const asset=matches[0],sha256=asset.digest?.match(/^sha256:([a-f0-9]{64})$/)?.[1];
  const info={version,tag:data.tag_name,releaseNotes:data.body,files:[{url:asset.browser_download_url!,sha256,size:asset.size}]};
  validateUpdate(info,'mac-arm64');return info;
}
/** Downloads official DMG with no account credentials. Installation remains a macOS Finder action. */
export function macUpdater(directory:string,fetcher:typeof fetch=fetch):UpdateEngine {
  let info:NativeUpdateInfo|undefined;
  return {
    check:async()=>{
      info=undefined;const response=await fetcher('https://api.github.com/repos/zhaojiseng/lumi/releases/latest',{headers:{Accept:'application/vnd.github+json','User-Agent':'Lumi updater'},signal:AbortSignal.timeout(15000),redirect:'error'});
      if(!response.ok)throw new Error('更新检查失败，请稍后重试。');info=macReleaseInfo(await response.json());return info;
    },
    download:async(signal,progress)=>{
      if(!info)throw new Error('更新尚未检查。');const expected=validateUpdate(info,'mac-arm64'),name=`Lumi-${expected.version}-arm64.dmg`;
      await mkdir(directory,{recursive:true});const temporary=path.join(directory,randomUUID()+'.part'),target=path.join(directory,name);
      let file:Awaited<ReturnType<typeof open>>|undefined;
      try{
        const response=await fetcher(info.files[0].url,{signal:AbortSignal.any([signal,AbortSignal.timeout(30*60_000)])});
        const final=new URL(response.url || info.files[0].url);
        if(!response.ok || !response.body || final.protocol!=='https:' || !['github.com','release-assets.githubusercontent.com','objects.githubusercontent.com'].includes(final.hostname))throw new Error('更新下载地址或响应无效。');
        file=await open(temporary,'wx');let received=0;
        for await(const chunk of response.body){signal.throwIfAborted();received+=chunk.length;if(received>expected.size)throw new Error('更新文件大小不一致。');await file.writeFile(chunk);progress(received,expected.size);}
        signal.throwIfAborted();await file.close();file=undefined;
        if(received!==expected.size)throw new Error('更新文件大小不一致。');
        await rename(temporary,target);return target;
      }finally{await file?.close();await rm(temporary,{force:true});}
    },
    install:()=>{throw new Error('更新请通过 Finder 替换应用。');},onError:()=>()=>{},
  };
}
