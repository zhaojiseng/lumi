import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,readFile,writeFile,readdir} from 'node:fs/promises';
import path from 'node:path';
import {runInNewContext} from 'node:vm';
import {transform} from 'esbuild';
import {ToolRuntimeService,type Command,versionFromOutput,chatGPTStoreVersion} from '../electron/services/tool-runtime';

test('CLI detection prioritizes a discovered tool, reports broken installs and caches simultaneous reads',async()=>{
  let calls=0;
  const service=new ToolRuntimeService({directory:'.test-data/unused',platform:'linux',latest:async()=>undefined,find:async name=>'/mock/'+name,run:async command=>{calls++;return command.file.endsWith('claude') ? {code:1,stdout:'',stderr:'Broken installation'} : {code:0,stdout:command.file.endsWith('codex') ? 'codex-cli 1.2.3' : 'v24.1.0',stderr:''};}});
  const [a,b]=await Promise.all([service.inspect(),service.inspect()]);assert.equal(calls,4);assert.deepEqual(a,b);assert.equal(a[0].version,'1.2.3');assert.equal(a[1].installed,true);assert.equal(a[1].phase,'error');assert.match(a[1].message!,/Broken/);
  await service.inspect();assert.equal(calls,4);await service.inspect(true);assert.equal(calls,8);service.close();
});
test('official installer is shared, installed version is verified, progress emitted and temporary scripts removed',async()=>{
  const directory=await mkdtemp(path.resolve('.test-data/tool-install-'));let installed=false,downloads=0;const seen:Command[]=[],phases:string[]=[];
  const service=new ToolRuntimeService({directory,platform:'linux',latest:async()=>undefined,find:async name=>name==='codex' && installed ? '/mock/codex' : undefined,download:async(url,target)=>{assert.equal(url,'https://chatgpt.com/codex/install.sh');downloads++;await writeFile(target,'# mock only');},run:async command=>{seen.push(command);if(command.file==='/bin/sh'){installed=true;return {code:0,stdout:'done',stderr:''};}return {code:0,stdout:'codex-cli 2.3.4',stderr:''};}});
  service.subscribe(state=>phases.push(state.phase));const [a,b]=await Promise.all([service.install('codex'),service.install('codex')]);assert.equal(downloads,1);assert.equal(a.version,'2.3.4');assert.deepEqual(a,b);assert.equal(seen.find(c=>c.file==='/bin/sh')?.env?.CODEX_NON_INTERACTIVE,'1');assert.ok(phases.includes('installing'));assert.deepEqual(await readdir(directory),[]);service.close();
});
test('failed official download stops before execution and hides credential-like output',async()=>{
  const directory=await mkdtemp(path.resolve('.test-data/tool-failure-'));let calls=0;
  const service=new ToolRuntimeService({directory,platform:'linux',latest:async()=>undefined,find:async()=>undefined,download:async()=>{throw new Error('Bearer fixture-secret-value https://private.invalid/token');},run:async()=>{calls++;return {code:0,stdout:'',stderr:''};}});
  const state=await service.install('claude');assert.equal(state.phase,'error');assert.equal(calls,0);assert.ok(!state.message?.includes('fixture-secret'));assert.ok(!state.message?.includes('private.invalid'));assert.deepEqual(await readdir(directory),[]);service.close();
});
test('Windows npm shims execute by literal PowerShell arguments, update the discovered prefix and verify the active version',async()=>{
  const directory=await mkdtemp(path.resolve('.test-data/tool-shim-')),shim=path.join(directory,"it's $(noop) & tool.cmd");await writeFile(shim,'@openai\\codex');
  const seen:Command[]=[];let version='1.2.3';
  const service=new ToolRuntimeService({directory,platform:'win32',latest:async()=>undefined,find:async name=>name==='codex' ? shim : name==='npm' ? path.join(directory,'npm.cmd') : undefined,run:async command=>{seen.push(command);const script=command.args.includes('-EncodedCommand') ? Buffer.from(command.args.at(-1)!,'base64').toString('utf16le') : '';if(script.includes('ConvertTo-Json'))return {code:0,stdout:'[]',stderr:''};if(script.includes("'install'")){assert.ok(script.includes("'--prefix'"));assert.ok(script.includes("'@openai/codex@latest'"));version='2.0.0';}return {code:0,stdout:'codex-cli '+version,stderr:''};}});
  await service.inspect();const installed=await service.install('codex');assert.equal(installed.version,'2.0.0');const probes=seen.filter(c=>Buffer.from(c.args.at(-1)!,'base64').toString('utf16le').includes("'--version'"));assert.ok(probes.some(c=>Buffer.from(c.args.at(-1)!,'base64').toString('utf16le').includes("it''s $(noop) & tool.cmd'")));service.close();
});
test('CLI versions preserve prerelease identities and omit unparseable output',()=>{assert.equal(versionFromOutput('codex-cli 1.2.3-beta.2'),'1.2.3-beta.2');assert.equal(versionFromOutput('v24.18.0'),'24.18.0');assert.equal(versionFromOutput('unknown'),undefined);});

test('ChatGPT Store desktop version is separate from Codex CLI and desktop executables are never launched',async()=>{
  const commands:Command[]=[];
  const service=new ToolRuntimeService({directory:'.test-data/unused',platform:'win32',latest:async()=>undefined,find:async name=>name==='codex' ? '/mock/codex.exe' : undefined,run:async command=>{
    commands.push(command);const script=command.args.includes('-EncodedCommand') ? Buffer.from(command.args.at(-1)!,'base64').toString('utf16le') : '';
    if(script.includes('Get-AppxPackage'))return {code:0,stdout:JSON.stringify([{version:'1.2026.271.0',path:'/registered/ChatGPT'}]),stderr:''};
    if(script.includes('ConvertTo-Json'))return {code:0,stdout:'[]',stderr:''};return {code:0,stdout:'codex-cli 0.160.0',stderr:''};
  }});
  const states=await service.inspect();assert.equal(states.find(r=>r.tool==='codex')?.version,'0.160.0');assert.equal(states.find(r=>r.tool==='chatgpt')?.version,'1.2026.271.0');assert.ok(!commands.some(c=>c.file.includes('ChatGPT')));service.close();
});

test('failed ChatGPT registration query does not report a fake version or block CLI detection',async()=>{
  const service=new ToolRuntimeService({directory:'.test-data/unused',platform:'win32',latest:async()=>undefined,find:async name=>name==='codex' ? '/mock/codex.exe' : undefined,run:async command=>{if(command.args.includes('-EncodedCommand'))return {code:1,stdout:'',stderr:'Registry read denied'};return {code:0,stdout:'codex-cli 0.160.0',stderr:''};}});
  const states=await service.inspect();assert.equal(states.find(r=>r.tool==='codex')?.version,'0.160.0');assert.equal(states.find(r=>r.tool==='chatgpt')?.version,undefined);assert.equal(states.find(r=>r.tool==='chatgpt')?.phase,'error');service.close();
});

test('Store catalog selects the newest official ChatGPT desktop package version',()=>{
  const packages=[
    {PackageFamilyName:'OpenAI.Codex_2p2nqsd0c76g0',PackageFullName:'OpenAI.Codex_26.928.3736.0_x64__2p2nqsd0c76g0'},
    {PackageFamilyName:'OpenAI.Codex_2p2nqsd0c76g0',PackageFullName:'OpenAI.Codex_26.930.100.0_arm64__2p2nqsd0c76g0'},
    {PackageFamilyName:'Other.App_abc',PackageFullName:'Other.App_99.0.0.0_x64__abc'}
  ];
  assert.equal(chatGPTStoreVersion({Product:{DisplaySkuAvailabilities:[{Sku:{Properties:{Packages:packages}}}]}},'x64'),'26.928.3736.0');
  assert.equal(chatGPTStoreVersion({Product:{DisplaySkuAvailabilities:[{Sku:{Properties:{Packages:packages}}}]}},'arm64'),'26.930.100.0');
  assert.equal(chatGPTStoreVersion({Product:{DisplaySkuAvailabilities:[]}}),undefined);
});

test('latest version lookup is cached and failure leaves local versions intact',async()=>{
  const calls:string[]=[];
  const service=new ToolRuntimeService({directory:'.test-data/unused',platform:'linux',find:async name=>name==='codex' ? '/mock/codex' : undefined,run:async()=>({code:0,stdout:'codex-cli 0.159.1',stderr:''}),latest:async tool=>{calls.push(tool);if(tool==='claude')throw new Error('offline');return tool==='codex' ? '0.159.3' : undefined;}});
  const first=await service.inspect();assert.equal(first.find(r=>r.tool==='codex')?.version,'0.159.1');assert.equal(first.find(r=>r.tool==='codex')?.latestVersion,'0.159.3');assert.equal(first.find(r=>r.tool==='claude')?.latestVersion,undefined);assert.ok(first.every(r=>r.latestCheckedAt));
  await service.inspect();assert.equal(calls.length,3);await service.inspect(true);assert.equal(calls.length,6);service.close();
});

test('runtime inspection only probes enabled tools and queries ChatGPT with Codex',async()=>{
  const found:string[]=[],latest:string[]=[],commands:Command[]=[];
  const service=new ToolRuntimeService({directory:'.test-data/unused',platform:'win32',find:async name=>{found.push(name);return '/mock/'+name+'.exe';},latest:async tool=>{latest.push(tool);return undefined;},run:async command=>{commands.push(command);const script=command.args.includes('-EncodedCommand') ? Buffer.from(command.args.at(-1)!,'base64').toString('utf16le') : '';return {code:0,stdout:script ? '[]' : command.file.endsWith('node.exe') ? 'v24.18.0' : 'tool 1.2.3',stderr:''};}});
  assert.deepEqual(await service.inspect(true,[]),[]);assert.equal(found.length,0);assert.equal(latest.length,0);assert.equal(commands.length,0,'Empty scope does not read shell paths or spawn probes');
  const claude=await service.inspect(false,['claude']);assert.deepEqual(claude.map(state=>state.tool),['claude']);assert.ok(found.includes('claude'));assert.ok(!found.includes('codex'));assert.deepEqual(latest,['claude']);assert.ok(!commands.some(command=>command.args.some(argument=>{try{return Buffer.from(argument,'base64').toString('utf16le').includes('Get-AppxPackage');}catch{return false;}})),'Claude does not inspect ChatGPT registration');
  found.length=0;latest.length=0;commands.length=0;
  const codex=await service.inspect(true,['codex','codex']);assert.deepEqual(codex.map(state=>state.tool),['codex','chatgpt']);assert.ok(found.includes('codex'));assert.ok(!found.includes('claude'));assert.deepEqual(latest.sort(),['chatgpt','codex']);assert.ok(commands.some(command=>command.args.includes('-EncodedCommand') && Buffer.from(command.args.at(-1)!,'base64').toString('utf16le').includes('Get-AppxPackage')));
  found.length=0;latest.length=0;commands.length=0;
  assert.deepEqual(await service.inspect(true,[]),[]);assert.equal(found.length,0);assert.equal(latest.length,0);assert.equal(commands.length,0,'Empty scope avoids fresh and cached tool reads');service.close();
});

test('main runtime handler derives allowed tools from active adapters without broadening the IPC argument',async()=>{
  const source=await readFile('electron/main.ts','utf8'),line=source.split(/\r?\n/).find(value=>value.includes("handle('toolRuntimes',"));assert.ok(line);
  let handler!:(force?:boolean)=>Promise<unknown>;
  const enabled=new Set(['adapter.tool.claude']),calls:{force?:boolean;tools:string[]}[]=[];
  const schema={optional:()=>schema};
  runInNewContext((await transform(line,{loader:'ts'})).code,{z:{boolean:()=>schema},handle:(name:string,received:unknown,callback:typeof handler)=>{assert.equal(name,'toolRuntimes');assert.equal(received,schema);handler=callback;},plugins:{isEnabled:(id:string)=>enabled.has(id)},runtimes:{inspect:async(force:boolean|undefined,tools:string[])=>{calls.push({force,tools:[...tools]});return [];}}});
  await handler();assert.deepEqual(calls.at(-1),{force:undefined,tools:['claude']});
  enabled.add('adapter.tool.codex');await handler(true);assert.deepEqual(calls.at(-1),{force:true,tools:['codex','claude']});
  enabled.clear();await handler(false);assert.deepEqual(calls.at(-1),{force:false,tools:[]});
});
