import { useState, useEffect, useCallback, useRef, useMemo, Suspense, lazy, type ReactNode, Component } from 'react';
import {Settings,AlertCircle} from 'lucide-react';
import {UpdateDialogProvider} from './components/UpdateDialog';
import {StartupScreen} from './components/StartupScreen';
import {RendererPageSwap} from './host/page-swap';
import { AppContext,type AppState } from './context';
import { bridge } from './bridge';
import {allRendererContributions,activeRendererContributions,rendererNavigation,resolveRendererPage,independentRendererPage,workbenchContributions,usageContributions,contentContributions,toolConfigContributions,type NavigationItem} from './host/renderer-registry';
import {usePluginHost,PluginSettingsProvider} from './host/plugins';
import {useCatalogHost,CatalogProvider} from './host/catalog';
import {useDashboardHost} from './host/dashboard';
import {ToolConfigViewsProvider} from './host/tool-config';
import {ContentViewsProvider} from './host/content-views';
import {UsageProvider} from './host/usage';
import {SourcePreferencesProvider} from './host/source-preferences';
import {WorkbenchProvider} from './host/workbench';
import {InterfaceHost} from './host/interface';
import {applyPreferencePatch, selectionValue} from '../shared/selections';
import {resolveRange} from '../shared/range';
import {refreshSeconds} from '../shared/refresh';
import {catalogChangesStorageKey,getCatalogChanges,observeCatalogChanges,subscribeCatalogChanges} from '../shared/catalog-changes';
import { DEFAULT_PREFERENCES, type Bootstrap, type RangeQuery, type StatisticsQuery, type Page, type Preferences, type PreferencePatch } from '../shared/types';
import { Button, Skeleton } from './components/ui';
const SettingsPage = lazy(() => import('./pages/Settings'));
const legacyNav:readonly NavigationItem[] = [
  { id: 'settings', label: '设置', icon: Settings, hint: '让工作台更顺手',section:'settings' },
];
const initialBootstrap: Bootstrap = { preferences: structuredClone(DEFAULT_PREFERENCES), desktop: !!window.lumi, version: '0.5.9', configs: [], secureStorage: false };
class ErrorBoundary extends Component<{ children: ReactNode }, { error: string }> {
  state = { error: '' };
  static getDerivedStateFromError(error: Error) { return { error: error.message }; }
  render() { return this.state.error ? <div className="empty-state"><AlertCircle size={28}/><h3>页面遇到问题</h3><p>{this.state.error}</p><Button onClick={() => location.reload()}>重新加载</Button></div> : this.props.children; }
}
export default function App() {
  const [bootstrap, setBootstrap] = useState<Bootstrap>(initialBootstrap);
  const [preferences, setPreferences] = useState<Preferences>(initialBootstrap.preferences);
  const [page, setPage] = useState<Page>('overview');
  const plugins=usePluginHost();
  const [refreshEpoch,setRefreshEpoch]=useState(0);
  const newApiStatus=plugins.statuses.find(s=>s.manifest.id==='provider.newapi'),newApiEnabled=newApiStatus?.state==='active';
  useEffect(()=>{const widget=plugins.statuses.find(s=>s.manifest.id==='surface.widget');if(widget?.state==='active' || widget?.state==='disabled')setPreferences(p=>p.widgetEnabled===(widget.state==='active') ? p : {...p,widgetEnabled:widget.state==='active'});},[plugins.statuses]);
  const registry=useMemo(()=>allRendererContributions(),[plugins.statuses,plugins.settings.extensions]);
  const contributions=useMemo(()=>activeRendererContributions(plugins.statuses,registry),[plugins.statuses,registry]);
  const nav=useMemo(()=>rendererNavigation(legacyNav,plugins.statuses,registry),[plugins.statuses,registry]);
  const visiblePage=useMemo(()=>resolveRendererPage(page,plugins.statuses,registry),[page,plugins.statuses,registry]);
  useEffect(()=>{if(!plugins.settings.loading && page!==visiblePage)setPage(visiblePage);},[page,visiblePage,plugins.settings.loading]);
  useEffect(()=>bridge.onNavigate(page=>{if(nav.some(item=>item.id===page))setPage(page);}),[nav]);
  useEffect(()=>bridge.onWidgetVisibility?.(widgetEnabled=>setPreferences(p=>({...p,widgetEnabled}))),[]);
  const overviewQuery = selectionValue<RangeQuery>(preferences, 'statistics.range', selectionValue<RangeQuery>(preferences,'overview.range',7), q => {try {resolveRange(q);return true;}catch{return false;}});
  const days=resolveRange(overviewQuery).days;
  const chosenModels=selectionValue<string[]>(preferences,'statistics.models',[],v=>Array.isArray(v));
  const chosenTokens=selectionValue<string[]>(preferences,'statistics.tokens',[],v=>Array.isArray(v));
  const queryKey=JSON.stringify([overviewQuery,chosenModels,chosenTokens]);
  const dashboardQuery=useMemo<StatisticsQuery>(()=>({range:overviewQuery,models:chosenModels,tokenIds:chosenTokens.map(Number).filter(n=>Number.isSafeInteger(n) && n>0)}),[queryKey]);
  const activeSite=preferences.sites.find(s=>s.id===preferences.activeSiteId);
  const accountKey=JSON.stringify([preferences.activeSiteId,activeSite?.url,activeSite?.userId,activeSite?.username,!!activeSite?.accessTokenConfigured,!!activeSite?.sessionAuth]);
  const dataScope=JSON.stringify([accountKey,newApiStatus?.generation,newApiStatus?.state]);
  const [ready, setReady] = useState(false),[bootstrapError,setBootstrapError]=useState('');
  const {dashboard,loading:dashboardLoading,error:dashboardError,refresh}=useDashboardHost(ready && newApiEnabled ? {accountKey:dataScope,query:dashboardQuery} : null);
  const loading=!ready && !bootstrapError || dashboardLoading,error=bootstrapError || dashboardError;
  const configureScope=useRef(accountKey);configureScope.current=accountKey;
  const configurePlugins=useRef(plugins.statuses);configurePlugins.current=plugins.statuses;
  const [loginOpen,setLoginOpen]=useState(false);
  useEffect(()=>{if(!newApiEnabled)setLoginOpen(false);},[newApiEnabled]);
  const [catalogNotice,setCatalogNotice]=useState({key:'',count:0});
  const modelViews=useMemo(()=>contentContributions('models',plugins.statuses,registry),[plugins.statuses,registry]);
  const catalog=useCatalogHost({scope:ready && visiblePage==='models' && modelViews.some(view=>view.id==='newapi.models') && activeSite ? {accountKey:dataScope,siteId:activeSite.id,siteUrl:activeSite.url} : null,refreshInterval:preferences.refreshInterval});
  const [notice, setNotice] = useState<{ text: string; kind: 'success' | 'error' | 'info'; id: number } | null>(null);
  const [searchOpen, setSearchOpen] = useState(false); const [query, setQuery] = useState(''); const [announcements, setAnnouncements] = useState(false);
  const contentRef = useRef<HTMLDivElement>(null);
  const toastTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const bootstrapVersion = useRef(0);
  const preferenceQueue = useRef<Promise<unknown>>(Promise.resolve()); const preferenceVersion = useRef(0);
  const appearanceVersion=useRef(0),[appearancePending,setAppearancePending]=useState(false);
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
  useEffect(() => { reloadBootstrap().then(() => setReady(true)).catch(e => setBootstrapError(e.message)); return () => { clearTimeout(toastTimer.current); }; }, [reloadBootstrap]);
  useEffect(()=>bridge.onRefresh(()=>{setRefreshEpoch(epoch=>epoch+1);void refresh(true);}),[refresh]);
  useEffect(()=>{
    if(!activeSite)return;
    const scope={id:activeSite.id,url:activeSite.url},key=catalogChangesStorageKey(scope);
    const update=()=>{const count=getCatalogChanges(scope).pendingCount;setCatalogNotice(previous=>previous.key===key && previous.count===count ? previous : {key,count});};
    const unsubscribe=subscribeCatalogChanges(scope,update);update();return unsubscribe;
  },[preferences.activeSiteId,activeSite?.url]);
  useEffect(()=>{
    if(!activeSite || !dashboard?.user || loading || error)return;
    const scope={id:activeSite.id,url:activeSite.url};
    // Defer one turn so a site switch clears the previous site's dashboard first.
    const timer=setTimeout(()=>observeCatalogChanges(scope,dashboard.catalog,dashboard.status,{warnings:dashboard.warnings,detectedAt:dashboard.fetchedAt}),0);
    return()=>clearTimeout(timer);
  },[dashboard,accountKey,loading,error]);
  useEffect(() => { const seconds=refreshSeconds(preferences.refreshInterval); if (!ready || !newApiEnabled || !seconds) return; const interval=setInterval(() => { if (document.visibilityState === 'visible')void refresh(); },seconds*1000); return () => clearInterval(interval); },[ready,newApiEnabled,preferences.refreshInterval,refresh]);
  useEffect(() => { const handler = (e: KeyboardEvent) => { if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') { e.preventDefault(); setQuery(''); setSearchOpen(v => !v); } if ((e.ctrlKey || e.metaKey) && e.key === ',') { e.preventDefault(); setPage('settings'); } }; document.addEventListener('keydown', handler); return () => document.removeEventListener('keydown', handler); }, []);
  const updatePreferences = useCallback(async (patch: PreferencePatch) => {
    const version = ++preferenceVersion.current;
    const appearance=patch.theme!==undefined || patch.interfaceSelection!==undefined ? ++appearanceVersion.current : 0;
    if(appearance)setAppearancePending(true);
    setPreferences(current => applyPreferencePatch(current, patch));
    const write = preferenceQueue.current.catch(() => {}).then(() => bridge.updatePreferences(patch));
    preferenceQueue.current = write;
    try {const saved = await write; if (version === preferenceVersion.current) setPreferences(saved);}
    catch (e) {if (version === preferenceVersion.current) await reloadBootstrap();throw e;}
    finally {if(appearance && appearance===appearanceVersion.current)setAppearancePending(false);}
  }, [reloadBootstrap]);
  const setOverviewQuery = useCallback((query: RangeQuery) => {void updatePreferences({selection:{siteId:preferences.activeSiteId,values:{'statistics.range':query}}}).catch(e=>toast(e.message,'error'));},[preferences.activeSiteId,updatePreferences,toast]);
  const setDays = useCallback((n: number) => setOverviewQuery(n),[setOverviewQuery]);
  const openLogin=useCallback(()=>{if(newApiEnabled)setLoginOpen(true);else{setPage('settings');toast('请先启用 NewAPI 插件。','info');}},[newApiEnabled,toast]);
  useEffect(() => { contentRef.current?.scrollTo({ top: 0 }); }, [page]);
  const configureModel = useCallback((model: string, tool: 'codex' | 'claude',group?: string) => {
    const adapterId='adapter.tool.'+tool,adapter=configurePlugins.current.find(status=>status.manifest.id===adapterId);
    if(adapter?.state!=='active'){
      setPage('settings');toast('请先在设置的“工具配置”分组中启用 '+(tool==='codex' ? 'Codex' : 'Claude Code')+'。','info');return;
    }
    const siteId=preferences.activeSiteId,scope=accountKey;
    void (async()=>{
      await updatePreferences({selection:{siteId,values:{[tool+'.model']:model,...(group ? {[tool+'.group']:group} : {})}}});
      const current=configurePlugins.current.find(status=>status.manifest.id===adapterId);
      if(configureScope.current===scope && current?.state==='active' && current.generation===adapter.generation)setPage('tools');
    })().catch(e=>toast(e.message,'error'));
  }, [preferences.activeSiteId,accountKey,updatePreferences,toast]);
  const catalogPending=activeSite && catalogNotice.key===catalogChangesStorageKey(activeSite) ? catalogNotice.count : 0;
  const status = loading ? '正在同步' : error ? '连接异常' : !newApiEnabled ? 'NewAPI 已停用' : dashboard?.user ? '站点已连接' : '等待登录';
  const pages=useMemo(()=>{
    const result:Record<Page,ReactNode>={overview:null,usage:null,models:null,tools:null,tokens:null,settings:<SettingsPage key={preferences.activeSiteId}/>};
    for(const contribution of contributions){const PluginPage=contribution.page.component;result[contribution.page.id]=<PluginPage key={independentRendererPage(contribution.page.id) ? contribution.page.id : accountKey}/>;}
    return result;
  },[contributions,preferences.activeSiteId,accountKey]);
  const content=useMemo(()=><ErrorBoundary><RendererPageSwap identity={visiblePage} accountKey={accountKey} statuses={plugins.statuses}><Suspense fallback={<Skeleton/>}>{pages[visiblePage]}</Suspense></RendererPageSwap></ErrorBoundary>,[visiblePage,accountKey,plugins.statuses,pages]);
  const appState=useMemo<AppState>(()=>({openLogin,bootstrap,preferences,dashboard,page:visiblePage,setPage:navigatePage,days,setDays,overviewQuery,setOverviewQuery,statisticsQuery:dashboardQuery,loading,error,refresh,updatePreferences,setPreferences,reloadBootstrap,toast,configureModel}),[openLogin,bootstrap,preferences,dashboard,visiblePage,navigatePage,days,setDays,overviewQuery,setOverviewQuery,dashboardQuery,loading,error,refresh,updatePreferences,reloadBootstrap,toast,configureModel]);
  const workbench=useMemo(()=>({cards:workbenchContributions(plugins.statuses,registry),siteScope:accountKey,refreshInterval:preferences.refreshInterval,refreshEpoch}),[plugins.statuses,registry,accountKey,preferences.refreshInterval,refreshEpoch]);
  const usage=useMemo(()=>({views:usageContributions(plugins.statuses,registry),siteScope:accountKey}),[plugins.statuses,registry,accountKey]);
  const sourceError=useCallback((message:string)=>toast(message,'error'),[toast]);
  const sources=useMemo(()=>({selections:preferences.sourceSelections,desktop:bootstrap.desktop,update:updatePreferences,onError:sourceError}),[preferences.sourceSelections,bootstrap.desktop,updatePreferences,sourceError]);
  const contents=useMemo(()=>({models:modelViews,tokens:contentContributions('tokens',plugins.statuses,registry),siteScope:accountKey}),[modelViews,plugins.statuses,registry,accountKey]);
  const toolConfigs=useMemo(()=>toolConfigContributions(plugins.statuses,registry),[plugins.statuses,registry]);
  const filteredActions = useMemo(()=>nav.filter(n => `${n.label} ${n.hint}`.toLowerCase().includes(query.toLowerCase())),[nav,query]);
  const searchedModels = useMemo(()=>query ? dashboard?.catalog.models.filter(m => m.model_name.toLowerCase().includes(query.toLowerCase())).slice(0, 5) || [] : [],[query,dashboard?.catalog.models]);
  if(!ready)return <StartupScreen error={error} retry={()=>{setBootstrapError('');void reloadBootstrap().then(()=>setReady(true)).catch(e=>setBootstrapError(e.message));}}/>;
  return <AppContext.Provider value={appState}><PluginSettingsProvider value={plugins.settings}><CatalogProvider value={catalog}><WorkbenchProvider value={workbench}><UsageProvider value={usage}><SourcePreferencesProvider value={sources}><ContentViewsProvider value={contents}><ToolConfigViewsProvider value={toolConfigs}><UpdateDialogProvider><InterfaceHost bootstrap={bootstrap} preferences={preferences} appearancePending={appearancePending} dashboard={dashboard} nav={nav} visiblePage={visiblePage} catalogPending={catalogPending} status={status} loading={loading} error={error} refreshDisabled={loading || (visiblePage==='models' && catalog.loading)} loginOpen={loginOpen} notice={notice} searchOpen={searchOpen} query={query} announcements={announcements} searchedModels={searchedModels} filteredActions={filteredActions} contentRef={contentRef} setPage={navigatePage} refresh={()=>{setRefreshEpoch(epoch=>epoch+1);void refresh(true);if(visiblePage==='models')void catalog.refresh(true);}} retry={()=>void refresh(true)} setQuery={setQuery} setSearchOpen={setSearchOpen} setAnnouncements={setAnnouncements} setLoginOpen={setLoginOpen} clearNotice={()=>setNotice(null)} selectSite={id=>void updatePreferences({activeSiteId:id}).catch(e=>toast(e.message,'error'))} configureModel={configureModel} windowControl={bridge.windowControl}>{content}</InterfaceHost></UpdateDialogProvider></ToolConfigViewsProvider></ContentViewsProvider></SourcePreferencesProvider></UsageProvider></WorkbenchProvider></CatalogProvider></PluginSettingsProvider></AppContext.Provider>;
}
