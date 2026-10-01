import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,readFile,writeFile,readdir} from 'node:fs/promises';
import path from 'node:path';
import {ToolRuntimeService,type Command,versionFromOutput} from '../electron/services/tool-runtime';

test('CLI detection prioritizes a discovered tool, reports broken installs and caches simultaneous reads',async()=>{
  let calls=0;
  const service=new ToolRuntimeService({directory:'.test-data/unused',platform:'linux',find:async name=>'/mock/'+name,run:async command=>{calls++;return command.file.endsWith('claude') ? {code:1,stdout:'',stderr:'Broken installation'} : {code:0,stdout:command.file.endsWith('codex') ? 'codex-cli 1.2.3' : 'v24.1.0',stderr:''};}});
  const [a,b]=await Promise.all([service.inspect(),service.inspect()]);assert.equal(calls,4);assert.deepEqual(a,b);assert.equal(a[0].version,'1.2.3');assert.equal(a[1].installed,true);assert.equal(a[1].phase,'error');assert.match(a[1].message!,/Broken/);
  await service.inspect();assert.equal(calls,4);await service.inspect(true);assert.equal(calls,8);service.close();
});
test('official installer is shared, installed version is verified, progress emitted and temporary scripts removed',async()=>{
  const directory=await mkdtemp(path.resolve('.test-data/tool-install-'));let installed=false,downloads=0;const seen:Command[]=[],phases:string[]=[];
  const service=new ToolRuntimeService({directory,platform:'linux',find:async name=>name==='codex' && installed ? '/mock/codex' : undefined,download:async(url,target)=>{assert.equal(url,'https://chatgpt.com/codex/install.sh');downloads++;await writeFile(target,'# mock only');},run:async command=>{seen.push(command);if(command.file==='/bin/sh'){installed=true;return {code:0,stdout:'done',stderr:''};}return {code:0,stdout:'codex-cli 2.3.4',stderr:''};}});
  service.subscribe(state=>phases.push(state.phase));const [a,b]=await Promise.all([service.install('codex'),service.install('codex')]);assert.equal(downloads,1);assert.equal(a.version,'2.3.4');assert.deepEqual(a,b);assert.equal(seen.find(c=>c.file==='/bin/sh')?.env?.CODEX_NON_INTERACTIVE,'1');assert.ok(phases.includes('installing'));assert.deepEqual(await readdir(directory),[]);service.close();
});
test('failed official download stops before execution and hides credential-like output',async()=>{
  const directory=await mkdtemp(path.resolve('.test-data/tool-failure-'));let calls=0;
  const service=new ToolRuntimeService({directory,platform:'linux',find:async()=>undefined,download:async()=>{throw new Error('Bearer fixture-secret-value https://private.invalid/token');},run:async()=>{calls++;return {code:0,stdout:'',stderr:''};}});
  const state=await service.install('claude');assert.equal(state.phase,'error');assert.equal(calls,0);assert.ok(!state.message?.includes('fixture-secret'));assert.ok(!state.message?.includes('private.invalid'));assert.deepEqual(await readdir(directory),[]);service.close();
});
test('Windows npm shims execute by literal PowerShell arguments, update the discovered prefix and verify the active version',async()=>{
  const directory=await mkdtemp(path.resolve('.test-data/tool-shim-')),shim=path.join(directory,"it's $(noop) & tool.cmd");await writeFile(shim,'@openai\\codex');
  const seen:Command[]=[];let version='1.2.3';
  const service=new ToolRuntimeService({directory,platform:'win32',find:async name=>name==='codex' ? shim : name==='npm' ? path.join(directory,'npm.cmd') : undefined,run:async command=>{seen.push(command);const script=command.args.includes('-EncodedCommand') ? Buffer.from(command.args.at(-1)!,'base64').toString('utf16le') : '';if(script.includes('ConvertTo-Json'))return {code:0,stdout:'[]',stderr:''};if(script.includes("'install'")){assert.ok(script.includes("'--prefix'"));assert.ok(script.includes("'@openai/codex@latest'"));version='2.0.0';}return {code:0,stdout:'codex-cli '+version,stderr:''};}});
  await service.inspect();const installed=await service.install('codex');assert.equal(installed.version,'2.0.0');const probes=seen.filter(c=>Buffer.from(c.args.at(-1)!,'base64').toString('utf16le').includes("'--version'"));assert.ok(probes.some(c=>Buffer.from(c.args.at(-1)!,'base64').toString('utf16le').includes("it''s $(noop) & tool.cmd'")));service.close();
});
test('CLI versions preserve prerelease identities and omit unparseable output',()=>{assert.equal(versionFromOutput('codex-cli 1.2.3-beta.2'),'1.2.3-beta.2');assert.equal(versionFromOutput('unknown'),undefined);});
