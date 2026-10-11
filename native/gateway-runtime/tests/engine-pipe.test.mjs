import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { setTimeout as delay } from 'node:timers/promises';
import { startEngine } from '../dev/engine.mjs';

const execute = promisify(execFile);
const repository = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const fixtureRoot = path.join(repository, '.cache', 'gateway-pipe-tests');
let fixtureDirectory;
let fixtureBinary;

before(async () => {
  await fs.mkdir(fixtureRoot, { recursive: true });
  fixtureDirectory = await fs.mkdtemp(path.join(fixtureRoot, 'peer-'));
  fixtureBinary = path.join(fixtureDirectory, 'pipe-engine' + (process.platform === 'win32' ? '.exe' : ''));
  await execute('rustc', [
    '--edition=2024', '--crate-name=engine_pipe_fixture',
    fileURLToPath(new URL('./fixtures/engine-pipe.rs', import.meta.url)),
    '-o', fixtureBinary,
  ], { windowsHide: true, timeout: 30_000, maxBuffer: 1024 * 1024 });
});

after(async () => {
  if (!fixtureDirectory) return;
  // The fixture never reads dataDir. Only its own checked cache directory is removed.
  const canonicalRoot = await fs.realpath(fixtureRoot);
  const canonicalDirectory = await fs.realpath(fixtureDirectory);
  assert.equal(path.dirname(canonicalDirectory), canonicalRoot);
  await fs.rm(canonicalDirectory, { recursive: true, force: true });
});

async function openPeer() {
  return startEngine({ dataDir: fixtureDirectory, testBinary: fixtureBinary, timeoutMs: 5000 });
}

async function parentIsAlive() {
  // An unhandled pipe error is asynchronous; allow it to surface before passing.
  await delay(30);
  assert.ok(Number.isSafeInteger(process.pid));
}

test('standard private bootstrap, request and repeated close remain functional', { timeout: 10_000 }, async () => {
  const engine = await openPeer();
  try {
    assert.deepEqual(engine.bootstrap, { protocolVersion: 1, fixture: true });
    assert.deepEqual(await engine.request('status'), { ok: true });
  } finally {
    await engine.close();
    await engine.close();
  }
  await assert.rejects(engine.request('status'), /网关核心不可用或队列已满/);
  await parentIsAlive();
});

test('core exit during a large queued write rejects all pending work without killing parent', { timeout: 10_000 }, async () => {
  const engine = await openPeer();
  try {
    const results = await Promise.allSettled([
      engine.request('exit-write', { fixturePayload: 'x'.repeat(5 * 1024 * 1024) }),
      engine.request('status'),
    ]);
    for (const result of results) {
      assert.equal(result.status, 'rejected');
      assert.match(result.reason.message, /网关核心连接已中断/);
      assert.ok(!result.reason.message.includes('fixturePayload'));
    }
    await assert.rejects(engine.request('status'), /网关核心不可用或队列已满/);
    await parentIsAlive();
  } finally {
    await engine.close();
  }
});

for (const method of ['malformed-json', 'malformed-shape', 'wrong-id', 'oversized']) {
  test(method + ' replies reject pending promises while the parent remains alive', { timeout: 10_000 }, async () => {
    const engine = await openPeer();
    try {
      await assert.rejects(engine.request(method), /网关核心连接已中断/);
      await assert.rejects(engine.request('status'), /网关核心不可用或队列已满/);
      await parentIsAlive();
    } finally {
      await engine.close();
    }
  });
}
