import type {PluginStatus,PluginViewId} from '../../shared/contracts/plugins';
import {validatePluginView} from '../../shared/plugin-preferences';
import type {ExtensionInventory} from '../../shared/contracts/extensions';
import type {ExtensionMarketInstall} from '../../shared/contracts/extension-market';

export interface PluginManagementBridge {
  extensionInventory?():Promise<ExtensionInventory>;
  reloadExtensions?():Promise<ExtensionInventory>;
  installExtension?(input:ExtensionMarketInstall):Promise<ExtensionInventory>;
  removeExtension?(id:string):Promise<ExtensionInventory>;
  listPlugins():Promise<PluginStatus[]>;
  setPluginEnabled(id:string,enabled:boolean):Promise<PluginStatus[]>;
  setPluginView(id:string,view:PluginViewId,enabled:boolean):Promise<PluginStatus[]>;
}
export interface PluginState {statuses:PluginStatus[];loading:boolean;busyId:string|null;error:string;extensions?:ExtensionInventory}
export class PluginResource {
  private version=0;
  private state:PluginState={statuses:[],loading:true,busyId:null,error:''};
  private listeners=new Set<()=>void>();
  constructor(private readonly bridge:PluginManagementBridge,private readonly registerExtensions?:(inventory:ExtensionInventory)=>void) {}
  getState=()=>this.state;
  subscribe=(listener:()=>void)=>{this.listeners.add(listener);return()=>{this.listeners.delete(listener);};};
  private publish(state:PluginState){this.state=state;this.listeners.forEach(listener=>listener());}
  load=async()=>{
    if(this.state.busyId)return;
    const version=++this.version;
    try{const extensions=await this.bridge.extensionInventory?.(),statuses=await this.bridge.listPlugins();if(version===this.version){if(extensions)this.registerExtensions?.(extensions);this.publish({...this.state,statuses,extensions,loading:false,error:''});}}
    catch(error:unknown){if(version===this.version)this.publish({...this.state,loading:false,error:error instanceof Error ? error.message : String(error)});}
  };
  reloadExtensions=async()=>{
    if(!this.bridge.reloadExtensions || this.state.busyId)return;
    const version=++this.version;this.publish({...this.state,busyId:'extensions:reload',error:''});
    try{const extensions=await this.bridge.reloadExtensions(),statuses=await this.bridge.listPlugins();if(version===this.version){this.registerExtensions?.(extensions);this.publish({...this.state,extensions,statuses,busyId:null});}}
    catch(error){if(version===this.version)this.publish({...this.state,busyId:null,error:error instanceof Error ? error.message : String(error)});throw error;}
  };
  private async changePackage(id:string,action:()=>Promise<ExtensionInventory>){
    if(this.state.busyId)throw new Error('插件状态正在更新，请稍后再试。');
    const version=++this.version;this.publish({...this.state,busyId:'extensions:'+id,error:''});
    try{const extensions=await action(),statuses=await this.bridge.listPlugins();if(version===this.version){this.registerExtensions?.(extensions);this.publish({...this.state,extensions,statuses,busyId:null});}}
    catch(error){if(version===this.version)this.publish({...this.state,busyId:null,error:error instanceof Error ? error.message : String(error)});throw error;}
  }
  installExtension=async(input:ExtensionMarketInstall)=>{if(!this.bridge.installExtension)throw new Error('宿主不支持插件市场安装。');await this.changePackage(input.id,()=>this.bridge.installExtension!(input));};
  removeExtension=async(id:string)=>{if(!this.bridge.removeExtension)throw new Error('宿主不支持插件卸载。');await this.changePackage(id,()=>this.bridge.removeExtension!(id));};
  setView=async(id:string,view:PluginViewId,enabled:boolean)=>{
    validatePluginView(id,view,this.state.statuses.map(status=>status.manifest));
    if(this.state.busyId)throw new Error('插件状态正在更新，请稍后再试。');
    const previous=this.state.statuses,version=++this.version;
    this.publish({...this.state,busyId:id+':'+view,error:'',statuses:previous.map(status=>status.manifest.id===id ? {...status,views:{...status.views,[view]:enabled}} : status)});
    try{const statuses=await this.bridge.setPluginView(id,view,enabled);if(version===this.version)this.publish({...this.state,statuses,busyId:null});}
    catch(error){let statuses=previous;try{statuses=await this.bridge.listPlugins();}catch{}if(version===this.version)this.publish({...this.state,statuses,busyId:null,error:error instanceof Error ? error.message : String(error)});throw error;}
  };
  setEnabled=async(id:string,enabled:boolean)=>{
    if(!this.state.statuses.some(status=>status.manifest.id===id && status.manifest.configurable))throw new Error('此内置插件不可配置。');
    if(this.state.busyId)throw new Error('插件状态正在更新，请稍后再试。');
    const previous=this.state.statuses,version=++this.version;
    this.publish({...this.state,busyId:id,error:'',statuses:previous.map(status=>status.manifest.id===id ? {...status,state:enabled ? 'activating' : 'deactivating',error:undefined} : status)});
    try{const statuses=await this.bridge.setPluginEnabled(id,enabled),extensions=await this.bridge.extensionInventory?.();if(version===this.version){if(extensions)this.registerExtensions?.(extensions);this.publish({...this.state,statuses,extensions:extensions || this.state.extensions,busyId:null});}}
    catch(error:unknown){
      let statuses=previous;
      try{statuses=await this.bridge.listPlugins();}catch{/* Failed write keeps the last known persisted state. */}
      if(version===this.version)this.publish({...this.state,statuses,busyId:null,error:error instanceof Error ? error.message : String(error)});
      throw error;
    }
  };
}
