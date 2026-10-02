import { useState, useEffect, useCallback, useRef, useMemo, Suspense, lazy, type ReactNode, Component } from 'react';
import { LayoutDashboard, BarChart3, Boxes, TerminalSquare, KeyRound, Settings, Search, Command, Bell, RefreshCw, ChevronRight, ChevronDown, Globe2, Plus, Minus, Square, X, ArrowUpRight, Sparkles, CircleHelp, CheckCircle2, AlertCircle, Info, LogOut } from 'lucide-react';
import { LoginModal, Welcome } from './components/Login';
import { UpdateNotice } from './components/UpdateNotice';
import {UpdateDialogProvider} from './components/UpdateDialog';
import {StartupScreen} from './components/StartupScreen';
import {MotionSwap} from './components/MotionSwap';
import { AppContext } from './context';
import { bridge } from './bridge';
import {applyPreferencePatch, selectionValue} from '../shared/selections';
import {resolveRange} from '../shared/range';
import {refreshSeconds} from '../shared/refresh';
import {catalogChangesStorageKey,getCatalogChanges,observeCatalogChanges,subscribeCatalogChanges} from '../shared/catalog-changes';
import { DEFAULT_PREFERENCES, type Bootstrap, type Dashboard, type RangeQuery, type StatisticsQuery, type Page, type Preferences, type PreferencePatch } from '../shared/types';
import { Logo, Modal, Button, Pill, Skeleton, Select } from './components/ui';
const loadOverview = () => import('./pages/Overview');
const Overview = lazy(loadOverview);
const Usage = lazy(() => import('./pages/Usage'));
const Models = lazy(() => import('./pages/Models'));
const Tools = lazy(() => import('./pages/Tools'));
const Tokens = lazy(() => import('./pages/Tokens'));
const SettingsPage = lazy(() => import('./pages/Settings'));
const nav = [
  { id: 'overview', label: '工作台', icon: LayoutDashboard, hint: '你的 AI 总览' },
  { id: 'usage', label: '用量分析', icon: BarChart3, hint: '消费趋势与明细' },
  { id: 'models', label: '模型广场', icon: Boxes, hint: '发现更多可能' },
  { id: 'tools', label: '工具配置', icon: TerminalSquare, hint: 'Codex / Claude Code' },
  { id: 'tokens', label: 'API 令牌', icon: KeyRound, hint: '管理访问与额度' },
  { id: 'settings', label: '设置', icon: Settings, hint: '让工作台更顺手' },
] as const;
const initialBootstrap: Bootstrap = { preferences: structuredClone(DEFAULT_PREFERENCES), desktop: !!window.lumi, version: '0.4.31', configs: [], secureStorage: false };
class ErrorBoundary extends Component<{ children: ReactNode }, { error: string }> {
  state = { error: '' };
  static getDerivedStateFromError(error: Error) { return { error: error.message }; }
  render() { return this.state.error ? <div className="empty-state"><AlertCircle size={28}/><h3>页面遇到问题</h3><p>{this.state.error}</p><Button onClick={() => location.reload()}>重新加载</Button></div> : this.props.children; }
}
export default function App() {
  const [bootstrap, setBootstrap] = useState<Bootstrap>(initialBootstrap);
  const [preferences, setPreferences] = useState<Preferences>(initialBootstrap.preferences);
  const [dashboard, setDashboard] = useState<Dashboard | null>(null);
  const [page, setPage] = useState<Page>('overview');
  useEffect(()=>bridge.onNavigate(page=>{if(nav.some(item=>item.id===page))setPage(page);}),[]);
  useEffect(()=>bridge.onWidgetVisibility?.(widgetEnabled=>setPreferences(p=>({...p,widgetEnabled}))),[]);
  const overviewQuery = selectionValue<RangeQuery>(preferences, 'statistics.range', selectionValue<RangeQuery>(preferences,'overview.range',7), q => {try {resolveRange(q);return true;}catch{return false;}});
  const days=resolveRange(overviewQuery).days;
  const chosenModels=selectionValue<string[]>(preferences,'statistics.models',[],v=>Array.isArray(v));
  const chosenTokens=selectionValue<string[]>(preferences,'statistics.tokens',[],v=>Array.isArray(v));
  const queryKey=JSON.stringify([overviewQuery,chosenModels,chosenTokens]);
  const dashboardQuery=useMemo<StatisticsQuery>(()=>({range:overviewQuery,models:chosenModels,tokenIds:chosenTokens.map(Number).filter(n=>Number.isSafeInteger(n) && n>0)}),[queryKey]);
  const activeSite=preferences.sites.find(s=>s.id===preferences.activeSiteId);
  const accountKey=JSON.stringify([preferences.activeSiteId,activeSite?.url,activeSite?.userId,activeSite?.username,activeSite?.accessTokenConfigured,activeSite?.sessionAuth]);
  const [loginOpen,setLoginOpen]=useState(false);
  const [catalogNotice,setCatalogNotice]=useState({key:'',count:0});
  const [ready, setReady] = useState(false); const [loading, setLoading] = useState(true); const [error, setError] = useState('');
  const [notice, setNotice] = useState<{ text: string; kind: 'success' | 'error' | 'info'; id: number } | null>(null);
  const [searchOpen, setSearchOpen] = useState(false); const [query, setQuery] = useState(''); const [announcements, setAnnouncements] = useState(false);
  const contentRef = useRef<HTMLDivElement>(null);
  const requestVersion = useRef(0); const toastTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const bootstrapVersion = useRef(0);
  const preferenceQueue = useRef<Promise<unknown>>(Promise.resolve()); const preferenceVersion = useRef(0);
  const toast = useCallback((text: string, kind: 'success' | 'error' | 'info' = 'info') => { clearTimeout(toastTimer.current); setNotice({ text, kind, id: Date.now() }); toastTimer.current = setTimeout(() => setNotice(null), 6000); }, []);
  const reloadBootstrap = useCallback(async () => {
    const request=++bootstrapVersion.current,b=await bridge.bootstrap();
    if(request!==bootstrapVersion.current)return;
    setBootstrap(previous=>({...b,configs:previous.configs}));setPreferences(b.preferences);
    void bridge.inspectConfigs().then(configs=>{if(request===bootstrapVersion.current)setBootstrap(previous=>({...previous,configs}));}).catch(()=>{});
  }, []);
  useEffect(() => { void loadOverview().catch(()=>{});reloadBootstrap().then(() => setReady(true)).catch(e => { setError(e.message); setLoading(false); }); return () => { clearTimeout(toastTimer.current); }; }, [reloadBootstrap]);
  const refresh = useCallback(async (force=false) => {
    const request = ++requestVersion.current; setLoading(true); setError('');
    try { const d = await bridge.dashboard(dashboardQuery,force); if (request === requestVersion.current) setDashboard(d); }
    catch (e: any) { if (request === requestVersion.current) setError(e.message); }
    finally { if (request === requestVersion.current) setLoading(false); }
  }, [dashboardQuery, accountKey]);
  useEffect(()=>bridge.onRefresh(()=>{void refresh(true);}),[refresh]);
  useEffect(()=>{setDashboard(null);requestVersion.current++;},[accountKey]);
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
  useEffect(() => { const seconds=refreshSeconds(preferences.refreshInterval); if (!ready || !seconds) return; let pending=false; const interval=setInterval(async () => { if (document.visibilityState !== 'visible' || pending) return; pending=true; try { await refresh(); } finally { pending=false; } },Math.max(15,seconds)*1000); return () => clearInterval(interval); },[ready,page,preferences.refreshInterval,refresh]);
  useEffect(() => { const query = matchMedia('(prefers-color-scheme: dark)'); const update = () => { document.documentElement.dataset.theme = preferences.theme === 'system' ? query.matches ? 'dark' : 'light' : preferences.theme; }; update(); query.addEventListener('change', update); return () => query.removeEventListener('change', update); }, [preferences.theme]);
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
    void updatePreferences({selection:{siteId:preferences.activeSiteId,values:{[tool+'.model']:model,...(group ? {[tool+'.group']:group} : {})}}}).catch(e=>toast(e.message,'error'));
    setPage('tools');
  }, [preferences.activeSiteId, updatePreferences, toast]);
  const site = preferences.sites.find(s => s.id === preferences.activeSiteId) || preferences.sites[0];
  const activeNav = nav.find(n => n.id === page)!;
  const catalogPending=activeSite && catalogNotice.key===catalogChangesStorageKey(activeSite) ? catalogNotice.count : 0;
  const status = loading ? '正在同步' : error ? '连接异常' : dashboard?.user ? '站点已连接' : '等待登录';
  const pages: Record<Page, ReactNode> = { overview: <Overview key={preferences.activeSiteId}/>, usage: <Usage key={preferences.activeSiteId}/>, models: <Models key={preferences.activeSiteId}/>, tools: <Tools key={preferences.activeSiteId}/>, tokens: <Tokens key={preferences.activeSiteId}/>, settings: <SettingsPage key={preferences.activeSiteId}/> };
  const filteredActions = nav.filter(n => `${n.label} ${n.hint}`.toLowerCase().includes(query.toLowerCase()));
  const searchedModels = query ? dashboard?.catalog.models.filter(m => m.model_name.toLowerCase().includes(query.toLowerCase())).slice(0, 5) || [] : [];
  const mac=bootstrap.platform==='darwin',shortcut=mac ? '⌘' : 'Ctrl';
  if(!ready)return <StartupScreen error={error} retry={()=>{setError('');void reloadBootstrap().then(()=>setReady(true)).catch(e=>setError(e.message));}}/>;
  return <AppContext.Provider value={{ openLogin:() => setLoginOpen(true),bootstrap, preferences, dashboard, page, setPage, days, setDays, overviewQuery,setOverviewQuery, statisticsQuery:dashboardQuery, loading, error, refresh, updatePreferences, setPreferences, reloadBootstrap, toast, configureModel }}><UpdateDialogProvider><div className={'desktop-shell platform-'+(bootstrap.platform || 'browser')}><header className="titlebar"><div className="breadcrumb"><span>我的空间</span><ChevronRight size={12}/><strong>{activeNav.label}</strong></div><div className="titlebar-actions"><button className="global-search" onClick={() => { setQuery(''); setSearchOpen(true); }}><Search size={15}/><span>搜索工作台</span><kbd>{shortcut} K</kbd></button><span className="header-divider"/><button className={`icon-button refresh-button ${loading ? 'spin' : ''}`} onClick={()=>void refresh(true)} disabled={loading} aria-label="刷新站点数据" title="刷新数据"><RefreshCw size={17}/></button><button className="icon-button notification-button" onClick={() => setAnnouncements(true)} aria-label="查看站点公告" title="站点公告"><Bell size={17}/>{dashboard?.status.announcements?.length ? <i/> : null}</button><button className="avatar" onClick={() => dashboard?.user ? setPage('settings') : setLoginOpen(true)} title="账户与设置" aria-label="账户设置">{(dashboard?.user?.display_name || dashboard?.user?.username || 'L').slice(0, 1).toUpperCase()}</button>{bootstrap.desktop && !mac && <div className="window-controls"><button aria-label="最小化" onClick={() => bridge.windowControl('minimize')}><Minus size={13}/></button><button aria-label="最大化或恢复" onClick={() => bridge.windowControl('maximize')}><Square size={11}/></button><button className="window-close" aria-label="关闭窗口" onClick={() => bridge.windowControl('close')}><X size={15}/></button></div>}</div></header>
    <aside className="sidebar surface"><div className="sidebar-navigation"><div className="brand-row"><Logo/><div><strong>Lumi<span>●</span></strong><p>你的 AI，尽在一处</p></div></div><div className="sidebar-divider"/><div className="sidebar-caption">WORKSPACE</div><nav aria-label="主导航">{nav.slice(0, 3).map(n => <button key={n.id} className={`nav-item ${page === n.id ? 'active' : ''}`} onClick={() => setPage(n.id)}><n.icon size={18} strokeWidth={1.7}/><span>{n.label}</span>{page === n.id ? <span className="nav-active-dot"/> : n.id === 'models' && catalogPending ? <span className="nav-count" style={{background:'var(--orange-soft)',color:'var(--orange)'}} title={catalogPending+' 项模型目录变动未读'}>{catalogPending}</span> : n.id === 'models' && dashboard?.catalog.models.length ? <span className="nav-count">{dashboard.catalog.models.length}</span> : null}</button>)}</nav><div className="sidebar-caption tools-caption">DEVELOPER TOOLS</div><nav aria-label="工具导航">{nav.slice(3, 5).map(n => <button key={n.id} className={`nav-item ${page === n.id ? 'active' : ''}`} onClick={() => setPage(n.id)}><n.icon size={18} strokeWidth={1.7}/><span>{n.label}</span>{page === n.id && <span className="nav-active-dot"/>}</button>)}</nav></div><div className="sidebar-footer"><button className={`nav-item settings-nav ${page === 'settings' ? 'active' : ''}`} onClick={() => setPage('settings')}><Settings size={18} strokeWidth={1.7}/><span>设置</span><span className="nav-shortcut">{shortcut} ,</span></button><div className="sidebar-divider"/><UpdateNotice/><div className="sidebar-site"><div className="site-icon"><Globe2 size={19}/></div><div><Select label="切换当前站点" className="site-switch" value={preferences.activeSiteId} onChange={value => updatePreferences({ activeSiteId: value }).catch(e => toast(e.message, 'error'))}>{preferences.sites.map(s => <option key={s.id} value={s.id}>{s.name}</option>)}</Select></div></div><div className="sidebar-status"><span className={`tiny-dot ${error ? 'red' : !dashboard?.user ? 'amber' : ''}`}/>{status}<span>v{bootstrap.version}</span></div></div></aside>
    <main className="main-area">
      <div className="content-scroll" ref={contentRef}><div className="content-container">{error && <div className="warning-banner error-banner"><AlertCircle size={16}/><span>{error}</span><button onClick={()=>void refresh(true)}>重试</button></div>}{dashboard?.warnings.length ? <details className="sync-warnings"><summary><AlertCircle size={14}/>{dashboard.warnings.length} 项数据未能同步，点击查看</summary>{dashboard.warnings.map((w, i) => <p key={i}>{w}</p>)}</details> : null}
        <ErrorBoundary><MotionSwap identity={page}><Suspense fallback={<Skeleton/>}>{page === 'settings' || page === 'tools' || page === 'usage' ? pages[page] : dashboard?.user ? pages[page] : loading ? <Skeleton/> : <Welcome onLogin={() => setLoginOpen(true)}/>}</Suspense></MotionSwap></ErrorBoundary>
      </div></div><footer className="app-statusbar"><span><span className={`tiny-dot ${error ? 'red' : !dashboard?.user ? 'amber' : ''}`}/>{site.name}<span className="statusbar-separator">/</span>{status}</span><span>{dashboard ? `上次同步 ${new Date(dashboard.fetchedAt).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })}` : '等待同步'}<span className="statusbar-separator">·</span>本机优先，安心创造</span></footer>
    </main>
    {loginOpen && <LoginModal key={preferences.activeSiteId} onClose={() => setLoginOpen(false)}/>}
    {notice && <div className={`toast ${notice.kind}`} role="status" key={notice.id}>{notice.kind === 'success' ? <CheckCircle2 size={19}/> : notice.kind === 'error' ? <AlertCircle size={19}/> : <Info size={19}/>}<span>{notice.text}</span><button onClick={() => setNotice(null)} aria-label="关闭通知"><X size={15}/></button></div>}
    {searchOpen && <Modal title="随时找到你需要的" subtitle="搜索页面、模型或开发工具" onClose={() => setSearchOpen(false)}><div className="search-input command-search"><Search size={18}/><input placeholder="搜索工作台…" aria-label="搜索工作台内容" autoFocus value={query} onChange={e => setQuery(e.target.value)}/><kbd>ESC</kbd></div><div className="command-results">{filteredActions.map(n => <button key={n.id} onClick={() => { setPage(n.id); setSearchOpen(false); }}><n.icon size={18}/><div><strong>{n.label}</strong><span>{n.hint}</span></div><ChevronRight size={15}/></button>)}{searchedModels.map(m => <button key={m.model_name} onClick={() => { if (m.supported_endpoint_types.some(p => p.includes('anthropic'))) configureModel(m.model_name, 'claude'); else configureModel(m.model_name, 'codex'); setSearchOpen(false); }}><Boxes size={18}/><div><strong>{m.model_name}</strong><span>{m.vendor} · 模型配置</span></div><ArrowUpRight size={15}/></button>)}{!filteredActions.length && !searchedModels.length && <p className="empty-search">没有找到结果，试试“模型”或“Codex”。</p>}</div></Modal>}
    {announcements && <Modal title="站点公告" subtitle={site.name} onClose={() => setAnnouncements(false)}><div className="announcement-list">{dashboard?.status.announcements?.length ? dashboard.status.announcements.map((a, i) => <article key={i}><div><Pill tone="green">站点消息</Pill><span>{new Date(a.publishDate).toLocaleDateString()}</span></div><p>{a.content}</p></article>) : <div className="empty-state"><Bell size={25}/><h3>暂无公告</h3><p>站点发布的新消息会显示在这里。</p></div>}</div></Modal>}
  </div></UpdateDialogProvider></AppContext.Provider>;
}
