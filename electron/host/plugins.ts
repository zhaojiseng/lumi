import {createPluginHost} from '../../shared/plugin-host';
import {configurablePlugin,validatePluginView,pluginEnabled} from '../../shared/plugin-preferences';
import type {CatalogReadCapability,CatalogReadRequest} from '../../shared/contracts/catalog';
import type {PluginStatus,PluginViewId,BuiltinCapabilityMap,PluginCapabilityId} from '../../shared/contracts/plugins';
import {newApiPlugin} from '../../plugins/provider.newapi/main';
import {builtinManifests} from '../../plugins/manifests';
import {localSessionsPlugin} from '../../plugins/source.local-sessions/main';
import {codexAdapterPlugin} from '../../plugins/adapter.tool.codex/main';
import {claudeAdapterPlugin} from '../../plugins/adapter.tool.claude/main';
import {createWidgetPlugin} from '../../plugins/surface.widget/main';
import {createTrayPlugin} from '../../plugins/surface.tray/main';
import {workbenchPlugin} from '../../plugins/feature.workbench/main';
import {usagePlugin} from '../../plugins/feature.usage/main';
import {codexProviderPlugin} from '../../plugins/provider.codex/main';
import {codexBridgePlugin} from '../../plugins/provider.codex-bridge/main';
import type {SettingsStore} from '../services/store';
import type {Command} from '../services/tool-runtime';
import type {DesktopSurfaceEnvironment} from '../../shared/contracts/desktop-surface';

/** Product and tool plugins can be toggled independently; system surfaces stay host-owned. */
export async function createBuiltinPlugins(store:SettingsStore,options:{catalog?:CatalogReadCapability;localHome?:string;resolveCodex?:()=>Promise<Command|undefined>;resolveCodexAppServer?:()=>Promise<Command|undefined>;chooseDirectory?:()=>Promise<string|null>;beforeDisable?:(id:string)=>void;desktop?:DesktopSurfaceEnvironment}={}){
  let dataEpoch=0;
  const desktop=options.desktop ? {...options.desktop,identity:()=>JSON.stringify([options.desktop!.identity(),dataEpoch])} : undefined;
  const implemented=['provider.newapi','provider.codex','provider.codex-bridge','source.local-sessions','adapter.tool.codex','adapter.tool.claude','surface.widget','surface.tray','feature.workbench','feature.usage'];
  const host=createPluginHost({plugins:[newApiPlugin(store,options.catalog),localSessionsPlugin(options.localHome),codexAdapterPlugin,claudeAdapterPlugin,createWidgetPlugin(desktop),createTrayPlugin(desktop),workbenchPlugin(()=>store.preferences),usagePlugin(()=>store.preferences),codexProviderPlugin(options.resolveCodex || (async()=>undefined)),codexBridgePlugin({resolve:options.resolveCodexAppServer || (async()=>undefined),chooseDirectory:options.chooseDirectory}),...builtinManifests.filter(m=>!implemented.includes(m.id)).map(manifest=>({manifest,activate(){}}))]});
  for(const manifest of builtinManifests.filter(m=>!m.configurable))await host.enable(manifest.id);
  for(const manifest of builtinManifests.filter(m=>m.configurable))if(pluginEnabled(manifest,store.preferences)){
    try{await host.enable(manifest.id);}catch{/* A failed product plugin must not abort the settings shell. */}
  }
  const generations=new Map<string,number>(),operations=new Map<string,number>(),transitioning=new Set<string>(),activeOperations=new Set<Promise<unknown>>();
  let closing=false,disposeResult:Promise<void>|undefined,pending:Promise<unknown>=Promise.resolve();
  const notifySurfaces=async()=>{const results=await Promise.allSettled(host.listProviders('surface.control').map(id=>host.requireCapability(id,'surface.control').changed()));if(results.some(r=>r.status==='rejected'))options.desktop?.log('桌面插件','显示状态暂未能更新。');};
  const refreshSurfaces=async(force=false)=>{await Promise.allSettled(host.listProviders('surface.control').map(id=>host.requireCapability(id,'surface.control').refresh(force)));};
  const generation=(id:string)=>generations.get(id) ?? 0;
  const list=():PluginStatus[]=>host.getStatuses().map(status=>({...status,views:{...store.preferences.pluginViews[status.manifest.id]},generation:generation(status.manifest.id)}));
  const enqueue=(operation:()=>Promise<PluginStatus[]>)=>{if(closing)return Promise.reject(new Error('插件宿主正在退出。'));const result=pending.catch(()=>{}).then(operation);pending=result;return result;};
  const setEnabled=(id:string,enabled:boolean)=>enqueue(async()=>{
    configurablePlugin(builtinManifests,id);const previous=host.isEnabled(id);
    if(!enabled && operations.get(id))throw new Error('插件正在执行操作，请完成后再停用。');
    if(!enabled && previous)options.beforeDisable?.(id);
    transitioning.add(id);
    ++dataEpoch;
    if(previous!==enabled)generations.set(id,generation(id)+1);
    try{if(enabled)await host.enable(id);else await host.disable(id);await store.setPluginEnabled(id,enabled);}
    catch(error){if(host.isEnabled(id)!==previous){generations.set(id,generation(id)+1);if(previous)await host.enable(id);else await host.disable(id);}throw error;}
    finally{transitioning.delete(id);}
    await notifySurfaces();
    return list();
  });
  const setView=(id:string,view:PluginViewId,enabled:boolean)=>enqueue(async()=>{
    validatePluginView(id,view);const key=id+':'+view;
    if(!enabled && operations.get(key))throw new Error('此显示项正在执行操作，请完成后再关闭。');
    generations.set(key,generation(key)+1);await store.setPluginView(id,view,enabled);return list();
  });
  const requireCapability=<Id extends PluginCapabilityId>(sourceId:string,id:Id):BuiltinCapabilityMap[Id]=>{
    if(closing)throw new Error('插件宿主正在退出。');
    if(transitioning.has(sourceId) || !host.isEnabled(sourceId))throw new Error('此插件未启用，请在设置中启用。');
    return host.requireCapability(sourceId,id);
  };
  const runFeature=<T>(id:string,operation:()=>Promise<T>):Promise<T>=>{
    if(closing)return Promise.reject(new Error('插件宿主正在退出。'));
    if(transitioning.has(id))return Promise.reject(new Error('插件状态正在更新，请稍后再试。'));
    if(!host.isEnabled(id))return Promise.reject(new Error('此插件未启用，请在设置中启用。'));
    const version=generation(id);operations.set(id,(operations.get(id) ?? 0)+1);
    const task=(async()=>{try{const result=await operation();if(closing || !host.isEnabled(id) || version!==generation(id))throw new Error('插件已停用，请重新执行。');return result;}finally{operations.set(id,(operations.get(id) ?? 1)-1);}})();
    activeOperations.add(task);void task.then(()=>activeOperations.delete(task),()=>activeOperations.delete(task));return task;
  };
  return {
    list,setEnabled,setView,generation,isEnabled:(id:string)=>!closing && host.isEnabled(id),require:requireCapability,runFeature,notifySurfaces,refreshSurfaces,
    /** Stable main-process facade reacquires a capability after disable/re-enable. */
    port<Id extends PluginCapabilityId>(sourceId:string,id:Id):BuiltinCapabilityMap[Id]{
      return new Proxy({} as BuiltinCapabilityMap[Id],{get(_target,method){return (...args:unknown[])=>{const capability=requireCapability(sourceId,id),fn=Reflect.get(capability,method);if(typeof fn!=='function')throw new Error('无效能力操作。');return Reflect.apply(fn,capability,args);};}});
    },
    runView<T>(id:string,view:PluginViewId,operation:()=>Promise<T>):Promise<T>{
      validatePluginView(id,view);if(store.preferences.pluginViews[id]?.[view]===false)return Promise.reject(new Error('此显示项未启用。'));
      const key=id+':'+view,version=generation(key);operations.set(key,(operations.get(key) ?? 0)+1);
      return runFeature(id,async()=>{const result=await operation();if(version!==generation(key))throw new Error('显示项已关闭，请重新执行。');return result;}).finally(()=>{operations.set(key,(operations.get(key) ?? 1)-1);});
    },
    readCatalog(input:CatalogReadRequest){
      if(store.preferences.pluginViews['provider.newapi']?.models===false)throw new Error('模型广场显示项未启用。');
      const version=generation('provider.newapi:models'),request=requireCapability('provider.newapi','catalog.read').read(input);
      return request.then(value=>{if(version!==generation('provider.newapi:models'))throw new Error('模型广场已关闭，请重新读取。');return value;});
    },
    dispose(){if(!disposeResult){closing=true;disposeResult=pending.catch(()=>{}).then(async()=>{await Promise.allSettled([...activeOperations]);await host.dispose();});}return disposeResult;},
  };
}
