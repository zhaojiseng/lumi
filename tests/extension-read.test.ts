import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { extensionRead } from '../electron/extensions/read';
import { EXTENSION_METHODS } from '../shared/contracts/extensions';
import { isGatewayMethod } from '../shared/contracts/gateway';

test('extension read routes the presentation methods and fails loudly on unknown methods',async()=>{
  const calls:string[]=[];
  const handlers={
    workbench:async (input:{force?:boolean})=>{calls.push('workbench');return {handler:'workbench',input};},
    usage:async (input:{force?:boolean})=>{calls.push('usage');return {handler:'usage',input};},
    codexUsage:async (input:{force?:boolean})=>{calls.push('codexUsage');return {handler:'codexUsage',input};},
  };
  assert.deepEqual(await extensionRead('workbench.read',{force:true},handlers),{handler:'workbench',input:{force:true}});
  assert.deepEqual(await extensionRead('usage.read',{},handlers),{handler:'usage',input:{}});
  assert.deepEqual(await extensionRead('codex.usage.read',{force:false},handlers),{handler:'codexUsage',input:{force:false}});
  assert.deepEqual(calls,['workbench','usage','codexUsage']);
  await assert.rejects(extensionRead('storage.read' as 'usage.read',{},handlers),/不支持/);
});

test('the extension host forwards exactly the methods the read router covers',async()=>{
  // context/storage/secrets/network are dispatched inside ExtensionHost.request,
  // gateway and codex.bridge have their own bridges; everything left must be a
  // presentation read with an explicit router case.
  const presentation=EXTENSION_METHODS.filter(method=>
    method!=='context.read' &&
    !['storage.read','storage.write','secret.set','secret.has','network.read'].includes(method) &&
    !method.startsWith('codex.bridge.') && !isGatewayMethod(method));
  assert.deepEqual(presentation.sort(),['codex.usage.read','usage.read','workbench.read']);
  const source=await readFile('electron/extensions/host.ts','utf8');
  assert.ok(source.includes("['workbench.read','usage.read','codex.usage.read']"),'扩展宿主转发列表已变化，请同步 electron/extensions/read.ts 路由');
});
