import {createContext,useContext,useEffect,useMemo,useState,useSyncExternalStore,type ReactNode} from 'react';
import {bridge} from '../bridge';
import type {PluginStatus,PluginViewId} from '../../shared/contracts/plugins';
import {PluginResource} from './plugin-resource';
import {settingsGroups} from '../../shared/plugin-preferences';
import {rendererRegistry} from './renderer-registry';
import {registerExternalRenderers} from './extensions-registry';
import type {ExtensionInventory} from '../../shared/contracts/extensions';

export interface PluginSettingsItem {id:string;title:string;description:string;status:PluginStatus;views:readonly {id:PluginViewId;title:string}[]}
export interface PluginSettingsValue {items:PluginSettingsItem[];statuses?:readonly PluginStatus[];extensions?:ExtensionInventory;reloadExtensions?():Promise<void>;loading:boolean;busyId:string|null;error:string;setEnabled(id:string,enabled:boolean):Promise<void>;setView(id:string,view:PluginViewId,enabled:boolean):Promise<void>}
const PluginSettingsContext=createContext<PluginSettingsValue|null>(null);
export function usePluginSettings(){const value=useContext(PluginSettingsContext);if(!value)throw new Error('插件设置宿主未提供。');return value;}
export function usePluginStatus(id:string){return useContext(PluginSettingsContext)?.items.find(item=>item.id===id)?.status;}
export function usePluginStatuses(){const value=useContext(PluginSettingsContext);return value?.statuses || value?.items.map(item=>item.status) || [];}
export function usePluginHost(){
  const [resource]=useState(()=>new PluginResource(bridge,inventory=>registerExternalRenderers(inventory.plugins)));
  const state=useSyncExternalStore(resource.subscribe,resource.getState);
  useEffect(()=>{void resource.load();return bridge.onWidgetVisibility?.(()=>{void resource.load();});},[resource]);
  const settings=useMemo<PluginSettingsValue>(()=>({
    statuses:state.statuses,
    extensions:state.extensions,reloadExtensions:resource.reloadExtensions,
    items:settingsGroups(state.statuses.map(status=>status.manifest)).flatMap(group=>{const status=state.statuses.find(s=>s.manifest.id===group.id);return status ? [{...group,status}] : [];}),
    loading:state.loading,busyId:state.busyId,error:state.error,setEnabled:resource.setEnabled,setView:resource.setView,
  }),[state,resource]);
  return {statuses:state.statuses,settings};
}
export function PluginSettingsProvider({value,children}:{value:PluginSettingsValue;children:ReactNode}){return <PluginSettingsContext.Provider value={value}>{children}</PluginSettingsContext.Provider>;}
export function PluginSettingsSection(){
  const {items,extensions,reloadExtensions,loading,busyId,error,setEnabled,setView}=usePluginSettings();
  return <section className="surface panel plugin-settings" aria-label="内置插件设置"><div className="section-heading"><div><h2>插件</h2><p>按接入和桌面功能管理插件，子项控制显示内容。</p></div></div>
    {loading && <p role="status">正在读取插件状态…</p>}{error && <p className="warning-banner error-banner" role="alert">{error}</p>}
    <h3 className="plugin-kind-heading">内置插件</h3>
    {[...items.filter(item=>item.status.origin!=='external'),...items.filter(item=>item.status.origin==='external')].map((item,index,array)=>{
      const enabled=item.status.state==='active' || item.status.state==='activating';
      const pending=item.status.state==='activating' || item.status.state==='deactivating',locked=!!busyId || pending;
      const label=pending ? '正在更新' : item.status.state==='failed' ? '启用失败' : enabled ? '已启用' : '已停用';
      return <div key={item.id}>{item.status.origin==='external' && (index===0 || array[index-1].status.origin!=='external') && <h3 className="plugin-kind-heading">额外插件</h3>}<div className="plugin-settings-group" data-plugin={item.id}>
        <div className="setting-control plugin-group-heading"><div><strong>{item.title}</strong><p>{item.description}</p>{item.status.error && <p role="alert">{item.status.error}</p>}</div><div className="plugin-switch-control"><span className="plugin-switch-status" role="status">{label}</span><button type="button" role="switch" className={'switch'+(enabled ? ' on' : '')} aria-label={'启用'+item.title} aria-checked={enabled} aria-disabled={locked} aria-busy={pending} onClick={()=>{if(!locked)void setEnabled(item.id,!enabled).catch(()=>{});}}><span aria-hidden="true"/></button></div></div>
        {item.views.length>0 && <div className="plugin-view-settings" aria-label={item.title+' 显示内容'}>{item.views.map(view=>{
          const checked=item.status.views?.[view.id] ?? item.status.manifest.settings?.views.find(v=>v.id===view.id)?.defaultEnabled ?? true,disabled=locked || !enabled;
          return <div className="setting-control plugin-view-control" key={view.id}><strong>{view.title}</strong><button type="button" role="switch" className={'switch'+(checked ? ' on' : '')} aria-label={'显示'+item.title+' '+view.title} aria-checked={checked} aria-disabled={disabled} aria-busy={busyId===item.id+':'+view.id} onClick={()=>{if(!disabled)void setView(item.id,view.id,!checked).catch(()=>{});}}><span aria-hidden="true"/></button></div>;
        })}</div>}
        {enabled && (()=>{const Settings=rendererRegistry.find(entry=>entry.manifest.id===item.id)?.settings.component;return Settings ? <Settings/> : null;})()}
        {item.status.origin==='external' && <p className="muted extension-permissions">声明权限：{extensions?.plugins.find(p=>p.manifest.id===item.id)?.manifest.permissions.join('、') || '无'}{extensions?.plugins.find(p=>p.manifest.id===item.id)?.manifest.networkOrigins.length ? ' · 网络来源：'+extensions.plugins.find(p=>p.manifest.id===item.id)!.manifest.networkOrigins.join('、') : ''}</p>}
      </div></div>;
    })}
    {extensions && <div className="extension-manager"><div className="setting-control"><div><strong>额外插件目录</strong><p>将独立插件文件夹放入此目录，然后重新扫描。新插件及内容变更后的插件需手动启用。</p></div><div><button className="button" disabled={!extensions.directory || !!busyId} onClick={()=>void bridge.openExtensionsDirectory().catch(()=>{})}>打开目录</button><button className="button" disabled={!extensions.directory || !!busyId} onClick={()=>void reloadExtensions?.().catch(()=>{})}>重新扫描</button></div></div>{!extensions.plugins.length && <p className="muted">暂无额外插件。</p>}{extensions.diagnostics.map(d=><p key={d.package} role="alert" className="warning-banner">{d.package}：{d.error}</p>)}</div>}
  </section>;
}
