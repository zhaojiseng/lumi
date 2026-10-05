import {PopupPresence} from '../components/PopupPresence';
import {Suspense,createContext,useContext,useEffect,useId,useMemo,useRef,useState,useSyncExternalStore,type ReactNode} from 'react';
import {Modal} from '../components/ui';
import {AppContext} from '../context';
import {bridge} from '../bridge';
import type {PluginStatus,PluginViewId} from '../../shared/contracts/plugins';
import {PluginResource} from './plugin-resource';
import {settingsGroups} from '../../shared/plugin-preferences';
import {allRendererContributions} from './renderer-registry';
import {registerExternalRenderers} from './extensions-registry';
import type {ExtensionInventory} from '../../shared/contracts/extensions';
import type {ExtensionMarketInstall} from '../../shared/contracts/extension-market';
import {ChevronDown,ChevronRight,Settings2,Store,TerminalSquare,Blocks} from 'lucide-react';
import {ExtensionMarketplace} from './extension-market';

export interface PluginSettingsItem {id:string;title:string;description:string;group?:'tools';status:PluginStatus;views:readonly {id:PluginViewId;title:string;description?:string}[]}
export interface PluginSettingsValue {items:PluginSettingsItem[];statuses?:readonly PluginStatus[];extensions?:ExtensionInventory;reloadExtensions?():Promise<void>;installExtension?(input:ExtensionMarketInstall):Promise<void>;removeExtension?(id:string):Promise<void>;loading:boolean;busyId:string|null;error:string;setEnabled(id:string,enabled:boolean):Promise<void>;setView(id:string,view:PluginViewId,enabled:boolean):Promise<void>}
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
    extensions:state.extensions,reloadExtensions:resource.reloadExtensions,installExtension:resource.installExtension,removeExtension:resource.removeExtension,
    items:settingsGroups(state.statuses.map(status=>status.manifest)).flatMap(group=>{const status=state.statuses.find(s=>s.manifest.id===group.id);return status ? [{...group,status}] : [];}),
    loading:state.loading,busyId:state.busyId,error:state.error,setEnabled:resource.setEnabled,setView:resource.setView,
  }),[state,resource]);
  return {statuses:state.statuses,settings};
}
export function PluginSettingsProvider({value,children}:{value:PluginSettingsValue;children:ReactNode}){return <PluginSettingsContext.Provider value={value}>{children}</PluginSettingsContext.Provider>;}
function PluginEnableControl({item}:{item:PluginSettingsItem}){
  const {busyId,setEnabled}=usePluginSettings();
  const enabled=item.status.state==='active' || item.status.state==='activating';
  const pending=item.status.state==='activating' || item.status.state==='deactivating',locked=!!busyId || pending;
  const label=pending ? '正在更新' : item.status.state==='failed' ? '启用失败' : enabled ? '已启用' : '已停用';
  return <div className="plugin-switch-control"><span className={'plugin-switch-status '+item.status.state} role="status">{label}</span><button type="button" role="switch" className={'switch'+(enabled ? ' on' : '')} aria-label={'启用'+item.title} aria-checked={enabled} aria-disabled={locked} aria-busy={pending} onClick={()=>{if(!locked)void setEnabled(item.id,!enabled).catch(()=>{});}}><span aria-hidden="true"/></button></div>;
}
function PluginSettingsNode({item,onOpen}:{item:PluginSettingsItem;onOpen(id:string,trigger:HTMLButtonElement):void}){
  return <li className="plugin-settings-group" data-plugin={item.id}>
    <div className="plugin-group-heading">
      <button type="button" className="plugin-row-button" aria-label={item.title+' 插件说明'} onClick={event=>onOpen(item.id,event.currentTarget)}><span><strong>{item.title}</strong><span className="plugin-node-description">{item.description}</span></span><ChevronRight size={15} aria-hidden="true"/></button>
      <PluginEnableControl item={item}/>
      <button type="button" className="icon-button plugin-settings-button" aria-label={item.title+' 插件设置'} title="插件说明与设置" onClick={event=>onOpen(item.id,event.currentTarget)}><Settings2 size={17}/></button>
    </div>
    {item.status.error && <p className="plugin-node-error warning-banner error-banner" role="alert">{item.status.error}</p>}
  </li>;
}
const capabilityLabels:Record<string,string>={'catalog.read':'模型目录','account.session':'账户连接','online.usage':'在线用量','tokens.manage':'令牌管理','toolCredential.provision':'工具配钥','desktopUsage.read':'桌面用量','subscriptionUsage.read':'订阅限额','toolConfig.build':'CLI 配置适配','widget.project':'浮窗数据','tray.project':'托盘数据','surface.control':'桌面面板'};
const permissionLabels:Record<string,string>={'workbench.read':'工作台数据','usage.read':'用量数据','codex.usage.read':'Codex 限额','storage':'插件存储','network.read':'网络读取','secrets':'加密凭据'};
function PluginSettingsDetails({item,active,onClose,returnFocus}:{item:PluginSettingsItem;active:boolean;onClose():void;returnFocus:HTMLButtonElement|null}){
  const {extensions,busyId,setView}=usePluginSettings(),enabled=item.status.state==='active' || item.status.state==='activating',running=item.status.state==='active';
  const [visited,setVisited]=useState(active);useEffect(()=>{if(active)setVisited(true);},[active]);
  const pending=item.status.state==='activating' || item.status.state==='deactivating',locked=!!busyId || pending;
  const settings=allRendererContributions().find(entry=>entry.manifest.id===item.id)?.settings,Settings=settings?.component,sections=settings?.sections || [];
  const extension=extensions?.plugins.find(plugin=>plugin.manifest.id===item.id);
  const capabilities=item.status.manifest.provides.map(id=>capabilityLabels[id] || id);
  if(!active && !visited)return null;
  return <Modal className="plugin-details-modal" title={item.title+' 插件设置'} subtitle={(item.status.origin==='external' ? '额外插件' : item.group==='tools' ? '工具配置插件' : '内置插件')+' · v'+item.status.manifest.version} open={active} returnFocus={returnFocus} portal onClose={onClose}><div className="plugin-details-page" data-plugin-details={item.id}>
    <div className="plugin-details-heading"><span>启用状态</span><PluginEnableControl item={item}/></div>
    {item.status.error && <p className="warning-banner error-banner" role="alert">{item.status.error}</p>}
    <section className="plugin-details-section"><h3>插件介绍</h3><p>{item.description}</p>{item.group==='tools' && <p className="muted">在侧栏“工具配置”中选择模型和渠道，预览后应用。停用保留已应用配置与备份。</p>}</section>
    {(Settings || sections.length>0) && <section className="plugin-details-section plugin-own-settings"><h3>插件自身设置</h3>{running && (active || visited) ? <div key={item.status.generation}>{Settings && <Settings/>}{sections.map(section=>{
      const shown=!section.view || (item.status.views?.[section.view] ?? item.status.manifest.settings?.views.find(view=>view.id===section.view)?.defaultEnabled ?? true);if(!shown)return null;
      const Component=section.component;
      return <div className="plugin-own-setting-section" key={section.id} data-plugin-setting-section={section.id}><h4>{section.title}</h4>{section.description && <p className="muted">{section.description}</p>}<Suspense fallback={<p role="status" className="muted">正在读取设置…</p>}><Component/></Suspense></div>;
    })}</div> : !running ? <p className="muted">启用插件后可调整设置。</p> : null}</section>}
    {item.views.length>0 && <section className="plugin-details-section"><h3>显示内容</h3><div className="plugin-view-settings" aria-label={item.title+' 显示内容'}>{item.views.map(view=>{
      const checked=item.status.views?.[view.id] ?? item.status.manifest.settings?.views.find(v=>v.id===view.id)?.defaultEnabled ?? true,disabled=locked || !enabled;
      return <div className="setting-control plugin-view-control" key={view.id}><div><strong>{view.title}</strong>{view.description && <p>{view.description}</p>}</div><button type="button" role="switch" className={'switch'+(checked ? ' on' : '')} aria-label={'显示'+item.title+' '+view.title} aria-checked={checked} aria-disabled={disabled} aria-busy={busyId===item.id+':'+view.id} onClick={()=>{if(!disabled)void setView(item.id,view.id,!checked).catch(()=>{});}}><span aria-hidden="true"/></button></div>;
    })}</div></section>}
    {(extension || capabilities.length>0) && <section className="plugin-details-section"><h3>{extension ? '声明权限' : '可用能力'}</h3><div className="plugin-permission-list">{(extension ? extension.manifest.permissions.map(id=>permissionLabels[id] || id) : capabilities).map(label=><span key={label}>{label}</span>)}</div>{extension && !extension.manifest.permissions.length && <p className="muted">未声明额外权限。</p>}{extension?.manifest.networkOrigins.length ? <p className="extension-permissions">允许网络来源：{extension.manifest.networkOrigins.join('、')}</p> : null}</section>}
    {extension && <dl className="plugin-details-metadata"><div><dt>作者</dt><dd>{extension.manifest.author || '未提供'}</dd></div><div><dt>许可证</dt><dd>{extension.manifest.license || '未提供'}</dd></div></dl>}
    {!Settings && !sections.length && !item.views.length && <p className="plugin-node-note muted">此插件没有额外设置项。</p>}
  </div></Modal>;
}
function PluginSettingsBranch({title,items,tools=false,onOpen}:{title:string;items:PluginSettingsItem[];tools?:boolean;onOpen(id:string,trigger:HTMLButtonElement):void}){
  const [expanded,setExpanded]=useState(true),bodyId=useId(),active=items.filter(item=>item.status.state==='active' || item.status.state==='activating').length;
  if(!items.length)return null;
  const Icon=tools ? TerminalSquare : Blocks;
  return <div className="plugin-settings-branch" data-plugin-group={tools ? 'tools' : title}>
    <h3 className="plugin-branch-heading"><button type="button" className="plugin-branch-toggle" aria-expanded={expanded} aria-controls={bodyId} onClick={()=>setExpanded(value=>!value)}><ChevronDown size={17} aria-hidden="true"/><Icon size={17} aria-hidden="true"/><strong>{title}</strong><span>{active} / {items.length} 已启用</span></button></h3>
    <ul className="plugin-settings-tree" id={bodyId} hidden={!expanded}>{items.map(item=><PluginSettingsNode key={item.id} item={item} onOpen={onOpen}/>)}</ul>
    {!expanded && items.filter(item=>item.status.error).map(item=><p className="warning-banner error-banner" key={item.id} role="alert">{item.title}：{item.status.error}</p>)}
  </div>;
}
export function PluginSettingsSection(){
  const {items,extensions,reloadExtensions,loading,busyId,error}=usePluginSettings();
  const app=useContext(AppContext),site=app?.preferences.sites.find(value=>value.id===app.preferences.activeSiteId);
  const scope=JSON.stringify([app?.page,app?.preferences.activeSiteId,site?.url,site?.userId,site?.username,!!site?.accessTokenConfigured,!!site?.sessionAuth]);
  const [marketOpen,setMarketOpen]=useState(false),[selection,setSelection]=useState<{id:string;scope:string}|null>(null);
  const returnFocus=useRef<HTMLButtonElement|null>(null);
  const builtin=items.filter(item=>item.status.origin!=='external'),external=items.filter(item=>item.status.origin==='external' && !extensions?.plugins.some(plugin=>plugin.manifest.id===item.id && plugin.manifest.kind==='interface'));
  const visibleItems=[...builtin,...external],selected=selection?.scope===scope ? visibleItems.find(item=>item.id===selection.id) : undefined;
  function open(id:string,trigger:HTMLButtonElement){returnFocus.current=trigger;setSelection({id,scope});}
  useEffect(()=>{if(selection && !selected)setSelection(null);},[selection,selected]);
  return <section className="surface panel plugin-settings" aria-label="插件设置">
    {loading && <p role="status">正在读取插件状态…</p>}{error && <p className="warning-banner error-banner" role="alert">{error}</p>}
    <div className="plugin-settings-overview"><div className="section-heading"><div><h2>插件</h2><p>展开分组管理启用状态，点击插件或设置按钮打开说明与设置。</p></div><button className="button" onClick={()=>setMarketOpen(true)}><Store size={16}/>插件市场</button></div>
      <PluginSettingsBranch title="内置插件" items={builtin.filter(item=>item.group!=='tools')} onOpen={open}/>
      <PluginSettingsBranch title="工具配置" items={builtin.filter(item=>item.group==='tools')} tools onOpen={open}/>
      <PluginSettingsBranch title="额外插件" items={external} onOpen={open}/>
      {extensions && <div className="extension-manager"><div className="setting-control"><div><strong>额外插件目录</strong><p>将独立插件文件夹放入此目录，然后重新扫描。新插件及内容变更后的插件需手动启用。</p></div><div><button className="button" disabled={!extensions.directory || !!busyId} onClick={()=>void bridge.openExtensionsDirectory().catch(()=>{})}>打开目录</button><button className="button" disabled={!extensions.directory || !!busyId} onClick={()=>void reloadExtensions?.().catch(()=>{})}>重新扫描</button></div></div>{!extensions.plugins.length && <p className="muted">暂无额外插件。</p>}{extensions.diagnostics.map(d=><p key={d.package} role="alert" className="warning-banner">{d.package}：{d.error}</p>)}</div>}
    </div>
    {visibleItems.map(item=><PluginSettingsDetails key={scope+':'+item.id} item={item} active={item.id===selected?.id} returnFocus={returnFocus.current} onClose={()=>setSelection(null)}/>)}
    <PopupPresence>{marketOpen && <ExtensionMarketplace onClose={()=>setMarketOpen(false)}/>}</PopupPresence>
  </section>;
}
