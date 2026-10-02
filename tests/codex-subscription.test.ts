import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,readFile,rm} from 'node:fs/promises';
import path from 'node:path';
import {normalizeCodexUsage} from '../plugins/provider.codex/services/normalize';
import {CodexUsageService,codexAuthScope} from '../plugins/provider.codex/services/usage';
import {CodexAccountRpc} from '../plugins/provider.codex/services/rpc';
import {SubscriptionResource} from '../src/host/subscription-resource';
import {createBuiltinPlugins} from '../electron/host/plugins';
import {SettingsStore} from '../electron/services/store';
import {workbenchManifest} from '../plugins/feature.workbench/manifest';
import {usageManifest} from '../plugins/feature.usage/manifest';
import {workbenchContributions,usageContributions,rendererNavigation} from '../src/host/renderer-registry';
import {builtinManifests} from '../plugins/manifests';
import {applyPreferencePatch,normalizeSourceSelections} from '../shared/selections';
import {DEFAULT_PREFERENCES} from '../shared/types';
const account={account:{type:'chatgpt',email:'fixture@example.invalid',planType:'plus'}};
const limits={rateLimits:{primary:{usedPercent:23,windowDurationMins:300,resetsAt:1900000000},secondary:{usedPercent:71,windowDurationMins:10080,resetsAt:1900400000},credits:{balance:'17.25',hasCredits:true,unlimited:false}}};
function deferred<T>(){let resolve!:(value:T)=>void;return {promise:new Promise<T>(r=>{resolve=r;}),resolve:(value:T)=>resolve(value)};}
async function fixture(t:{after(fn:()=>Promise<void>):void}){const base=path.resolve('.test-data');await mkdir(base,{recursive:true});const root=await mkdtemp(path.join(base,'codex-subscription-'));t.after(()=>rm(root,{recursive:true,force:true,maxRetries:5,retryDelay:100}));return root;}
test('Codex windows retain server duration/reset and credits; missing/invalid values remain unknown',()=>{
  const value=normalizeCodexUsage(account,limits,'scope',100);
  assert.equal(value.state,'ready');assert.equal(value.windows[0].secondary?.remainingPercent,29);assert.equal(value.windows[0].secondary?.durationMinutes,10080);assert.equal(value.windows[0].secondary?.resetsAt,1900400000000);assert.equal(value.windows[0].credits?.remaining,17.25);
  assert.notEqual(value.account?.id,normalizeCodexUsage(account,limits,'other').account?.id);assert.doesNotMatch(JSON.stringify(value),/access_token|refresh_token/);
  const invalid=normalizeCodexUsage(account,{rateLimits:{primary:{usedPercent:-1,windowDurationMins:0,resetsAt:'bad'},credits:{balance:'not-a-number'}}},'scope');
  assert.deepEqual(invalid.windows[0].primary,{usedPercent:null,remainingPercent:null,durationMinutes:null,resetsAt:null});assert.equal(invalid.windows[0].credits?.remaining,null);assert.equal(invalid.windows[0].secondary,null);
  assert.equal(normalizeCodexUsage(account,{rateLimits:{credits:{balance:'0'}}},'scope').windows[0].credits?.remaining,0);
  assert.equal(normalizeCodexUsage(account,{rateLimits:{primary:{usedPercent:110}}},'scope').windows[0].primary?.remainingPercent,0);
  assert.equal(normalizeCodexUsage({account:null},limits,'scope').state,'signed-out');assert.equal(normalizeCodexUsage({account:{type:'apiKey'}},limits,'scope').state,'unsupported');
});
test('multi-bucket quota separates model limits from weekly windows and preserves legacy credit metadata',()=>{
  const value=normalizeCodexUsage(account,{...limits,rateLimitsByLimitId:{codex:{secondary:{usedPercent:10,windowDurationMins:10080}},spark:{limitName:'Spark',primary:{usedPercent:20,windowDurationMins:60},credits:{unlimited:true}}}},'scope');
  assert.equal(value.windows.length,2);assert.equal(value.windows[0].secondary?.remainingPercent,90);assert.equal(value.windows[0].credits?.remaining,17.25);assert.equal(value.windows[1].label,'Spark');assert.equal(value.windows[1].primary?.durationMinutes,60);assert.equal(value.windows[1].credits?.unlimited,true);
});
test('usage reads coalesce, cache per Codex auth scope, reject changed accounts and clean up on disable',async()=>{
  let scope='a',reads=0,closes=0,now=100;const wait=deferred<{account:unknown;limits:unknown}>();
  const service=new CodexUsageService({resolve:async()=>({file:'fixture',args:[]}),scope:async()=>scope,now:()=>now,connect:()=>({read:async()=>{reads++;return wait.promise;},close:()=>{closes++;}})});
  const one=service.read(),two=service.read();await new Promise(r=>setImmediate(r));assert.equal(reads,1);wait.resolve({account,limits});await one;await two;assert.equal(closes,1);
  await service.read();assert.equal(reads,1);now=60101;await service.read();assert.equal(reads,2);
  scope='b';await service.read();assert.equal(reads,3);
  const late=deferred<{account:unknown;limits:unknown}>();
  const changing=new CodexUsageService({resolve:async()=>({file:'fixture',args:[]}),scope:async()=>scope,connect:()=>({read:()=>late.promise,close:()=>{closes++;}})});
  const old=changing.read();await new Promise(r=>setImmediate(r));scope='c';late.resolve({account,limits});await assert.rejects(old,/切换/);
  const revoked=new CodexUsageService({resolve:async()=>({file:'fixture',args:[]}),scope:async()=>scope,connect:()=>({read:()=>late.promise,close:()=>{}})});revoked.close();await assert.rejects(revoked.read(),/停用/);service.close();changing.close();
});
test('bounded local auth fingerprint changes without persisting or returning credentials',async t=>{
  const root=await fixture(t),home=path.join(root,'.codex');await mkdir(home);
  const absent=await codexAuthScope(home);await writeFile(path.join(home,'auth.json'),'{"tokens":{"access_token":"fake-only"}}');const first=await codexAuthScope(home);assert.notEqual(first,absent);assert.match(first,/^[a-f0-9]{64}$/);
  await writeFile(path.join(home,'auth.json'),'{"tokens":{"access_token":"different-fake"}}');assert.notEqual(await codexAuthScope(home),first);
  await writeFile(path.join(home,'auth.json'),'x'.repeat(1024*1024+1));await assert.rejects(codexAuthScope(home));
});
test('real stdio client sends only initialization and account reads, handles split lines and ignores notices',async t=>{
  const root=await fixture(t),script=path.join(root,'mock.cjs'),audit=path.join(root,'methods.json');
  await writeFile(script,`const fs=require('node:fs'),readline=require('node:readline');const methods=[];readline.createInterface({input:process.stdin}).on('line',line=>{const q=JSON.parse(line);methods.push(q.method);fs.writeFileSync(${JSON.stringify(audit)},JSON.stringify(methods));if(!q.id)return;const result=q.method==='account/read' ? ${JSON.stringify(account)} : q.method==='account/rateLimits/read' ? ${JSON.stringify(limits)} : {};const text=JSON.stringify({id:q.id,result})+'\\n';process.stdout.write(JSON.stringify({method:'account/rateLimits/updated',params:{}})+'\\n');process.stdout.write(text.slice(0,7));setTimeout(()=>process.stdout.write(text.slice(7)),5);});`);
  const rpc=new CodexAccountRpc({file:process.execPath,args:[script],env:{...process.env,CODEX_HOME:root}},2000);t.after(async()=>rpc.close());
  const value=await rpc.read();rpc.close();assert.deepEqual(value,{account,limits});assert.deepEqual(JSON.parse(await readFile(audit,'utf8')),['initialize','initialized','account/read','account/rateLimits/read','account/read']);
});
test('stdio client times out, rejects overlarge output and never exposes raw server errors',async t=>{
  const root=await fixture(t);
  for(const [name,code,timeout,expected] of [['timeout','setInterval(()=>{},100)',80,/超时/],['oversize',"process.stdout.write('x'.repeat(1024*1024+1));setInterval(()=>{},100)",2000,/超出/],['error',"require('node:readline').createInterface({input:process.stdin}).on('line',line=>{const q=JSON.parse(line);process.stdout.write(JSON.stringify({id:q.id,error:{message:'Bearer secret-fake-only'}})+'\\n');});",2000,/读取失败/]] as const){
    const file=path.join(root,name+'.cjs');await writeFile(file,code);const rpc=new CodexAccountRpc({file:process.execPath,args:[file]},timeout);await assert.rejects(rpc.read(),expected);rpc.close();
  }
});
test('renderer resource revokes old reads across disable/re-enable and clears failed account data',async()=>{
  const requests:ReturnType<typeof deferred<ReturnType<typeof normalizeCodexUsage>>>[]=[];
  const resource=new SubscriptionResource(()=>{const request=deferred<ReturnType<typeof normalizeCodexUsage>>();requests.push(request);return request.promise;});
  resource.configure(true);const old=resource.refresh();assert.equal(resource.refresh(),old);await Promise.resolve();resource.configure(false);resource.configure(true);const next=resource.refresh();await Promise.resolve();requests[0].resolve(normalizeCodexUsage(account,limits,'old'));await old;assert.equal(resource.getState().snapshot,null);requests[1].resolve(normalizeCodexUsage(account,limits,'new'));await next;assert.equal(resource.getState().snapshot?.account?.id,normalizeCodexUsage(account,limits,'new').account?.id);
});
test('a provider disabled during a read closes the client and rejects the late result',async()=>{
  const waiting=deferred<{account:unknown;limits:unknown}>();let closed=0;
  const service=new CodexUsageService({home:path.resolve('.test-data/codex-fixture-home'),scope:async()=> 'fixture',resolve:async()=>({file:'fixture',args:[],env:{OPENAI_API_KEY:'fake-only'}}),connect:command=>{
    assert.equal(command.env?.OPENAI_API_KEY,undefined);assert.equal(command.env?.CODEX_HOME,path.resolve('.test-data/codex-fixture-home'));
    return {read:()=>waiting.promise,close:()=>{closed++;}};
  }});
  const result=service.read();await new Promise(resolve=>setImmediate(resolve));service.close();assert.equal(closed,1);waiting.resolve({account,limits});await assert.rejects(result,/停用/);
});
test('Workbench and Usage are source-neutral; providers own contributions and Codex disable is persisted',async t=>{
  assert.deepEqual(workbenchManifest.requires,[]);assert.deepEqual(usageManifest.requires,[]);
  const statuses=builtinManifests.map(manifest=>({manifest,state:manifest.id==='provider.newapi' ? 'disabled' as const : 'active' as const}));
  assert.deepEqual(workbenchContributions(statuses).map(card=>card.id),['codex.subscription']);assert.deepEqual(usageContributions(statuses).map(view=>view.id),['local']);assert.ok(rendererNavigation([],statuses).some(item=>item.id==='overview'));
  const root=await fixture(t),store=new SettingsStore(root,{available:()=>true,encrypt:s=>s,decrypt:s=>s});await store.load();
  const host=await createBuiltinPlugins(store,{localHome:root});t.after(()=>host.dispose());assert.ok(host.require('provider.codex','subscriptionUsage.read'));
  await host.setEnabled('provider.codex',false);assert.throws(()=>host.require('provider.codex','subscriptionUsage.read'));await store.load();assert.equal(store.preferences.pluginEnabled['provider.codex'],false);
  const restarted=await createBuiltinPlugins(store,{localHome:root});t.after(()=>restarted.dispose());assert.throws(()=>restarted.require('provider.codex','subscriptionUsage.read'));
  const patched=applyPreferencePatch(structuredClone(DEFAULT_PREFERENCES),{sourceSelection:{sourceId:'source.local-sessions',values:{range:30,tool:'codex'}}});
  const switched=applyPreferencePatch(patched,{activeSiteId:'different-site'});assert.deepEqual(switched.sourceSelections,patched.sourceSelections);assert.deepEqual(switched.viewSelections,{});
  await store.update({sourceSelection:{sourceId:'source.local-sessions',values:{range:30,tool:'codex',models:['fixture']}}});await store.load();assert.deepEqual(store.preferences.sourceSelections['source.local-sessions'],{range:30,tool:'codex',models:['fixture']});
  const migrated=normalizeSourceSelections(undefined,{a:{'usage.tab':'local','usage.localTool':'claude','statistics.range':30,'statistics.models':['m']},b:{'statistics.range':1}},'a');assert.deepEqual(migrated,{'feature.usage':{tab:'local'},'source.local-sessions':{tool:'claude',range:30,models:['m']}});assert.deepEqual(normalizeSourceSelections({}, {},'b'),{});
});
