import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { GATEWAY_METHODS } from '../shared/contracts/gateway';
import { EXTENSION_PERMISSIONS, EXTENSION_SLOTS } from '../shared/contracts/extensions';
import { SURFACE_COLOR_KEYS } from '../shared/surface-theme';

// The SDK d.ts ships twice (main repo and lumi-extensions repo) and hand-syncs
// against host contracts. These checks fail on the field drift that previously
// reached released SDK copies.
const sdkPath = 'extensions/sdk/lumi-extension.d.ts';
const siblingSdkPath = '../extensions/sdk/lumi-extension.d.ts';
const hostFiles = [
  'shared/widget.ts',
  'shared/menu-bar.ts',
  'shared/surface-theme.ts',
  'shared/contracts/codex-bridge.ts',
  'shared/contracts/extensions.ts',
  'shared/contracts/subscription-usage.ts',
  'shared/contracts/gateway.ts',
] as const;

function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
}
function interfaceBody(source: string, name: string): string {
  const clean = stripComments(source);
  const match = clean.match(new RegExp(`\\binterface\\s+${name}\\b`));
  assert.ok(match, `缺少 interface ${name}`);
  const start = clean.indexOf('{', match.index);
  assert.ok(start >= 0, `interface ${name} 缺少主体`);
  let depth = 0, end = start;
  for (; end < clean.length; end++) {
    const c = clean[end];
    if (c === '{') depth++;
    else if (c === '}') { depth--; if (!depth) break; }
  }
  return clean.slice(start + 1, end);
}
/** Depth-zero keys of an interface body; nested object types carry their own ';' separators. */
function interfaceKeys(body: string): string[] {
  const keys: string[] = [];
  let depth = 0, buffer = '';
  const flush = () => {
    const match = buffer.match(/^\s*(?:readonly\s+)?(?:'([^']+)'|"([^"]+)"|([A-Za-z_$][\w$]*))/);
    if (match) keys.push(match[1] ?? match[2] ?? match[3]);
    buffer = '';
  };
  for (const c of body) {
    if (c === '{' || c === '(') depth++;
    else if (c === '}' || c === ')') { depth--; continue; }
    if (c === ';' && depth === 0) { flush(); continue; }
    if (depth === 0) buffer += c;
  }
  flush();
  return keys;
}
function typeUnion(source: string, name: string): string[] {
  const match = stripComments(source).match(new RegExp(`export type ${name}=([^;]+);`));
  assert.ok(match, `缺少 type ${name}`);
  return [...match[1].matchAll(/'([^']+)'/g)].map(m => m[1]);
}
function assertSameKeys(label: string, host: readonly string[], sdk: readonly string[]): void {
  assert.deepEqual([...sdk].sort(), [...host].sort(), `${label} 与宿主契约字段不一致`);
}

test('both shipped SDK type copies stay byte-identical', async () => {
  const sdk = await readFile(sdkPath, 'utf8');
  let sibling: string;
  try { sibling = await readFile(path.resolve(siblingSdkPath), 'utf8'); }
  catch { return; } // The extensions repository is not checked out next to main in CI.
  assert.equal(sibling, sdk, '两份 lumi-extension.d.ts 不一致，请同步修改后提交');
});

test('SDK presentation types match host contracts field by field', async t => {
  const sources = new Map(<[string, string][]>await Promise.all(hostFiles.map(async file => [file, await readFile(file, 'utf8')])));
  t.after(() => { sources.clear(); });
  const sdk = await readFile(sdkPath, 'utf8');
  const mappings: [string, string, string][] = [
    ['shared/widget.ts', 'WidgetModel', 'WidgetModel'],
    ['shared/widget.ts', 'WidgetState', 'WidgetState'],
    ['shared/menu-bar.ts', 'NativeMenuBarState', 'NativeMenuBarState'],
    ['shared/contracts/codex-bridge.ts', 'CodexBridgeStatus', 'CodexBridgeStatus'],
    ['shared/contracts/codex-bridge.ts', 'CodexBridgeMessage', 'CodexBridgeMessage'],
    ['shared/contracts/extensions.ts', 'ExtensionContext', 'Context'],
    ['shared/contracts/subscription-usage.ts', 'SubscriptionWindow', 'SubscriptionWindow'],
    ['shared/contracts/subscription-usage.ts', 'SubscriptionCredits', 'SubscriptionCredits'],
    ['shared/contracts/subscription-usage.ts', 'SubscriptionUsageSnapshot', 'SubscriptionUsageSnapshot'],
  ];
  for (const [file, hostName, sdkName] of mappings) {
    const host = interfaceKeys(interfaceBody(sources.get(file)!, hostName));
    const extension = interfaceKeys(interfaceBody(sdk, sdkName));
    assertSameKeys(`SDK ${sdkName}（宿主 ${hostName}）`, host, extension);
  }
});

test('SDK gateway method maps match the host gateway method list', async () => {
  const sdk = await readFile(sdkPath, 'utf8');
  for (const name of ['GatewayInputMap', 'GatewayOutputMap']) {
    assertSameKeys(`SDK ${name}`, GATEWAY_METHODS, interfaceKeys(interfaceBody(sdk, name)));
  }
});

test('SDK slot, permission and palette unions match host registries', async () => {
  const sdk = await readFile(sdkPath, 'utf8');
  assertSameKeys('SDK ExtensionSlot', EXTENSION_SLOTS, typeUnion(sdk, 'ExtensionSlot'));
  assertSameKeys('SDK ExtensionPermission', EXTENSION_PERMISSIONS, typeUnion(sdk, 'ExtensionPermission'));
  assertSameKeys('SDK SurfacePalette', SURFACE_COLOR_KEYS, typeUnion(sdk, 'SurfacePalette'));
});
