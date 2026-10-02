import { useState, useEffect, useCallback, useRef, useMemo, Suspense, lazy, type ReactNode, Component } from 'react';
import { LayoutDashboard, BarChart3, Boxes, TerminalSquare, KeyRound, Settings, Search, Command, Bell, RefreshCw, ChevronRight, ChevronDown, Globe2, Plus, Minus, Square, X, ArrowUpRight, Sparkles, CircleHelp, CheckCircle2, AlertCircle, Info, LogOut } from 'lucide-react';
import { LoginModal, Welcome } from './components/Login';
import { UpdateNotice } from './components/UpdateNotice';
import {UpdateDialogProvider} from './components/UpdateDialog';
import {StartupScreen} from './components/StartupScreen';
import {RendererPageSwap} from './host/page-swap';
import { AppContext } from './context';
import { bridge } from './bridge';
import {activeRendererContributions,rendererNavigation,resolveRendererPage,independentRendererPage,workbenchContributions,usageContributions,contentContributions,toolConfigContributions,type NavigationItem} from './host/renderer-registry';
import {usePluginHost,PluginSettingsProvider} from './host/plugins';
import {useCatalogHost,CatalogProvider} from './host/catalog';
import {ToolConfigViewsProvider} from './host/tool-config';
import {ContentViewsProvider} from './host/content-views';
import {UsageProvider} from './host/usage';
import {SourcePreferencesProvider} from './host/source-preferences';
import {WorkbenchProvider} from './host/workbench';
import {useDefaultTheme} from '../plugins/theme.default/renderer';
import {applyPreferencePatch, selectionValue} from '../shared/selections';
import {resolveRange} from '../shared/range';
import {refreshSeconds} from '../shared/refresh';
import {catalogChangesStorageKey,getCatalogChanges,observeCatalogChanges,subscribeCatalogChanges} from '../shared/catalog-changes';
import { DEFAULT_PREFERENCES, type Bootstrap, type Dashboard, type RangeQuery, type StatisticsQuery, type Page, type Preferences, type PreferencePatch } from '../shared/types';
import { Logo, Modal, Button, Pill, Skeleton, Select } from './components/ui';
const SettingsPage = lazy(() => import('./pages/Settings'));
const legacyNav:readonly NavigationItem[] = [
  { id: 'settings', label: '设置', icon: Settings, hint: '让工作台更顺手',section:'settings' },
];
const initialBootstrap: Bootstrap = { preferences: structuredClone(DEFAULT_PREFERENCES), desktop: !!window.lumi, version: '0.4.35', configs: [], secureStorage: false };
class ErrorBoundary extends Component<{ children: ReactNode }, { error: string }> {
  state = { error: '' };
  static getDerivedStateFromError(error: Error) { return { error: error.message }; }
  render() { return this.state.error ? <div className="empty-state"><AlertCircle size={28}/><h3>页面遇到问题</h3><p>{this.state.error}</p><Button onClick={() => location.reload()}>重新加载</Button></div> : this.props.children; }
}
export default function App() {
  const [bootstrap, setBootstrap] = useState<Bootstrap>(initialBootstrap);
  const [preferences, setPreferences] = useState<Preferences>(initialBootstrap.preferences);
  const [dashboardSnapshot,setDashboardSnapshot]=useState<{accountKey:string;value:Dashboard}|null>(null);
  const [page, setPage] = useState<Page>('overview');
  const plugins=usePluginHost();
  const [refreshEpoch,setRefreshEpoch]=useState(0);
  const newApiStatus=plugins.statuses.find(s=>s.manifest.id==='provider.newapi'),newApiEnabled=newApiStatus?.state==='active';
  useEffect(()=>{const widget=plugins.statuses.find(s=>s.manifest.id==='surface.widget');if(widget?.state==='active' || widget?.state==='disabled')setPreferences(p=>p.widgetEnabled===(widget.state==='active') ? p : {...p,widgetEnabled:widget.state==='active'});},[plugins.statuses]);
  const contributions=activeRendererContributions(plugins.statuses);
  const nav=rendererNavigation(legacyNav,plugins.statuses);
  const visiblePage=resolveRendererPage(page,plugins.statuses);
  useEffect(()=>{if(!plugins.settings.loading && page!==visiblePage)setPage(visiblePage);},[page,visiblePage,plugins.settings.loading]);
  useEffect(()=>bridge.onNavigate(page=>{if(nav.some(item=>item.id===page))setPage(page);}),[plugins.statuses]);
  useEffect(()=>bridge.onWidgetVisibility?.(widgetEnabled=>setPreferences(p=>({...p,widgetEnabled}))),[]);
  const overviewQuery = selectionValue<RangeQuery>(preferences, 'statistics.range', selectionValue<RangeQuery>(preferences,'overview.range',7), q => {try {resolveRange(q);return true;}catch{return false;}});
  const days=resolveRange(overviewQuery).days;
  const chosenModels=selectionValue<string[]>(preferences,'statistics.models',[],v=>Array.isArray(v));
  const chosenTokens=selectionValue<string[]>(preferences,'statistics.tokens',[],v=>Array.isArray(v));
  const queryKey=JSON.stringify([overviewQuery,chosenModels,chosenTokens]);
  const dashboardQuery=useMemo<StatisticsQuery>(()=>({range:overviewQuery,models:chosenModels,tokenIds:chosenTokens.map(Number).filter(n=>Number.isSafeInteger(n) && n>0)}),[queryKey]);
  const activeSite=preferences.sites.find(s=>s.id===preferences.activeSiteId);
  const accountKey=JSON.stringify([preferences.activeSiteId,activeSite?.url,activeSite?.userId,activeSite?.username,activeSite?.accessTokenConfigured,activeSite?.sessionAuth]);
  const dataScope=JSON.stringify([accountKey,newApiStatus?.generation,newApiStatus?.state]);
  const dashboard=newApiEnabled && dashboardSnapshot?.accountKey===dataScope ? dashboardSnapshot.value : null;
  const configureScope=useRef(accountKey);configureScope.current=accountKey;
  const [loginOpen,setLoginOpen]=useState(false);
  useEffect(()=>{if(!newApiEnabled)setLoginOpen(false);},[newApiEnabled]);
  const [catalogNotice,setCatalogNotice]=useState({key:'',count:0});
  const [ready, setReady] = useState(false); const [loading, setLoading] = useState(true); const [error, setError] = useState('');
  const catalog=useCatalogHost({scope:ready && visiblePage==='models' && contentContributions('models',plugins.statuses).some(view=>view.id==='newapi.models') && activeSite ? {accountKey:dataScope,siteId:activeSite.id,siteUrl:activeSite.url} : null,refreshInterval:preferences.refreshInterval});
  const [notice, setNotice] = useState<{ text: string; kind: 'success' | 'error' | 'info'; id: number } | null>(null);
  const [searchOpen, setSearchOpen] = useState(false); const [query, setQuery] = useState(''); const [announcements, setAnnouncements] = useState(false);
  const contentRef = useRef<HTMLDivElement>(null);
  const requestVersion = useRef(0); const toastTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const bootstrapVersion = useRef(0);
  const preferenceQueue = useRef<Promise<unknown>>(Promise.resolve()); const preferenceVersion = useRef(0);
  const toast = useCallback((text: string, kind: 'success' | 'error' | 'info' = 'info') => { clearTimeout(toastTimer.current); setNotice({ text, kind, id: Date.now() }); toastTimer.current = setTimeout(() => setNotice(null), 6000); }, []);
  const navigatePage=useCallback((next:Page)=>{
    const available=resolveRendererPage(next,plugins.statuses);
    if(next!==available){toast('请先在设置中启用对应功能插件。','info');setPage('settings');}
    else setPage(next);
  },[plugins.statuses,toast]);
  const reloadBootstrap = useCallback(async () => {
    const request=++bootstrapVersion.current,b=await bridge.bootstrap();
    if(request!==bootstrapVersion.current)return;
    setBootstrap(previous=>({...b,configs:previous.configs}));setPreferences(b.preferences);
    void bridge.inspectConfigs().then(configs=>{if(request===bootstrapVersion.current)setBootstrap(previous=>({...previous,configs}));}).catch(()=>{});
  }, []);
  useEffect(() => { reloadBootstrap().then(() => setReady(true)).catch(e => { setError(e.message); setLoading(false); }); return () => { clearTimeout(toastTimer.current); }; }, [reloadBootstrap]);
  const refresh = useCallback(async (force=false) => {
    const request = ++requestVersion.current;if(!newApiEnabled){setDashboardSnapshot(null);setLoading(false);setError('');return;}setLoading(true);setError('');
    try { const d = await bridge.dashboard(dashboardQuery,force); if (request === requestVersion.current) setDashboardSnapshot({accountKey:dataScope,value:d}); }
    catch (e: any) { if (request === requestVersion.current) setError(e.message); }
    finally { if (request === requestVersion.current) setLoading(false); }
  }, [dashboardQuery, dataScope,newApiEnabled]);
  useEffect(()=>bridge.onRefresh(()=>{setRefreshEpoch(epoch=>epoch+1);void refresh(true);}),[refresh]);
  useEffect(()=>{setDashboardSnapshot(null);requestVersion.current++;},[accountKey]);
  useEffect(()=>{
    if(!activeSite)return;
    const scope={id:activeSite.id,url:activeSite.url},key=catalogChangesStorageKey(scope);
    const update=()=>setCatalogNotice({key,count:getCatalogChanges(scope).pendingCount});
    const unsubscribe=subscribeCatalogChanges(scope,update);update();return unsubscribe;
  },[preferences.activeSiteId,activeSite?.url]);
  useEffect(()=>{
    if(!activeSite || !dashboard?.user || loading || error)return;
    const scope={id:activeSite.id,url:activeSite.url};
    // Defer one turn so a site switch clears the previous site's dashboard first.
    const timer=setTimeout(()=>observeCatalogChanges(scope,dashboard.catalog,dashboard.status,{warnings:dashboard.warnings,detectedAt:dashboard.fetchedAt}),0);
    return()=>clearTimeout(timer);
  },[dashboard,accountKey,loading,error]);
  useEffect(() => { if (!ready) return; void refresh(); }, [ready, refresh]);
  useEffect(() => { const seconds=refreshSeconds(preferences.refreshInterval); if (!ready || !newApiEnabled || !seconds) return; let pending=false; const interval=setInterval(async () => { if (document.visibilityState !== 'visible' || pending) return; pending=true; try { await refresh(); } finally { pending=false; } },Math.max(15,seconds)*1000); return () => clearInterval(interval); },[ready,page,newApiEnabled,preferences.refreshInterval,refresh]);
  useDefaultTheme(preferences.theme);
  useEffect(() => { const handler = (e: KeyboardEvent) => { if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') { e.preventDefault(); setQuery(''); setSearchOpen(v => !v); } if ((e.ctrlKey || e.metaKey) && e.key === ',') { e.preventDefault(); setPage('settings'); } }; document.addEventListener('keydown', handler); return () => document.removeEventListener('keydown', handler); }, []);
  const updatePreferences = useCallback(async (patch: PreferencePatch) => {
    const version = ++preferenceVersion.current;
    setPreferences(current => applyPreferencePatch(current, patch));
    const write = preferenceQueue.current.catch(() => {}).then(() => bridge.updatePreferences(patch));
    preferenceQueue.current = write;
    try {const saved = await write; if (version === preferenceVersion.current) setPreferences(saved);}
    catch (e) {if (version === preferenceVersion.current) await reloadBootstrap();throw e;}
  }, [reloadBootstrap]);
  const setOverviewQuery = (query: RangeQuery) => {void updatePreferences({selection:{siteId:preferences.activeSiteId,values:{'statistics.range':query}}}).catch(e=>toast(e.message,'error'));};
  const setDays = (n: number) => setOverviewQuery(n);
  useEffect(() => { contentRef.current?.scrollTo({ top: 0 }); }, [page]);
  const configureModel = useCallback((model: string, tool: 'codex' | 'claude',group?: string) => {
    const siteId=preferences.activeSiteId,scope=accountKey;
    void (async()=>{
      await updatePreferences({selection:{siteId,values:{[tool+'.model']:model,...(group ? {[tool+'.group']:group} : {})}}});
      if(configureScope.current===scope)setPage('tools');
    })().catch(e=>toast(e.message,'error'));
  }, [preferences.activeSiteId,accountKey,plugins.statuses,plugins.settings.setEnabled,updatePreferences,toast]);
  const site = preferences.sites.find(s => s.id === preferences.activeSiteId) || preferences.sites[0];
  const activeNav = nav.find(n => n.id === visiblePage)!;
  const catalogPending=activeSite && catalogNotice.key===catalogChangesStorageKey(activeSite) ? catalogNotice.count : 0;
  const status = loading ? '正在同步' : error ? '连接异常' : !newApiEnabled ? 'NewAPI 已停用' : dashboard?.user ? '站点已连接' : '等待登录';
  const pages: Record<Page, ReactNode> = { overview:null,usage:null,models:null,tools:null,tokens:null,settings:<SettingsPage key={preferences.activeSiteId}/> };
  for(const contribution of contributions){const PluginPage=contribution.page.component;pages[contribution.page.id]=<PluginPage key={independentRendererPage(contribution.page.id) ? contribution.page.id : accountKey}/>;}
  const filteredActions = nav.filter(n => `${n.label} ${n.hint}`.toLowerCase().includes(query.toLowerCase()));
  const searchedModels = query ? dashboard?.catalog.models.filter(m => m.model_name.toLowerCase().includes(query.toLowerCase())).slice(0, 5) || [] : [];
  const mac=bootstrap.platform==='darwin',shortcut=mac ? '⌘' : 'Ctrl';
  if(!ready)return <StartupScreen error={error} retry={()=>{setError('');void reloadBootstrap().then(()=>setReady(true)).catch(e=>setError(e.message));}}/>;
  return <AppContext.Provider value={{ openLogin:() => {if(newApiEnabled)setLoginOpen(true);else{setPage('settings');toast('请先启用 NewAPI 插件。','info');}},bootstrap, preferences, dashboard, page:visiblePage, setPage:navigatePage, days, setDays, overviewQuery,setOverviewQuery, statisticsQuery:dashboardQuery, loading, error, refresh, updatePreferences, setPreferences, reloadBootstrap, toast, configureModel }}><PluginSettingsProvider value={plugins.settings}><CatalogProvider value={catalog}><WorkbenchProvider value={{cards:workbenchContributions(plugins.statuses),siteScope:accountKey,refreshInterval:preferences.refreshInterval,refreshEpoch}}><UsageProvider value={{views:usageContributions(plugins.statuses),siteScope:accountKey}}><SourcePreferencesProvider value={{selections:preferences.sourceSelections,desktop:bootstrap.desktop,update:updatePreferences,onError:message=>toast(message,'error')}}><ContentViewsProvider value={{models:contentContributions('models',plugins.statuses),tokens:contentContributions('tokens',plugins.statuses),siteScope:accountKey}}><ToolConfigViewsProvider value={toolConfigContributions(plugins.statuses)}><UpdateDialogProvider><div className={'desktop-shell platform-'+(bootstrap.platform || 'browser')}><header className="titlebar"><div className="breadcrumb"><span>我的空间</span><ChevronRight size={12}/><strong>{activeNav.label}</strong></div><div className="titlebar-actions"><button className="global-search" onClick={() => { setQuery(''); setSearchOpen(true); }}><Search size={15}/><span>搜索工作台</span><kbd>{shortcut} K</kbd></button><span className="header-divider"/><button className={`icon-button refresh-button ${loading ? 'spin' : ''}`} onClick={()=>{setRefreshEpoch(epoch=>epoch+1);void refresh(true);if(visiblePage==='models')void catalog.refresh(true);}} disabled={loading || (visiblePage==='models' && catalog.loading)} aria-label="刷新站点数据" title="刷新数据"><RefreshCw size={17}/></button><button className="icon-button notification-button" onClick={() => setAnnouncements(true)} aria-label="查看站点公告" title="站点公告"><Bell size={17}/>{dashboard?.status.announcements?.length ? <i/> : null}</button><button className="avatar" onClick={() => dashboard?.user ? setPage('settings') : setLoginOpen(true)} title="账户与设置" aria-label="账户设置">{(dashboard?.user?.display_name || dashboard?.user?.username || 'L').slice(0, 1).toUpperCase()}</button>{bootstrap.desktop && !mac && <div className="window-controls"><button aria-label="最小化" onClick={() => bridge.windowControl('minimize')}><Minus size={13}/></button><button aria-label="最大化或恢复" onClick={() => bridge.windowControl('maximize')}><Square size={11}/></button><button className="window-close" aria-label="关闭窗口" onClick={() => bridge.windowControl('close')}><X size={15}/></button></div>}</div></header>
    <aside className="sidebar surface"><div className="sidebar-navigation"><div className="brand-row"><Logo/><div><strong>Lumi<span>●</span></strong><p>你的 AI，尽在一处</p></div></div><div className="sidebar-divider"/><div className="sidebar-caption">WORKSPACE</div><nav aria-label="主导航">{nav.filter(n=>n.section==='workspace').map(n => <button key={n.id} className={`nav-item ${visiblePage === n.id ? 'active' : ''}`} onClick={() => setPage(n.id)}><n.icon size={18} strokeWidth={1.7}/><span>{n.label}</span>{visiblePage === n.id ? <span className="nav-active-dot"/> : n.id === 'models' && catalogPending ? <span className="nav-count" style={{background:'var(--orange-soft)',color:'var(--orange)'}} title={catalogPending+' 项模型目录变动未读'}>{catalogPending}</span> : n.id === 'models' && dashboard?.catalog.models.length ? <span className="nav-count">{dashboard.catalog.models.length}</span> : null}</button>)}</nav><div className="sidebar-caption tools-caption">DEVELOPER TOOLS</div><nav aria-label="工具导航">{nav.filter(n=>n.section==='tools').map(n => <button key={n.id} className={`nav-item ${visiblePage === n.id ? 'active' : ''}`} onClick={() => setPage(n.id)}><n.icon size={18} strokeWidth={1.7}/><span>{n.label}</span>{visiblePage === n.id && <span className="nav-active-dot"/>}</button>)}</nav></div><div className="sidebar-footer"><nav aria-label="设置导航">{nav.filter(n=>n.section==='settings').map(n=><button key={n.id} className={`nav-item settings-nav ${visiblePage===n.id ? 'active' : ''}`} onClick={()=>setPage(n.id)}><n.icon size={18} strokeWidth={1.7}/><span>{n.label}</span>{n.id==='settings' && <span className="nav-shortcut">{shortcut} ,</span>}</button>)}</nav><div className="sidebar-divider"/><UpdateNotice/><div className="sidebar-site"><div className="site-icon"><Globe2 size={19}/></div><div><Select label="切换当前站点" className="site-switch" value={preferences.activeSiteId} onChange={value => updatePreferences({ activeSiteId: value }).catch(e => toast(e.message, 'error'))}>{preferences.sites.map(s => <option key={s.id} value={s.id}>{s.name}</option>)}</Select></div></div><div className="sidebar-status"><span className={`tiny-dot ${error ? 'red' : !dashboard?.user ? 'amber' : ''}`}/>{status}<span>v{bootstrap.version}</span></div></div></aside>
    <main className="main-area">
      <div className="content-scroll" ref={contentRef}><div className="content-container">{error && <div className="warning-banner error-banner"><AlertCircle size={16}/><span>{error}</span><button onClick={()=>void refresh(true)}>重试</button></div>}{dashboard?.warnings.length ? <details className="sync-warnings"><summary><AlertCircle size={14}/>{dashboard.warnings.length} 项数据未能同步，点击查看</summary>{dashboard.warnings.map((w, i) => <p key={i}>{w}</p>)}</details> : null}
        <ErrorBoundary><RendererPageSwap identity={visiblePage} accountKey={accountKey} statuses={plugins.statuses}><Suspense fallback={<Skeleton/>}>{pages[visiblePage]}</Suspense></RendererPageSwap></ErrorBoundary>
      </div></div><footer className="app-statusbar"><span><span className={`tiny-dot ${error ? 'red' : !dashboard?.user ? 'amber' : ''}`}/>{site.name}<span className="statusbar-separator">/</span>{status}</span><span>{dashboard ? `上次同步 ${new Date(dashboard.fetchedAt).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })}` : '等待同步'}<span className="statusbar-separator">·</span>本机优先，安心创造</span></footer>
    </main>
    {loginOpen && <LoginModal key={preferences.activeSiteId} onClose={() => setLoginOpen(false)}/>}
    {notice && <div className={`toast ${notice.kind}`} role="status" key={notice.id}>{notice.kind === 'success' ? <CheckCircle2 size={19}/> : notice.kind === 'error' ? <AlertCircle size={19}/> : <Info size={19}/>}<span>{notice.text}</span><button onClick={() => setNotice(null)} aria-label="关闭通知"><X size={15}/></button></div>}
    {searchOpen && <Modal title="随时找到你需要的" subtitle="搜索页面、模型或开发工具" onClose={() => setSearchOpen(false)}><div className="search-input command-search"><Search size={18}/><input placeholder="搜索工作台…" aria-label="搜索工作台内容" autoFocus value={query} onChange={e => setQuery(e.target.value)}/><kbd>ESC</kbd></div><div className="command-results">{filteredActions.map(n => <button key={n.id} onClick={() => { setPage(n.id); setSearchOpen(false); }}><n.icon size={18}/><div><strong>{n.label}</strong><span>{n.hint}</span></div><ChevronRight size={15}/></button>)}{searchedModels.map(m => <button key={m.model_name} onClick={() => { if (m.supported_endpoint_types.some(p => p.includes('anthropic'))) configureModel(m.model_name, 'claude'); else configureModel(m.model_name, 'codex'); setSearchOpen(false); }}><Boxes size={18}/><div><strong>{m.model_name}</strong><span>{m.vendor} · 模型配置</span></div><ArrowUpRight size={15}/></button>)}{!filteredActions.length && !searchedModels.length && <p className="empty-search">没有找到结果，试试“模型”或“Codex”。</p>}</div></Modal>}
    {announcements && <Modal title="站点公告" subtitle={site.name} onClose={() => setAnnouncements(false)}><div className="announcement-list">{dashboard?.status.announcements?.length ? dashboard.status.announcements.map((a, i) => <article key={i}><div><Pill tone="green">站点消息</Pill><span>{new Date(a.publishDate).toLocaleDateString()}</span></div><p>{a.content}</p></article>) : <div className="empty-state"><Bell size={25}/><h3>暂无公告</h3><p>站点发布的新消息会显示在这里。</p></div>}</div></Modal>}
  </div></UpdateDialogProvider></ToolConfigViewsProvider></ContentViewsProvider></SourcePreferencesProvider></UsageProvider></WorkbenchProvider></CatalogProvider></PluginSettingsProvider></AppContext.Provider>;
}
