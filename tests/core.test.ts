
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, access } from 'node:fs/promises';
import path from 'node:path';
import { createServer, type Server } from 'node:http';
import { parse } from 'smol-toml';
import { SettingsStore, normalizeUrl, type Cipher } from '../electron/services/store';
import { ConfigService, buildCodex, buildClaude, redact } from '../electron/services/config';
import { LocalUsageService } from '../electron/services/local-usage';
import { NewApiClient } from '../electron/services/new-api';
import { currency, csvEscape, toolForLog } from '../shared/utils';
import type { ResolvedToolToken } from '../electron/services/new-api';
import type { ConfigRequest, UsageLog } from '../shared/types';
const testRoot = path.resolve('.test-data');
const cipher: Cipher = { available: () => true, encrypt: s => Buffer.from(s).toString('base64'), decrypt: s => Buffer.from(s, 'base64').toString() };
// This test cipher only makes serialization assertions; production uses Electron safeStorage.
async function fixture() {
  await mkdir(testRoot, { recursive: true }); const root = await mkdtemp(path.join(testRoot, 'case-'));
  const home = path.join(root, 'home'); await mkdir(home, { recursive: true });
  const store = new SettingsStore(path.join(root, 'app'), cipher); await store.load();
  await store.saveSite({ id: store.activeSite().id, name: 'Fixture', url: 'https://fixture.invalid', allowHttp: false, accessToken: 'account-secret', apiKey: 'sk-fixture-only' });
  const configs = new ConfigService(store,path.join(root,'app'),home,async req => ({key:store.toolKey(req.tool),tokenName:'Lumi-Codex',tokenId:1,group:req.group,created:false,siteId:store.activeSite().id,siteUrl:store.activeSite().url}));
  return { root, home, store, configs };
}
const request: ConfigRequest = { tool: 'codex', model: 'fixture-codex', group:'default' };
test('site URLs are normalized and reject embedded credentials and unsupported schemes', () => {
  assert.equal(normalizeUrl('https://example.com/v1/'), 'https://example.com');
  assert.equal(normalizeUrl('https://example.com/new-api/api'), 'https://example.com/new-api');
  for (const value of ['file:///etc/passwd', 'https://user:secret@example.com', 'https://example.com?token=secret', 'not-a-url']) assert.throws(() => normalizeUrl(value));
});
test('HTTP requires explicit consent before storing credentials', async () => {
  const { store } = await fixture();
  await assert.rejects(store.saveSite({ name: 'HTTP', url: 'http://fixture.invalid', allowHttp: false, accessToken: 'secret' }), /HTTP/);
});
test('changing a site URL cannot carry secrets to a new origin', async () => {
  const { store, root } = await fixture(); const id = store.activeSite().id;
  await store.setToolKey('codex', 'sk-codex-private');
  await store.saveSite({ id, name: 'Changed', url: 'https://different.invalid', allowHttp: false });
  assert.equal(store.credentials(id).accessToken, undefined); assert.equal(store.toolKey('codex'), '');
  const file = await readFile(path.join(root, 'app', 'settings.json'), 'utf8'); assert.ok(!file.includes('account-secret')); assert.ok(!file.includes('sk-codex-private'));
});
test('encrypted settings restore secrets but never include raw keys in preferences', async () => {
  const { root, store } = await fixture(); const again = new SettingsStore(path.join(root, 'app'), cipher); await again.load();
  assert.equal(again.credentials().accessToken, 'account-secret'); assert.equal(again.toolKey('codex'), 'sk-fixture-only');
  assert.ok(!JSON.stringify(store.preferences).includes('sk-fixture-only'));
});

test('dismissing an update survives restart and site changes and can be restored',async()=>{
  const {root,store}=await fixture();
  assert.equal(store.preferences.dismissedUpdateVersion,'');
  await store.update({dismissedUpdateVersion:'1.2.3'});
  await store.saveSite({name:'Other',url:'https://other.invalid',allowHttp:false});
  const again=new SettingsStore(path.join(root,'app'),cipher);await again.load();
  assert.equal(again.preferences.dismissedUpdateVersion,'1.2.3');
  await again.update({dismissedUpdateVersion:''});
  const restored=new SettingsStore(path.join(root,'app'),cipher);await restored.load();
  assert.equal(restored.preferences.dismissedUpdateVersion,'');
  const file=path.join(root,'app','settings.json'),saved=JSON.parse(await readFile(file,'utf8'));
  saved.preferences.dismissedUpdateVersion={version:'1.2.3'};await writeFile(file,JSON.stringify(saved));
  const migrated=new SettingsStore(path.join(root,'app'),cipher);await migrated.load();
  assert.equal(migrated.preferences.dismissedUpdateVersion,'');
});
test('skipping an update is separate from hiding its notice and persists through restart',async()=>{
  const {root,store}=await fixture();await store.update({skippedUpdateVersion:'1.2.3',dismissedUpdateVersion:'1.2.2'});
  const again=new SettingsStore(path.join(root,'app'),cipher);await again.load();assert.equal(again.preferences.skippedUpdateVersion,'1.2.3');assert.equal(again.preferences.dismissedUpdateVersion,'1.2.2');
  await again.update({dismissedUpdateVersion:''});assert.equal(again.preferences.skippedUpdateVersion,'1.2.3');await again.update({skippedUpdateVersion:''});
  const restored=new SettingsStore(path.join(root,'app'),cipher);await restored.load();assert.equal(restored.preferences.skippedUpdateVersion,'');
});
test('floating widget data source persists and invalid values fall back to API',async()=>{
  const {root,store}=await fixture();assert.equal(store.preferences.widgetDataSource,'api');
  await store.update({widgetDataSource:'local'});
  const saved=new SettingsStore(path.join(root,'app'),cipher);await saved.load();assert.equal(saved.preferences.widgetDataSource,'local');
  const file=path.join(root,'app','settings.json'),raw=JSON.parse(await readFile(file,'utf8'));raw.preferences.widgetDataSource='invalid';await writeFile(file,JSON.stringify(raw));
  const migrated=new SettingsStore(path.join(root,'app'),cipher);await migrated.load();assert.equal(migrated.preferences.widgetDataSource,'api');
});
test('Codex direct config preserves unrelated TOML and official login, keeping the gateway token in its provider', () => {
  const before = '[projects."/sample"]\ntrust_level = "trusted"\n\n[mcp_servers.docs]\ncommand = "sample"\n';
  const r = buildCodex(before, JSON.stringify({ auth_mode: 'chatgpt', tokens: { access_token: 'old-token' }, custom: 3 }), request, 'https://gateway.invalid', 'sk-config-only');
  const parsed: any = parse(r.config); const auth = JSON.parse(r.auth);
  assert.equal(parsed.projects['/sample'].trust_level, 'trusted'); assert.equal(parsed.mcp_servers.docs.command, 'sample');
  assert.equal(parsed.model_providers.custom.wire_api, 'responses'); assert.equal(parsed.model_providers.custom.base_url, 'https://gateway.invalid/v1');
  assert.equal(parsed.model_providers.custom.experimental_bearer_token,'sk-config-only');assert.equal(parsed.model_providers.custom.requires_openai_auth,true);
  assert.equal(auth.OPENAI_API_KEY, undefined); assert.equal(auth.auth_mode, 'chatgpt'); assert.deepEqual(auth.tokens, {access_token:'old-token'}); assert.equal(auth.custom, 3);
});
test('Claude config merge preserves permission settings and replaces conflicting API auth', () => {
  const r = JSON.parse(buildClaude(JSON.stringify({ permissions: { allow: ['Read'] }, env: { CUSTOM_VAR: 'kept', ANTHROPIC_API_KEY: 'old' } }), { ...request, tool: 'claude', model: 'custom-sonnet', opus: 'custom-opus' }, 'https://gateway.invalid', 'sk-claude-only'));
  assert.deepEqual(r.permissions.allow, ['Read']); assert.equal(r.env.CUSTOM_VAR, 'kept'); assert.equal(r.env.ANTHROPIC_API_KEY, undefined);
  assert.equal(r.env.ANTHROPIC_DEFAULT_OPUS_MODEL, 'custom-opus'); assert.equal(r.env.ANTHROPIC_DEFAULT_HAIKU_MODEL, 'custom-sonnet');
  assert.equal(r.env.CLAUDE_CODE_ATTRIBUTION_HEADER,'false');
});

test('Claude attribution option writes a string by default and removes only that setting when disabled',()=>{
  const original={permissions:{allow:['Read']},env:{CUSTOM_VAR:'kept',CLAUDE_CODE_ATTRIBUTION_HEADER:'true'}};
  for(const disableAttributionHeader of [undefined,true,false]){
    const result=JSON.parse(buildClaude(JSON.stringify(original),{...request,tool:'claude',disableAttributionHeader},'https://gateway.invalid','fixture-key'));
    assert.equal(result.env.CLAUDE_CODE_ATTRIBUTION_HEADER,disableAttributionHeader===false ? undefined : 'false');
    assert.equal(result.env.CUSTOM_VAR,'kept');assert.deepEqual(result.permissions,original.permissions);
  }
});

test('Claude context window defaults to 256k and custom values override the old window without changing unrelated settings',()=>{
  const original={permissions:{allow:['Read']},env:{CUSTOM_VAR:'kept',CLAUDE_CODE_MAX_CONTEXT_TOKENS:'200000'}};
  for(const contextWindow of [undefined,256000,1000000,4096]){
    const result=JSON.parse(buildClaude(JSON.stringify(original),{...request,tool:'claude',contextWindow},'https://gateway.invalid','fixture-key'));
    assert.equal(result.env.CLAUDE_CODE_MAX_CONTEXT_TOKENS,String(contextWindow ?? 256000));
    assert.equal(result.env.CUSTOM_VAR,'kept');assert.deepEqual(result.permissions,original.permissions);
  }
});

test('Claude custom context is previewed, applied, inspected, persisted and restored; invalid lengths do not provision tokens',async()=>{
  const {configs,home,store}=await fixture(),dir=path.join(home,'.claude');await mkdir(dir);
  const file=path.join(dir,'settings.json'),original=JSON.stringify({env:{CLAUDE_CODE_MAX_CONTEXT_TOKENS:'200000',CUSTOM_VAR:'kept'}});await writeFile(file,original);
  for(const contextWindow of [0,4095,10000001,256000.5,NaN,Infinity])await assert.rejects(configs.preview({...request,tool:'claude',contextWindow}),/4096/);
  const preview=await configs.preview({...request,tool:'claude',contextWindow:1000000});
  assert.ok(preview.changes.some(change=>change.includes('1000000') && change.includes('CLAUDE_CODE_MAX_CONTEXT_TOKENS')));assert.equal(await readFile(file,'utf8'),original);
  await configs.apply(preview.id);
  assert.equal(JSON.parse(await readFile(file,'utf8')).env.CLAUDE_CODE_MAX_CONTEXT_TOKENS,'1000000');
  assert.equal((await configs.inspect()).find(state=>state.tool==='claude')?.contextWindow,1000000);
  assert.equal(store.preferences.bindings.find(binding=>binding.tool==='claude')?.contextWindow,1000000);
  await configs.restore((await configs.backups())[0].id);assert.equal(await readFile(file,'utf8'),original);
});

test('Claude attribution choice survives preview/apply and backup restores the original settings',async()=>{
  const {configs,home,store}=await fixture(),dir=path.join(home,'.claude');await mkdir(dir);
  const file=path.join(dir,'settings.json'),original=JSON.stringify({env:{CUSTOM_VAR:'kept'},permissions:{allow:['Read']}});await writeFile(file,original);
  const preview=await configs.preview({...request,tool:'claude'});assert.ok(preview.changes.some(change=>change.includes('CLAUDE_CODE_ATTRIBUTION_HEADER')));assert.equal(await readFile(file,'utf8'),original);
  await configs.apply(preview.id);assert.equal(JSON.parse(await readFile(file,'utf8')).env.CLAUDE_CODE_ATTRIBUTION_HEADER,'false');
  const enabledBackup=(await configs.backups())[0];
  assert.equal(store.preferences.bindings.find(binding=>binding.tool==='claude')?.disableAttributionHeader,true);
  const disabled=await configs.preview({...request,tool:'claude',disableAttributionHeader:false});await configs.apply(disabled.id);
  assert.equal(JSON.parse(await readFile(file,'utf8')).env.CLAUDE_CODE_ATTRIBUTION_HEADER,undefined);
  assert.equal(store.preferences.bindings.find(binding=>binding.tool==='claude')?.disableAttributionHeader,false);
  const disabledBackup=(await configs.backups()).find(backup=>backup.id!==enabledBackup.id)!;
  await configs.restore(disabledBackup.id);assert.equal(JSON.parse(await readFile(file,'utf8')).env.CLAUDE_CODE_ATTRIBUTION_HEADER,'false');
  await configs.restore(enabledBackup.id);assert.equal(await readFile(file,'utf8'),original);
});
test('all displayed config credentials are redacted', () => {
  const input = 'OPENAI_API_KEY = "sk-abc"\nexperimental_bearer_token = "custom-secret"\n{"tokens":{"access_token":"oauth-a","refresh_token":"oauth-r","id_token":"oauth-id"},"ANTHROPIC_AUTH_TOKEN":"sk-claude"}';
  const r = redact(input); for (const value of ['sk-abc','custom-secret','oauth-a','oauth-r','oauth-id','sk-claude']) assert.ok(!r.includes(value));
});
test('preview leaves local files intact and application creates a reversible backup', async () => {
  const { configs, home, root } = await fixture(); const dir = path.join(home, '.codex'); await mkdir(dir);
  const config = '# original comment\nmodel = "original"\n'; const auth = '{"tokens":{"access_token":"original-account"}}';
  await writeFile(path.join(dir, 'config.toml'), config); await writeFile(path.join(dir, 'auth.json'), auth);
  const p = await configs.preview(request); assert.ok(p.files.every(f => !f.after.includes('sk-fixture-only'))); assert.equal(await readFile(path.join(dir, 'config.toml'), 'utf8'), config);
  await configs.apply(p.id); assert.equal((await configs.inspect())[0].model, 'fixture-codex');
  const backups = await configs.backups(); assert.equal(backups.length, 1);
  const b = await readFile(path.join(root, 'app', 'backups', backups[0].id + '.json'), 'utf8'); assert.ok(!b.includes('original-account'));
  await configs.restore(backups[0].id); assert.equal(await readFile(path.join(dir, 'config.toml'), 'utf8'), config); assert.equal(await readFile(path.join(dir, 'auth.json'), 'utf8'), auth); assert.equal((await configs.backups()).length, 2);
});
test('file changes after preview cause apply to fail before writing', async () => {
  const { configs, home } = await fixture(); const p = await configs.preview(request); const dir = path.join(home, '.codex'); await mkdir(dir, { recursive: true });
  await writeFile(path.join(dir, 'config.toml'), 'model = "changed-elsewhere"\n');
  await assert.rejects(configs.apply(p.id), /其他程序修改/); assert.equal(await readFile(path.join(dir, 'config.toml'), 'utf8'), 'model = "changed-elsewhere"\n'); assert.equal((await configs.backups()).length, 0);
});
test('restore will not overwrite files modified by another application', async () => {
  const { configs, home } = await fixture(); const p = await configs.preview(request); await configs.apply(p.id); const [b] = await configs.backups();
  await writeFile(path.join(home, '.codex/config.toml'), 'model = "external-model"\n');
  await assert.rejects(configs.restore(b.id), /发生变化/); assert.equal(await readFile(path.join(home, '.codex/config.toml'), 'utf8'), 'model = "external-model"\n');
});
test('invalid existing config is never overwritten', async () => {
  const { configs, home } = await fixture(); await mkdir(path.join(home, '.claude')); const p = path.join(home, '.claude/settings.json'); await writeFile(p, '{broken');
  await assert.rejects(configs.preview({ ...request, tool: 'claude' }), /语法无效/); assert.equal(await readFile(p, 'utf8'), '{broken');
});
test('local sessions count Codex cumulative deltas and deduplicate streamed Claude snapshots', async () => {
  const { home } = await fixture(); const cd = path.join(home, '.codex/sessions'); const cl = path.join(home, '.claude/projects/fixture'); await mkdir(cd, { recursive: true }); await mkdir(cl, { recursive: true });
  const a = new Date().toISOString(); const b = new Date(Date.now() - 1000).toISOString();
  const tokenEvent = (timestamp: string, input: number, output: number, cache: number) => ({ type: 'event_msg', timestamp, payload: { type: 'token_count', info: { total_token_usage: { input_tokens: input, output_tokens: output, cached_input_tokens: cache } } } });
  await writeFile(path.join(cd, 'rollout.jsonl'), [{ type: 'session_meta', payload: { id: 'session-a' } }, { type: 'turn_context', payload: { model: 'fixture-codex' } }, tokenEvent(b, 100, 20, 40), tokenEvent(b, 100, 20, 40), tokenEvent(a, 180, 50, 70)].map(e => JSON.stringify(e)).join('\n'));
  await writeFile(path.join(cl, 'claude.jsonl'), [10,30].map(output => JSON.stringify({ type: 'assistant', timestamp: a, sessionId: 'claude-session', message: { id: 'message-a', model: 'fixture-claude', usage: { input_tokens: 90, output_tokens: output, cache_read_input_tokens: 20, cache_creation_input_tokens: 5 } } })).join('\n') + '\nnot-json');
  const scan = await new LocalUsageService(home).scan(7); assert.equal(scan.filesScanned, 2);
  const codex = scan.rows.find(r => r.tool === 'codex')!; const claude = scan.rows.find(r => r.tool === 'claude')!;
  assert.equal(codex.inputTokens, 110); assert.equal(codex.outputTokens, 50); assert.equal(codex.cacheReadTokens, 70); assert.equal(codex.requests, 2);
  assert.equal(claude.inputTokens, 90); assert.equal(claude.outputTokens, 30); assert.equal(claude.cacheWriteTokens, 5); assert.equal(claude.requests, 1);
});
test('site currency conversion respects custom units and currency rates', () => {
  const c = currency({ system_name: 'Fixture', quota_per_unit: 500000, quota_display_type: 'CUSTOM', custom_currency_symbol: '✾', custom_currency_exchange_rate: 2 });
  assert.equal(c.value(250000), 1); assert.equal(c.symbol, '✾');
});
test('CSV cells protect spreadsheet formulas and preserve quotes', () => { assert.equal(csvEscape('=SUM(1,2)'), '"\'=SUM(1,2)"'); assert.equal(csvEscape('a"b'), '"a""b"'); });
test('tool attribution uses independent token names rather than model guesses', () => {
  const log = { model_name: 'claude-opus', token_name: 'shared' } as UsageLog;
  const bindings = [{ ...request, siteId: 'x', tokenName: 'shared', model: 'fixture' }, { ...request, tool: 'claude' as const, siteId: 'x', tokenName: 'shared', model: 'fixture' }];
  assert.equal(toolForLog(log, bindings), 'other'); assert.equal(toolForLog({ ...log, token_name: 'codex-only' }, [{ ...bindings[0], tokenName: 'codex-only' }]), 'codex');
});
async function mockServer() {
  const seen: { path: string; token: string; user: string; query: URLSearchParams }[] = [];
  const server = createServer((req, res) => {
    const url = new URL(req.url!, 'http://localhost'); seen.push({ path: url.pathname, token: req.headers.authorization || '', user: String(req.headers['new-api-user'] || ''), query: url.searchParams });
    res.setHeader('Content-Type', 'application/json'); let data: any = {};
    if (url.pathname === '/api/status') data = { system_name: 'Fixture', quota_per_unit: 500000, quota_display_type: 'USD' };
    else if (url.pathname === '/api/user/self') data = { quota: 1000000, used_quota: 500000, display_name: 'Test', group: 'default' };
    else if (url.pathname === '/api/log/self') data = { items: [{ id: 1, token_name: 'Lumi-Codex', model_name: 'fixture', type: 2, quota: 1000 }], total: 1 };
    else if (url.pathname === '/api/data/self') data = [{ created_at: Date.now() / 1000, model_name: 'fixture', quota: 1000, token_used: 30, count: 1 }];
    else if (url.pathname === '/api/log/self/stat') data = { quota: url.searchParams.get('token_name') === 'Lumi-Codex' ? 123 : 456, rpm: 1, tpm: 10 };
    else if (url.pathname === '/api/token/') data = { items: [{ id: 1, name: 'Lumi-Codex', key: 'must-never-reach-renderer', status: 1 }], total: 1 };
    else if (url.pathname === '/api/pricing') { res.end(JSON.stringify({ success: true, data: [{ model_name: 'fixture', supported_endpoint_types: ['openai-response'], vendor_id: 7 }], vendors: [{ id: 7, name: 'Fixture' }], group_ratio: { default: 1 } })); return; }
    res.end(JSON.stringify({ success: true, data }));
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve)); const address = server.address() as { port: number };
  return { server, seen, url: 'http://127.0.0.1:' + address.port };
}
test('New API adapter authenticates, parses paginated DTOs, queries independent tool spend and strips token keys', async () => {
  const { server, seen, url } = await mockServer();
  try {
    const { store } = await fixture(); await store.saveSite({ id: store.activeSite().id, name: 'Mock', url, allowHttp: true, accessToken: 'account-access', userId: 42 });
    await store.saveBinding({...request,siteId:store.activeSite().id,tokenName:'Lumi-Codex'});
    const d = await new NewApiClient(store).dashboard(7);
    assert.equal(d.user?.quota, 1000000); assert.equal(d.logs.total, 1); assert.equal(d.catalog.models[0].vendor, 'Fixture'); assert.equal((d.tokens[0] as any).key, undefined);
    assert.equal(d.toolStats?.find(t => t.tool === 'codex')?.stat?.quota, 123);
    assert.equal(seen.find(r => r.path === '/api/status')?.token, '');
    assert.ok(seen.filter(r => r.path !== '/api/status').every(r => r.token === 'Bearer account-access' && r.user === '42'));
    assert.equal(seen.find(r => r.path === '/api/log/self')?.query.get('p'), '1');
    assert.equal(d.warnings.length, 0);
  } finally { await new Promise<void>(r => server.close(() => r())); }
});

test('changing the configured site URL invalidates an outstanding config preview', async () => {
  const { configs, store } = await fixture(); const p = await configs.preview(request);
  await store.saveSite({ id: store.activeSite().id, name: 'New origin', url: 'https://other.invalid', allowHttp: false, accessToken: 'new-access', apiKey: 'sk-new-origin' });
  await assert.rejects(configs.apply(p.id), /站点或登录账户/);
});
test('redaction also protects custom MCP keys, passwords and Authorization headers', () => {
  const input = 'CUSTOM_API_KEY = "custom-key"\nPASSWORD = "custom-password"\n{"Authorization":"Bearer private-header","client_secret":"oauth-secret"}';
  const result = redact(input); for (const value of ['custom-key', 'custom-password', 'private-header', 'oauth-secret']) assert.ok(!result.includes(value));
});
