import {normalizePluginEnabled,normalizePluginViews,validatePluginView,configurablePlugin,pluginEnabled} from '../shared/plugin-preferences';
import {builtinManifests} from '../plugins/manifests';
import type {PluginStatus} from '../shared/contracts/plugins';
import {normalizeMenuBarContents} from '../shared/menu-bar';
import {normalizeMenuBarRange} from '../shared/menu-bar-periods';
import {normalizeWidgetPeriod} from '../shared/widget-period';
import {refreshSeconds} from '../shared/refresh';
import {migrateLogColumns} from '../shared/logs';
import {resolveRange} from '../shared/range';
import {applyPreferencePatch, normalizeSelections,normalizeSourceSelections} from '../shared/selections';
import {normalizeInterfaceSelections} from '../shared/interface-appearance';
import {normalizeInterfacePriorities,normalizeBackground} from '../shared/interface-styles';
import { DEFAULT_PREFERENCES, DEFAULT_SITE_URL, type Preferences, type LumiBridge, type SiteInput, type Dashboard } from '../shared/types';
let preferences: Preferences = structuredClone(DEFAULT_PREFERENCES);
try { const saved = localStorage.getItem('lumi-ui-preferences'); if (saved) { const p=JSON.parse(saved); preferences={...preferences,background:normalizeBackground(p.background),interfacePriorities:normalizeInterfacePriorities(p.interfacePriorities),defaultInterfaceEnabled:p.defaultInterfaceEnabled!==false,interfaceSelections:normalizeInterfaceSelections(p.interfaceSelections),widgetEnabled:typeof p.widgetEnabled==='boolean' ? p.widgetEnabled : preferences.widgetEnabled,pluginEnabled:normalizePluginEnabled(p.pluginEnabled),pluginViews:normalizePluginViews(p.pluginViews,p.pluginEnabled),theme:p.theme || 'light',tokenPrefix:p.tokenPrefix || preferences.tokenPrefix,refreshInterval:refreshSeconds(p.refreshInterval),menuBarRefreshInterval:refreshSeconds(p.menuBarRefreshInterval),widgetDataSource:p.widgetDataSource === 'local' ? 'local' : 'api',widgetPeriod:normalizeWidgetPeriod(p.widgetPeriod),widgetInputMode:p.widgetInputMode==='uncached' ? 'uncached' : 'total',menuBarContents:normalizeMenuBarContents(p.menuBarContents),menuBarTotalsRange:normalizeMenuBarRange(p.menuBarTotalsRange),menuBarChartRange:normalizeMenuBarRange(p.menuBarChartRange),lowBalanceThreshold:p.lowBalanceThreshold ?? preferences.lowBalanceThreshold,favoriteModels:p.favoriteModels || [],viewSelections:normalizeSelections(p.viewSelections),sourceSelections:normalizeSourceSelections(p.sourceSelections,normalizeSelections(p.viewSelections),p.activeSiteId || preferences.activeSiteId),logColumns:migrateLogColumns(p.logColumns),sites:(p.sites || preferences.sites).map((s: any) => ({id:s.id,name:s.name,url:s.url,allowHttp:!!s.allowHttp,accessTokenConfigured:false,apiKeyConfigured:false})),activeSiteId:p.activeSiteId || preferences.activeSiteId}; } } catch {}
function save() { localStorage.setItem('lumi-ui-preferences',JSON.stringify({background:preferences.background,interfacePriorities:preferences.interfacePriorities,defaultInterfaceEnabled:preferences.defaultInterfaceEnabled,interfaceSelections:preferences.interfaceSelections,widgetEnabled:preferences.widgetEnabled,pluginEnabled:preferences.pluginEnabled,pluginViews:preferences.pluginViews,theme:preferences.theme,tokenPrefix:preferences.tokenPrefix,refreshInterval:preferences.refreshInterval,menuBarRefreshInterval:preferences.menuBarRefreshInterval,widgetDataSource:preferences.widgetDataSource,widgetPeriod:preferences.widgetPeriod,widgetInputMode:preferences.widgetInputMode,menuBarContents:preferences.menuBarContents,menuBarTotalsRange:preferences.menuBarTotalsRange,menuBarChartRange:preferences.menuBarChartRange,lowBalanceThreshold:preferences.lowBalanceThreshold,favoriteModels:preferences.favoriteModels,viewSelections:preferences.viewSelections,sourceSelections:preferences.sourceSelections,logColumns:preferences.logColumns,sites:preferences.sites.map(({id,name,url,allowHttp}) => ({id,name,url,allowHttp})),activeSiteId:preferences.activeSiteId}));return structuredClone(preferences); }
const desktopOnly = async (): Promise<never> => { throw new Error('此操作需要在 Lumi Electron 桌面应用中完成。'); };
async function publicStatus() { const site=preferences.sites.find(s => s.id === preferences.activeSiteId)!;if(site.url===DEFAULT_SITE_URL)return {system_name:'New API',quota_per_unit:0,password_login_enabled:false};const r=await fetch('/_lumi/public-status?site='+encodeURIComponent(site.url),{cache:'no-store'});if (!r.ok) throw new Error('站点信息加载失败，请在桌面应用中连接。');const j=await r.json();if (!j.success) throw new Error(j.message);return j.data; }
function browserPluginStatuses():PluginStatus[]{return builtinManifests.map(manifest=>({manifest,state:manifest.configurable && !pluginEnabled(manifest,preferences) ? 'disabled' : 'active',views:preferences.pluginViews[manifest.id]}));}
const browserBridge: LumiBridge = {
  syncSurfaceTheme:async()=>{},
  extensionMarket:desktopOnly,installExtension:desktopOnly,removeExtension:desktopOnly,
  extensionInventory:async()=>({directory:'',plugins:[],diagnostics:[]}),reloadExtensions:desktopOnly,openExtensionsDirectory:desktopOnly,extensionRequest:desktopOnly,
  readCodexUsage:desktopOnly,
  readCatalog:desktopOnly,
  listPlugins:async()=>browserPluginStatuses(),
  setPluginEnabled:async(id,enabled)=>{
    configurablePlugin(builtinManifests,id);
    if(typeof enabled!=='boolean')throw new Error('插件启用状态无效。');
    const previous=preferences.pluginEnabled,previousWidget=preferences.widgetEnabled;
    preferences.pluginEnabled={...previous,[id]:enabled};if(id==='surface.widget')preferences.widgetEnabled=enabled;
    try{save();}catch(error){preferences.pluginEnabled=previous;preferences.widgetEnabled=previousWidget;throw error;}
    return browserPluginStatuses();
  },
  setPluginView:async(id,view,enabled)=>{
    validatePluginView(id,view);if(typeof enabled!=='boolean')throw new Error('显示状态无效。');
    const previous=preferences.pluginViews;preferences.pluginViews={...previous,[id]:{...previous[id],[view]:enabled}};
    try{save();}catch(error){preferences.pluginViews=previous;throw error;}
    return browserPluginStatuses();
  },
  onWidgetVisibility:()=>()=>{},
  bootstrap:async () => ({preferences:structuredClone(preferences),desktop:false,platform:'browser',version:'0.5.14',secureStorage:false,configs:[]}),
  inspectConfigs:async()=>[],
  appLogs:async()=>({startedAt:Date.now(),entries:[],dropped:0}),onAppLog:()=>()=>{},onNavigate:()=>()=>{},onRefresh:()=>()=>{},
  appCache:desktopOnly,clearAppCache:desktopOnly,
  toolRuntimes:async()=>[],installTool:desktopOnly,onToolRuntime:()=>()=>{},
  saveSite:async (input: SiteInput) => { if (input.accessToken || input.apiKey) return desktopOnly();const u=new URL(input.url);if (!['http:','https:'].includes(u.protocol) || u.username || u.password || u.search || u.hash) throw new Error('请输入有效站点地址。');const id=input.id || crypto.randomUUID();const site={id,name:input.name,url:u.href.replace(/\/$/,''),allowHttp:input.allowHttp,accessTokenConfigured:false,apiKeyConfigured:false};preferences.sites=input.id ? preferences.sites.map(s => s.id === id ? site : s) : [...preferences.sites,site];preferences.activeSiteId=id;return save(); },
  removeSite:async id => { if (preferences.sites.length < 2) throw new Error('请至少保留一个站点。');preferences.sites=preferences.sites.filter(s => s.id !== id);if (preferences.activeSiteId === id) preferences.activeSiteId=preferences.sites[0].id;return save(); },
  updatePreferences:async patch => { if(patch.interfaceSelection)return desktopOnly();preferences=applyPreferencePatch(preferences,patch);preferences.widgetPeriod=normalizeWidgetPeriod(preferences.widgetPeriod);preferences.widgetInputMode=preferences.widgetInputMode==='uncached' ? 'uncached' : 'total';return save(); },
  loginInfo:async () => {const s=await publicStatus();return {enabled:s.password_login_enabled !== false,turnstile:!!s.turnstile_check,encryption:!!s.password_login_encryption_enabled,siteName:s.system_name};},login:desktopOnly,verifyLogin:desktopOnly,browserLogin:desktopOnly,logout:desktopOnly,
  modelHealth:desktopOnly, dashboard:async query => ({status:await publicStatus(),user:null,logs:{items:[],total:0,page:1,pageSize:100},series:[],stat:null,catalog:{models:[],groupRatio:{},usableGroups:{},autoGroups:[],vendors:[]},tokens:[],warnings:[],fetchedAt:Date.now(),days:resolveRange(query).days,range:resolveRange(query).range} satisfies Dashboard),
  logs:desktopOnly,localUsage:desktopOnly,localSessionDetails:desktopOnly,onLocalUsageProgress:()=>()=>{},loadLocalSession:desktopOnly,onLocalSessionProgress:()=>()=>{},localSessionRecords:desktopOnly,localSessionContent:desktopOnly,localSessionRaw:desktopOnly,releaseLocalSession:desktopOnly,previewConfig:desktopOnly,onConfigProgress:()=>()=>{},applyConfig:desktopOnly,backups:async () => [],restoreBackup:desktopOnly,createToken:desktopOnly,toggleToken:desktopOnly,updateToken:desktopOnly,getTokenKey:desktopOnly,copyTokenKey:desktopOnly,exportLogs:desktopOnly,
  tokenUsage:desktopOnly,usageQuality:desktopOnly,updateStatus:async()=>({phase:'unsupported',currentVersion:'0.5.14',received:0,total:0}),checkUpdate:desktopOnly,downloadUpdate:desktopOnly,cancelUpdate:desktopOnly,showUpdateFile:desktopOnly,openUpdateFile:desktopOnly,restartUpdate:desktopOnly,onUpdate:()=>()=>{},onReviewUpdate:()=>()=>{},
  openExternal:async url => {const u=new URL(url);if (!['http:','https:'].includes(u.protocol)) throw new Error('不支持此链接。');window.open(u.href,'_blank','noopener,noreferrer');},windowControl:async () => {},
};
export const bridge=window.lumi || browserBridge;
