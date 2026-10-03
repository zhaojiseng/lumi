import {createHash} from 'node:crypto';
import {z} from 'zod';
import {EXTENSION_MARKET_REPOSITORY,EXTENSION_MARKET_URL,compareExtensionVersions,type ExtensionMarketCatalog,type ExtensionMarketItem,type ExtensionMarketInstall} from '../../shared/contracts/extension-market';
import {extensionId,parseExtensionManifest,safeExtensionPath} from '../../shared/extension-manifest';
import type {ExtensionHost} from './host';

const api='https://api.github.com/repos/'+EXTENSION_MARKET_REPOSITORY;
const raw='https://raw.githubusercontent.com/'+EXTENSION_MARKET_REPOSITORY;
const sha=z.string().regex(/^[a-f0-9]{40}$/);
const treeSchema=z.object({truncated:z.boolean(),tree:z.array(z.object({path:z.string().max(500),mode:z.string(),type:z.string(),sha,size:z.number().int().nonnegative().optional()})).max(10000)});
type TreeFile={name:string;sha:string;size:number};
type PackageEntry={item:ExtensionMarketItem;files:TreeFile[];};
export type MarketRead=(url:string,limit:number,signal:AbortSignal)=>Promise<Buffer>;

export async function readMarketResource(url:string,limit:number,signal:AbortSignal):Promise<Buffer>{
  const parsed=new URL(url);
  if(parsed.origin!=='https://api.github.com' && parsed.origin!=='https://raw.githubusercontent.com')throw new Error('插件市场来源无效。');
  const response=await fetch(url,{redirect:'error',signal,headers:{Accept:'application/vnd.github+json','User-Agent':'Lumi-Extension-Market'}});
  if(!response.ok){await response.body?.cancel();throw new Error([403,429].includes(response.status) ? 'GitHub 请求额度暂时受限，请稍后刷新。' : '插件市场暂时无法连接（HTTP '+response.status+'）。');}
  if(!response.body)throw new Error('插件市场返回空响应。');
  const reader=response.body.getReader(),chunks:Buffer[]=[];let size=0;
  try{for(;;){const {done,value}=await reader.read();if(done)break;if((size+=value.length)>limit)throw new Error('插件市场文件超过大小限制。');chunks.push(Buffer.from(value));}}
  catch(error){await reader.cancel().catch(()=>{});throw error;}
  finally{reader.releaseLock();}
  return Buffer.concat(chunks,size);
}
export function marketPackageFiles(input:unknown):Map<string,TreeFile[]>{
  const tree=treeSchema.parse(input);if(tree.truncated)throw new Error('插件市场目录不完整，请稍后重试。');
  const packages=new Map<string,TreeFile[]>(),counts=new Map<string,number>();
  for(const node of tree.tree){
    const [root,id,...parts]=node.path.split('/');if(root!=='plugins' || !extensionId.test(id || '') || !parts.length)continue;
    const name=parts.join('/');
    if(!safeExtensionPath(name) || !['blob','tree'].includes(node.type) || !['100644','100755','040000'].includes(node.mode))throw new Error('市场插件包含不支持的路径或链接。');
    const count=(counts.get(id) || 0)+1;counts.set(id,count);if(count>128)throw new Error('市场插件文件数量超过限制。');
    if(node.type==='tree')continue;
    if(node.size===undefined || node.size>2*1024*1024)throw new Error('市场插件文件超过大小限制。');
    const files=packages.get(id) || [];files.push({name,sha:node.sha,size:node.size});packages.set(id,files);
  }
  if(packages.size>128)throw new Error('插件市场条目过多。');
  for(const files of packages.values()){
    if(files.reduce((sum,file)=>sum+file.size,0)>16*1024*1024 || new Set(files.map(file=>file.name.toLowerCase())).size!==files.length)throw new Error('市场插件大小或文件名称冲突。');
  }
  return packages;
}
export class ExtensionMarket {
  private controller=new AbortController();private snapshot?:ExtensionMarketCatalog;private entries=new Map<string,PackageEntry>();private pending?:Promise<ExtensionMarketCatalog>;private installing=false;
  constructor(private host:ExtensionHost,private transport:MarketRead=readMarketResource){}
  private signal(){return AbortSignal.any([this.controller.signal,AbortSignal.timeout(15000)]);}
  private async json(url:string){return JSON.parse((await this.transport(url,4*1024*1024,this.signal())).toString('utf8'));}
  private async file(revision:string,id:string,file:TreeFile,limit=2*1024*1024){
    if(file.size>limit)throw new Error('市场插件文件超过大小限制。');
    const bytes=await this.transport(raw+'/'+revision+'/plugins/'+id+'/'+file.name,limit,this.signal());
    const digest=createHash('sha1').update('blob '+bytes.length+'\0').update(bytes).digest('hex');
    if(bytes.length!==file.size || digest!==file.sha)throw new Error('插件文件校验失败，请刷新市场后重试。');
    return bytes;
  }
  read(input:{force?:boolean}={}):Promise<ExtensionMarketCatalog>{
    if(this.controller.signal.aborted)return Promise.reject(new Error('插件市场正在退出。'));
    if(this.pending)return this.pending;
    if(!input.force && this.snapshot && Date.now()-this.snapshot.fetchedAt<300000)return Promise.resolve(structuredClone(this.snapshot));
    const pending=this.load();this.pending=pending;
    void pending.finally(()=>{if(this.pending===pending)this.pending=undefined;}).catch(()=>{});
    return pending;
  }
  private async load(){
    const revision=sha.parse((await this.json(api+'/commits/main')).sha),packages=marketPackageFiles(await this.json(api+'/git/trees/'+revision+'?recursive=1'));
    const entries=new Map<string,PackageEntry>(),diagnostics:ExtensionMarketCatalog['diagnostics']=[];
    for(const [id,files] of packages){
      try{
        const manifestFile=files.find(file=>file.name==='plugin.json');if(!manifestFile)throw new Error('缺少 plugin.json。');
        const manifest=parseExtensionManifest(JSON.parse((await this.file(revision,id,manifestFile,65536)).toString('utf8').replace(/^\uFEFF/,'')));
        if(manifest.id!==id)throw new Error('插件 ID 与仓库目录不一致。');
        if(!files.some(file=>file.name==='LICENSE' && file.size>0) || files.some(file=>file.name==='lumi-sdk.js'))throw new Error('插件许可或 SDK 文件无效。');
        for(const contribution of manifest.contributions)if(!files.some(file=>file.name===contribution.entry))throw new Error('缺少插件界面入口。');
        const item:ExtensionMarketItem={manifest,sourceUrl:EXTENSION_MARKET_URL+'/tree/'+revision+'/plugins/'+id};
        if(manifest.interface){
          const css=files.find(file=>file.name===manifest.interface!.stylesheet);if(!css)throw new Error('缺少界面样式。');
          const preview=manifest.interface.preview && files.find(file=>file.name===manifest.interface!.preview);if(manifest.interface.preview && !preview)throw new Error('缺少预览模板。');
          item.preview={id,css:(await this.file(revision,id,css,65536)).toString('utf8'),appearanceGroups:manifest.interface.appearanceGroups,preview:preview ? (await this.file(revision,id,preview,32768)).toString('utf8') : undefined};
        }
        entries.set(id,{item,files});
      }catch(error){diagnostics.push({package:id,error:error instanceof z.ZodError ? '插件清单与当前宿主不兼容。' : error instanceof Error ? error.message : '插件无效。'});}
    }
    if(this.controller.signal.aborted)throw new Error('插件市场正在退出。');
    const catalog={revision,fetchedAt:Date.now(),plugins:[...entries.values()].map(entry=>entry.item),diagnostics};
    this.entries=entries;this.snapshot=catalog;return structuredClone(catalog);
  }
  async install(input:ExtensionMarketInstall){
    if(this.installing)throw new Error('插件正在安装，请稍后再试。');
    if(this.controller.signal.aborted)throw new Error('插件市场正在退出。');
    const entry=this.entries.get(input.id);if(!entry || !this.snapshot || this.snapshot.revision!==input.revision)throw new Error('插件市场内容已更新，请刷新后重新安装。');
    const installed=this.host.inventory().plugins.find(pkg=>pkg.manifest.id===input.id);
    if(installed && compareExtensionVersions(entry.item.manifest.version,installed.manifest.version)<0)throw new Error('本地插件版本较新，无法通过市场降级。');
    this.installing=true;
    try{
      // All bytes use the catalog's immutable commit and Git blob hashes, even if main advances.
      const files=new Map<string,Buffer>(),remaining=[...entry.files];
      const results=await Promise.allSettled(Array.from({length:Math.min(3,remaining.length)},async()=>{let file;while((file=remaining.shift())){const bytes=await this.file(input.revision,input.id,file);files.set(file.name,bytes);}}));
      for(const result of results)if(result.status==='rejected')throw result.reason;
      if(this.controller.signal.aborted)throw new Error('插件市场正在退出。');
      return await this.host.installFiles(input.id,files);
    }finally{this.installing=false;}
  }
  dispose(){this.controller.abort();this.entries.clear();this.snapshot=undefined;}
}
