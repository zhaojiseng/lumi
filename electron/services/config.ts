import { readFile, mkdir, readdir, unlink } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { randomUUID, createHash } from 'node:crypto';
import { parse, stringify } from 'smol-toml';
import { atomicWrite, type SettingsStore } from './store';
import type { ResolvedToolToken } from './new-api';
import {planDirectHistory,applyStateChanges,type StateChange} from './codex-direct';
import {assertCodexIdle} from './codex-sessions';
import type { Tool, ConfigRequest, ConfigPreview, ToolConfigState, BackupInfo } from '../../shared/types';
interface Snapshot { path: string; content: string | null; }
interface Pending { preview: ConfigPreview; files: Snapshot[]; before: Snapshot[]; rows:StateChange[]; request: ConfigRequest; key: string; siteId: string; siteUrl: string; token: ResolvedToolToken; userId?: number; sessionId?: string; authIdentity: string; }
interface Backup extends BackupInfo { before: Snapshot[]; after: Snapshot[]; rows?:StateChange[]; }
const authIdentity = (s:ReturnType<SettingsStore['credentials']>) => s.sessionAuth && s.sessionId ? 'session:' + s.sessionId : 'bearer:' + (s.accessToken ? createHash('sha256').update(s.accessToken).digest('hex') : '');
const hash = (s: string | null) => createHash('sha256').update(s === null ? '<missing>' : s).digest('hex');
async function readOptional(file: string) { try { return await readFile(file, 'utf8'); } catch (e: any) { if (e.code === 'ENOENT') return null; throw e; } }
export function redact(content: string) {
  return content.replace(/((?:[\w.-]*(?:TOKEN|API_?KEY|SECRET|PASSWORD|CREDENTIAL|AUTHORIZATION|PRIVATE_KEY)[\w.-]*)["']?\s*[:=]\s*)["'][^"']*["']/gi, '$1"••••••••"')
    .replace(/("(?:access_token|refresh_token|id_token)"\s*:\s*)"[^"\n]*"/gi, '$1"••••••••"');
}
// Used only to disconnect obsolete Lumi-generated catalogs and restore historical backups.
const LEGACY_CODEX_CATALOG='lumi-model-catalog.json';
function disconnectLegacyCatalog(doc:Record<string,any>,configDir:string) {
  const legacy=path.resolve(configDir,LEGACY_CODEX_CATALOG);
  const matches=(value:unknown)=>{
    if(typeof value!=='string')return false;
    const resolved=path.resolve(configDir,value);
    return process.platform==='win32' ? resolved.toLowerCase()===legacy.toLowerCase() : resolved===legacy;
  };
  if(matches(doc.model_catalog_json))delete doc.model_catalog_json;
  for(const profile of Object.values(doc.profiles || {})){
    if(profile && typeof profile==='object' && matches((profile as any).model_catalog_json))delete (profile as any).model_catalog_json;
  }
}
export function buildCodex(config: string | null, auth: string | null, req: ConfigRequest, baseUrl: string, key: string, configDir?:string) {
  const doc: any = config?.trim() ? parse(config) : {};
  const credentials: any = auth?.trim() ? JSON.parse(auth) : {};
  doc.model = req.model; doc.model_provider = 'custom'; delete doc.model_reasoning_effort;
  doc.model_context_window=req.contextWindow ?? 272000;
  if(configDir)disconnectLegacyCatalog(doc,configDir);
  const profile=typeof doc.profile==='string' ? doc.profiles?.[doc.profile] : undefined;
  if(profile && typeof profile==='object'){profile.model=req.model;profile.model_provider='custom';profile.model_context_window=doc.model_context_window;delete profile.model_reasoning_effort;}
  doc.model_providers ??= {};
  doc.model_providers.custom = { name: 'Lumi · New API', base_url: baseUrl + '/v1', wire_api: 'responses', experimental_bearer_token:key, requires_openai_auth: !!credentials.tokens };
  if(doc.model_providers.lumi?.name==='Lumi · New API' && !Object.values(doc.profiles || {}).some((p:any)=>p.model_provider==='lumi'))delete doc.model_providers.lumi;
  return { config: stringify(doc), auth: JSON.stringify(credentials, null, 2) + '\n' };
}
export function buildClaude(content: string | null, req: ConfigRequest, baseUrl: string, key: string) {
  const doc: any = content?.trim() ? JSON.parse(content) : {};
  doc.env = { ...doc.env, ANTHROPIC_BASE_URL: baseUrl, ANTHROPIC_AUTH_TOKEN: key, ANTHROPIC_MODEL: req.model,
    ANTHROPIC_DEFAULT_SONNET_MODEL: req.sonnet || req.model,
    ANTHROPIC_DEFAULT_OPUS_MODEL: req.opus || req.model,
    ANTHROPIC_DEFAULT_HAIKU_MODEL: req.haiku || req.model,
  };
  delete doc.env.ANTHROPIC_API_KEY;
  doc.model = req.model;
  return JSON.stringify(doc, null, 2) + '\n';
}
export class ConfigService {
  private pending = new Map<string, Pending>();
  private busy = false;
  private homeDir: string;
  private respectEnvironment: boolean;
  invalidateTokenPreviews(id:number) { for(const [key,p] of this.pending)if(p.token.tokenId===id)this.pending.delete(key); }
  constructor(private store: SettingsStore, private dataDir: string, homeDir?: string, private resolveToken?: (req: ConfigRequest) => Promise<ResolvedToolToken>) {
    this.homeDir = homeDir || process.env.LUMI_TEST_HOME || os.homedir();
    this.respectEnvironment = !homeDir && !process.env.LUMI_TEST_HOME;
  }
  private async paths(tool: Tool) {
    const test = !this.respectEnvironment;
    const codex = !test && process.env.CODEX_HOME ? path.resolve(process.env.CODEX_HOME) : path.join(this.homeDir, '.codex');
    const claude = !test && process.env.CLAUDE_CONFIG_DIR ? path.resolve(process.env.CLAUDE_CONFIG_DIR) : path.join(this.homeDir, '.claude');
    return tool === 'codex' ? [path.join(codex, 'config.toml'), path.join(codex, 'auth.json')] : [path.join(claude, 'settings.json')];
  }
  async inspect(): Promise<ToolConfigState[]> {
    return Promise.all((['codex', 'claude'] as Tool[]).map(async tool => {
      const files = await this.paths(tool); const content = await readOptional(files[0]);
      try {
        const doc: any = content?.trim() ? (tool === 'codex' ? parse(content) : JSON.parse(content)) : {};
        const active=tool==='codex' && typeof doc.profile==='string' ? {...doc,...doc.profiles?.[doc.profile]} : doc;
        const auth = tool === 'codex' ? await readOptional(files[1]) : null;
        const credentials = auth?.trim() ? JSON.parse(auth) : {};
        return { tool, path: files[0], exists: content !== null, model: tool === 'codex' ? active.model : doc.env?.ANTHROPIC_MODEL || doc.model, baseUrl: tool === 'codex' ? doc.model_providers?.[active.model_provider]?.base_url : doc.env?.ANTHROPIC_BASE_URL, keyConfigured: tool === 'codex' ? !!(credentials.OPENAI_API_KEY || doc.model_providers?.[active.model_provider]?.experimental_bearer_token) : !!(doc.env?.ANTHROPIC_AUTH_TOKEN || doc.env?.ANTHROPIC_API_KEY),contextWindow:tool==='codex' ? active.model_context_window : undefined };
      } catch { return { tool, path: files[0], exists: content !== null, keyConfigured: false, error: '配置文件解析失败，请先修复 JSON / TOML 语法。' }; }
    }));
  }
  async preview(req: ConfigRequest): Promise<ConfigPreview> {
    const site = structuredClone(this.store.activeSite());
    if (site.url.startsWith('http:') && !site.allowHttp) throw new Error('请先在站点设置中允许使用 HTTP。');
    if (!this.resolveToken) throw new Error('自动配钥服务不可用。');
    if(req.tool==='codex' && req.contextWindow!==undefined && (!Number.isInteger(req.contextWindow) || req.contextWindow<4096 || req.contextWindow>10000000))throw new Error('上下文窗口请输入 4096–10000000 的整数 Tokens。');
    const paths = await this.paths(req.tool);
    const before = await Promise.all(paths.map(async p => ({ path:p,content:await readOptional(p) })));
    try {
      if(req.tool==='codex') {
        buildCodex(before[0].content,before[1].content,req,site.url,'validation-only',path.dirname(paths[0]));
      }else buildClaude(before[0].content,req,site.url,'validation-only');
    }
    catch { throw new Error('现有配置文件语法无效。为保留配置，已取消预览。请先检查 JSON / TOML。'); }
    const plannedHistory=req.tool==='codex' ? await planDirectHistory(path.dirname(paths[0]),before[0].content,req.model,req.contextWindow ?? 272000,this.respectEnvironment) : undefined;
    const token = await this.resolveToken(req);
    if (token.siteId !== site.id || token.siteUrl !== site.url || this.store.activeSite().id !== site.id) throw new Error('站点已变更，请重新预览。');
    const key = token.key; const account = this.store.credentials(site.id);
    let files: Snapshot[];let rows:StateChange[]=[];let sessionCount=0;
    try {
      if (req.tool === 'codex') {
        const result = buildCodex(before[0].content, before[1].content, req, site.url, key,path.dirname(paths[0]));
        files = [{ path: paths[0], content: result.config }, { path: paths[1], content: before[1].content }];
        const history=plannedHistory!;
        rows=history.rows;sessionCount=history.files.length;
        before.push(...history.files.map(f=>({path:f.path,content:f.content})));files.push(...history.files.map(f=>({path:f.path,content:f.after})));
      } else files = [{ path: paths[0], content: buildClaude(before[0].content, req, site.url, key) }];
    } catch { throw new Error('现有配置文件语法无效。为保留配置，已取消预览。请先检查 JSON / TOML。'); }
    for (const [id, p] of this.pending) if (p.preview.expiresAt < Date.now()) this.pending.delete(id);
    const preview: ConfigPreview = { token: { id:token.tokenId,name:token.tokenName,group:token.group,created:token.created },id: randomUUID(), tool: req.tool, expiresAt: Date.now() + 300000,
      files: files.slice(0,paths.length).map((f, i) => ({ path: f.path, before: redact(before[i].content || '# 文件尚不存在'), after: redact(f.content || '# 文件尚不存在') })),
      changes: [],
    };
    preview.changes=req.tool==='codex' ? [`模型：${req.model}`,`上下文窗口：${req.contextWindow ?? 272000} Tokens`,`渠道：${req.group}`,`直连接口：${site.url}/v1`,`固定 custom provider，专用密钥写入 provider 表；保留现有官方登录。`,`同时更新 ${sessionCount} 个历史会话文件、${rows.length} 个会话索引；包含归档的 Lumi / 当前 custom 对话，其他渠道不修改。`,`历史请求、用量与提示词保持原样；只切换会话渠道和最近保存的模型设置。`,`配置、会话和索引变更一起加密备份；应用前关闭 Codex，之后重新打开原对话。`] : [`模型：${req.model}`,`渠道：${req.group}`,`Claude Code CLI 直连：${site.url}`,`专用令牌：${token.tokenName}`,`仅写入 Claude Code CLI 的 settings.json。`,`保留已有 MCP、权限与其他配置；应用后重新启动 Claude Code。`];
    this.pending.set(preview.id, { preview, files, before, rows,request: req, key, siteId: site.id, siteUrl: site.url,token,userId:account.userId,sessionId:account.sessionId,authIdentity:authIdentity(account) }); return preview;
  }
  private async transaction(before: Snapshot[], after: Snapshot[]) {
    const changed: Snapshot[] = [];
    try {
      for (let i = 0; i < after.length; i++) {
        changed.push(before[i]);
        if (after[i].content === null) { try { await unlink(after[i].path); } catch (e: any) { if (e.code !== 'ENOENT') throw e; } }
        else await atomicWrite(after[i].path, after[i].content!);
      }
    } catch (cause) {
      const failures: string[] = [];
      for (const f of changed.reverse()) { try { if (f.content === null) await unlink(f.path).catch(e => { if (e.code !== 'ENOENT') throw e; }); else await atomicWrite(f.path, f.content); } catch { failures.push(f.path); } }
      throw new Error(failures.length ? `写入失败，以下文件回滚失败：${failures.join('、')}。请使用加密备份恢复。` : '配置写入失败，已恢复原文件。请检查文件权限。', { cause });
    }
  }
  private async saveBackup(backup: Backup) {
    if (!this.store.cipher.available()) throw new Error('系统加密存储不可用，无法安全备份配置。');
    const directory = path.join(this.dataDir, 'backups'); await mkdir(directory, { recursive: true });
    await atomicWrite(path.join(directory, backup.id + '.json'), JSON.stringify({ version: 1, encrypted: this.store.cipher.encrypt(JSON.stringify(backup)) }));
  }
  private async readBackup(id: string): Promise<Backup> {
    if (!/^[a-zA-Z0-9-]+$/.test(id)) throw new Error('无效备份 ID。');
    const data = JSON.parse(await readFile(path.join(this.dataDir, 'backups', id + '.json'), 'utf8'));
    const backup:Backup=JSON.parse(this.store.cipher.decrypt(data.encrypted));
    // Historical multi-file Claude backups now restore only the CLI configuration.
    if(backup.tool==='claude' && backup.before.length>1){
      const [cliPath]=await this.paths('claude');
      const index=backup.before.findIndex(f=>f.path===cliPath);
      if(index<0 || backup.after[index]?.path!==cliPath)throw new Error('备份路径与当前工具目录不匹配。');
      backup.before=[backup.before[index]];backup.after=[backup.after[index]];backup.paths=[cliPath];delete backup.rows;
    }
    return backup;
  }
  async apply(id: string) {
    if (this.busy) throw new Error('正在写入配置，请稍后重试。');
    const p = this.pending.get(id);
    if (!p || p.preview.expiresAt < Date.now()) throw new Error('预览已过期，请重新预览配置。');
    const token=this.store.preferences.managedTokens.find(t=>t.siteId===p.siteId && t.id===p.token.tokenId);
    if(token && (token.group!==p.request.group || token.name!==p.token.tokenName))throw new Error('专用令牌的渠道已变更，请重新预览配置。');
    if (this.store.activeSite().id !== p.siteId || this.store.activeSite().url !== p.siteUrl || this.store.credentials(p.siteId).userId !== p.userId || this.store.credentials(p.siteId).sessionId !== p.sessionId || authIdentity(this.store.credentials(p.siteId)) !== p.authIdentity) throw new Error('站点或登录账户已切换，请重新预览。');
    this.busy = true;
    try {
      if(p.request.tool==='codex' && this.respectEnvironment)await assertCodexIdle();
      for (const f of p.before) if (hash(await readOptional(f.path)) !== hash(f.content)) throw new Error('配置在预览后被其他程序修改，请重新预览。');
      const backup: Backup = { id: randomUUID(), tool: p.request.tool, createdAt: Date.now(), paths: p.files.map(f => f.path), before: p.before, after: p.files,rows:p.rows };
      await this.saveBackup(backup);
      await this.transaction(p.before, p.files);
      let stateApplied=false;
      try {
        applyStateChanges(p.rows);stateApplied=true;
        await this.store.setToolKey(p.request.tool, p.key, undefined, p.siteId);
        await this.store.saveBinding({ tool: p.request.tool, model: p.request.model, group: p.request.group,contextWindow:p.request.tool==='codex' ? p.request.contextWindow ?? 272000 : undefined, tokenName: p.token.tokenName,tokenId:p.token.tokenId, sonnet: p.request.sonnet, opus: p.request.opus, haiku: p.request.haiku, siteId: p.siteId, appliedAt: Date.now() });
      } catch (e) {if(stateApplied)applyStateChanges(p.rows,true); await this.transaction(p.files, p.before); throw e; }
      this.pending.delete(id); return this.inspect();
    } finally { this.busy = false; }
  }
  async backups(): Promise<BackupInfo[]> {
    let files: string[];
    try { files = await readdir(path.join(this.dataDir, 'backups')); } catch (e: any) { if (e.code === 'ENOENT') return []; throw e; }
    const rows = [];
    for (const file of files.filter(f => f.endsWith('.json'))) { const b = await this.readBackup(file.slice(0, -5)); rows.push({ id: b.id, tool: b.tool, createdAt: b.createdAt, paths: b.paths }); }
    return rows.sort((a, b) => b.createdAt - a.createdAt);
  }
  async restore(id: string) {
    if (this.busy) throw new Error('正在写入配置，请稍后重试。');
    this.busy = true;
    try {
      const b = await this.readBackup(id);
      const allowed=await this.paths(b.tool);
      if(b.tool==='codex')allowed.push(path.join(path.dirname(allowed[0]),LEGACY_CODEX_CATALOG));
      const paths=b.before.map(f=>f.path);
      const codexHome=path.dirname(allowed[0]);
      const sessionPath=(p:string)=>b.tool==='codex' && [path.join(codexHome,'sessions'),path.join(codexHome,'archived_sessions')].some(root=>{const rel=path.relative(root,p);return !!rel && !rel.startsWith('..') && !path.isAbsolute(rel) && p.endsWith('.jsonl');});
      if(!paths.length || new Set(paths).size!==paths.length || paths.some(p=>!allowed.includes(p) && !sessionPath(p)) || b.after.length!==b.before.length || b.after.some((f,i)=>f.path!==paths[i]))throw new Error('备份路径与当前工具目录不匹配。');
      if(b.tool==='codex' && this.respectEnvironment)await assertCodexIdle();
      const current = await Promise.all(paths.map(async p => ({ path: p, content: await readOptional(p) })));
      for (let i = 0; i < current.length; i++) if (hash(current[i].content) !== hash(b.after[i].content)) throw new Error('当前配置已在备份后发生变化。请先在工具页重新预览并应用配置，再恢复，避免覆盖其他程序的修改。');
      await this.saveBackup({ id: randomUUID(), tool: b.tool, createdAt: Date.now(), paths, before: current, after: b.before,rows:b.rows?.map(r=>({...r,before:r.after,after:r.before})) });
      await this.transaction(current, b.before);
      try{applyStateChanges(b.rows || [],true);}catch(e){await this.transaction(b.before,current);throw e;}
      return this.inspect();
    } finally { this.busy = false; }
  }
}
