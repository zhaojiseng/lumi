import {normalizePluginEnabled,normalizePluginViews,validatePluginView} from '../../shared/plugin-preferences';
import {configurablePlugin} from '../../shared/plugin-preferences';
import {builtinManifests} from '../../plugins/manifests';
import {normalizeLogColumns,migrateLogColumns} from '../../shared/logs';
import {applyPreferencePatch, normalizeSelections,normalizeSourceSelections} from '../../shared/selections';
import {normalizeInterfaceSelections,validInterfaceSelection} from '../../shared/interface-appearance';
import {normalizeInterfacePriorities,normalizeBackground,validBackgroundImage,BACKGROUND_FITS} from '../../shared/interface-styles';
import {normalizeMenuBarContents} from '../../shared/menu-bar';
import {normalizeMenuBarRange} from '../../shared/menu-bar-periods';
import {refreshSeconds} from '../../shared/refresh';
import {refreshAnimation} from '../../shared/motion';
import {normalizeWidgetPeriod} from '../../shared/widget-period';
import { readFile, writeFile, mkdir, rename } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { DEFAULT_PREFERENCES, type Preferences, type PreferencePatch, type SiteInput, type SiteProfile, type Tool, type ToolBinding } from '../../shared/types';
export interface Cipher { encrypt(text: string): string; decrypt(text: string): string; available(): boolean; }
export interface SessionCookie { name: string; value: string; path: string; expires?: number; }
export interface SiteSecret { accessToken?: string; apiKey?: string; codexKey?: string; claudeKey?: string; cookies?: SessionCookie[]; accessExpiresAt?: number; sessionAuth?: boolean; username?: string; userId?: number; sessionId?: string; }
export async function atomicWrite(file: string, content: string) {
  await mkdir(path.dirname(file), { recursive: true });
  const temp = `${file}.${randomUUID()}.tmp`;
  await writeFile(temp, content, { mode: 0o600 });
  await rename(temp, file);
}
export function normalizeUrl(raw: string) {
  let url: URL;
  try { url = new URL(raw.trim()); } catch { throw new Error('请输入完整站点地址，例如 https://api.example.com'); }
  if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) throw new Error('站点地址只接受 HTTP / HTTPS，不能包含账户、查询参数或锚点。');
  url.pathname = url.pathname.replace(/\/(?:v1|api)\/?$/, '').replace(/\/+$/, '');
  return url.toString().replace(/\/$/, '');
}
export class SettingsStore {
  preferences: Preferences = structuredClone(DEFAULT_PREFERENCES);
  private secrets: Record<string, SiteSecret> = {};
  private encrypted = '';
  private vaultError = '';
  private pendingWrite: Promise<void> = Promise.resolve();
  constructor(private directory: string, readonly cipher: Cipher) {}
  async load() {
    let data: any;
    try { data = JSON.parse(await readFile(path.join(this.directory, 'settings.json'), 'utf8')); }
    catch (e: any) { if (e.code === 'ENOENT') return; throw new Error('设置文件无法读取。请检查应用数据目录。'); }
    this.preferences = { ...structuredClone(DEFAULT_PREFERENCES), ...data.preferences };
    this.preferences.pluginViews=normalizePluginViews(this.preferences.pluginViews,this.preferences.pluginEnabled);
    this.preferences.pluginEnabled=normalizePluginEnabled(this.preferences.pluginEnabled);
    this.preferences.interfaceSelections=normalizeInterfaceSelections(this.preferences.interfaceSelections);
    this.preferences.interfacePriorities=normalizeInterfacePriorities(this.preferences.interfacePriorities);
    this.preferences.defaultInterfaceEnabled=this.preferences.defaultInterfaceEnabled!==false;
    this.preferences.background=normalizeBackground(this.preferences.background);
    this.preferences.widgetEnabled=this.preferences.pluginEnabled['surface.widget'] ?? !!this.preferences.widgetEnabled;
    // Migrate old settings: obsolete preview and reasoning preferences never survive.
    delete (this.preferences as any).demoMode;
    this.preferences.bindings = this.preferences.bindings.map(({ reasoning, ...b }: any) => ({ ...b, group: b.group || "" }));
    this.preferences.managedTokens ||= [];
    this.preferences.logColumns = migrateLogColumns(this.preferences.logColumns);
    this.preferences.viewSelections = normalizeSelections(this.preferences.viewSelections);
    this.preferences.sourceSelections = normalizeSourceSelections(data.preferences?.sourceSelections,this.preferences.viewSelections,this.preferences.activeSiteId);
    this.preferences.menuBarContents=normalizeMenuBarContents(this.preferences.menuBarContents);
    this.preferences.menuBarTotalsRange=normalizeMenuBarRange(this.preferences.menuBarTotalsRange);
    this.preferences.menuBarChartRange=normalizeMenuBarRange(this.preferences.menuBarChartRange);
    this.preferences.refreshInterval=refreshSeconds(this.preferences.refreshInterval);
    this.preferences.menuBarRefreshInterval=refreshSeconds(this.preferences.menuBarRefreshInterval);
    this.preferences.widgetEnabled=this.preferences.widgetEnabled===true;
    this.preferences.widgetDataSource=this.preferences.widgetDataSource==='local' ? 'local' : 'api';
    this.preferences.widgetPeriod=normalizeWidgetPeriod(this.preferences.widgetPeriod);
    this.preferences.widgetInputMode=this.preferences.widgetInputMode==='uncached' ? 'uncached' : 'total';
    this.preferences.dataRefreshAnimation=refreshAnimation(this.preferences.dataRefreshAnimation);
    if(!this.preferences.widgetPosition || !Number.isSafeInteger(this.preferences.widgetPosition.x) || !Number.isSafeInteger(this.preferences.widgetPosition.y))this.preferences.widgetPosition=null;
    for(const field of ['dismissedUpdateVersion','skippedUpdateVersion'] as const)if (typeof this.preferences[field] !== 'string' || !/^(?:|(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*))$/.test(this.preferences[field]) || this.preferences[field].length>30) this.preferences[field] = '';
    this.encrypted = data.vault || '';
    if (this.encrypted) {
      try { this.secrets = JSON.parse(this.cipher.decrypt(this.encrypted)); }
      catch { this.vaultError = '系统无法解密已保存的凭据。请在原系统账户运行应用，或重新输入凭据。'; }
    }
    this.syncFlags();
  }
  private syncFlags() {
    this.preferences.sites = this.preferences.sites.map(s => ({ ...s, accessTokenConfigured: !!this.secrets[s.id]?.accessToken, apiKeyConfigured: !!this.secrets[s.id]?.apiKey, username: this.secrets[s.id]?.username, sessionAuth: !!this.secrets[s.id]?.sessionAuth }));
  }
  private async persist() {
    if (this.vaultError) throw new Error(this.vaultError);
    this.syncFlags();
    const hasSecrets = Object.values(this.secrets).some(s => Object.values(s).some(Boolean));
    if (hasSecrets && !this.cipher.available()) throw new Error('系统加密存储不可用，无法保存密钥。');
    this.encrypted = hasSecrets ? this.cipher.encrypt(JSON.stringify(this.secrets)) : '';
    const content = JSON.stringify({ version: 2, preferences: this.preferences, vault: this.encrypted }, null, 2);
    const write = this.pendingWrite.then(() => atomicWrite(path.join(this.directory, 'settings.json'), content));
    this.pendingWrite = write.catch(() => {});
    await write;
  }
  activeSite(): SiteProfile {
    const site = this.preferences.sites.find(s => s.id === this.preferences.activeSiteId);
    if (!site) throw new Error('请先添加站点。'); return site;
  }
  credentials(id = this.preferences.activeSiteId): SiteSecret {
    if (this.vaultError) throw new Error(this.vaultError);
    return structuredClone(this.secrets[id] || {});
  }
  async saveSite(input: SiteInput) {
    const url = normalizeUrl(input.url);
    const id = input.id || randomUUID();
    const previous = this.preferences.sites.find(s => s.id === id);
    if (input.id && !previous) throw new Error('站点不存在。');
    const site: SiteProfile = { id, name: input.name.trim(), url, userId: input.userId ?? (previous?.url === url ? previous.userId : undefined), allowHttp: input.allowHttp, accessTokenConfigured: false, apiKeyConfigured: false };
    // A changed origin must never inherit credentials for a different server.
    const secret = previous?.url === url ? { ...this.credentials(id) } : {};
    if (input.clearAccessToken) { for (const field of ['accessToken','cookies','accessExpiresAt','sessionAuth','username','userId','sessionId'] as const) delete secret[field]; }
    if (input.clearApiKey) delete secret.apiKey;
    if (input.accessToken?.trim()) { for (const field of ['cookies','accessExpiresAt','sessionAuth','username','sessionId'] as const) delete secret[field]; secret.accessToken = input.accessToken.trim().replace(/^Bearer\s+/i, ''); }
    if (input.apiKey?.trim()) secret.apiKey = input.apiKey.trim().replace(/^Bearer\s+/i, '');
    if (url.startsWith('http:') && Object.values(secret).some(Boolean) && !site.allowHttp) throw new Error('此站点使用 HTTP。勾选允许 HTTP 后才能保存和发送凭据。');
    const prevPreferences = structuredClone(this.preferences); const prevSecrets = structuredClone(this.secrets);
    try {
      this.secrets[id] = secret;
      this.preferences.sites = previous ? this.preferences.sites.map(s => s.id === id ? site : s) : [...this.preferences.sites, site];
      this.preferences.activeSiteId = id;
      if (previous && previous.url !== url) { this.preferences.bindings = this.preferences.bindings.filter(b => b.siteId !== id); this.preferences.managedTokens = this.preferences.managedTokens.filter(t => t.siteId !== id); delete this.preferences.viewSelections[id]; }
      await this.persist();
    } catch (e) { this.preferences = prevPreferences; this.secrets = prevSecrets; throw e; }
    return structuredClone(this.preferences);
  }
  async removeSite(id: string) {
    if (this.preferences.sites.length <= 1) throw new Error('请至少保留一个站点。');
    this.preferences.sites = this.preferences.sites.filter(s => s.id !== id); delete this.secrets[id]; this.preferences.managedTokens = this.preferences.managedTokens.filter(t => t.siteId !== id); this.preferences.bindings = this.preferences.bindings.filter(b => b.siteId !== id);
    delete this.preferences.viewSelections[id];
    if (this.preferences.activeSiteId === id) this.preferences.activeSiteId = this.preferences.sites[0].id;
    await this.persist(); return structuredClone(this.preferences);
  }
  async update(patch: PreferencePatch) {
    if(patch.interfacePriority && Object.keys(normalizeInterfacePriorities({[patch.interfacePriority.id]:patch.interfacePriority.priority})).length!==1)throw new Error('界面优先级无效。');
    if(patch.background && (!validBackgroundImage(patch.background.image) || !BACKGROUND_FITS.includes(patch.background.fit) || typeof patch.background.name!=='string' || patch.background.name.length>120))throw new Error('背景图片设置无效。');
    if(patch.interfaceSelection && !validInterfaceSelection(patch.interfaceSelection))throw new Error('外观选择设置无效。');
    if (patch.activeSiteId && !this.preferences.sites.some(s => s.id === patch.activeSiteId)) throw new Error('站点不存在。');
    if (patch.selection && !this.preferences.sites.some(s => s.id === patch.selection!.siteId)) throw new Error('站点已移除，请重新选择。');
    if (patch.selection && Object.keys(normalizeSelections({[patch.selection.siteId]: patch.selection.values})[patch.selection.siteId] || {}).length !== Object.keys(patch.selection.values).length) throw new Error('选择设置无效。');
    if(patch.sourceSelection && (!['source.local-sessions','feature.usage'].includes(patch.sourceSelection.sourceId) || Object.keys(normalizeSelections({[patch.sourceSelection.sourceId]:patch.sourceSelection.values})[patch.sourceSelection.sourceId] || {}).length!==Object.keys(patch.sourceSelection.values).length))throw new Error('来源选择设置无效。');
    const previousAppearance=this.preferences.interfaceSelections;
    const previousStyles={interfacePriorities:this.preferences.interfacePriorities,background:this.preferences.background,defaultInterfaceEnabled:this.preferences.defaultInterfaceEnabled};
    this.preferences = applyPreferencePatch(this.preferences, patch);
    const updatedAppearance=this.preferences.interfaceSelections;
    const updatedStyles={interfacePriorities:this.preferences.interfacePriorities,background:this.preferences.background,defaultInterfaceEnabled:this.preferences.defaultInterfaceEnabled};
    this.preferences.dataRefreshAnimation=refreshAnimation(this.preferences.dataRefreshAnimation);
    this.preferences.menuBarContents=normalizeMenuBarContents(this.preferences.menuBarContents);
    this.preferences.menuBarTotalsRange=normalizeMenuBarRange(this.preferences.menuBarTotalsRange);
    this.preferences.menuBarChartRange=normalizeMenuBarRange(this.preferences.menuBarChartRange);
    this.preferences.refreshInterval=refreshSeconds(this.preferences.refreshInterval);
    this.preferences.menuBarRefreshInterval=refreshSeconds(this.preferences.menuBarRefreshInterval);
    this.preferences.widgetDataSource=this.preferences.widgetDataSource==='local' ? 'local' : 'api';
    this.preferences.widgetPeriod=normalizeWidgetPeriod(this.preferences.widgetPeriod);
    this.preferences.widgetInputMode=this.preferences.widgetInputMode==='uncached' ? 'uncached' : 'total';
    this.preferences.logColumns = normalizeLogColumns(this.preferences.logColumns);
    try{await this.persist();}catch(error){if(patch.interfaceSelection && this.preferences.interfaceSelections===updatedAppearance)this.preferences.interfaceSelections=previousAppearance;for(const key of ['interfacePriorities','background','defaultInterfaceEnabled'] as const){if(this.preferences[key]===updatedStyles[key])Object.assign(this.preferences,{[key]:previousStyles[key]});}throw error;}
    return structuredClone(this.preferences);
  }
  async setPluginEnabled(id:string,enabled:boolean) {
    configurablePlugin(builtinManifests,id);
    if(typeof enabled!=='boolean')throw new Error('插件启用状态无效。');
    const previous=this.preferences.pluginEnabled,previousWidget=this.preferences.widgetEnabled;
    this.preferences.pluginEnabled={...previous,[id]:enabled};
    if(id==='surface.widget')this.preferences.widgetEnabled=enabled;
    try {await this.persist();}catch(e){this.preferences.pluginEnabled=previous;this.preferences.widgetEnabled=previousWidget;throw e;}
  }
  async setPluginView(id:string,view:import('../../shared/contracts/plugins').PluginViewId,enabled:boolean){
    validatePluginView(id,view);if(typeof enabled!=='boolean')throw new Error('显示状态无效。');
    const previous=this.preferences.pluginViews;
    this.preferences.pluginViews={...previous,[id]:{...previous[id],[view]:enabled}};
    try{await this.persist();}catch(error){this.preferences.pluginViews=previous;throw error;}
  }
  async setToolKey(tool: Tool, key: string, binding?: Partial<ToolBinding>, id = this.preferences.activeSiteId) {
    if (!this.preferences.sites.some(s => s.id === id)) throw new Error('站点已移除。');
    this.secrets[id] = { ...this.credentials(id), [tool === 'codex' ? 'codexKey' : 'claudeKey']: key };
    if (binding) { const old = this.preferences.bindings.find(b => b.tool === tool && b.siteId === id); const next = { tool, model: '', group: '', tokenName: '', ...old, ...binding, siteId: id }; this.preferences.bindings = [...this.preferences.bindings.filter(b => !(b.tool === tool && b.siteId === id)), next]; }
    await this.persist();
  }
  toolKey(tool: Tool) { const s = this.credentials(); return s[tool === 'codex' ? 'codexKey' : 'claudeKey'] || s.apiKey || ''; }
  async saveBinding(binding: ToolBinding) { this.preferences.bindings = [...this.preferences.bindings.filter(b => !(b.tool === binding.tool && b.siteId === binding.siteId)), binding]; await this.persist(); }
  assertSite(id: string, url: string) { const s = this.preferences.sites.find(s => s.id === id); if (!s || s.url !== url) throw new Error('站点已变更，请重新操作。'); return s; }
  async saveSession(id: string, url: string, secret: SiteSecret, expectedToken?: string) {
    const site = this.assertSite(id, url);
    if (expectedToken !== undefined && this.credentials(id).accessToken !== expectedToken) throw new Error('登录状态已变更，请重新操作。');
    if (!this.cipher.available()) throw new Error('系统加密存储不可用，无法保存登录凭证。');
    if (url.startsWith('http:') && !site.allowHttp) throw new Error('请在站点设置中允许 HTTP 后登录。');
    const old = this.credentials(id); const previous = structuredClone(this.preferences);
    try {
      // Never reuse another account's tool credentials or bookkeeping.
      const sameUser = old.userId !== undefined && old.userId === secret.userId;
      this.secrets[id] = { ...(sameUser ? old : {}), ...secret };
      if (!sameUser) { this.preferences.managedTokens = this.preferences.managedTokens.filter(t => t.siteId !== id); this.preferences.bindings = this.preferences.bindings.filter(b => b.siteId !== id); }
      this.preferences.sites = this.preferences.sites.map(s => s.id === id ? { ...s, userId: secret.userId } : s);
      await this.persist();
    } catch (e) { this.secrets[id] = old; this.preferences = previous; throw e; }
    return structuredClone(this.preferences);
  }
  async clearSession(id: string, expectedUrl?: string, expectedToken?: string) {
    if (expectedUrl) this.assertSite(id, expectedUrl);
    if (expectedToken !== undefined && this.credentials(id).accessToken !== expectedToken) return structuredClone(this.preferences);
    this.secrets[id] = {};
    this.preferences.sites = this.preferences.sites.map(s => s.id === id ? { ...s, userId: undefined, username: undefined } : s);
    this.preferences.bindings = this.preferences.bindings.filter(b => b.siteId !== id);
    this.preferences.managedTokens = this.preferences.managedTokens.filter(t => t.siteId !== id);
    await this.persist(); return structuredClone(this.preferences);
  }
  async registerToken(token: Preferences['managedTokens'][number], url: string) {
    this.assertSite(token.siteId, url);
    const old=this.preferences.managedTokens.find(t=>t.siteId===token.siteId && t.id===token.id);
    const previousNames=[...new Set([...(old?.previousNames || []),...(old && old.name!==token.name ? [old.name] : [])])].filter(name=>name!==token.name);
    this.preferences.managedTokens = [...this.preferences.managedTokens.filter(t => !(t.siteId === token.siteId && t.id === token.id)), {...token,...(previousNames.length ? {previousNames} : {})}];
    this.preferences.bindings=this.preferences.bindings.map(b=>b.siteId===token.siteId && b.tokenId===token.id ? {...b,tokenName:token.name,group:token.group} : b);
    await this.persist();
  }
  async syncTokenSettings(siteId:string,url:string,id:number,name:string,group:string) {
    this.assertSite(siteId,url);
    this.preferences.managedTokens=this.preferences.managedTokens.map(t=>t.siteId===siteId && t.id===id ? {...t,group} : t);
    this.preferences.bindings=this.preferences.bindings.map(b=>b.siteId===siteId && (b.tokenId===id || b.tokenName===name) ? {...b,group} : b);
    await this.persist();
  }
}
