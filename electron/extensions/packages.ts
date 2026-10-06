import {lstat,readdir,readFile,realpath} from 'node:fs/promises';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {parseExtensionManifest,safeExtensionPath} from '../../shared/extension-manifest';
import type {ExtensionDescriptor} from '../../shared/contracts/extensions';
export interface ExtensionPackage extends ExtensionDescriptor {files:Map<string,Buffer>;size:number;directory:string;}
export const EXTENSION_MIME:Record<string,string>={'.html':'text/html; charset=utf-8','.js':'text/javascript; charset=utf-8','.mjs':'text/javascript; charset=utf-8','.css':'text/css; charset=utf-8','.json':'application/json','.svg':'image/svg+xml','.png':'image/png','.jpg':'image/jpeg','.jpeg':'image/jpeg','.webp':'image/webp','.ico':'image/x-icon','.woff':'font/woff','.woff2':'font/woff2','.txt':'text/plain; charset=utf-8'};
/** Pin validated bytes for this lifecycle, eliminating asset changes during an active session. */
export async function readExtensionPackage(directory:string):Promise<ExtensionPackage>{
  if((await lstat(directory)).isSymbolicLink())throw new Error('插件目录不能是符号链接。');
  const root=await realpath(directory),files=new Map<string,Buffer>();let size=0,count=0;
  async function walk(dir:string,prefix=''){
    for(const entry of (await readdir(dir,{withFileTypes:true})).sort((a,b)=>a.name.localeCompare(b.name))){
      const name=prefix+entry.name,file=path.join(dir,entry.name),stat=await lstat(file);
      if(stat.isSymbolicLink())throw new Error('插件不能包含符号链接。');
      if(!safeExtensionPath(name) || ++count>128)throw new Error('插件文件名无效或文件数量超过限制。');
      if(stat.isDirectory()){await walk(file,name+'/');continue;}
      if(!stat.isFile() || stat.size>2*1024*1024 || (size+=stat.size)>16*1024*1024)throw new Error('插件文件类型或大小超过限制。');
      const resolved=await realpath(file);if(!resolved.startsWith(root+path.sep))throw new Error('插件文件超出包目录。');
      files.set(name,await readFile(file));
    }
  }
  await walk(root);
  const bytes=files.get('plugin.json');if(!bytes || bytes.length>64*1024)throw new Error('缺少有效 plugin.json。');
  const manifest=parseExtensionManifest(JSON.parse(bytes.toString('utf8').replace(/^\uFEFF/,'')));
  if(!files.get('LICENSE')?.length)throw new Error('插件必须附带完整 LICENSE 文件。');
  if(files.has('lumi-sdk.js'))throw new Error('lumi-sdk.js 由宿主提供，请勿覆盖。');
  if(files.has('lumi-ui.css'))throw new Error('lumi-ui.css 由宿主提供，请勿覆盖。');
  for(const view of manifest.contributions)if(!files.has(view.entry))throw new Error('缺少界面入口：'+view.entry);
  if(manifest.interface){const css=files.get(manifest.interface.stylesheet);if(!css || css.length>65536)throw new Error('缺少界面样式或超过 64 KiB 限制。');}
  if(manifest.interface?.preview){const preview=files.get(manifest.interface.preview);if(!preview || preview.length>32768)throw new Error('缺少外观预览模板或超过 32 KiB 限制。');}
  const hash=createHash('sha256');for(const [name,data] of files){hash.update(name+'\0');hash.update(data);hash.update('\0');}
  return {manifest,digest:hash.digest('hex'),files,size,directory:root};
}
export async function scanExtensionPackages(roots:string[]){
  const packages:ExtensionPackage[]=[],diagnostics:{package:string;error:string}[]=[];let size=0;
  for(const root of roots){
    const inheritedIds=new Set(packages.map(pkg=>pkg.manifest.id));
    let entries;try{if((await lstat(root)).isSymbolicLink())throw new Error('扩展根目录不能是符号链接。');entries=await readdir(root,{withFileTypes:true});}catch(error:any){if(error.code==='ENOENT')continue;diagnostics.push({package:path.basename(root),error:'扩展目录无法读取。'});continue;}
    for(const entry of entries.sort((a,b)=>a.name.localeCompare(b.name))){
      if(!entry.isDirectory() && !entry.isSymbolicLink())continue;
      try{const pkg=await readExtensionPackage(path.join(root,entry.name));if(inheritedIds.has(pkg.manifest.id))continue;if(packages.length>=32)throw new Error('最多加载 32 个额外插件。');if(packages.some(p=>p.manifest.id===pkg.manifest.id))throw new Error('插件 ID 已被另一个包注册。');if(size+pkg.size>64*1024*1024)throw new Error('额外插件总大小超过限制。');packages.push(pkg);size+=pkg.size;}
      catch(error){diagnostics.push({package:entry.name,error:error instanceof Error ? error.message : '插件包无效。'});}
    }
  }
  return {packages,diagnostics};
}
