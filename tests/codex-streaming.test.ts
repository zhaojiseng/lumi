import test, {type TestContext} from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {once} from 'node:events';
import {appendFileSync, createReadStream, readdirSync} from 'node:fs';
import {mkdir, mkdtemp, open, readFile, readdir, rename, rm, stat, writeFile} from 'node:fs/promises';
import {DatabaseSync} from 'node:sqlite';
import path from 'node:path';
import {ConfigService} from '../electron/services/config';
import {SettingsStore, type Cipher} from '../electron/services/store';
import {
  scanSessionFile, prepareSession, commitSession, discardSessions, reverseSession, rollbackSessions,
  type SessionChange,
} from '../electron/services/codex-session-files';
import type {ConfigProgress} from '../shared/types';

const MiB = 1024 * 1024;
const cipherLimit = 128 * 1024;
const requestMarker = 'isolated-request-body-never-backup';
const request = {tool: 'codex' as const, model: 'new-fixture-model', group: 'fixture', contextWindow: 400000};
const testData = path.resolve(import.meta.dirname, '..', '.test-data');

function boundedCipher() {
  const state = {
    encryptLengths: [] as number[],
    decryptLengths: [] as number[],
    onEncrypt: undefined as ((text: string) => void) | undefined,
  };
  const check = (text: string) => {
    if (text.length > cipherLimit) throw new RangeError('Invalid string length: isolated cipher limit');
  };
  // Deliberately reversible simulation, matching existing tests; no OS vault or real keys.
  const cipher: Cipher = {
    available: () => true,
    encrypt(text) {
      check(text);
      state.encryptLengths.push(text.length);
      state.onEncrypt?.(text);
      return Buffer.from(text).toString('base64');
    },
    decrypt(text) {
      const plain = Buffer.from(text, 'base64').toString('utf8');
      check(plain);
      state.decryptLengths.push(plain.length);
      return plain;
    },
  };
  return {cipher, state};
}

async function fixture(t: TestContext) {
  await mkdir(testData, {recursive: true});
  const root = await mkdtemp(path.join(testData, 'codex-streaming-'));
  const relative = path.relative(testData, path.resolve(root));
  assert.ok(relative && !relative.startsWith('..') && !path.isAbsolute(relative));
  t.after(() => rm(root, {recursive: true, force: true, maxRetries: 5, retryDelay: 100}));
  const home = path.join(root, 'home'), dir = path.join(home, '.codex'), app = path.join(root, 'app');
  await mkdir(dir, {recursive: true});
  const {cipher, state} = boundedCipher();
  const store = new SettingsStore(app, cipher);
  await store.load();
  await store.saveSite({id: store.activeSite().id, name: 'Isolated fixture', url: 'https://fixture.invalid', allowHttp: false});
  const config = path.join(dir, 'config.toml'), auth = path.join(dir, 'auth.json');
  const originalConfig = 'model = "old-fixture-model"\nmodel_provider = "lumi"\n';
  const originalAuth = '{"tokens":{"access_token":"official-fixture"}}\r\n';
  await writeFile(config, originalConfig);
  await writeFile(auth, originalAuth);
  let resolves = 0;
  // Supplying home explicitly disables real CODEX_HOME, SQLite environment and process discovery.
  const service = new ConfigService(store, app, home, async () => {
    resolves++;
    return {siteId: store.activeSite().id, siteUrl: store.activeSite().url, key: 'sk-test-fixture',
      tokenId: 1, tokenName: 'Lumi-fixture', group: request.group, created: false};
  });
  return {root, dir, app, config, auth, originalConfig, originalAuth, cipher, cipherState: state, service,
    get resolves() { return resolves; }};
}

async function fileHash(file: string) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(file, {highWaterMark: 64 * 1024})) hash.update(chunk);
  return hash.digest('hex');
}

async function temporaryFiles(root: string): Promise<string[]> {
  const found: string[] = [];
  for (const entry of await readdir(root, {withFileTypes: true})) {
    const file = path.join(root, entry.name);
    if (entry.isDirectory()) found.push(...await temporaryFiles(file));
    else if (/\.(?:lumi-tmp|tmp)$/.test(entry.name)) found.push(file);
  }
  return found;
}

async function writeRepeated(emit: (bytes: Buffer) => Promise<void>) {
  // Each JSONL body is >=8 MiB, but construction only holds one 64 KiB buffer.
  const chunk = Buffer.alloc(64 * 1024, 'x');
  for (let i = 0; i < 128; i++) await emit(chunk);
}

async function journal(file: string, id: string, options: {
  provider?: string; large?: boolean; instructions?: number; ending?: '\r\n' | ''; context?: boolean;
} = {}) {
  await mkdir(path.dirname(file), {recursive: true});
  const provider = options.provider ?? 'lumi', ending = options.ending ?? '';
  const meta = {type: 'session_meta', payload: {id, model_provider: provider, cwd: '隔离工作目录'}};
  const metaBefore = ' \t ' + JSON.stringify(meta) + ' \r\n';
  const metaAfter = JSON.stringify({...meta, payload: {...meta.payload, model_provider: 'custom'}}) + '\r\n';
  const historical = ' \t' + JSON.stringify({type: 'event_msg', payload: {type: 'thread_settings_applied',
    thread_settings: {model: 'historical-model', model_provider_id: provider, model_context_window: 123456,
      collaboration_mode: {settings: {model: 'historical-model', developer_instructions: '早期中文指令原样保留'}}}}}) + ' \r\n';
  const body = Buffer.from(' \t{"type":"response_item","payload":{"role":"user","content":"请求原文 ' + requestMarker + '"}}\r\n');
  const settings = {
    model: 'old-fixture-model', model_provider_id: provider,
    ...(options.context === false ? {} : {model_context_window: 200000}),
    collaboration_mode: {mode: 'default', settings: {model: 'old-fixture-model',
      developer_instructions: '中文指令 🚀 ' + 'i'.repeat(options.instructions ?? 0)}},
    approval_policy: 'on-request',
  };
  const latest = {type: 'event_msg', payload: {type: 'thread_settings_applied', thread_settings: settings}};
  const latestBefore = ' ' + JSON.stringify(latest) + ' ' + ending;
  const latestAfter = JSON.stringify({type: 'event_msg', payload: {type: 'thread_settings_applied', thread_settings: {
    ...settings, model: request.model, model_provider_id: 'custom',
    ...(options.context === false ? {} : {model_context_window: request.contextWindow}),
    collaboration_mode: {...settings.collaboration_mode, settings: {...settings.collaboration_mode.settings, model: request.model}},
  }}}) + ending;
  const before = createHash('sha256'), after = createHash('sha256');
  let size = 0, afterSize = 0;
  const handle = await open(file, 'wx');
  const emit = async (bytes: Buffer, replacement = bytes) => {
    await handle.writeFile(bytes);
    before.update(bytes); after.update(replacement);
    size += bytes.length; afterSize += replacement.length;
  };
  let latestOffset = 0, latestAfterOffset = 0;
  try {
    await emit(Buffer.from(metaBefore), Buffer.from(metaAfter));
    await emit(Buffer.from(historical));
    await emit(Buffer.from(' {"type":"turn_context","payload":{"model":"past-model","note":"中文旧轮次"}}\r\n'));
    await emit(body);
    if (options.large) {
      for (let line = 0; line < 4; line++) {
        await emit(Buffer.from('{"type":"response_item","payload":{"role":"user","content":"' + requestMarker + ' 中文 '));
        await writeRepeated(bytes => emit(bytes));
        await emit(Buffer.from('"}}\r\n'));
      }
    }
    await emit(Buffer.from(' {"type":"event_msg","payload":{"type":"token_count","info":{"input_tokens":987}}}\r\n'));
    latestOffset = size; latestAfterOffset = afterSize;
    await emit(Buffer.from(latestBefore), Buffer.from(latestAfter));
  } finally { await handle.close(); }
  return {file, id, size, beforeHash: before.digest('hex'), afterHash: after.digest('hex'),
    metaBefore, metaAfter, latestBefore, latestAfter, latestOffset, latestAfterOffset};
}

async function scan(file: string) {
  const change = await scanSessionFile(file, request.model, request.contextWindow, new Set(['lumi', 'custom']));
  assert.ok(change, 'fixture must have a migration to exercise');
  return change;
}

function assertPatchShape(change: SessionChange, afterHash = false) {
  assert.deepEqual(Object.keys(change).sort(), (afterHash
    ? ['path', 'id', 'beforeHash', 'afterHash', 'patches'] : ['path', 'id', 'beforeHash', 'patches']).sort());
  for (const patch of change.patches) assert.deepEqual(Object.keys(patch).sort(), ['offset', 'before', 'after'].sort());
}

async function backupManifest(f: Awaited<ReturnType<typeof fixture>>, id: string) {
  const envelope = JSON.parse(await readFile(path.join(f.app, 'backups', id + '.json'), 'utf8'));
  return {envelope, text: f.cipher.decrypt(envelope.encrypted)};
}

test('32 MiB histories stream across multiple sessions, back up only patches, restore bytes and avoid repeated rewrites', {timeout: 30000}, async t => {
  const f = await fixture(t), events: ConfigProgress[] = [];
  const unsubscribe = f.service.subscribe(event => events.push({...event}));
  t.after(unsubscribe);
  const sessions = [
    await journal(path.join(f.dir, 'sessions', '2026', 'active.jsonl'), 'active', {large: true, instructions: 36000, ending: '\r\n'}),
    await journal(path.join(f.dir, 'archived_sessions', 'archived.jsonl'), 'archived', {large: true, instructions: 36000}),
    await journal(path.join(f.dir, 'sessions', 'small.jsonl'), 'small', {instructions: 36000, context: false}),
  ];
  const other = await journal(path.join(f.dir, 'sessions', 'official.jsonl'), 'official', {provider: 'openai'});
  assert.ok(sessions.slice(0, 2).every(s => s.size >= 32 * MiB));
  const preview = await f.service.preview(request);
  assert.equal(preview.files.length, 2);
  assert.ok(!JSON.stringify(preview).includes('sk-test-fixture'));
  assert.deepEqual(events.map(e => e.phase), ['validating', 'key', 'done']);
  await f.service.apply(preview.id);
  const applyEvents = events.filter(e => e.operation === 'apply');
  assert.deepEqual([...new Set(applyEvents.map(e => e.phase))], ['history', 'backup', 'writing', 'done']);
  assert.ok(applyEvents.some(e => e.phase === 'history' && e.completed === 4 && e.total === 4));
  for (const session of sessions) assert.equal(await fileHash(session.file), session.afterHash,
    'only metadata and the latest settings may change; all history bytes must match');
  assert.equal(await fileHash(other.file), other.beforeHash);
  assert.equal(await readFile(f.auth, 'utf8'), f.originalAuth);
  const [backup] = await f.service.backups();
  assert.deepEqual(new Set(backup.paths), new Set([f.config, f.auth, ...sessions.map(s => s.file)]));
  const {envelope, text} = await backupManifest(f, backup.id), manifest = JSON.parse(text);
  assert.equal(envelope.version, 2);
  assert.equal(manifest.sessions, undefined);
  assert.equal(manifest.before.length, 2);
  assert.equal(manifest.after.length, 2);
  assert.equal(manifest.sessionParts.length, 3);
  assert.ok(!text.includes(requestMarker));
  let combinedPatchLength = 0;
  for (const reference of manifest.sessionParts as {part: string; path: string}[]) {
    const part = JSON.parse(await readFile(path.join(f.app, 'backups', reference.part), 'utf8'));
    assert.deepEqual(Object.keys(part), ['encrypted']);
    const plain = f.cipher.decrypt(part.encrypted), change: SessionChange = JSON.parse(plain);
    combinedPatchLength += plain.length;
    assert.ok(!plain.includes(requestMarker), 'request bodies must never enter encrypted session backups');
    assert.ok(plain.length <= cipherLimit);
    assertPatchShape(change, true);
    const session = sessions.find(s => s.file === reference.path)!;
    assert.equal(change.path, session.file);
    assert.equal(change.beforeHash, session.beforeHash);
    assert.equal(change.afterHash, session.afterHash);
    assert.deepEqual(change.patches, [
      {offset: 0, before: session.metaBefore, after: session.metaAfter},
      {offset: session.latestOffset, before: session.latestBefore, after: session.latestAfter},
    ]);
    const settings = JSON.parse(change.patches[1].after).payload.thread_settings;
    assert.equal(settings.model, request.model);
    assert.equal(settings.collaboration_mode.settings.model, request.model);
    assert.equal(settings.approval_policy, 'on-request');
    assert.equal(settings.model_context_window, session.id === 'small' ? undefined : request.contextWindow);
  }
  assert.ok(combinedPatchLength > cipherLimit, 'one combined session encryption would exceed the simulated string limit');
  const identities = await Promise.all(sessions.map(s => stat(s.file, {bigint: true})));
  const partsBefore = (await readdir(path.join(f.app, 'backups'))).filter(p => p.endsWith('.part')).sort();
  const again = await f.service.preview(request);
  await f.service.apply(again.id);
  for (const [index, session] of sessions.entries()) {
    const current = await stat(session.file, {bigint: true}), previous = identities[index];
    assert.deepEqual([current.dev, current.ino, current.size, current.mtimeNs, current.ctimeNs],
      [previous.dev, previous.ino, previous.size, previous.mtimeNs, previous.ctimeNs], 'same configuration must not rewrite session files');
    assert.equal(await scanSessionFile(session.file, request.model, request.contextWindow, new Set(['custom'])), null);
  }
  assert.deepEqual((await readdir(path.join(f.app, 'backups'))).filter(p => p.endsWith('.part')).sort(), partsBefore);
  const second = (await f.service.backups()).find(b => b.id !== backup.id)!;
  assert.equal(JSON.parse((await backupManifest(f, second.id)).text).sessionParts, undefined);
  await f.service.restore(backup.id);
  for (const session of [...sessions, other]) assert.equal(await fileHash(session.file), session.beforeHash,
    'restore must recover CRLF, Chinese, original whitespace and absent final newlines exactly');
  assert.equal(await readFile(f.config, 'utf8'), f.originalConfig);
  assert.equal(await readFile(f.auth, 'utf8'), f.originalAuth);
  assert.deepEqual([...new Set(events.filter(e => e.operation === 'restore').map(e => e.phase))], ['validating', 'backup', 'writing', 'done']);
  assert.ok(f.cipherState.encryptLengths.every(n => n <= cipherLimit));
  assert.ok(f.cipherState.decryptLengths.every(n => n <= cipherLimit));
  assert.deepEqual(await temporaryFiles(f.root), []);
});

test('preview never scans an oversized malformed history configuration record; apply rejects it without writes', async t => {
  const f = await fixture(t), events: ConfigProgress[] = [];
  const unsubscribe = f.service.subscribe(event => events.push({...event}));
  const file = path.join(f.dir, 'sessions', 'oversized.jsonl');
  await mkdir(path.dirname(file), {recursive: true});
  const handle = await open(file, 'wx');
  try {
    await handle.writeFile('{"type":"session_meta","payload":{"id":"oversized","model_provider":"lumi","broken":"');
    await writeRepeated(bytes => handle.writeFile(bytes));
    await handle.writeFile('\r\n'); // Intentionally malformed, >8 MiB configuration record.
  } finally { await handle.close(); }
  const before = await fileHash(file);
  const preview = await f.service.preview(request);
  assert.equal(preview.files.length, 2);
  assert.equal(f.resolves, 1);
  assert.deepEqual(events.map(e => [e.operation, e.phase]), [['preview', 'validating'], ['preview', 'key'], ['preview', 'done']]);
  await assert.rejects(f.service.apply(preview.id), /会话配置记录过大/);
  assert.deepEqual(events.filter(e => e.operation === 'apply').map(e => e.phase), ['history']);
  assert.equal(await fileHash(file), before);
  assert.equal(await readFile(f.config, 'utf8'), f.originalConfig);
  assert.equal(await readFile(f.auth, 'utf8'), f.originalAuth);
  assert.deepEqual(await f.service.backups(), []);
  assert.deepEqual(await temporaryFiles(f.root), []);
  unsubscribe();
  const count = events.length;
  await f.service.preview(request); // A failed apply releases busy; unsubscribe really detaches.
  assert.equal(events.length, count);
});

test('byte offsets, staging, reverse patches and rollback preserve CRLF and Chinese without a final newline', async t => {
  const f = await fixture(t), session = await journal(path.join(f.dir, 'sessions', 'bytes.jsonl'), 'bytes');
  const original = await readFile(session.file), change = await scan(session.file);
  assertPatchShape(change);
  assert.equal(change.beforeHash, session.beforeHash);
  assert.deepEqual(change.patches.map(p => p.offset), [0, session.latestOffset]);
  assert.ok(session.latestOffset > original.toString('utf8').indexOf(session.latestBefore), 'offsets count UTF-8 bytes, not JS characters');
  const prepared = await prepareSession(change);
  assert.equal(await fileHash(session.file), session.beforeHash, 'prepare must not write the source');
  assert.equal(await fileHash(prepared.temporary), session.afterHash);
  assert.equal(prepared.change.afterHash, session.afterHash);
  await commitSession(prepared);
  await discardSessions([prepared]);
  assert.equal(await fileHash(session.file), session.afterHash);
  const reverse = reverseSession(prepared.change);
  assert.equal(reverse.beforeHash, session.afterHash);
  assert.equal(reverse.afterHash, session.beforeHash);
  assert.deepEqual(reverse.patches, [
    {offset: 0, before: session.metaAfter, after: session.metaBefore},
    {offset: session.latestAfterOffset, before: session.latestAfter, after: session.latestBefore},
  ]);
  assert.notEqual(session.latestAfterOffset, session.latestOffset, 'metadata length change exercises reverse offset adjustment');
  const stagedRestore = await prepareSession(reverse);
  assert.equal(await fileHash(stagedRestore.temporary), session.beforeHash);
  await discardSessions([stagedRestore]);
  assert.equal(await fileHash(session.file), session.afterHash, 'discard must leave committed content alone');
  await rollbackSessions([prepared.change]);
  assert.deepEqual(await readFile(session.file), original);
  assert.deepEqual(await temporaryFiles(f.root), []);
});

test('scan returns null when latest custom settings already match, ignoring old settings while still finding another migration', async t => {
  const f = await fixture(t);
  const ready = await journal(path.join(f.dir, 'sessions', 'ready.jsonl'), 'ready', {provider: 'custom'});
  const original = await readFile(ready.file, 'utf8');
  const configured = original.replace(ready.metaBefore, ready.metaAfter).replace(ready.latestBefore, ready.latestAfter);
  await writeFile(ready.file, configured);
  assert.ok(configured.includes('"model":"historical-model"'), 'earlier settings deliberately remain different');
  assert.equal(await scanSessionFile(ready.file, request.model, request.contextWindow, new Set(['custom'])), null);
  assert.equal(await readFile(ready.file, 'utf8'), configured);
  const stale = await journal(path.join(f.dir, 'sessions', 'stale.jsonl'), 'stale', {provider: 'custom'});
  const staleContent = await readFile(stale.file, 'utf8');
  await writeFile(stale.file, staleContent.replace(stale.metaBefore, stale.metaAfter));
  const change = await scan(stale.file);
  assert.equal(change.patches.length, 1, 'already matching metadata must not get a redundant patch');
  assert.equal(change.patches[0].offset, stale.latestAfterOffset);
  assert.equal(change.patches[0].before, stale.latestBefore);
  assert.equal(change.patches[0].after, stale.latestAfter);
  const other = await journal(path.join(f.dir, 'sessions', 'other.jsonl'), 'other', {provider: 'openai'});
  assert.equal(await scanSessionFile(other.file, request.model, request.contextWindow, new Set(['custom', 'lumi'])), null);
  assert.equal(await fileHash(other.file), other.beforeHash);
  assert.deepEqual(await temporaryFiles(f.root), []);
});

test('prepare rejects same-size edits outside patched records using the full file hash and cleans its stage', async t => {
  const f = await fixture(t), session = await journal(path.join(f.dir, 'sessions', 'hash-conflict.jsonl'), 'hash-conflict');
  const change = await scan(session.file), original = await readFile(session.file);
  const external = Buffer.from(original.toString('utf8').replace('请求原文', '请求改文'));
  assert.equal(external.length, original.length);
  assert.notDeepEqual(external, original);
  await writeFile(session.file, external);
  await assert.rejects(prepareSession(change), /会话已变更/);
  assert.deepEqual(await readFile(session.file), external);
  assert.deepEqual(await temporaryFiles(f.root), []);
});

test('commit refuses a source changed after staging, and discard removes stages idempotently', async t => {
  const f = await fixture(t), session = await journal(path.join(f.dir, 'sessions', 'commit-conflict.jsonl'), 'commit-conflict');
  const prepared = await prepareSession(await scan(session.file));
  appendFileSync(session.file, '\r\n{"external":"fixture-only"}');
  const external = await readFile(session.file);
  await assert.rejects(commitSession(prepared), /会话已变更/);
  assert.deepEqual(await readFile(session.file), external);
  await discardSessions([prepared]);
  await discardSessions([prepared]);
  assert.deepEqual(await temporaryFiles(f.root), []);
});

test('Windows commits recover from a short reader lock but reject edits during replacement retries', {skip:process.platform!=='win32'}, async t => {
  const f=await fixture(t),session=await journal(path.join(f.dir,'sessions','reader-lock.jsonl'),'reader-lock');
  const prepared=await prepareSession(await scan(session.file)),reader=createReadStream(session.file);reader.pause();await once(reader,'open');
  let release:ReturnType<typeof setTimeout>|undefined;
  try{
    await assert.rejects(rename(prepared.temporary,session.file),{code:'EPERM'});
    release=setTimeout(()=>reader.destroy(),50);
    await commitSession(prepared);
    assert.equal(reader.closed,true);
    assert.equal(await fileHash(session.file),session.afterHash);
  }finally{clearTimeout(release);const closed=reader.closed ? Promise.resolve() : once(reader,'close');reader.destroy();await closed;await discardSessions([prepared]);}
  await rollbackSessions([prepared.change]);
  const conflicted=await prepareSession(await scan(session.file)),held=createReadStream(session.file);held.pause();await once(held,'open');
  try{
    await assert.rejects(rename(conflicted.temporary,session.file),{code:'EPERM'});
    release=setTimeout(()=>{appendFileSync(session.file,'\n{"external":"fixture"}');held.destroy();},25);
    await assert.rejects(commitSession(conflicted),/会话已变更/);
    assert.ok((await readFile(session.file,'utf8')).endsWith('{"external":"fixture"}'));
    assert.equal(JSON.parse((await readFile(session.file,'utf8')).split('\r\n')[0]).payload.model_provider,'lumi');
  }finally{clearTimeout(release);const closed=held.closed ? Promise.resolve() : once(held,'close');held.destroy();await closed;await discardSessions([conflicted]);}
  assert.deepEqual(await temporaryFiles(f.root),[]);
});

test('apply rolls back an earlier session and config when a later staged source is externally changed', async t => {
  const f = await fixture(t);
  const first = await journal(path.join(f.dir, 'sessions', 'first.jsonl'), 'first');
  const second = await journal(path.join(f.dir, 'archived_sessions', 'second.jsonl'), 'second');
  const firstBefore = await readFile(first.file), secondBefore = await readFile(second.file);
  const appended = '\r\n{"external":"changed during apply"}';
  let injected = false;
  const unsubscribe = f.service.subscribe(event => {
    if (event.operation === 'apply' && event.phase === 'writing') {
      // Synchronous hook makes this race deterministic, after both sessions are staged.
      assert.equal(readdirSync(path.dirname(first.file)).filter(p => p.endsWith('.lumi-tmp')).length, 1);
      assert.equal(readdirSync(path.dirname(second.file)).filter(p => p.endsWith('.lumi-tmp')).length, 1);
      appendFileSync(second.file, appended);
      injected = true;
    }
  });
  t.after(unsubscribe);
  const preview = await f.service.preview(request);
  await assert.rejects(f.service.apply(preview.id), /会话已变更/);
  assert.ok(injected);
  assert.deepEqual(await readFile(first.file), firstBefore, 'already committed session must be rolled back');
  assert.deepEqual(await readFile(second.file), Buffer.concat([secondBefore, Buffer.from(appended)]));
  assert.equal(await readFile(f.config, 'utf8'), f.originalConfig);
  assert.equal(await readFile(f.auth, 'utf8'), f.originalAuth);
  assert.deepEqual(await temporaryFiles(f.root), []);
});

test('restore guards untouched bytes before committing any session and cleans earlier prepared stages', async t => {
  const f = await fixture(t);
  const first = await journal(path.join(f.dir, 'sessions', 'first.jsonl'), 'first');
  const second = await journal(path.join(f.dir, 'archived_sessions', 'second.jsonl'), 'second');
  const preview = await f.service.preview(request);
  await f.service.apply(preview.id);
  const [backup] = await f.service.backups(), appliedFirst = await readFile(first.file), appliedSecond = await readFile(second.file);
  const config = await readFile(f.config), auth = await readFile(f.auth);
  const external = Buffer.from(appliedSecond.toString('utf8').replace('请求原文', '请求改文'));
  assert.equal(external.length, appliedSecond.length);
  assert.notDeepEqual(external, appliedSecond);
  await writeFile(second.file, external);
  const events: ConfigProgress[] = [], unsubscribe = f.service.subscribe(event => events.push({...event}));
  t.after(unsubscribe);
  await assert.rejects(f.service.restore(backup.id), /会话已变更/);
  assert.deepEqual(await readFile(first.file), appliedFirst, 'earlier stages must not be committed if any hash conflicts');
  assert.deepEqual(await readFile(second.file), external);
  assert.deepEqual(await readFile(f.config), config);
  assert.deepEqual(await readFile(f.auth), auth);
  assert.deepEqual(events.map(e => e.phase), ['validating', 'backup']);
  assert.equal((await f.service.backups()).length, 1, 'failed restore must not create an undo backup');
  assert.deepEqual(await temporaryFiles(f.root), []);
});

test('lightweight preview SQLite snapshot detects later conflicts and rolls back all streamed sessions', async t => {
  const f = await fixture(t);
  const first = await journal(path.join(f.dir, 'sessions', 'first.jsonl'), 'first');
  const second = await journal(path.join(f.dir, 'archived_sessions', 'second.jsonl'), 'second');
  const db = new DatabaseSync(path.join(f.dir, 'state_5.sqlite'));
  try {
    db.exec("CREATE TABLE threads(id TEXT PRIMARY KEY, model_provider TEXT, model TEXT); INSERT INTO threads VALUES('first','lumi','old-fixture-model'),('second','lumi','old-fixture-model')");
    const preview = await f.service.preview(request);
    db.exec("UPDATE threads SET model='external-fixture-model' WHERE id='first'");
    await assert.rejects(f.service.apply(preview.id), /索引已变更/);
    for (const session of [first, second]) assert.equal(await fileHash(session.file), session.beforeHash);
    assert.equal(await readFile(f.config, 'utf8'), f.originalConfig);
    assert.equal(await readFile(f.auth, 'utf8'), f.originalAuth);
    assert.deepEqual(db.prepare('SELECT id, model_provider, model FROM threads ORDER BY id').all().map(row => ({...row})), [
      {id: 'first', model_provider: 'lumi', model: 'external-fixture-model'},
      {id: 'second', model_provider: 'lumi', model: 'old-fixture-model'},
    ]);
    assert.deepEqual(await temporaryFiles(f.root), []);
  } finally { db.close(); }
});

test('encryption failure after one patch part removes partial backups and all stages before any source writes', async t => {
  const f = await fixture(t);
  const first = await journal(path.join(f.dir, 'sessions', 'first.jsonl'), 'first');
  const second = await journal(path.join(f.dir, 'archived_sessions', 'second.jsonl'), 'fail-archived');
  let injected = false;
  f.cipherState.onEncrypt = text => {
    const value = JSON.parse(text);
    if (value.id === 'fail-archived' && Array.isArray(value.patches)) {
      assert.equal(readdirSync(path.join(f.app, 'backups')).filter(p => p.endsWith('.part')).length, 1);
      injected = true;
      throw new RangeError('Invalid string length: injected isolated encryption failure');
    }
  };
  const preview = await f.service.preview(request);
  await assert.rejects(f.service.apply(preview.id), {name: 'RangeError', message: /Invalid string length/});
  assert.ok(injected);
  for (const session of [first, second]) assert.equal(await fileHash(session.file), session.beforeHash);
  assert.equal(await readFile(f.config, 'utf8'), f.originalConfig);
  assert.equal(await readFile(f.auth, 'utf8'), f.originalAuth);
  assert.deepEqual(await readdir(path.join(f.app, 'backups')), []);
  assert.deepEqual(await temporaryFiles(f.root), []);
  f.cipherState.onEncrypt = undefined;
  await f.service.apply(preview.id); // Failed application releases busy and remains retryable.
  for (const session of [first, second]) assert.equal(await fileHash(session.file), session.afterHash);
  assert.deepEqual(await temporaryFiles(f.root), []);
});

test('legacy v1 encrypted full-snapshot backups still restore small session files and the old catalog', async t => {
  const f = await fixture(t), session = await journal(path.join(f.dir, 'sessions', 'legacy.jsonl'), 'legacy');
  const original = await readFile(session.file, 'utf8');
  const migrated = original.replace(session.metaBefore, session.metaAfter).replace(session.latestBefore, session.latestAfter);
  const catalog = path.join(f.dir, 'lumi-model-catalog.json');
  const before = [{path: f.config, content: f.originalConfig}, {path: f.auth, content: f.originalAuth},
    {path: catalog, content: null}, {path: session.file, content: original}];
  const after = [{path: f.config, content: 'model = "legacy-applied"\n'}, {path: f.auth, content: '{}\n'},
    {path: catalog, content: 'Legacy fixture catalog bytes'}, {path: session.file, content: migrated}];
  for (const file of after) await writeFile(file.path, file.content);
  const backup = {id: 'legacy-streaming-v1', tool: 'codex', createdAt: 1, paths: before.map(f => f.path), before, after};
  await mkdir(path.join(f.app, 'backups'), {recursive: true});
  await writeFile(path.join(f.app, 'backups', backup.id + '.json'), JSON.stringify({version: 1, encrypted: f.cipher.encrypt(JSON.stringify(backup))}));
  assert.deepEqual((await f.service.backups())[0].paths, backup.paths);
  await f.service.restore(backup.id);
  assert.equal(await readFile(f.config, 'utf8'), f.originalConfig);
  assert.equal(await readFile(f.auth, 'utf8'), f.originalAuth);
  assert.equal(await readFile(session.file, 'utf8'), original);
  await assert.rejects(stat(catalog), {code: 'ENOENT'});
  assert.deepEqual(await temporaryFiles(f.root), []);
});
