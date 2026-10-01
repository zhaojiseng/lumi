import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,readdir,symlink,chmod} from 'node:fs/promises';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {AppLogStore,redactLog} from '../electron/services/app-logs';
import {windowLayout,macMenu} from '../electron/window-layout';
import {ToolRuntimeService,shellPath} from '../electron/services/tool-runtime';
import {macUpdater,macReleaseInfo} from '../electron/services/mac-updater';
import {UpdateService,validateUpdate} from '../electron/services/updates';

test('macOS uses native title controls and menu roles, and initial window fits the work area',()=>{
  const options=windowLayout('darwin',{width:1280,height:720});assert.equal(options.frame,true);assert.equal(options.titleBarStyle,'hidden');assert.deepEqual(options.trafficLightPosition,{x:24,y:22});assert.equal(options.height,720);assert.equal(options.minHeight,640);
  assert.equal(windowLayout('win32',{width:1920,height:1080}).frame,false);assert.ok(macMenu().some(item=>Array.isArray(item.submenu) && item.submenu.some(child=>child.role==='quit')));
});
test('runtime logs capture from startup, sanitize credentials, keep bounded memory and do not persist between instances',()=>{
  const store=new AppLogStore(3),seen:number[]=[];const stop=store.subscribe(entry=>{seen.push(entry.id);entry.message='subscriber mutation';});
  store.write('info','启动','started');store.write('debug','请求','ok');store.write('warn','请求','Cookie: fixture-cookie');store.write('error','工具','env: node: No such file or directory');
  const snapshot=store.snapshot();assert.deepEqual(seen,[1,2,3,4]);assert.equal(snapshot.dropped,1);assert.equal(snapshot.entries[0].message,'ok');snapshot.entries.length=0;assert.equal(store.snapshot().entries.length,3);stop();assert.equal(new AppLogStore().snapshot().entries.length,0);
  const raw='password="fixture-password" access_token=fixture-access API_KEY=fixture-key Bearer fixture-bearer sk-fixturesecret0123 '+'https://'+'name:secret@fixture.invalid/api?token=private#private';
  const safe=redactLog(raw);for(const value of ['fixture-password','fixture-access','fixture-key','fixture-bearer','sk-fixturesecret','name:secret','token=private','#private'])assert.ok(!safe.includes(value),value);
  assert.ok(!redactLog('{"cookie":"fixture-session; more=private"}').includes('fixture-session'));
});
test('macOS tool discovery finds NVM Node when the inherited GUI PATH has no Node',async()=>{
  const home=await mkdtemp(path.resolve('.test-data/mac-env-')),bin=path.join(home,'.nvm','versions','node','v24.18.0','bin');await mkdir(bin,{recursive:true});
  for(const name of ['node','npm','codex','claude'])await writeFile(path.join(bin,name),'#!/usr/bin/env node\n');
  let shellReads=0;const seen:{file:string;path?:string}[]=[];
  const service=new ToolRuntimeService({directory:home,home,platform:'darwin',env:{PATH:home,SHELL:'/bin/zsh',NVM_DIR:path.join(home,'.nvm')},latest:async()=>undefined,run:async command=>{
    seen.push({file:command.file,path:command.env?.PATH});
    if(command.args.includes('-ilc')){shellReads++;return {code:0,stdout:'Shell startup text\n\x1eLUMI_PATH\x1f'+home+'\x1e',stderr:''};}
    if(command.file==='/usr/bin/plutil')return {code:1,stdout:'',stderr:''};
    assert.ok(command.env?.PATH?.startsWith(bin),JSON.stringify(command.env));return {code:0,stdout:command.file.endsWith('node') ? 'v24.18.0' : 'tool 1.2.3',stderr:''};
  }});
  const states=await service.inspect();assert.equal(shellReads,1);assert.equal(states[0].version,'1.2.3');assert.equal(states[0].nodeVersion,'24.18.0',JSON.stringify(seen));assert.equal(states[0].npmAvailable,true);
  await service.inspect(true);assert.equal(shellReads,2);service.close();assert.equal(shellPath('noise\x1eLUMI_PATH\x1f/opt/homebrew/bin:/usr/bin\x1e'),'/opt/homebrew/bin:/usr/bin');
});
test('Unix CLI shebang actually resolves Node from the repaired GUI environment',{skip:process.platform==='win32'},async()=>{
  const home=await mkdtemp(path.resolve('.test-data/mac-real-env-')),bin=path.join(home,'.nvm','versions','node','v24.18.0','bin');await mkdir(bin,{recursive:true});await symlink(process.execPath,path.join(bin,'node'));
  const cli=path.join(bin,'codex');await writeFile(cli,`#!/usr/bin/env node\nif (process.versions.node !== '${process.versions.node}') process.exit(1);\nconsole.log('codex-cli 1.2.3');\n`);await chmod(cli,0o755);
  // Keep discovery isolated from preinstalled CI tools; execution uses the real process runner.
  const service=new ToolRuntimeService({directory:home,home,platform:'darwin',env:{PATH:'/usr/bin:/bin',HOME:home,SHELL:'/bin/sh',NVM_DIR:path.join(home,'.nvm')},find:async name=>name==='node' || name==='codex' ? path.join(bin,name) : undefined,latest:async()=>undefined});
  try{const states=await service.inspect();assert.equal(states[0].version,'1.2.3',JSON.stringify(states[0]));assert.equal(states[0].nodeVersion,process.versions.node,JSON.stringify(states[0]));}finally{service.close();}
});
const bytes=Buffer.from('Isolated DMG fixture, not an application.'),version='0.4.23',name=`Lumi-${version}-arm64.dmg`,url=`https://github.com/zhaojiseng/lumi/releases/download/v${version}/${name}`;
function release(){return {tag_name:'v'+version,draft:false,prerelease:false,assets:[{name,size:bytes.length,digest:'sha256:'+createHash('sha256').update(bytes).digest('hex'),browser_download_url:url}]};}
test('macOS update only accepts official ARM64 DMG and complete SHA-256, rejecting other assets',()=>{
  assert.equal(validateUpdate(macReleaseInfo(release()),'mac-arm64').size,bytes.length);
  for(const invalid of [{...release(),draft:true},{...release(),prerelease:true},{...release(),tag_name:'v0.4.23-beta'},{...release(),assets:[{...release().assets[0],digest:'invalid'}]},{...release(),assets:[{...release().assets[0],browser_download_url:'https://untrusted.invalid/app.dmg'}]},{...release(),assets:[{...release().assets[0],name:'Lumi-0.4.23-x64.dmg'}]}])assert.throws(()=>macReleaseInfo(invalid));
});
test('macOS DMG download reports progress, validates the file and cannot trigger Windows restart installation',async()=>{
  const directory=await mkdtemp(path.resolve('.test-data/mac-update-'));let requested=0;
  const engine=macUpdater(directory,async input=>{requested++;return String(input).includes('api.github.com') ? Response.json(release()) : new Response(bytes);});
  const service=new UpdateService({version:'0.4.22',enabled:true,target:'mac-arm64',engine});assert.equal((await service.check()).phase,'available');assert.equal(service.snapshot().installMode,'replace');assert.equal((await service.download()).phase,'ready');assert.equal(service.snapshot().received,bytes.length);assert.ok((await service.readyFile()).endsWith(name));await assert.rejects(service.restart(),/macOS/);assert.equal(requested,2);assert.deepEqual(await readdir(directory),[name]);service.close();
});
test('macOS update removes partial downloads on cancel and rejects corrupt files',async()=>{
  const directory=await mkdtemp(path.resolve('.test-data/mac-update-fail-'));const controller=new AbortController();
  const engine=macUpdater(directory,async input=>String(input).includes('api.github.com') ? Response.json(release()) : new Response(bytes));await engine.check();await assert.rejects(engine.download(controller.signal,()=>controller.abort()));assert.deepEqual(await readdir(directory),[]);
  const corrupt=macUpdater(directory,async input=>String(input).includes('api.github.com') ? Response.json(release()) : new Response(Buffer.alloc(bytes.length)));const service=new UpdateService({version:'0.4.22',enabled:true,target:'mac-arm64',engine:corrupt});await service.check();assert.equal((await service.download()).phase,'error');await assert.rejects(service.readyFile());service.close();
});
