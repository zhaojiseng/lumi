export type Tool = 'codex' | 'claude';
export type Page = 'overview' | 'usage' | 'models' | 'tools' | 'tokens' | 'settings';
export type Theme = 'light' | 'dark' | 'system';
export interface SiteProfile {
  id: string; name: string; url: string; userId?: number; allowHttp: boolean;
  accessTokenConfigured: boolean; apiKeyConfigured: boolean; username?: string; sessionAuth?: boolean;
}
export interface ToolBinding {
  tool: Tool; model: string; group: string; tokenName: string; tokenId?: number; siteId: string;
  sonnet?: string; opus?: string; haiku?: string; appliedAt?: number; contextWindow?:number;
}
export const LOG_COLUMN_IDS = ['time','model','token','input','output','cacheRead','cacheWrite','cost','duration','speed','channel','status','firstToken','group','requestId','stream','tool'] as const;
export type LogColumnId = typeof LOG_COLUMN_IDS[number];
export const DEFAULT_LOG_COLUMNS: LogColumnId[] = ['time','model','token','input','output','cacheRead','cost','duration','speed','channel','status'];
export interface Preferences {
  sites: SiteProfile[]; activeSiteId: string; tokenPrefix: string; theme: Theme;
  refreshInterval: number; lowBalanceThreshold: number; favoriteModels: string[];
  bindings: ToolBinding[]; managedTokens: ManagedToken[]; logColumns: LogColumnId[];
  viewSelections: Record<string, Record<string, SelectionValue>>;
}
export type SelectionValue = string | number | boolean | DateRange;
export interface SelectionPatch { siteId: string; values: Record<string, SelectionValue>; }
export type PreferencePatch = Partial<Pick<Preferences, 'activeSiteId' | 'tokenPrefix' | 'theme' | 'refreshInterval' | 'lowBalanceThreshold' | 'favoriteModels' | 'logColumns'>> & { selection?: SelectionPatch };
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
  prompt_tokens: number; completion_tokens: number; quota: number; use_time: number;
  is_stream: boolean; group: string; channel?: number; channel_name?: string; content?: string; other?: string; request_id?: string; status_code?: number;
}
export interface DateRange { startDate: string; endDate: string; }
export type DashboardQuery = number | DateRange;
export interface LogQuery { range?: DateRange; days: number; page: number; pageSize: number; model?: string; tokenName?: string; type?: number; }
export interface LogPage { items: UsageLog[]; total: number; page: number; pageSize: number; }
export interface QuotaPoint { created_at: number; model_name: string; quota: number; token_used: number; count: number; }
export interface UsageStat { quota: number; rpm: number; tpm: number; }
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
  range?: DateRange; today?: { quota: number | null; requests: number | null }; health?: HealthSummary | null; healthError?: string;
  status: SiteStatus; user: UserInfo | null; logs: LogPage; series: QuotaPoint[];
  stat: UsageStat | null; toolStats?: { tool: Tool; tokenName: string; stat: UsageStat | null }[]; catalog: ModelCatalog; tokens: ApiToken[];
  warnings: string[]; fetchedAt: number; days: number;
}
export interface ToolConfigState {
  tool: Tool; exists: boolean; path: string; model?: string; baseUrl?: string;
  keyConfigured: boolean; error?: string; contextWindow?:number;
}
export interface LocalUsageRow {
  tool: Tool; date: string; model: string; inputTokens: number; outputTokens: number;
  cacheReadTokens: number; cacheWriteTokens: number; requests: number; sessions: number;
}
export interface LocalUsage {
  rows: LocalUsageRow[]; filesScanned: number; warnings: string[]; scannedAt: number;
}
export interface ConfigRequest {
  tool: Tool; model: string; group: string; sonnet?: string; opus?: string; haiku?: string; contextWindow?:number;
}
export interface ConfigPreview {
  id: string; tool: Tool; files: { path: string; before: string; after: string }[];
  changes: string[]; expiresAt: number; token?: { id: number; name: string; group: string; created: boolean };
}
export interface BackupInfo { id: string; tool: Tool; createdAt: number; paths: string[]; }
export interface Bootstrap {
  preferences: Preferences; desktop: boolean; version: string;
  configs: ToolConfigState[]; secureStorage: boolean;
}
export interface CreateTokenInput {
  name: string; tool?: Tool; group: string; unlimited: boolean; quota: number;
  models?: string; expiredTime?:number; allowIps?:string; crossGroupRetry?:boolean;
}
export interface UpdateTokenInput extends Omit<CreateTokenInput,'tool'> { id:number; }
export interface LumiBridge {
  bootstrap(): Promise<Bootstrap>;
  saveSite(input: SiteInput): Promise<Preferences>;
  removeSite(id: string): Promise<Preferences>;
  updatePreferences(patch: PreferencePatch): Promise<Preferences>;
  loginInfo(): Promise<LoginInfo>;
  login(input: LoginInput): Promise<LoginResult>;
  verifyLogin(input: { challengeId: string; code: string }): Promise<LoginResult>;
  browserLogin(): Promise<Preferences>;
  logout(siteId: string): Promise<Preferences>;
  dashboard(query: DashboardQuery): Promise<Dashboard>;
  modelHealth(model: string): Promise<ModelHealthDetails>;
  logs(query: LogQuery): Promise<LogPage>;
  localUsage(days: number): Promise<LocalUsage>;
  previewConfig(input: ConfigRequest): Promise<ConfigPreview>;
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
  sites: [{ id: DEFAULT_SITE_ID, name: 'New API', url: DEFAULT_SITE_URL, allowHttp: false, accessTokenConfigured: false, apiKeyConfigured: false }],
  activeSiteId: DEFAULT_SITE_ID, tokenPrefix: 'Lumi-', theme: 'light', refreshInterval: 60,
  logColumns: [...DEFAULT_LOG_COLUMNS], lowBalanceThreshold: 10, favoriteModels: [], managedTokens: [], viewSelections: {}, bindings: [
    { tool: 'codex', model: '', group: '', tokenName: 'Lumi-Codex', siteId: DEFAULT_SITE_ID },
    { tool: 'claude', model: '', group: '', tokenName: 'Lumi-Claude', siteId: DEFAULT_SITE_ID },
  ],
};

export interface ManagedToken { siteId: string; tool: Tool; id: number; name: string; group: string; }
export interface LoginInfo { enabled: boolean; turnstile: boolean; encryption: boolean; siteName: string; }
export interface LoginInput { username: string; password: string; turnstileToken?: string; }
export type LoginResult = { state: "success"; preferences: Preferences } | { state: "verification"; challengeId: string; methods: string[]; expiresAt: number };
export interface UsageField { type?: "number" | "boolean"; unit?: string; unitLabel?: string | Record<string, string>; enum?: string[]; enumLabels?: Record<string, string | Record<string, string>>; description?: string | Record<string, string>; }
export interface UsageExample { label: string; facts: Record<string, string | number>; }
export interface BillingVariant { plugin_key: string; plugin_name: string; billing_mode?: string; billing_expr: string; billing_usage_schema?: Record<string, UsageField>; billing_usage_examples?: UsageExample[]; }
