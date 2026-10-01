import {normalizeHealth,normalizeHealthDetails} from '../../shared/health';
import { resolveRange,statisticsFilters,isRollingRange } from '../../shared/range';
import {filterLogs,logStat} from '../../shared/statistics';
import type { SettingsStore, SiteSecret, SessionCookie } from './store';
import { publicEncrypt, randomBytes, createCipheriv, randomUUID, createHash } from 'node:crypto';
import { normalizeCatalog, availableGroups } from '../../shared/catalog';
import {tokenSettings} from './token-controls';
import {DEFAULT_SITE_URL} from '../../shared/types';
import {ReadCache} from './read-cache';
import {appLogs} from './app-logs';
import {tokenPoints} from '../../shared/trends';
import {summarizeQuality} from '../../shared/usage-quality';
import {trackedToolTokenNames} from '../../shared/utils';
import {logMetrics} from '../../shared/logs';
import {DEFAULT_MENU_BAR_SELECTION} from '../../shared/menu-bar';
import type { ModelInfo, Dashboard, DashboardQuery, HealthSummary, ModelHealthDetails, SiteStatus, UserInfo, UsageStat, UsageLog, QuotaPoint, ModelCatalog, LogPage, LogQuery, ApiToken, CreateTokenInput, SiteProfile, Preferences } from '../../shared/types';
import type { LoginInput, LoginInfo, LoginResult, ConfigRequest, Tool, UpdateTokenInput, TokenUsage, UsageQuality,MenuBarUsage,MenuBarSelection,MenuBarDetails } from '../../shared/types';
export interface ResolvedToolToken { key: string; tokenName: string; tokenId: number; group: string; created: boolean; siteId: string; siteUrl: string; models?:ModelInfo[]; }
class ApiError extends Error { constructor(message: string, public status: number, public code?: string) { super(message); } }
interface Scope { site: SiteProfile; secret: SiteSecret; preferences: Preferences; }
interface Challenge { scope: Scope; cookies: SessionCookie[]; flowToken?: string; expiresAt: number; }

export function timeRange(query: DashboardQuery) { const r=resolveRange(query); return {start_timestamp:r.start_timestamp,end_timestamp:r.end_timestamp}; }
export class NewApiClient {
  private cache:ReadCache;
  private refreshes: Map<string, Promise<SiteSecret>>;
  private provisions: Map<string, Promise<ResolvedToolToken>>;
  private challenges: Map<string, Challenge>;
  constructor(private store: SettingsStore, private snapshot?: Scope, private owner?: NewApiClient) {
    this.cache=owner?.cache || new ReadCache();
    this.refreshes = owner?.refreshes || new Map(); this.provisions = owner?.provisions || new Map(); this.challenges = owner?.challenges || new Map();
  }
  private scope() { const site = structuredClone(this.store.activeSite()); return new NewApiClient(this.store, { site, secret: this.store.credentials(site.id), preferences: structuredClone(this.store.preferences) }, this.owner || this); }
  private current() { return this.snapshot || { site: structuredClone(this.store.activeSite()), secret: this.store.credentials(), preferences: structuredClone(this.store.preferences) }; }
  private checkScope(scope: Scope) { this.store.assertSite(scope.site.id, scope.site.url); }
  private checkTransport(site: SiteProfile) { if (site.url.startsWith('http:') && !site.allowHttp) throw new Error('此站点使用 HTTP，请先在站点设置中勾选允许 HTTP 再登录。'); }
  private cookieHeader(cookies: SessionCookie[], pathname: string) { return cookies.filter(c => (!c.expires || c.expires > Date.now()/1000) && (pathname === c.path || pathname.startsWith(c.path.replace(/\/$/, '') + '/'))).map(c => c.name + '=' + c.value).join('; '); }
  private readCookies(response: Response, previous: SessionCookie[] = []): SessionCookie[] {
    const cookies = [...previous];
    for (const raw of response.headers.getSetCookie()) {
      const [first, ...attrs] = raw.split(';'); const split = first.indexOf('='); if (split < 1) continue;
      const cookie: SessionCookie = { name: first.slice(0, split).trim(), value: first.slice(split + 1), path: '/' };
      if (!/^[\w-]+$/.test(cookie.name) || /[\r\n;]/.test(cookie.value)) continue;
      for (const attr of attrs) { const [key, ...v] = attr.trim().split('='); const value = v.join('='); if (key.toLowerCase() === 'path') cookie.path = value || '/'; if (key.toLowerCase() === 'expires') cookie.expires = Date.parse(value)/1000; if (key.toLowerCase() === 'max-age') cookie.expires = Date.now()/1000 + Number(value); }
      const index = cookies.findIndex(c => c.name === cookie.name && c.path === cookie.path); if (index >= 0) cookies.splice(index,1);
      if (!cookie.expires || cookie.expires > Date.now()/1000) cookies.push(cookie);
    }
    return cookies;
  }
  private async raw(scope: Scope, endpoint: string, options: { query?: Record<string, unknown>; method?: string; body?: unknown; secret?: SiteSecret; authenticated?: boolean } = {}) {
    this.checkScope(scope);
    if(scope.site.url===DEFAULT_SITE_URL)throw new Error('请先在设置中填写你的 New API 站点地址。');
    const url = new URL(scope.site.url + endpoint); const secret = options.secret || {};
    if (options.query) for (const [k,v] of Object.entries(options.query)) if (v !== undefined && v !== '') url.searchParams.set(k,String(v));
    const headers: Record<string,string> = { Accept: 'application/json', 'Cache-Control': 'no-store' };
    if (options.authenticated) {
      this.checkTransport(scope.site);
      if (secret.accessToken) headers.Authorization = 'Bearer ' + secret.accessToken;
      const userId = secret.userId || scope.site.userId; if (userId) headers['New-Api-User'] = String(userId);
      const cookies = this.cookieHeader(secret.cookies || [],url.pathname); if (cookies) headers.Cookie = cookies;
    }
    if (options.body !== undefined) headers['Content-Type'] = 'application/json';
    if (endpoint.startsWith('/api/user/auth/')) { headers.Origin = new URL(scope.site.url).origin; headers.Referer = scope.site.url + '/login'; if (secret.sessionId) headers['X-Auth-Session'] = secret.sessionId; }
    let response: Response;const started=performance.now(),requestLabel=(options.method || 'GET')+' '+endpoint;
    try { response = await fetch(url, { method: options.method || 'GET', headers, body: options.body === undefined ? undefined : JSON.stringify(options.body), signal: AbortSignal.timeout(20000), redirect: 'error' }); }
    catch (e: any) { appLogs.write('error','站点请求',requestLabel+' · '+(e.name==='TimeoutError' ? '超时' : '网络连接失败'));throw new Error(e.name === 'TimeoutError' ? '站点请求超时（20 秒）。' : '无法连接站点，请检查地址、网络及证书。'); }
    appLogs.write(response.ok ? 'debug' : 'warn','站点请求',`${requestLabel} · HTTP ${response.status} · ${Math.round(performance.now()-started)} ms`);
    let json: any; try { json = await response.json(); } catch { throw new ApiError('站点没有返回 JSON（HTTP ' + response.status + '）。请确认地址是 New API 站点。',response.status); }
    if (!response.ok || json.success === false) {
      const message = response.status === 401 ? '登录已过期，请重新登录当前站点。' : response.status === 403 ? '当前账户无权访问此接口。' : String(json.message || json.error?.message || '请求失败：HTTP ' + response.status);
      appLogs.write('warn','站点请求',requestLabel+' · '+message);
      throw new ApiError(message,response.status,json.code);
    }
    return { json, cookies: this.readCookies(response,secret.cookies) };
  }
  private async validSecret(scope: Scope): Promise<SiteSecret> {
    const current = this.store.credentials(scope.site.id);
    // A logged-out or changed account cannot be revived by an in-flight request.
    if (current.userId !== scope.secret.userId || current.sessionId !== scope.secret.sessionId || current.accessToken !== scope.secret.accessToken && !(scope.secret.sessionAuth && current.sessionAuth && current.sessionId && current.userId)) throw new Error('登录状态已变更，请刷新页面。');
    if (current.accessToken !== scope.secret.accessToken) return current;
    if (scope.secret.sessionAuth && scope.secret.accessExpiresAt && scope.secret.accessExpiresAt <= Date.now()/1000 + 45) return this.refreshSecret(scope);
    return scope.secret;
  }
  private async refreshSecret(scope: Scope): Promise<SiteSecret> {
    const id = scope.site.id; const existing = this.refreshes.get(id); if (existing) return existing;
    const job = (async () => {
      try {
        const r = await this.raw(scope,'/api/user/auth/refresh',{ method:'POST',authenticated:true,secret:scope.secret });
        const secret = this.bundle(r.json.data,r.cookies,scope.secret);
        await this.store.saveSession(id,scope.site.url,secret,scope.secret.accessToken);
        return secret;
      } catch (e) {
        if (e instanceof ApiError && e.status === 401) await this.store.clearSession(id,scope.site.url,scope.secret.accessToken);
        throw e;
      }
    })();
    this.refreshes.set(id,job); try { return await job; } finally { if (this.refreshes.get(id) === job) this.refreshes.delete(id); }
  }
  private async request(endpoint: string, options: { query?: Record<string, unknown>; method?: string; body?: unknown; public?: boolean } = {}): Promise<any> {
    const scope = this.current();
    this.checkScope(scope);
    const prefix=scope.site.id+'\0'+scope.site.url+'\0';
    if (options.public) {
      const result=await this.cache.get(prefix+'public:'+endpoint,300000,async()=>(await this.raw(scope,endpoint,options)).json);
      this.checkScope(scope);return result;
    }
    let secret = await this.validSecret(scope);
    if (!secret.accessToken && !secret.cookies?.length) throw new Error('请先用账号和密码登录当前站点。');
    const load=async()=>{
      try {return (await this.raw(scope,endpoint,{...options,secret,authenticated:true})).json;}
      catch(e){if(e instanceof ApiError && e.status===401 && secret.sessionAuth){secret=await this.refreshSecret({...scope,secret});return (await this.raw(scope,endpoint,{...options,secret,authenticated:true})).json;}throw e;}
    };
    const ttl=endpoint==='/api/pricing' ? 300000 : endpoint==='/api/data/self' || endpoint==='/api/log/self/stat' || endpoint.startsWith('/api/perf-metrics') ? 60000 : endpoint==='/api/token/' || endpoint==='/api/user/self' ? 30000 : endpoint==='/api/log/self' ? 15000 : 0;
    let result:any;
    if((options.method || 'GET')==='GET' && options.body===undefined && ttl){
      const identity=createHash('sha256').update(JSON.stringify([secret.userId,secret.sessionId,secret.accessToken,secret.cookies])).digest('hex');
      const entries=Object.entries(options.query || {}).filter(([,v])=>v!==undefined && v!=='').map(([key,value])=>[key,key==='end_timestamp' && typeof value==='number' && value>=Date.now()/1000-60 ? Math.floor(value/60)*60 : value]).sort(([a],[b])=>String(a).localeCompare(String(b)));
      result=await this.cache.get(prefix+identity+':'+endpoint+JSON.stringify(entries),ttl,load);
    }else{
      const mutation=(options.method || 'GET')!=='GET';
      if(mutation)this.cache.invalidate(prefix);
      try{result=await load();}finally{if(mutation)this.cache.invalidate(prefix);}
    }
    this.checkScope(scope);await this.validSecret(scope);
    return result;
  }
  private bundle(data: any, cookies: SessionCookie[], previous: SiteSecret = {}): SiteSecret {
    const user = data?.user || data;
    if (!Number.isInteger(user?.id) || user.id <= 0) throw new Error('站点没有返回有效的登录账户。');
    return { ...previous, accessToken: typeof data.access_token === 'string' ? data.access_token : previous.accessToken, cookies, accessExpiresAt: typeof data.access_expires_at === 'number' ? data.access_expires_at : previous.accessExpiresAt, userId:user.id, username:user.username || user.display_name || String(user.id), sessionId:data.session?.sid || previous.sessionId, sessionAuth:!!data.access_token && cookies.some(c => c.name === 'new_api_refresh') };
  }
  async loginInfo(): Promise<LoginInfo> { if (!this.snapshot) return this.scope().loginInfo(); if(this.snapshot.site.url===DEFAULT_SITE_URL)throw new Error('请先在设置中填写你的 New API 站点地址。');const s = await this.status(); return { enabled:s.password_login_enabled !== false, turnstile:!!s.turnstile_check, encryption:!!s.password_login_encryption_enabled, siteName:s.system_name }; }
  async login(input: LoginInput): Promise<LoginResult> {
    if (!this.snapshot) return this.scope().login(input);
    const scope = this.current(); this.checkTransport(scope.site); if (!this.store.cipher.available()) throw new Error('系统加密存储不可用，无法保存登录凭证。');
    const info = await this.loginInfo(); if (!info.enabled) throw new Error('此站点未启用账号密码登录。');
    if (info.turnstile && !input.turnstileToken) throw new Error('请使用站点安全登录窗口完成人机验证。');
    let body: any = { username:input.username.trim(),password:input.password };
    if (info.encryption) {
      const key = (await this.raw(scope,'/api/user/login/encryption-key')).json.data;
      if (!key?.public_key || !key?.kid) throw new Error('无法获取站点登录公钥。');
      const aes = randomBytes(32), iv = randomBytes(12); const cipher = createCipheriv('aes-256-gcm',aes,iv);
      const encrypted = Buffer.concat([cipher.update(input.password,'utf8'),cipher.final(),cipher.getAuthTag()]);
      const wrapped = publicEncrypt({ key:key.public_key,oaepHash:'sha256',oaepLabel:Buffer.from('password-v2') },aes);
      body = { username:input.username.trim(),password_encrypted:'v2.' + [wrapped,iv,encrypted].map(b => b.toString('base64')).join('.'),encryption_key_id:key.kid };
    }
    const r = await this.raw(scope,'/api/user/login',{ method:'POST',body,query:{ turnstile:input.turnstileToken },authenticated:true,secret:{} });
    const d = r.json.data;
    if (d?.require_verification || d?.require_2fa) {
      for (const [id,c] of this.challenges) if (c.expiresAt < Date.now()) this.challenges.delete(id);
      const id = randomUUID(); const expiresAt = d.expires_at ? d.expires_at*1000 : Date.now()+300000;
      this.challenges.set(id,{scope,cookies:r.cookies,flowToken:d.flow_token,expiresAt});
      return { state:'verification',challengeId:id,methods:Array.isArray(d.methods) ? d.methods.map((m: any) => typeof m === 'string' ? m : m.method || m.id).filter(Boolean) : ['2fa'],expiresAt };
    }
    return this.finishLogin(scope,d,r.cookies);
  }
  async verifyLogin(input: { challengeId: string; code: string }): Promise<LoginResult> {
    const challenge = this.challenges.get(input.challengeId); if (!challenge || challenge.expiresAt <= Date.now()) throw new Error('登录验证已过期，请重新登录。');
    const {scope,flowToken,cookies} = challenge; this.checkScope(scope);
    const r = await this.raw(scope,flowToken ? '/api/user/login/verify' : '/api/user/login/2fa',{ method:'POST',authenticated:true,secret:{cookies},body:flowToken ? { flow_token:flowToken,method:'2fa',code:input.code.trim() } : { code:input.code.trim() } });
    const result = await this.finishLogin(scope,r.json.data,r.cookies); this.challenges.delete(input.challengeId); return result;
  }
  private async finishLogin(scope: Scope, data: any, cookies: SessionCookie[],canCommit:()=>boolean = () => true): Promise<LoginResult> {
    let secret = this.bundle(data,cookies);
    if (!secret.accessToken) {
      // Legacy servers issue only a session cookie. Obtain their account PAT automatically.
      const r = await this.raw(scope,'/api/user/token',{secret,authenticated:true});
      const token = typeof r.json.data === 'string' ? r.json.data : r.json.data?.access_token;
      if (!token) throw new Error('登录成功，但站点没有返回可保存的账户凭证。'); secret = { ...secret,accessToken:token,sessionAuth:false };
    }
    const verified = (await this.raw(scope,'/api/user/self',{secret,authenticated:true})).json.data;
    if (verified?.id !== secret.userId) throw new Error('登录账户验证失败。');
    if (!canCommit()) throw new Error('登录已取消，未保存凭证。');
    return { state:'success',preferences:await this.store.saveSession(scope.site.id,scope.site.url,secret) };
  }
  async acceptBrowserSession(siteId: string,siteUrl: string,accessToken: string,cookies: SessionCookie[],canCommit:()=>boolean = () => true) {
    const site = this.store.assertSite(siteId,siteUrl); this.checkTransport(site);
    const scope: Scope = {site,secret:{},preferences:structuredClone(this.store.preferences)};
    const user = (await this.raw(scope,'/api/user/self',{secret:{accessToken,cookies},authenticated:true})).json.data;
    if (!accessToken) { const result = await this.finishLogin(scope,user,cookies,canCommit); if (result.state !== 'success') throw new Error('未完成登录'); return result.preferences; }
    let claim: any = {}; try { claim = JSON.parse(Buffer.from(accessToken.split('.')[1], 'base64url').toString()); } catch {}
    const secret = this.bundle({ access_token:accessToken,access_expires_at:claim.exp,session:{sid:claim.sid},user },cookies);
    if (!canCommit()) throw new Error('登录已取消，未保存凭证。');
    return this.store.saveSession(siteId,siteUrl,secret);
  }
  async logout(siteId: string) {
    const site = this.store.preferences.sites.find(s => s.id === siteId); if (!site) throw new Error('站点不存在。');
    const secret = this.store.credentials(siteId);
    this.cache.invalidate(siteId+'\0');
    if (secret.sessionAuth) { try { await this.raw({site,secret,preferences:this.store.preferences},'/api/user/auth/logout',{method:'POST',authenticated:true,secret}); } catch { /* Local logout must still remove the encrypted session. */ } }
    return this.store.clearSession(siteId,site.url,secret.accessToken);
  }
  async status(): Promise<SiteStatus> { if (!this.snapshot) return this.scope().status(); if(this.snapshot.site.url===DEFAULT_SITE_URL)return {system_name:'New API',quota_per_unit:0,password_login_enabled:false};return (await this.request('/api/status', { public: true })).data; }
  async catalog(): Promise<ModelCatalog> {
    if (!this.snapshot) return this.scope().catalog();
    return normalizeCatalog(await this.request('/api/pricing'));
  }
  async logs(q: LogQuery, window?: {start_timestamp:number;end_timestamp:number}): Promise<LogPage> {
    if (!this.snapshot) return this.scope().logs(q,window);
    if(q.models?.length || q.tokenIds?.length){
      const rows=filterLogs((await this.completeLogs(q.range || q.days,0)).rows,q).filter(row=>(!q.type || row.type===q.type) && (!q.model || row.model_name===q.model) && (!q.tokenName || row.token_name===q.tokenName));
      return {items:rows.slice((q.page-1)*q.pageSize,q.page*q.pageSize),total:rows.length,page:q.page,pageSize:q.pageSize};
    }
    const j = await this.request('/api/log/self', { query: { ...(window || timeRange(q.range || q.days)), p: q.page, page_size: q.pageSize, type: q.type || 0, model_name: q.model, token_name: q.tokenName } });
    // New API changed from an array to a paginated DTO; accept both shapes.
    const data = j.data;
    const items: UsageLog[] = Array.isArray(data) ? data : data?.items || [];
    return { items: items.map(l => ({ ...l, prompt_tokens: l.prompt_tokens || 0, completion_tokens: l.completion_tokens || 0, quota: l.quota || 0 })), total: Array.isArray(data) ? (typeof j.total === 'number' ? j.total : items.length) : data?.total ?? items.length, page: q.page, pageSize: q.pageSize };
  }
  async tokens(): Promise<ApiToken[]> {
    if (!this.snapshot) return this.scope().tokens();
    const items: ApiToken[] = [];
    for (let p = 1; p <= 20; p++) {
      const j = await this.request('/api/token/', { query: { p, page_size: 100 } });
      const data = j.data; const page: ApiToken[] = Array.isArray(data) ? data : data?.items || [];
      items.push(...page.map(({ ...t }) => { delete (t as any).key; return t; }));
      if (page.length < 100 || items.length >= (data?.total ?? j.total ?? Infinity)) break;
    }
    return items;
  }
  private async usageData(window: {start_timestamp:number;end_timestamp:number}): Promise<QuotaPoint[]> {
    // Some New API sites cap /api/data/self at one month per request.
    const chunkSeconds=28*86400;
    const windows=[];
    for(let start=window.start_timestamp;start<=window.end_timestamp;start+=chunkSeconds)
      windows.push({start_timestamp:start,end_timestamp:Math.min(start+chunkSeconds-1,window.end_timestamp)});
    const chunks=await Promise.all(windows.map(query=>this.request('/api/data/self',{query}).then(j=>j.data as QuotaPoint[])));
    return chunks.flat();
  }
  private async completeLogs(query:DashboardQuery,type=2,fixedWindow?:{start_timestamp:number;end_timestamp:number}):Promise<{rows:UsageLog[];fetchedAt:number}>{
    const scope=this.current(),secret=await this.validSecret(scope);
    const resolved=resolveRange(query),window=fixedWindow || {start_timestamp:resolved.start_timestamp,end_timestamp:resolved.end_timestamp};
    const identity=createHash('sha256').update(JSON.stringify([secret.userId,secret.sessionId,secret.accessToken,secret.cookies])).digest('hex');
    const cacheWindow={...window,...(isRollingRange(query) ? {start_timestamp:Math.floor(window.start_timestamp/60)*60} : {}),end_timestamp:window.end_timestamp>=Date.now()/1000-60 ? Math.floor(window.end_timestamp/60)*60 : window.end_timestamp};
    return this.cache.get(scope.site.id+'\0'+scope.site.url+'\0'+identity+':completeLogs:'+type+':'+JSON.stringify(cacheWindow),60000,async()=>{
      const rows:UsageLog[]=[];let expected:number|undefined;const ids=new Set<number>();
      for(let page=1;page<=101;page++){
        const j=await this.request('/api/log/self',{query:{...window,p:page,page_size:100,type}}),data=j.data;
        const items:UsageLog[]=Array.isArray(data) ? data : data?.items;
        if(!Array.isArray(items))throw new Error('站点未返回可用的消费日志。');
        const total=Array.isArray(data) ? j.total : data.total;
        if(Number.isSafeInteger(total) && total>=0){if(expected!==undefined && expected!==total)throw new Error('消费记录已变化，请重新加载曲线。');expected=total;}
        if(expected!==undefined && expected>10000 || rows.length+items.length>10000)throw new Error('详细统计超过 10,000 条消费日志，请缩小日期范围。');
        for(const item of items){if(!Number.isSafeInteger(item.id) || ids.has(item.id))throw new Error('消费日志分页不完整，请重新加载曲线。');ids.add(item.id);rows.push(item);}
        if(items.length<100 || expected!==undefined && rows.length>=expected){
          if(expected!==undefined && rows.length!==expected)throw new Error('消费日志分页不完整，请缩小日期范围后重试。');
          this.checkScope(scope);await this.validSecret(scope);
          return {rows:rows.filter(row=>row.created_at>=window.start_timestamp && row.created_at<=window.end_timestamp),fetchedAt:Date.now()};
        }
      }
      throw new Error('详细统计超过 10,000 条消费日志，请缩小日期范围。');
    }).then(async result=>{this.checkScope(scope);await this.validSecret(scope);return {...result,rows:result.rows.filter(row=>row.created_at>=window.start_timestamp && row.created_at<=window.end_timestamp)};});
  }
  async tokenUsage(query:DashboardQuery):Promise<TokenUsage>{
    if(!this.snapshot)return this.scope().tokenUsage(query);
    const resolved=resolveRange(query),filters=statisticsFilters(query),complete=await this.completeLogs(query,filters.models?.length || filters.tokenIds?.length ? 0 : 2,resolved),rows=filterLogs(complete.rows,filters).filter(r=>r.type===2),fetchedAt=complete.fetchedAt;
    return {points:tokenPoints(rows,resolved),quality:summarizeQuality(rows,resolved,fetchedAt),logCount:rows.length,fetchedAt};
  }
  async usageQuality(query:DashboardQuery):Promise<UsageQuality>{
    if(!this.snapshot)return this.scope().usageQuality(query);
    const scope=this.current(),secret=await this.validSecret(scope);
    const identity=createHash('sha256').update(JSON.stringify([secret.userId,secret.sessionId,secret.accessToken,secret.cookies])).digest('hex');
    // Keep today's key stable across minute refreshes; detailed metrics refresh every five minutes.
    const key=scope.site.id+'\0'+scope.site.url+'\0'+identity+':quality:'+JSON.stringify([isRollingRange(query) ? ['24h',new Date().toLocaleDateString('sv-SE')] : resolveRange(query).range,statisticsFilters(query)]);
    const value=await this.cache.get(key,300000,async()=>(await this.tokenUsage(query)).quality);
    this.checkScope(scope);await this.validSecret(scope);return value;
  }
  async menuBarUsage(force=false,selection:MenuBarSelection=DEFAULT_MENU_BAR_SELECTION):Promise<MenuBarUsage>{
    if(!this.snapshot)return this.scope().menuBarUsage(force,selection);
    const scope=this.current();if(force)this.cache.invalidate(scope.site.id+'\0');
    const todayWindow=timeRange(1),window=timeRange(selection.range || selection.days),statusTask=this.status(),empty={siteId:scope.site.id,siteName:scope.site.name,today:{quota:null,tokens:null,requests:null},tools:[],period:{selection,quota:null,tokens:null,requests:null,points:null},fetchedAt:Date.now(),warnings:[]};
    if(!scope.secret.accessToken && !scope.secret.cookies?.length)return {...empty,status:await statusTask,user:null};
    const results=await Promise.allSettled([statusTask,this.request('/api/user/self').then(j=>j.data as UserInfo),this.usageData(window),this.request('/api/log/self/stat',{query:{...window,type:2}}).then(j=>j.data as UsageStat),this.tokens(),this.request('/api/log/self/stat',{query:{...todayWindow,type:2}}).then(j=>j.data as UsageStat)]);
    if(results[0].status==='rejected')throw results[0].reason;
    if(results[1].status==='rejected')throw results[1].reason;
    let points=results[2].status==='fulfilled' ? results[2].value.filter(p=>p.created_at>=window.start_timestamp && p.created_at<=window.end_timestamp) : null;
    if(selection.range==='24h')points=(await this.menuBarDetails(selection).catch(()=>null))?.points ?? null;
    const known=results[4].status==='fulfilled' ? results[4].value : [];
    const names=trackedToolTokenNames(scope.preferences,scope.site.id,known);
    const toolResults=await Promise.allSettled(names.map(async b=>({tool:b.tool,quota:((await this.request('/api/log/self/stat',{query:{...window,type:2,token_name:b.name}})).data as UsageStat).quota})));
    const tools=(['codex','claude'] as const).map(tool=>{const rows=toolResults.filter((_,i)=>names[i].tool===tool);return {tool,quota:!rows.length || rows.some(r=>r.status==='rejected') ? null : rows.reduce((sum,r)=>sum+(r as PromiseFulfilledResult<{quota:number}>).value.quota,0)};});
    this.checkScope(scope);await this.validSecret(scope);
    const today=points?.filter(p=>p.created_at>=todayWindow.start_timestamp) ?? null;
    return {...empty,status:results[0].value,user:results[1].value,today:{quota:results[5].status==='fulfilled' ? results[5].value.quota : today?.reduce((s,p)=>s+p.quota,0) ?? null,tokens:today?.reduce((s,p)=>s+(p.token_used || 0),0) ?? null,requests:today?.reduce((s,p)=>s+(p.count || 0),0) ?? null},tools,
      period:{selection,quota:selection.tool==='all' ? results[3].status==='fulfilled' ? results[3].value.quota : points?.reduce((s,p)=>s+p.quota,0) ?? null : tools.find(t=>t.tool===selection.tool)?.quota ?? null,tokens:selection.tool==='all' ? points?.reduce((s,p)=>s+(p.token_used || 0),0) ?? null : null,requests:selection.tool==='all' ? points?.reduce((s,p)=>s+(p.count || 0),0) ?? null : null,points:selection.tool==='all' ? points : null},
      fetchedAt:Date.now(),warnings:[...results.slice(2).filter(r=>r.status==='rejected').map(()=> '部分统计不可用'),...toolResults.filter(r=>r.status==='rejected').map(()=> '工具统计不可用')]};
  }
  async menuBarDetails(selection:MenuBarSelection=DEFAULT_MENU_BAR_SELECTION):Promise<MenuBarDetails>{
    if(!this.snapshot)return this.scope().menuBarDetails(selection);
    const scope=this.current(),secret=await this.validSecret(scope),window=timeRange(selection.range || selection.days);
    const key=scope.site.id+'\0'+scope.site.url+'\0'+createHash('sha256').update(JSON.stringify([secret.userId,secret.sessionId,secret.accessToken,secret.cookies])).digest('hex')+':menuDetails:'+JSON.stringify([selection.range==='24h' ? ['24h',new Date().toLocaleDateString('sv-SE')] : resolveRange(selection.range || selection.days).range,selection.tool,scope.preferences.managedTokens,scope.preferences.bindings]);
    const details=await this.cache.get(key,300000,async()=>{
      const [complete,tokens]=await Promise.all([this.completeLogs(selection.range || selection.days,2,window),selection.tool==='all' ? Promise.resolve([]) : this.tokens()]);
      const tracked=trackedToolTokenNames(scope.preferences,scope.site.id,tokens).filter(t=>t.tool===selection.tool);
      if(selection.tool!=='all' && !tracked.length)throw new Error('尚未配置此工具的专用令牌。');
      const ids=new Set(tracked.map(t=>t.id));
      const rows=complete.rows.filter(r=>r.type===2 && (selection.tool==='all' || ids.has(r.token_id)));
      if(selection.tool!=='all' && complete.rows.some(r=>r.token_id===undefined))throw new Error('站点未提供令牌 ID，无法确认工具用量。');
      const sum=(values:(number|null|undefined)[])=>values.some(v=>typeof v!=='number' || !Number.isFinite(v) || v<0) ? null : (values as number[]).reduce((a,b)=>a+b,0);
      return {points:tokenPoints(rows,window).map(({token_name,token_id,...point})=>point),quality:summarizeQuality(rows,window,complete.fetchedAt),inputTokens:sum(rows.map(r=>r.prompt_tokens)),outputTokens:sum(rows.map(r=>r.completion_tokens)),cacheReadTokens:sum(rows.map(r=>logMetrics(r).cacheRead)),cacheWriteTokens:sum(rows.map(r=>logMetrics(r).cacheWrite))};
    });
    this.checkScope(scope);await this.validSecret(scope);return details;
  }
  async dashboard(query: DashboardQuery,force=false): Promise<Dashboard> {
    if (!this.snapshot) return this.scope().dashboard(query,force);
    if(force)this.cache.invalidate(this.snapshot.site.id+'\0');
    const fetchedAt=Date.now(),resolved=resolveRange(query,new Date(fetchedAt)); const {days,range}=resolved; const timestamps={start_timestamp:resolved.start_timestamp,end_timestamp:resolved.end_timestamp};
    const filters=statisticsFilters(query),detailed=!!(range.startTime || range.endTime || filters.models?.length || filters.tokenIds?.length);
    const statusTask = this.status();
    if (!this.snapshot.secret.accessToken && !this.snapshot.secret.cookies?.length) return { range,status:await statusTask,user:null,logs:{items:[],total:0,page:1,pageSize:100},series:[],stat:null,toolStats:[],catalog:{models:[],groupRatio:{},usableGroups:{},autoGroups:[],vendors:[]},tokens:[],warnings:[],fetchedAt,days };
    const names = ['账户余额', '请求记录', '用量曲线', '消费统计', '模型广场', 'API 令牌'];
    const results = await Promise.allSettled([
      this.request('/api/user/self').then(j => j.data as UserInfo),
      detailed ? Promise.resolve({items:[],total:0,page:1,pageSize:100}) : this.logs({ days, range, page: 1, pageSize: 100 },timestamps),
      detailed ? Promise.resolve([]) : this.usageData(timestamps),
      detailed ? Promise.resolve(null) : this.request('/api/log/self/stat', { query: { ...timestamps, type: 2 } }).then(j => j.data as UsageStat),
      this.catalog(), this.tokens(),
      this.request('/api/perf-metrics/summary',{query:{hours:24}}).then(j => normalizeHealth(j.data)),
      statusTask,
      detailed ? this.completeLogs(query,0,timestamps).then(({rows})=>filterLogs(rows,filters)) : Promise.resolve(null),
    ]);
    if(results[7].status==='rejected')throw results[7].reason;
    if(detailed && results[8].status==='rejected')throw results[8].reason;
    const status=results[7].value as SiteStatus;
    const value = <T>(i: number, fallback: T): T => results[i].status === 'fulfilled' ? (results[i] as PromiseFulfilledResult<T>).value : fallback;
    const knownTokens = value<ApiToken[]>(5, []);
    const prefs = this.snapshot?.preferences || this.store.preferences;
    const toolNames=trackedToolTokenNames(prefs,prefs.activeSiteId,knownTokens),bindings=detailed ? toolNames.filter((b,i)=>toolNames.findIndex(x=>x.tool===b.tool && x.id===b.id)===i) : toolNames;
    const detailRows=value<UsageLog[] | null>(8,null),detailStat=detailRows ? logStat(detailRows,timestamps) : null;
    const toolResults = await Promise.allSettled(bindings.map(async b => ({tool:b.tool,tokenName:b.name,stat:detailed ? detailRows && !detailRows.some(row=>row.type===2 && row.token_id===undefined) ? logStat(detailRows.filter(row=>row.token_id===b.id),timestamps) : null : (await this.request('/api/log/self/stat',{query:{...timestamps,type:2,token_name:b.name}})).data as UsageStat})));
    const toolStats = (['codex','claude'] as Tool[]).map(tool => { const rows = toolResults.filter((r,i) => bindings[i].tool === tool && r.status === 'fulfilled').map(r => (r as PromiseFulfilledResult<any>).value); const failed = toolResults.some((r,i) => bindings[i].tool === tool && (r.status === 'rejected' || r.value.stat===null)); return {tool,tokenName:rows.map(r => r.tokenName).join(', '),stat:!rows.length || failed ? null : rows.reduce((a,r) => ({quota:a.quota+r.stat.quota,rpm:a.rpm+r.stat.rpm,tpm:a.tpm+r.stat.tpm}),{quota:0,rpm:0,tpm:0})}; });
    const warnings = results.slice(0,6).flatMap((r, i) => r.status === 'rejected' ? [`${names[i]}：${r.reason.message}`] : []);
    toolResults.forEach((r, i) => { if (r.status === 'rejected') warnings.push(`${bindings[i].tool} 独立消费：${r.reason.message}`); });
    if (results[8].status === 'rejected') warnings.push('筛选统计：'+results[8].reason.message);
    const series=detailed ? tokenPoints(detailRows || [],timestamps) : value<QuotaPoint[]>(2,[]).filter(p=>p.created_at>=timestamps.start_timestamp && p.created_at<=timestamps.end_timestamp),stat=detailed ? detailStat : value<UsageStat|null>(3,null);
    const seriesAvailable=detailed ? detailRows!==null : results[2].status==='fulfilled';
    const interval={quota:stat?.quota ?? (seriesAvailable ? series.reduce((s,p)=>s+p.quota,0) : null),tokens:seriesAvailable ? series.reduce((s,p)=>s+(p.token_used || 0),0) : null,requests:seriesAvailable ? series.reduce((s,p)=>s+(p.count || 0),0) : null};
    return { range, query, detailed, quality:detailRows ? summarizeQuality(detailRows,timestamps) : undefined, interval,health:value<HealthSummary | null>(6,null),healthError:results[6].status === 'rejected' ? '健康度暂不可用：'+results[6].reason.message : undefined,status, toolStats, user: value<UserInfo | null>(0, null), logs: detailed ? {items:(detailRows || []).slice(0,100),total:detailRows?.length || 0,page:1,pageSize:100} : value(1, { items: [], total: 0, page: 1, pageSize: 100 }), series, stat, catalog: value(4, { models: [], groupRatio: {}, usableGroups: {}, autoGroups: [], vendors: [] }), tokens: value(5, []), warnings, fetchedAt, days };
  }
  async modelHealth(model: string): Promise<ModelHealthDetails> {
    if (!this.snapshot) return this.scope().modelHealth(model);
    const j=await this.request('/api/perf-metrics',{query:{model,hours:24}});
    return normalizeHealthDetails(j.data);
  }
  async allLogs(query: LogQuery, max = 10000): Promise<UsageLog[]> {
    if (!this.snapshot) return this.scope().allLogs(query, max);
    const rows: UsageLog[] = [];
    for (let page = 1; rows.length < max; page++) {
      const r = await this.logs({ ...query, page, pageSize: 100 }); rows.push(...r.items);
      if (r.total > max) throw new Error(`本次结果有 ${r.total} 条，超过 ${max} 条导出上限。请缩小日期或筛选范围。`);
      if (!r.items.length || r.items.length < 100 || rows.length >= r.total) break;
    }
    return rows;
  }
  async createToken(input: CreateTokenInput): Promise<void> {
    if (!this.snapshot) return this.scope().createToken(input);
    const catalog = await this.catalog();
    const settings=tokenSettings(input,catalog);
    const before = await this.tokens();
    if (input.tool && before.some(t => t.name === input.name)) throw new Error('工具专用令牌名称已存在，请使用不同名称或在工具页自动复用。');
    await this.request('/api/token/', { method: 'POST', body:settings });
    if (input.tool) {
      const after = await this.tokens(); const token = after.find(t => t.name === input.name && !before.some(old => old.id === t.id));
      if (!token) throw new Error('令牌已创建，但无法自动定位，请刷新后重试。');
      const key = await this.tokenKey(token.id);
      this.checkScope(this.current());
      await this.store.registerToken({siteId:this.snapshot!.site.id,tool:input.tool,id:token.id,name:token.name,group:input.group},this.snapshot!.site.url);
      await this.store.setToolKey(input.tool,key,{tokenName:token.name,tokenId:token.id,group:input.group},this.snapshot!.site.id);
    }
  }
  private async tokenKey(id: number): Promise<string> {
    let j: any;
    try { j = await this.request('/api/token/' + id + '/key',{method:'POST'}); }
    catch (e) { if (!(e instanceof ApiError) || ![404,405].includes(e.status)) throw e; j = await this.request('/api/token/' + id); }
    const key = typeof j.data === 'string' ? j.data : j.data?.key;
    if (!key || typeof key !== 'string' || /[•*\s]/.test(key)) throw new Error('站点未返回完整令牌密钥，无法自动配置。请检查账户读取密钥的权限。');
    return key.startsWith('sk-') ? key : 'sk-' + key;
  }
  async getTokenKey(id: number): Promise<string> {
    if (!this.snapshot) return this.scope().getTokenKey(id);
    if (!Number.isSafeInteger(id) || id <= 0) throw new Error('令牌 ID 无效。');
    const scope = this.current();
    if (!(await this.tokens()).some(t => t.id === id)) throw new Error('令牌已移除或不属于当前账户。');
    const key = await this.tokenKey(id);
    this.checkScope(scope);
    await this.validSecret(scope);
    if (this.store.activeSite().id !== scope.site.id) throw new Error('当前站点已切换，请重新读取密钥。');
    return key;
  }
  async ensureToolToken(req: ConfigRequest): Promise<ResolvedToolToken> {
    if (!this.snapshot) return this.scope().ensureToolToken(req);
    const scope = this.current(); const lock = scope.site.id + ':' + req.tool;
    const existing = this.provisions.get(lock);
    const job = (existing ? existing.catch(() => undefined) : Promise.resolve()).then(() => this.provision(req)); this.provisions.set(lock,job);
    try { return await job; } finally { if (this.provisions.get(lock) === job) this.provisions.delete(lock); }
  }
  private async provision(req: ConfigRequest): Promise<ResolvedToolToken> {
    const scope = this.current(); this.checkTransport(scope.site);
    const catalog = await this.catalog(); const model = catalog.models.find(m => m.model_name === req.model);
    if (!model) throw new Error('请选择站点提供的模型。');
    if (!availableGroups(model,catalog).includes(req.group)) throw new Error('所选渠道无法提供这个模型，请重新选择。');
    const tokens = await this.tokens(); const now = Date.now()/1000;
    await this.validSecret(scope);const prefs=this.store.preferences;
    const prefix = prefs.tokenPrefix || 'Lumi-';
    const label = req.tool === 'codex' ? 'Codex' : 'Claude';
    const name = (prefix + label).slice(0,50);
    const dedicated = prefs.managedTokens.filter(t => t.siteId === scope.site.id && t.tool === req.tool);
    const binding = prefs.bindings.find(b => b.tool === req.tool && b.siteId === scope.site.id);
    const valid = (t: ApiToken) => t.status === 1 && (t.expired_time <= 0 || t.expired_time > now) && (t.unlimited_quota || t.remain_quota > 0) && (!t.model_limits_enabled || (t.model_limits || '').split(',').map(s => s.trim()).includes(req.model)) && tokens.filter(x => x.name === t.name).length === 1 && !prefs.managedTokens.some(x => x.siteId === scope.site.id && x.tool !== req.tool && x.id === t.id) && !prefs.bindings.some(x => x.siteId === scope.site.id && x.tool !== req.tool && x.tokenName === t.name);
    let token = tokens.find(t=>valid(t) && t.name===name) || tokens.find(t=>valid(t) && t.id===binding?.tokenId && dedicated.some(x=>x.id===t.id)) || tokens.find(t=>valid(t) && dedicated.some(x=>x.id===t.id));
    let created = false;
    if (!token) {
      if(tokens.some(t=>t.name===name))throw new Error('专用令牌 '+name+' 已存在但不可用，请在 API 令牌页面检查状态、有效期、额度或模型限制。');
      await this.request('/api/token/',{method:'POST',body:{name,remain_quota:0,unlimited_quota:true,expired_time:-1,group:req.group,model_limits_enabled:false,model_limits:'',allow_ips:'',cross_group_retry:false}});
      token = (await this.tokens()).find(t => t.name === name && !tokens.some(x => x.id === t.id)); created = true;
      if (!token) throw new Error('专用令牌已创建，但未能读取。请刷新后重新预览。');
    }
    const key = await this.tokenKey(token.id);
    if(!created && (token.group!==req.group || token.name!==name)){
      if(tokens.some(t=>t.id!==token!.id && t.name===name))throw new Error('专用令牌名称冲突，请在 API 令牌页面处理后重试。');
      if(token.model_limits_enabled && (token.model_limits || '').split(',').map(s=>s.trim()).filter(Boolean).some(name=>!catalog.models.some(m=>m.model_name===name && availableGroups(m,catalog).includes(req.group))))throw new Error('已有模型限制与所选渠道不兼容，请先在 API 令牌页面调整限制。');
      const oldName=token.name;
      await this.request('/api/token/',{method:'PUT',body:{id:token.id,name,group:req.group,remain_quota:token.remain_quota,unlimited_quota:token.unlimited_quota,expired_time:token.expired_time,model_limits_enabled:!!token.model_limits_enabled,model_limits:token.model_limits || '',allow_ips:token.allow_ips || '',cross_group_retry:!!token.cross_group_retry}});
      token=(await this.tokens()).find(t=>t.id===token!.id);
      if(!token || token.group!==req.group || token.name!==name)throw new Error('专用令牌渠道更新未生效，请刷新后重试。');
      if(oldName!==name && !dedicated.some(t=>t.id===token!.id))await this.store.registerToken({siteId:scope.site.id,tool:req.tool,id:token.id,name:oldName,group:req.group},scope.site.url);
    }
    this.checkScope(scope);
    if (this.store.credentials(scope.site.id).userId !== scope.secret.userId) throw new Error('登录账户已改变，请重新预览。');
    await this.store.registerToken({siteId:scope.site.id,tool:req.tool,id:token.id,name:token.name,group:req.group},scope.site.url);
    this.checkScope(scope);
    return { key,tokenName:token.name,tokenId:token.id,group:req.group,created,siteId:scope.site.id,siteUrl:scope.site.url,...(req.tool==='codex' ? {models:catalog.models.filter(m=>availableGroups(m,catalog).includes(req.group) && (!token!.model_limits_enabled || (token!.model_limits || '').split(',').map(s=>s.trim()).includes(m.model_name)))} : {}) };
  }
  async toggleToken(id: number, enabled: boolean): Promise<void> { if (!this.snapshot) return this.scope().toggleToken(id, enabled); await this.request('/api/token/', { method: 'PUT', query: { status_only: true }, body: { id, status: enabled ? 1 : 2 } }); }
  async updateToken(input:UpdateTokenInput):Promise<void> {
    if(!this.snapshot)return this.scope().updateToken(input);
    if(!Number.isSafeInteger(input.id) || input.id<=0)throw new Error('无效令牌 ID。');
    const catalog=await this.catalog(),settings=tokenSettings(input,catalog);
    const current=(await this.tokens()).find(t=>t.id===input.id);
    if(!current)throw new Error('令牌不存在，请刷新后重试。');
    const scope=this.current(),managed=scope.preferences.managedTokens.some(t=>t.siteId===scope.site.id && t.id===input.id) || scope.preferences.bindings.some(b=>b.siteId===scope.site.id && (b.tokenId===input.id || b.tokenName===current.name));
    if(managed && settings.name!==current.name)throw new Error('工具专用令牌名称需保留，以维护历史消费归属。');
    const checkAccount=()=>{this.checkScope(scope);const secret=this.store.credentials(scope.site.id);if(secret.userId!==scope.secret.userId || secret.sessionId!==scope.secret.sessionId || (scope.secret.userId===undefined && secret.accessToken!==scope.secret.accessToken))throw new Error('登录账户已变更，请重新打开令牌控制。');};
    checkAccount();
    await this.request('/api/token/',{method:'PUT',body:{id:input.id,...settings}});
    checkAccount();
    if(managed)await this.store.syncTokenSettings(scope.site.id,scope.site.url,input.id,current.name,settings.group);
  }
}
