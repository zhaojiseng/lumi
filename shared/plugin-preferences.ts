import type {PluginManifest,PluginViewId} from './contracts/plugins';
import {builtinManifests} from '../plugins/manifests';
import type {Preferences} from './types';
export function pluginEnabled(manifest:PluginManifest,preferences:Pick<Preferences,'pluginEnabled'|'widgetEnabled'>){
  return preferences.pluginEnabled[manifest.id] ?? (manifest.id==='surface.widget' ? preferences.widgetEnabled : manifest.defaultEnabled ?? true);
}
export function settingsGroups(manifests:readonly PluginManifest[]=builtinManifests){return manifests.filter(m=>m.configurable && m.settings).map(m=>({id:m.id,...m.settings!})).sort((a,b)=>a.order-b.order);}
export const pluginSettingsGroups=settingsGroups();
export function configurablePlugin(manifests:readonly PluginManifest[],id:string):PluginManifest{
  const manifest=manifests.find(item=>item.id===id);
  if(!manifest || !manifest.configurable)throw new Error('此内置插件不能切换启用状态。');
  return manifest;
}
export function normalizePluginEnabled(value:unknown):Record<string,boolean>{
  if(!value || typeof value!=='object' || Array.isArray(value))return {};
  const flags=value as Record<string,unknown>;
  return Object.fromEntries(builtinManifests.filter(m=>m.configurable && typeof flags[m.id]==='boolean').map(m=>[m.id,flags[m.id] as boolean]));
}
export function validatePluginView(id:string,view:string,manifests:readonly PluginManifest[]=builtinManifests):asserts view is PluginViewId{
  const group=settingsGroups(manifests).find(item=>item.id===id);
  if(!group || !group.views.some(item=>item.id===view))throw new Error('此插件没有该显示项。');
}
export function normalizePluginViews(value:unknown,legacy:unknown={},manifests:readonly PluginManifest[]=builtinManifests):Record<string,Partial<Record<PluginViewId,boolean>>>{
  const saved=value && typeof value==='object' && !Array.isArray(value) ? value as Record<string,unknown> : {};
  const flags=legacy && typeof legacy==='object' && !Array.isArray(legacy) ? legacy as Record<string,unknown> : {};
  const result:Record<string,Partial<Record<PluginViewId,boolean>>>={};
  const migration:Partial<Record<PluginViewId,string>>={workbench:'feature.workbench',usage:'feature.usage',models:'feature.models',tokens:'feature.tokens'};
  for(const group of settingsGroups(manifests)){
    const input=saved[group.id],fields=input && typeof input==='object' && !Array.isArray(input) ? input as Record<string,unknown> : {};
    for(const view of group.views){
      const old=group.id==='provider.newapi' ? flags[migration[view.id] || ''] : undefined;
      const enabled=typeof fields[view.id]==='boolean' ? fields[view.id] as boolean : typeof old==='boolean' ? old : undefined;
      if(enabled!==undefined)(result[group.id] ??={})[view.id]=enabled;
    }
  }
  return result;
}
export function pluginViewEnabled(status:{state:string;manifest?:PluginManifest;views?:Partial<Record<PluginViewId,boolean>>}|undefined,view:PluginViewId){return status?.state==='active' && (status.views?.[view] ?? status.manifest?.settings?.views.find(v=>v.id===view)?.defaultEnabled ?? true);}
