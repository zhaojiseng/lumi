import type {ComponentType,LazyExoticComponent} from 'react';
import type {LucideIcon} from 'lucide-react';
import type {Page,PluginPageId} from '../../shared/types';
import type {PluginManifest,PluginStatus} from '../../shared/contracts/plugins';
import {pluginViewEnabled} from '../../shared/plugin-preferences';
import {widgetRenderer} from '../../plugins/surface.widget/renderer';
import {trayRenderer} from '../../plugins/surface.tray/renderer';
import {modelsRenderer} from '../../plugins/feature.models/renderer';
import {workbenchRenderer} from '../../plugins/feature.workbench/renderer';
import {usageRenderer} from '../../plugins/feature.usage/renderer';
import {toolConfigRenderer} from '../../plugins/feature.tool-config/renderer';
import {newApiRenderer} from '../../plugins/provider.newapi/renderer';
import {codexProviderRenderer} from '../../plugins/provider.codex/renderer';
import type {WorkbenchCard} from './workbench';
import type {UsageView} from './usage';
import {localSessionsRenderer} from '../../plugins/source.local-sessions/renderer';
import {tokensRenderer} from '../../plugins/feature.tokens/renderer';
import type {ContentView} from './content-views';
import type {ToolConfigView} from './tool-config';
import {externalRendererContributions} from './extensions-registry';
import {codexAdapterRenderer} from '../../plugins/adapter.tool.codex/renderer';
import {claudeAdapterRenderer} from '../../plugins/adapter.tool.claude/renderer';

export interface NavigationItem {id:Page;label:string;hint:string;icon:LucideIcon;section:'workspace'|'tools'|'settings'}
export interface RendererPage {id:Page;component:LazyExoticComponent<ComponentType>;scope?:'site'|'independent'}
export interface SidebarContribution {page:RendererPage & {id:PluginPageId};navigation:NavigationItem;view?:string}
export interface SettingsTabContribution {id:string;label:string;order:number;view?:string;component:LazyExoticComponent<ComponentType>}
export interface ConnectionContribution {id:string;label:string;order:number;view?:string;component:LazyExoticComponent<ComponentType>}
export interface RendererContribution {
  manifest:PluginManifest;
  page?:RendererPage;
  navigation?:NavigationItem;
  sidebar?:readonly SidebarContribution[];
  workbench?:readonly WorkbenchCard[];
  usage?:readonly UsageView[];
  models?:readonly ContentView[];
  tokens?:readonly ContentView[];
  toolConfigs?:readonly ToolConfigView[];
  connections?:readonly ConnectionContribution[];
  settingsTabs?:readonly SettingsTabContribution[];
  settings:{title:string;description:string;component?:ComponentType};
}
/** Built-ins are static imports: the renderer never executes externally supplied plugin code. */
export const rendererRegistry:readonly RendererContribution[]=[workbenchRenderer,usageRenderer,modelsRenderer,toolConfigRenderer,tokensRenderer,newApiRenderer,codexProviderRenderer,localSessionsRenderer,codexAdapterRenderer,claudeAdapterRenderer,widgetRenderer,trayRenderer];
export const allRendererContributions=():readonly RendererContribution[]=>[...rendererRegistry,...externalRendererContributions()];
export const isRendererActive=(id:string,statuses:readonly PluginStatus[])=>statuses.some(status=>status.manifest.id===id && status.state==='active');
type PageContribution=RendererContribution & {page:NonNullable<RendererContribution['page']>;navigation:NavigationItem;view?:string};
function registeredPages(registry:readonly RendererContribution[]):PageContribution[]{return registry.flatMap(item=>[
  ...(item.page && item.navigation ? [{...item,page:item.page,navigation:item.navigation}] : []),
  ...(item.sidebar || []).map(entry=>({...item,page:entry.page,navigation:entry.navigation,view:entry.view})),
]);}
export function validateRendererRegistry(registry:readonly RendererContribution[]){
  const ids=new Set<string>();
  const settingsIds=new Set<string>(),connectionIds=new Set<string>();
  for(const item of registry){
    if(!!item.page!==!!item.navigation)throw new Error('页面与导航必须一起注册：'+item.manifest.id);
    for(const [entries,seen] of [[item.settingsTabs || [],settingsIds],[item.connections || [],connectionIds]] as const)for(const entry of entries){
      if(!entry.id.startsWith(`plugin:${item.manifest.id}:`) || !entry.label.trim() || !Number.isFinite(entry.order))throw new Error('无效插件设置/连接贡献：'+entry.id);
      if(seen.has(entry.id))throw new Error('重复插件设置/连接贡献：'+entry.id);seen.add(entry.id);
      if(entry.view && !item.manifest.settings?.views.some(view=>view.id===entry.view))throw new Error('设置/连接开关必须在插件设置中声明：'+entry.view);
    }
    for(const entry of item.sidebar || [])if(!entry.page.id.startsWith(`plugin:${item.manifest.id}:`))throw new Error('额外侧栏页面必须使用插件命名空间：'+entry.page.id);
    for(const entry of item.sidebar || [])if(entry.view && !item.manifest.settings?.views.some(view=>view.id===entry.view))throw new Error('侧栏开关必须在插件设置中声明：'+entry.view);
    for(const entry of [...item.workbench || [],...item.usage || [],...item.models || [],...item.tokens || [],...item.toolConfigs || []])if(entry.view && !item.manifest.settings?.views.some(view=>view.id===entry.view))throw new Error('内容开关必须在插件设置中声明：'+entry.view);
  }
  for(const item of registeredPages(registry)){
    if(item.page.id!==item.navigation.id || item.page.id==='settings')throw new Error('无效插件导航：'+item.page.id);
    if(ids.has(item.page.id))throw new Error('重复插件页面：'+item.page.id);
    ids.add(item.page.id);
  }
}
validateRendererRegistry(rendererRegistry);
export function activeRendererContributions(statuses:readonly PluginStatus[],registry:readonly RendererContribution[]=allRendererContributions()){return registeredPages(registry).filter(item=>isRendererActive(item.manifest.id,statuses) && (!item.view || pluginViewEnabled(statuses.find(s=>s.manifest.id===item.manifest.id),item.view)) && pageHasContent(item.page.id,statuses,registry));}
export function workbenchContributions(statuses:readonly PluginStatus[],registry=allRendererContributions()){return registry.flatMap(item=>(item.workbench || []).filter(view=>pluginViewEnabled(statuses.find(s=>s.manifest.id===item.manifest.id),view.view || 'workbench'))).sort((a,b)=>a.order-b.order);}
export function usageContributions(statuses:readonly PluginStatus[],registry=allRendererContributions()){return registry.flatMap(item=>(item.usage || []).filter(view=>pluginViewEnabled(statuses.find(s=>s.manifest.id===item.manifest.id),view.view || 'usage'))).sort((a,b)=>a.order-b.order);}
export function contentContributions(kind:'models'|'tokens',statuses:readonly PluginStatus[],registry=allRendererContributions()){return registry.flatMap(item=>(item[kind] || []).filter(view=>pluginViewEnabled(statuses.find(s=>s.manifest.id===item.manifest.id),view.view || kind))).sort((a,b)=>a.order-b.order);}
export function toolConfigContributions(statuses:readonly PluginStatus[],registry=allRendererContributions()){return registry.flatMap(item=>(item.toolConfigs || []).filter(view=>pluginViewEnabled(statuses.find(s=>s.manifest.id===item.manifest.id),view.view || 'tools')));}
export function connectionContributions(statuses:readonly PluginStatus[],registry=allRendererContributions()){return registry.flatMap(item=>(item.connections || []).filter(view=>pluginViewEnabled(statuses.find(s=>s.manifest.id===item.manifest.id),view.view || 'connections'))).sort((a,b)=>a.order-b.order);}
export function settingsTabContributions(statuses:readonly PluginStatus[],registry=allRendererContributions()){return registry.flatMap(item=>(item.settingsTabs || []).filter(view=>pluginViewEnabled(statuses.find(s=>s.manifest.id===item.manifest.id),view.view || 'settings'))).sort((a,b)=>a.order-b.order);}
export function rendererNavigation(legacy:readonly NavigationItem[],statuses:readonly PluginStatus[],registry:readonly RendererContribution[]=allRendererContributions()):NavigationItem[] {
  const contributed=activeRendererContributions(statuses,registry).map(item=>item.navigation);
  return (['workspace','tools','settings'] as const).flatMap(section=>[...legacy.filter(item=>item.section===section),...contributed.filter(item=>item.section===section)]);
}
export function configurableRendererContributions(statuses:readonly PluginStatus[]){
  return rendererRegistry.filter(item=>item.manifest.configurable && statuses.some(status=>status.manifest.id===item.manifest.id && status.manifest.configurable));
}
export function isRendererPageAvailable(page:string,statuses:readonly PluginStatus[],registry:readonly RendererContribution[]=allRendererContributions()):boolean {
  if(page==='settings')return true;
  const contribution=registeredPages(registry).find(item=>item.page.id===page);
  return !!contribution && isRendererActive(contribution.manifest.id,statuses) && (!contribution.view || pluginViewEnabled(statuses.find(s=>s.manifest.id===contribution.manifest.id),contribution.view)) && pageHasContent(page,statuses,registry);
}
function pageHasContent(page:string,statuses:readonly PluginStatus[],registry:readonly RendererContribution[]){
  if(page==='overview')return workbenchContributions(statuses,registry).length>0;
  if(page==='usage')return usageContributions(statuses,registry).length>0;
  if(page==='models' || page==='tokens')return contentContributions(page,statuses,registry).length>0;
  return true;
}
export function independentRendererPage(page:string){return ['overview','usage','models','tokens'].includes(page) || registeredPages(allRendererContributions()).some(item=>item.page.id===page && item.page.scope==='independent');}
export function resolveRendererPage(page:Page,statuses:readonly PluginStatus[],registry:readonly RendererContribution[]=allRendererContributions()):Page {
  return isRendererPageAvailable(page,statuses,registry) ? page : isRendererPageAvailable('overview',statuses,registry) ? 'overview' : 'settings';
}
