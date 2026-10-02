import {mkdir} from 'node:fs/promises';
import {z} from 'zod';
import type {Cipher} from '../services/store';
import {extensionStatus,type ExtensionInventory,type ExtensionContext,type ExtensionPermission,type ExtensionRequest} from '../../shared/contracts/extensions';
import {safeExtensionPath} from '../../shared/extension-manifest';
import {ExtensionStore} from './store';
import {scanExtensionPackages,EXTENSION_MIME,type ExtensionPackage} from './packages';
import {extensionNetworkRead} from './network';
import path from 'node:path';
interface ActivePackage {pkg:ExtensionPackage;enabled:boolean;generation:number;controller:AbortController;pending:number;}
export interface ExtensionHostOptions {
  directory:string;roots?:string[];settingsDirectory:string;cipher:Cipher;sdk:Buffer;
  context():ExtensionContext;scope():string;
  read(method:'workbench.read'|'usage.read'|'codex.usage.read',input:unknown):Promise<unknown>;
}
const keySchema=z.string().regex(/^[a-z][a-z0-9.-]{0,79}$/).refine(key=>!['constructor','prototype'].includes(key));
const json=z.unknown().refine(value=>{try{return JSON.stringify(value)?.length<=65536;}catch{return false;}},'扩展设置超过大小限制。');
export class ExtensionHost {
  private store:ExtensionStore;private packages=new Map<string,ActivePackage>();private diagnostics:ExtensionInventory['diagnostics']=[];private epoch=0;private closing=false;private queue:Promise<unknown>=Promise.resolve();
  constructor(private options:ExtensionHostOptions){this.store=new ExtensionStore(options.settingsDirectory,options.cipher);}
  async start(){await mkdir(this.options.directory,{recursive:true});await this.store.load();await this.reload();}
  private serial<T>(job:()=>Promise<T>):Promise<T>{if(this.closing)return Promise.reject(new Error('扩展宿主正在退出。'));const result=this.queue.catch(()=>{}).then(()=>{if(this.closing)throw new Error('扩展宿主正在退出。');return job();});this.queue=result;return result;}
  inventory():ExtensionInventory{const selected=[...this.packages.values()].find(p=>p.enabled && p.pkg.manifest.kind==='interface'),stylesheet=selected?.pkg.manifest.interface?.stylesheet;return {directory:this.options.directory,plugins:[...this.packages.values()].map(({pkg})=>({manifest:pkg.manifest,digest:pkg.digest})),diagnostics:this.diagnostics,interfaceStyle:selected && stylesheet ? {id:selected.pkg.manifest.id,css:selected.pkg.files.get(stylesheet)!.toString('utf8')} : undefined};}
  statuses(){return [...this.packages.values()].map(p=>extensionStatus(p.pkg.manifest,p.enabled,p.generation,this.store.get(p.pkg.manifest.id).views));}
  has(id:string){return this.packages.has(id);}
  reload(){return this.serial(async()=>{
    const scanned=await scanExtensionPackages([this.options.directory,...this.options.roots || []]);
    for(const item of this.packages.values())item.controller.abort();
    this.packages.clear();this.diagnostics=scanned.diagnostics;
    for(const pkg of scanned.packages){const saved=this.store.get(pkg.manifest.id);this.packages.set(pkg.manifest.id,{pkg,enabled:saved.enabled && saved.digest===pkg.digest,generation:++this.epoch,controller:new AbortController(),pending:0});}
    let selected=false;for(const item of this.packages.values())if(item.enabled && item.pkg.manifest.kind==='interface'){if(selected)item.enabled=false;selected=true;}
    return this.inventory();
  });}
  setEnabled(id:string,enabled:boolean){return this.serial(async()=>{
    const item=this.packages.get(id);if(!item)throw new Error('额外插件不存在，请重新扫描。');
    if(item.pkg.manifest.kind==='interface'){
      const changed=[item,...enabled ? [...this.packages.values()].filter(other=>other!==item && other.enabled && other.pkg.manifest.kind==='interface') : []],previous=changed.map(p=>p.enabled);
      changed.forEach(p=>{p.controller.abort();p.controller=new AbortController();p.generation=++this.epoch;p.enabled=p===item && enabled;});
      try{await this.store.changeEnabled(changed.map(p=>({id:p.pkg.manifest.id,enabled:p.enabled,digest:p.pkg.digest})));}catch(error){changed.forEach((p,index)=>{p.enabled=previous[index];p.generation=++this.epoch;});throw error;}
      return;
    }
    const previous=item.enabled;item.controller.abort();item.controller=new AbortController();item.generation=++this.epoch;item.enabled=enabled;
    try{await this.store.change(id,{enabled,digest:item.pkg.digest});}catch(error){item.enabled=previous;item.generation=++this.epoch;throw error;}
  });}
  setView(id:string,view:string,enabled:boolean){return this.serial(async()=>{
    const item=this.packages.get(id);if(!item?.pkg.manifest.switches.some(s=>s.id===view))throw new Error('额外插件没有此功能开关。');
    await this.store.change(id,{views:{...this.store.get(id).views,[view]:enabled}});
    item.controller.abort();item.controller=new AbortController();item.generation=++this.epoch;
  });}
  private active(input:ExtensionRequest){
    const item=this.packages.get(input.id),view=item?.pkg.manifest.contributions.find(v=>v.id===input.view);
    if(this.closing || !item?.enabled || input.generation!==item.generation || !view || view.switch && (this.store.get(input.id).views[view.switch] ?? item.pkg.manifest.switches.find(s=>s.id===view.switch)?.defaultEnabled)===false)throw new Error('扩展或显示项已停用，请重新打开。');
    return item;
  }
  async request(input:ExtensionRequest){
    const item=this.active(input),view=item.pkg.manifest.contributions.find(v=>v.id===input.view)!;
    const siteBound=view.scope==='site' || ['context.read','workbench.read','usage.read'].includes(input.method),scope=siteBound ? this.options.scope() : undefined;if(item.pending>=8)throw new Error('扩展请求过于频繁。');
    const permissions=item.pkg.manifest.permissions,requirePermission=(permission:ExtensionPermission)=>{if(!permissions.includes(permission))throw new Error('扩展未声明此操作权限。');};
    ++item.pending;
    try{
      let result:unknown;
      if(input.method==='context.read')result=this.options.context();
      else if(input.method==='storage.read'){requirePermission('storage');const {key}=z.object({key:keySchema}).strict().parse(input.input);result=this.store.get(input.id).storage[key] ?? null;}
      else if(input.method==='storage.write'){
        requirePermission('storage');const {key,value}=z.object({key:keySchema,value:json}).strict().parse(input.input);
        await this.serial(async()=>{this.active(input);const storage={...this.store.get(input.id).storage,[key]:value};json.parse(storage);await this.store.change(input.id,{storage});});result=null;
      }else if(input.method==='secret.has'){requirePermission('secrets');const {key}=z.object({key:keySchema}).strict().parse(input.input);result=this.store.hasSecret(input.id,key);}
      else if(input.method==='secret.set'){
        requirePermission('secrets');const {key,value}=z.object({key:keySchema,value:z.string().min(1).max(10000).nullable()}).strict().parse(input.input);
        await this.serial(async()=>{this.active(input);await this.store.change(input.id,{}, {key,value});});result=null;
      }else if(input.method==='network.read'){
        requirePermission('network.read');result=await extensionNetworkRead(input.input,item.pkg.manifest.networkOrigins,AbortSignal.any([item.controller.signal,AbortSignal.timeout(15000)]),key=>{requirePermission('secrets');return this.store.secret(input.id,key);});
      }else if(['workbench.read','usage.read','codex.usage.read'].includes(input.method)){
        requirePermission(input.method as ExtensionPermission);result=await this.options.read(input.method as 'workbench.read'|'usage.read'|'codex.usage.read',z.object({force:z.boolean().optional()}).strict().parse(input.input || {}));
      }else throw new Error('无效扩展接口。');
      this.active(input);if(siteBound && scope!==this.options.scope())throw new Error('连接上下文已变更，请重新读取。');
      if(JSON.stringify(result ?? null).length>2*1024*1024)throw new Error('扩展返回数据超过大小限制。');return result;
    }finally{--item.pending;}
  }
  asset(rawUrl:string):{body:Buffer;type:string;csp:string}|undefined {
    let url:URL;try{url=new URL(rawUrl);}catch{return;}
    if(url.protocol!=='lumi-extension:' || url.search || url.username || url.password || url.port)return;
    const item=this.packages.get(url.hostname);if(this.closing || !item?.enabled)return;
    const segments=url.pathname.slice(1).split('/'),generation=segments.shift(),name=segments.join('/');
    if(generation!==String(item.generation) || !safeExtensionPath(name))return;
    const body=name==='lumi-sdk.js' ? this.options.sdk : item.pkg.files.get(name),type=name==='lumi-sdk.js' ? EXTENSION_MIME['.js'] : EXTENSION_MIME[path.extname(name)];if(!body || !type)return;
    const origin='lumi-extension://'+url.hostname;
    return {body,type,csp:`default-src 'none'; script-src ${origin}; style-src ${origin} 'unsafe-inline'; img-src ${origin} data:; font-src ${origin}; connect-src 'none'; frame-src 'none'; worker-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'`};
  }
  dispose(){this.closing=true;for(const item of this.packages.values())item.controller.abort();this.packages.clear();}
}
