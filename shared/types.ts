import type {CatalogReadRequest,CatalogSnapshot} from './contracts/catalog';
import type {PluginStatus,PluginViewId} from './contracts/plugins';
import type {SubscriptionUsageSnapshot} from './contracts/subscription-usage';
import type {ExtensionInventory,ExtensionRequest} from './contracts/extensions';
import type {ExtensionMarketCatalog,ExtensionMarketInstall} from './contracts/extension-market';
import type {DataRefreshAnimation} from './motion';
import type {InterfaceSelection} from './contracts/interface';
import type {UserBackground} from './interface-styles';
import type {WidgetPeriod} from './widget-period';
export type Tool = 'codex' | 'claude';
export type PluginPageId = `plugin:${string}`;
export type Page = 'overview' | 'usage' | 'models' | 'tools' | 'tokens' | 'settings' | PluginPageId;
export type Theme = 'light' | 'dark' | 'system';
export interface SiteProfile {
  id: string; name: string; url: string; userId?: number; allowHttp: boolean;
  accessTokenConfigured: boolean; apiKeyConfigured: boolean; username?: string; sessionAuth?: boolean;
}
export interface ToolBinding {
  tool: Tool; model: string; group: string; tokenName: string; tokenId?: number; siteId: string;
  sonnet?: string; opus?: string; haiku?: string; appliedAt?: number; contextWindow?:number; disableAttributionHeader?:boolean;
}
export const LOG_COLUMN_IDS = ['time','model','reasoning','token','input','output','cacheRead','cacheWrite','cost','duration','speed','netSpeed','channel','status','firstToken','group','requestId','stream','tool'] as const;
export type LogColumnId = typeof LOG_COLUMN_IDS[number];
export const DEFAULT_LOG_COLUMNS: LogColumnId[] = ['time','model','reasoning','token','input','output','cacheRead','cost','duration','speed','channel','status'];
export const MENU_BAR_SECTION_IDS = ['balance','totals','tokenDetail','efficiency','chart','models'] as const;
export type MenuBarSectionId = typeof MENU_BAR_SECTION_IDS[number];
export type MenuBarRange = 'follow' | '24h' | 1 | 7 | 30;
export type WidgetDataSource = 'api' | 'local';
export type WidgetInputMode = 'total' | 'uncached';
export interface Preferences {
  pluginEnabled:Record<string,boolean>;
  pluginViews:Record<string,Partial<Record<PluginViewId,boolean>>>;
  interfaceSelections:Record<string,Record<string,string>>;
  interfacePriorities:Record<string,number>;
  defaultInterfaceEnabled:boolean;
  background:UserBackground;
  widgetEnabled:boolean; widgetPosition:{x:number;y:number}|null; widgetDataSource:WidgetDataSource; widgetPeriod:WidgetPeriod; widgetInputMode:WidgetInputMode; dataRefreshAnimation:DataRefreshAnimation;
  sites: SiteProfile[]; activeSiteId: string; tokenPrefix: string; theme: Theme;
  refreshInterval: number; menuBarRefreshInterval: number; menuBarContents: MenuBarSectionId[]; menuBarTotalsRange:MenuBarRange; menuBarChartRange:MenuBarRange; lowBalanceThreshold: number; favoriteModels: string[];
  bindings: ToolBinding[]; managedTokens: ManagedToken[]; logColumns: LogColumnId[];
  viewSelections: Record<string, Record<string, SelectionValue>>;
  sourceSelections: Record<string, Record<string, SelectionValue>>;
  dismissedUpdateVersion: string;
  skippedUpdateVersion: string;
}
export type SelectionValue = string | number | boolean | DateRange | string[];
export interface SelectionPatch { siteId: string; values: Record<string, SelectionValue>; }
export type PreferencePatch = Partial<Pick<Preferences, 'background' | 'defaultInterfaceEnabled' | 'dataRefreshAnimation' | 'widgetEnabled' | 'widgetPosition' | 'widgetDataSource' | 'widgetPeriod' | 'widgetInputMode' | 'activeSiteId' | 'tokenPrefix' | 'theme' | 'refreshInterval' | 'menuBarRefreshInterval' | 'menuBarContents' | 'menuBarTotalsRange' | 'menuBarChartRange' | 'lowBalanceThreshold' | 'favoriteModels' | 'logColumns' | 'dismissedUpdateVersion' | 'skippedUpdateVersion'>> & { interfaceOrder?:string[];interfacePriority?:{id:string;priority:number};interfaceSelection?:InterfaceSelection;selection?: SelectionPatch;sourceSelection?:{sourceId:'source.local-sessions'|'feature.usage';values:Record<string,SelectionValue>} };
export interface SiteInput {
  id?: string; name: string; url: string; userId?: number; allowHttp: boolean;
  accessToken?: string; apiKey?: string; clearAccessToken?: boolean; clearApiKey?: boolean;
}
export interface SiteStatus {
  system_name: string; version?: string; quota_per_unit: number; quota_display_type?: string;
  custom_currency_symbol?: string; custom_currency_exchange_rate?: number; usd_exchange_rate?: number;
  announcements?: { content: string; publishDate: string; type?: string }[];
  [key: string]: unknown;
}
export interface UserInfo {
  id: number; username: string; display_name: string; quota: number; used_quota: number;
  request_count: number; group: string; email?: string;
}
export interface UsageLog {
  id: number; created_at: number; type: number; model_name: string; token_name: string;
  token_id?: number;
  prompt_tokens: number; completion_tokens: number; quota: number; use_time: number;
  is_stream: boolean; group: string; channel?: number; channel_name?: string; content?: string; other?: string; request_id?: string; status_code?: number;
  reasoning_effort?:string; reasoning?:{effort?:string}; request?:Record<string,unknown>; metadata?:Record<string,unknown>;
}
export interface DateRange { startDate: string; endDate: string; startTime?: string; endTime?: string; }
export type RangeQuery = number | '24h' | DateRange;
export interface StatisticsQuery { range: RangeQuery; models?: string[]; tokenIds?: number[]; }
export type DashboardQuery = RangeQuery | StatisticsQuery;
export interface LogQuery { range?: RangeQuery; days: number; page: number; pageSize: number; model?: string; tokenName?: string; models?: string[]; tokenIds?: number[]; type?: number; }
export interface LogPage { items: UsageLog[]; total: number; page: number; pageSize: number; }
export interface QuotaPoint { created_at: number; model_name: string; quota: number; token_used: number; count: number; token_name?: string; token_id?: number; cacheInputTokens?:number; cacheReadTokens?:number; outputTokens?:number; durationSeconds?:number; speedSamples?:number; netOutputTokens?:number; subsequentDurationSeconds?:number; netSpeedSamples?:number; }
export interface UsageQuality {
  requestCount:number;cacheSamples:number;speedSamples:number;inputTokens:number;cacheReadTokens:number;
  outputTokens:number;durationSeconds:number;cacheHitRate:number|null;averageTokenSpeed:number|null;fetchedAt:number;
  /** Absent on older snapshots; valid streamed timing samples only. */
  netSpeedSamples?:number;netOutputTokens?:number;subsequentDurationSeconds?:number;averageNetTokenSpeed?:number|null;
}
export interface TokenUsage { points: QuotaPoint[]; quality:UsageQuality; logCount: number; fetchedAt: number; }
export type TrendGrouping = 'total' | 'model' | 'token';
export type TrendMetric = 'cost' | 'tokens' | 'requests' | 'cacheHitRate' | 'speed' | 'netSpeed';
export interface UpdateState {
  phase: 'idle' | 'checking' | 'current' | 'available' | 'downloading' | 'verifying' | 'ready' | 'installing' | 'error' | 'unsupported';
  currentVersion: string; version?: string; releaseUrl?: string; checkedAt?: number;
  received: number; total: number; error?: string;
  /** Complete verified installer size; received/total describe network transfer, including differential downloads. */
  packageSize?:number;
  installMode?: 'restart' | 'replace';
  releaseNotes?: string;
}
export interface AppCacheInfo {
  totalBytes:number;browserBytes:number;updateBytes:number;protectedBytes:number;scannedAt:number;warnings:string[];
}
export interface AppCacheClearResult {cache:AppCacheInfo;freedBytes:number;}
export type AppLogLevel = 'debug' | 'info' | 'warn' | 'error';
export interface AppLogEntry { id:number; timestamp:number; level:AppLogLevel; source:string; message:string; }
export interface AppLogSnapshot { startedAt:number; entries:AppLogEntry[]; dropped:number; }
export interface UsageStat { quota: number; rpm: number; tpm: number; }
export interface MenuBarUsage {
  siteId:string;siteName:string;status:SiteStatus;user:UserInfo|null;
  today:{quota:number|null;tokens:number|null;requests:number|null};
  tools:{tool:Tool;quota:number|null}[];fetchedAt:number;warnings:string[];
  period?:{selection:MenuBarSelection;quota:number|null;tokens:number|null;requests:number|null;points:QuotaPoint[]|null};
  chartPeriod?:{selection:MenuBarSelection;points:QuotaPoint[]|null};
  details?:MenuBarDetails;
}
export interface MenuBarSelection {days:1|7|30;tool:'all'|Tool;range?:1|7|30|'24h';}
export interface MenuBarDetails {points:QuotaPoint[];chartPoints?:QuotaPoint[]|null;quality:UsageQuality;inputTokens:number|null;outputTokens:number|null;cacheReadTokens:number|null;cacheWriteTokens:number|null;}
export interface ModelInfo {
  model_name: string; description?: string; vendor_id?: number; vendor?: string;
  quota_type: number; model_ratio: number; model_price: number; completion_ratio: number;
  cache_ratio?: number; create_cache_ratio?: number; cache_creation_ratio?: number; image_ratio?: number; audio_ratio?: number; audio_completion_ratio?: number;
  billing_mode?: string; billing_expr?: string; billing_usage_schema?: Record<string, UsageField>; billing_usage_examples?: UsageExample[]; billing_plugin_variants?: BillingVariant[]; enable_groups: string[];
  supported_endpoint_types: string[]; tags?: string; [key: string]: unknown;
}
export interface ModelCatalog {
  models: ModelInfo[]; groupRatio: Record<string, number>; usableGroups: Record<string, string>;
  autoGroups: string[]; vendors: { id: number; name: string; description?: string; icon?: string }[];
}
export interface ApiToken {
  id: number; name: string; status: number; remain_quota: number; used_quota: number;
  unlimited_quota: boolean; expired_time: number; created_time: number;
  group: string; model_limits_enabled?: boolean; model_limits?: string; allow_ips?: string | null; cross_group_retry?: boolean;
}
export interface ModelHealth { model_name: string; success_rate: number; avg_latency_ms: number; avg_tps: number; recent_success_series?: { ts: number; success_rate: number }[]; }
export interface HealthSummary { models: ModelHealth[]; window_start: number; window_end: number; }
export interface ModelHealthDetails { model_name: string; window_start: number; window_end: number; groups: { group: string; success_rate: number; avg_latency_ms: number; avg_ttft_ms: number; avg_tps: number }[]; }
export interface Dashboard {
  interval?:{quota:number|null;tokens:number|null;requests:number|null};
  query?: DashboardQuery; quality?: UsageQuality; detailed?: boolean;
  range?: DateRange; today?: { quota: number | null; requests: number | null }; health?: HealthSummary | null; healthError?: string;
  status: SiteStatus; user: UserInfo | null; logs: LogPage; series: QuotaPoint[];
  stat: UsageStat | null; toolStats?: { tool: Tool; tokenName: string; stat: UsageStat | null }[]; catalog: ModelCatalog; tokens: ApiToken[];
  warnings: string[]; fetchedAt: number; days: number;
}
export interface ToolConfigState {
  tool: Tool; exists: boolean; path: string; model?: string; baseUrl?: string;
  keyConfigured: boolean; error?: string; contextWindow?:number;
}
export interface ToolRuntimeState {
  tool: Tool | 'chatgpt'; installed: boolean; version?: string; path?: string; checkedAt: number;
  latestVersion?: string; latestCheckedAt?: number;
  phase: 'idle' | 'checking' | 'installing' | 'error'; message?: string;
  npmAvailable: boolean; nodeVersion?: string;
}
export interface LocalUsageRow {
  tool: Tool; date: string; model: string; inputTokens: number; outputTokens: number;
  cacheReadTokens: number; cacheWriteTokens: number; requests: number; sessions: number;
}
export interface LocalUsage {
  rows: LocalUsageRow[]; points?:LocalUsagePoint[]; sessions?:LocalSessionSummary[]; filesScanned: number; warnings: string[]; scannedAt: number;
}
export interface LocalSessionSummary {
  id:string;tool:Tool;model:string;startedAt:number;updatedAt:number;inputTokens:number;outputTokens:number;cacheReadTokens:number;cacheWriteTokens:number;requests:number;
  metadata?:LocalSessionMetadata;
}
export interface LocalSessionMetadata {title?:string;firstPrompt?:string;sessionKey?:string;cwd?:string;project?:string;gitBranch?:string;version?:string;source?:string;}
export interface LocalSessionRecord {
  id:string;created_at:number;model:string;inputTokens:number;outputTokens:number;cacheReadTokens:number;cacheWriteTokens:number;contextTokens:number;reasoning?:string;
}
export interface LocalSessionPage {items:LocalSessionRecord[];nextCursor?:string;scannedBytes:number;totalBytes:number;}
export interface LocalSessionQuery {sessionId:string;query:DashboardQuery;cursor?:string;}
export interface LocalSessionLoad {sessionId:string;query:DashboardQuery;requestId:string;}
export interface LocalSessionProgress {requestId:string;phase:'read'|'complete';bytesRead:number;totalBytes:number;calls:number;}
export interface LocalSessionSnapshot {snapshotId:string;metadata:LocalSessionMetadata;total:number;eventTotal:number;totalBytes:number;warnings:string[];}
export interface LocalSessionRecordsQuery {snapshotId:string;page:number;pageSize:number;}
export interface LocalSessionRecordsPage {items:LocalSessionRecord[];total:number;page:number;pageSize:number;}
export interface LocalSessionContentQuery extends LocalSessionRecordsQuery {recordId?:string;}
export interface LocalSessionEvent {id:string;createdAt?:number;role:'user'|'assistant'|'tool'|'system'|'event';kind:string;text:string;toolName?:string;toolCallId?:string;details:{label:string;value:string}[];truncated?:boolean;rawBytes?:number;}
export interface LocalSessionContentPage {items:LocalSessionEvent[];total:number;page:number;pageSize:number;association:'session'|'turn'|'message'|'unavailable';}
export interface LocalSessionRawQuery {snapshotId:string;eventId:string;offset:number;}
export interface LocalSessionRawPage {text:string;offset:number;nextOffset?:number;totalBytes:number;}
export interface LocalUsagePoint {
  tool:Tool;created_at:number;model:string;inputTokens:number;outputTokens:number;cacheReadTokens:number;cacheWriteTokens:number;requests:number;
}
export interface LocalUsageProgress {
  requestId:string;phase:'discover'|'read'|'complete';filesDone:number;filesTotal:number;bytesRead:number;bytesTotal:number;
}
export interface ConfigRequest {
  tool: Tool; model: string; group: string; sonnet?: string; opus?: string; haiku?: string; contextWindow?:number; disableAttributionHeader?:boolean;
}
export interface ConfigPreview {
  id: string; tool: Tool; files: { path: string; before: string; after: string }[];
  changes: string[]; expiresAt: number; token?: { id: number; name: string; group: string; created: boolean };
}
export interface ConfigProgress {
  tool:Tool; operation:'preview'|'apply'|'restore';
  phase:'validating'|'key'|'history'|'backup'|'writing'|'done'; completed?:number; total?:number;
}
export interface BackupInfo { id: string; tool: Tool; createdAt: number; paths: string[]; }
export interface Bootstrap {
  preferences: Preferences; desktop: boolean; version: string;
  platform?: 'win32' | 'darwin' | 'linux' | 'browser';
  configs: ToolConfigState[]; secureStorage: boolean;
}
export interface CreateTokenInput {
  name: string; tool?: Tool; group: string; unlimited: boolean; quota: number;
  models?: string; expiredTime?:number; allowIps?:string; crossGroupRetry?:boolean;
}
export interface UpdateTokenInput extends Omit<CreateTokenInput,'tool'> { id:number; }
export interface LumiBridge {
  syncSurfaceTheme(input:import('./surface-theme').SurfaceTheme):Promise<void>;
  extensionInventory():Promise<ExtensionInventory>;
  extensionMarket(input:{force?:boolean}):Promise<ExtensionMarketCatalog>;
  installExtension(input:ExtensionMarketInstall):Promise<ExtensionInventory>;
  removeExtension(id:string):Promise<ExtensionInventory>;
  reloadExtensions():Promise<ExtensionInventory>;
  openExtensionsDirectory():Promise<void>;
  extensionRequest(input:ExtensionRequest):Promise<unknown>;
  readCodexUsage(input:{force?:boolean}):Promise<SubscriptionUsageSnapshot>;
  readCatalog(input:CatalogReadRequest):Promise<CatalogSnapshot>;
  listPlugins():Promise<PluginStatus[]>;
  setPluginEnabled(id:string,enabled:boolean):Promise<PluginStatus[]>;
  setPluginView(id:string,view:PluginViewId,enabled:boolean):Promise<PluginStatus[]>;
  bootstrap(): Promise<Bootstrap>;
  inspectConfigs(): Promise<ToolConfigState[]>;
  toolRuntimes(force?: boolean): Promise<ToolRuntimeState[]>;
  installTool(tool: Tool): Promise<ToolRuntimeState>;
  onToolRuntime(listener: (state: ToolRuntimeState) => void): () => void;
  appLogs(): Promise<AppLogSnapshot>;
  appCache():Promise<AppCacheInfo>;
  clearAppCache():Promise<AppCacheClearResult>;
  onAppLog(listener: (entry: AppLogEntry) => void): () => void;
  onNavigate(listener: (page:Page) => void): () => void;
  onRefresh(listener:()=>void):()=>void;
  onWidgetVisibility(listener:(enabled:boolean)=>void):()=>void;
  saveSite(input: SiteInput): Promise<Preferences>;
  removeSite(id: string): Promise<Preferences>;
  updatePreferences(patch: PreferencePatch): Promise<Preferences>;
  loginInfo(): Promise<LoginInfo>;
  login(input: LoginInput): Promise<LoginResult>;
  verifyLogin(input: { challengeId: string; code: string }): Promise<LoginResult>;
  browserLogin(): Promise<Preferences>;
  logout(siteId: string): Promise<Preferences>;
  dashboard(query: DashboardQuery, force?: boolean): Promise<Dashboard>;
  tokenUsage(query: DashboardQuery): Promise<TokenUsage>;
  usageQuality(query:DashboardQuery):Promise<UsageQuality>;
  updateStatus(): Promise<UpdateState>;
  checkUpdate(): Promise<UpdateState>;
  downloadUpdate(): Promise<UpdateState>;
  cancelUpdate(): Promise<void>;
  showUpdateFile(): Promise<void>;
  openUpdateFile(): Promise<void>;
  restartUpdate(): Promise<void>;
  onUpdate(listener: (state: UpdateState) => void): () => void;
  onReviewUpdate(listener:()=>void):()=>void;
  modelHealth(model: string): Promise<ModelHealthDetails>;
  logs(query: LogQuery): Promise<LogPage>;
  localUsage(query: DashboardQuery,requestId?:string): Promise<LocalUsage>;
  onLocalUsageProgress(listener:(progress:LocalUsageProgress)=>void):()=>void;
  localSessionDetails(input:LocalSessionQuery):Promise<LocalSessionPage>;
  loadLocalSession(input:LocalSessionLoad):Promise<LocalSessionSnapshot>;
  onLocalSessionProgress(listener:(progress:LocalSessionProgress)=>void):()=>void;
  localSessionRecords(input:LocalSessionRecordsQuery):Promise<LocalSessionRecordsPage>;
  localSessionContent(input:LocalSessionContentQuery):Promise<LocalSessionContentPage>;
  localSessionRaw(input:LocalSessionRawQuery):Promise<LocalSessionRawPage>;
  releaseLocalSession(input:{requestId?:string;snapshotId?:string}):Promise<void>;
  previewConfig(input: ConfigRequest): Promise<ConfigPreview>;
  onConfigProgress(listener:(progress:ConfigProgress)=>void):()=>void;
  applyConfig(id: string): Promise<ToolConfigState[]>;
  backups(): Promise<BackupInfo[]>;
  restoreBackup(id: string): Promise<ToolConfigState[]>;
  createToken(input: CreateTokenInput): Promise<void>;
  toggleToken(id: number, enabled: boolean): Promise<void>;
  updateToken(input:UpdateTokenInput):Promise<void>;
  getTokenKey(id: number): Promise<string>;
  copyTokenKey(id: number): Promise<void>;
  exportLogs(query: LogQuery): Promise<{ path?: string; count: number }>;
  openExternal(url: string): Promise<void>;
  windowControl(action: 'minimize' | 'maximize' | 'close'): Promise<void>;
}
export const DEFAULT_SITE_ID = 'cyg-default';
export const DEFAULT_SITE_URL = 'https://api.example.com';
export const DEFAULT_PREFERENCES: Preferences = {
  pluginEnabled:{},
  pluginViews:{},
  interfaceSelections:{},
  interfacePriorities:{},defaultInterfaceEnabled:true,background:{image:'',name:'',fit:'cover'},
  widgetEnabled:false,widgetPosition:null,widgetDataSource:'api',widgetPeriod:60,widgetInputMode:'total',dataRefreshAnimation:'slide-up',
  sites: [{ id: DEFAULT_SITE_ID, name: 'New API', url: DEFAULT_SITE_URL, allowHttp: false, accessTokenConfigured: false, apiKeyConfigured: false }],
  activeSiteId: DEFAULT_SITE_ID, tokenPrefix: 'Lumi-', theme: 'light', refreshInterval: 60, menuBarRefreshInterval:60, menuBarContents:[...MENU_BAR_SECTION_IDS], menuBarTotalsRange:'follow', menuBarChartRange:'follow', dismissedUpdateVersion: '', skippedUpdateVersion: '',
  logColumns: [...DEFAULT_LOG_COLUMNS], lowBalanceThreshold: 10, favoriteModels: [], managedTokens: [], viewSelections: {}, sourceSelections:{}, bindings: [
    { tool: 'codex', model: '', group: '', tokenName: 'Lumi-Codex', siteId: DEFAULT_SITE_ID },
    { tool: 'claude', model: '', group: '', tokenName: 'Lumi-Claude', siteId: DEFAULT_SITE_ID },
  ],
};

export interface ManagedToken { siteId: string; tool: Tool; id: number; name: string; group: string; previousNames?:string[]; }
export interface LoginInfo { enabled: boolean; turnstile: boolean; encryption: boolean; siteName: string; }
export interface LoginInput { username: string; password: string; turnstileToken?: string; }
export type LoginResult = { state: "success"; preferences: Preferences } | { state: "verification"; challengeId: string; methods: string[]; expiresAt: number };
export interface UsageField { type?: "number" | "boolean"; unit?: string; unitLabel?: string | Record<string, string>; enum?: string[]; enumLabels?: Record<string, string | Record<string, string>>; description?: string | Record<string, string>; }
export interface UsageExample { label: string; facts: Record<string, string | number>; }
export interface BillingVariant { plugin_key: string; plugin_name: string; billing_mode?: string; billing_expr: string; billing_usage_schema?: Record<string, UsageField>; billing_usage_examples?: UsageExample[]; }
