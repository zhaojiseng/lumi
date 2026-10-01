import test from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {mkdtemp,mkdir,readFile,writeFile} from 'node:fs/promises';
import {generateKeyPairSync,privateDecrypt,createDecipheriv} from 'node:crypto';
import path from 'node:path';
import {SettingsStore,type Cipher} from '../electron/services/store';
import {NewApiClient} from '../electron/services/new-api';
import {normalizeCatalog,availableGroups,groupRatio} from '../shared/catalog';
import {publishedPriceSections,legacyPrices,compilePrice} from '../shared/pricing';
import {buildCodex,ConfigService} from '../electron/services/config';
import {parse} from 'smol-toml';
import type {ApiToken,ModelInfo,UsageLog,QuotaPoint} from '../shared/types';
const cipher:Cipher={available:() => true,encrypt:s => Buffer.from(s).toString('base64'),decrypt:s => Buffer.from(s,'base64').toString()};
const status={system_name:'Fixture',quota_per_unit:500000,quota_display_type:'CUSTOM',custom_currency_symbol:'✾',custom_currency_exchange_rate:2,password_login_enabled:true,password_login_encryption_enabled:false,turnstile_check:false};
const model:ModelInfo={model_name:'model-a',quota_type:0,model_ratio:1.5,model_price:0,completion_ratio:5,cache_ratio:.1,create_cache_ratio:1.25,enable_groups:['standard','premium'],supported_endpoint_types:['openai-response','anthropic']};
async function workflow(options:{twoFA?:boolean;legacy?:boolean;captcha?:boolean;encryption?:boolean;expires?:boolean;maskKey?:boolean;key404?:boolean;endpointTypes?:string[];logs?:UsageLog[];points?:QuotaPoint[];detailFailure?:boolean;pointFailure?:boolean}={}) {
  await mkdir('.test-data',{recursive:true});const root=await mkdtemp(path.resolve('.test-data/workflow-'));const store=new SettingsStore(root,cipher);await store.load();
  const seen:{endpoint:string;method:string;body:any;cookie:string;auth:string;user:string;origin:string}[]=[];let refreshCount=0;let created=0;let legacyPAT=0;const tokens:ApiToken[]=[];let current='session-initial';let suppliedPassword='';const rsa=options.encryption ? generateKeyPairSync('rsa',{modulusLength:2048}) : undefined;
  const server=createServer(async(req,res) => {
    const u=new URL(req.url!,'http://localhost');let raw='';for await (const chunk of req)raw+=chunk;const body=raw ? JSON.parse(raw) : undefined;
    seen.push({endpoint:u.pathname,method:req.method!,body,cookie:req.headers.cookie || '',auth:req.headers.authorization || '',user:String(req.headers['new-api-user'] || ''),origin:req.headers.origin || ''});res.setHeader('Content-Type','application/json');
    const send=(data:any,extra:any={}) => res.end(JSON.stringify({success:true,data,...extra}));
    const user={id:42,username:'fixture-user',display_name:'Fixture',quota:10000000,used_quota:0,group:'standard',request_count:0};
    if(u.pathname === '/api/status')return send({...status,turnstile_check:!!options.captcha,password_login_encryption_enabled:!!options.encryption});
    if(u.pathname === '/api/user/login/encryption-key')return send({enabled:true,kid:'fixture-kid',public_key:rsa!.publicKey.export({type:'spki',format:'pem'})});
    const login=() => {res.setHeader('Set-Cookie',options.legacy ? 'session=legacy-cookie; HttpOnly; Path=/' : 'new_api_refresh=refresh-initial; HttpOnly; Path=/api/user/auth; Max-Age=2592000');return send(options.legacy ? user : {access_token:current,access_expires_at:Math.floor(Date.now()/1000)+(options.expires ? -10 : 900),user,session:{sid:'sid-fixture'}});};
    if(u.pathname === '/api/user/login') {
      if(options.encryption) {assert.equal(body.password,undefined);const parts=body.password_encrypted.split('.');const aes=privateDecrypt({key:rsa!.privateKey,oaepHash:'sha256',oaepLabel:Buffer.from('password-v2')},Buffer.from(parts[1],'base64'));const payload=Buffer.from(parts[3],'base64');const d=createDecipheriv('aes-256-gcm',aes,Buffer.from(parts[2],'base64'));d.setAuthTag(payload.subarray(-16));suppliedPassword=Buffer.concat([d.update(payload.subarray(0,-16)),d.final()]).toString();} else suppliedPassword=body.password;
      if(options.twoFA)return send({require_verification:true,flow_token:'server-flow-secret',methods:[{method:'2fa'}],expires_at:Math.floor(Date.now()/1000)+300});return login();
    }
    if(u.pathname === '/api/user/login/verify'){if(body.code !== '123456')return res.end(JSON.stringify({success:false,message:'验证码错误'}));assert.equal(body.flow_token,'server-flow-secret');return login();}
    if(u.pathname === '/api/user/auth/refresh'){refreshCount++;assert.equal(req.headers.cookie,'new_api_refresh=refresh-initial');assert.equal(req.headers.origin,'http://127.0.0.1:'+port);await new Promise(resolve => setTimeout(resolve,15));current='session-rotated';res.setHeader('Set-Cookie','new_api_refresh=refresh-rotated; HttpOnly; Path=/api/user/auth; Max-Age=2592000');return send({access_token:current,access_expires_at:Math.floor(Date.now()/1000)+900,user,session:{sid:'sid-fixture'}});}
    if(u.pathname === '/api/user/auth/logout')return send({});
    if(u.pathname === '/api/user/token'){legacyPAT++;assert.ok(req.headers.cookie?.includes('session=legacy-cookie'));return send('legacy-account-PAT');}
    if(u.pathname === '/api/user/self')return send(user);
    if(u.pathname === '/api/pricing'){const catalogModel={...model,supported_endpoint_types:options.endpointTypes ?? model.supported_endpoint_types};return send([catalogModel,{...catalogModel,model_name:'model-b',enable_groups:['premium']}],{usable_group:{standard:{desc:'标准渠道',ratio:1},premium:{desc:'高质量渠道',ratio:2},auto:{desc:'自动渠道'}},group_ratio:{standard:1,premium:2},auto_groups:['standard','premium']});}
    if(u.pathname === '/api/token/' && req.method === 'POST'){created++;tokens.push({id:created,name:body.name,status:1,remain_quota:body.remain_quota,used_quota:0,unlimited_quota:body.unlimited_quota,expired_time:-1,created_time:0,group:body.group,model_limits_enabled:body.model_limits_enabled,model_limits:body.model_limits});return send({});}
    if(u.pathname === '/api/token/' && req.method === 'PUT'){const token=tokens.find(t=>t.id===body.id);if(!token){res.statusCode=404;return send(null);}Object.assign(token,body);return send({});}
    if(u.pathname === '/api/token/')return send({items:tokens.map(t => ({...t,key:'must-never-display'})),total:tokens.length});
    if(/^\/api\/token\/\d+\/key$/.test(u.pathname)){if(options.key404){res.statusCode=404;return res.end(JSON.stringify({success:false}));}return send(options.maskKey ? 'sk-******' : 'private-key-'+u.pathname.split('/')[3]);}
    if(/^\/api\/token\/\d+$/.test(u.pathname))return send({key:'legacy-key'});
    if(u.pathname === '/api/log/self'){if(options.detailFailure){res.statusCode=403;return res.end(JSON.stringify({success:false}));}const rows=(options.logs || []).filter(r=>r.created_at>=Number(u.searchParams.get('start_timestamp')) && r.created_at<=Number(u.searchParams.get('end_timestamp')));const page=Number(u.searchParams.get('p') || 1)-1,size=Number(u.searchParams.get('page_size') || 100);return send({items:rows.slice(page*size,(page+1)*size),total:rows.length});}
    if(u.pathname === '/api/data/self'){if(options.pointFailure){res.statusCode=403;return res.end(JSON.stringify({success:false}));}return send((options.points || []).filter(p=>p.created_at>=Number(u.searchParams.get('start_timestamp')) && p.created_at<=Number(u.searchParams.get('end_timestamp'))));}
    if(u.pathname === '/api/log/self/stat')return send({quota:10,rpm:1,tpm:2});
    res.statusCode=404;res.end(JSON.stringify({success:false,message:'Unknown endpoint'}));
  });
  await new Promise<void>(resolve => server.listen(0,'127.0.0.1',resolve));const port=(server.address() as any).port;const url='http://127.0.0.1:'+port;await store.saveSite({id:store.activeSite().id,name:'Fixture',url,allowHttp:true});const api=new NewApiClient(store);
  return {root,store,api,seen,tokens,url,get created(){return created;},get refreshCount(){return refreshCount;},get legacyPAT(){return legacyPAT;},get suppliedPassword(){return suppliedPassword;},close:() => new Promise<void>(resolve => server.close(() => resolve()))};
}
test('password login saves only encrypted session credentials and automatically restores authentication',async() => {
  const f=await workflow();try{const r=await f.api.login({username:'fixture-user',password:'password-only-in-memory'});assert.equal(r.state,'success');assert.equal(f.store.activeSite().username,'fixture-user');assert.equal(f.store.credentials().accessToken,'session-initial');assert.equal(f.legacyPAT,0);const disk=await readFile(path.join(f.root,'settings.json'),'utf8');for(const v of ['password-only-in-memory','session-initial','refresh-initial'])assert.ok(!disk.includes(v));const restored=new SettingsStore(f.root,cipher);await restored.load();assert.equal((await new NewApiClient(restored).dashboard(7)).user?.id,42);assert.ok(!JSON.stringify(r).includes('session-initial'));}finally{await f.close();}
});
test('login supports hybrid password encryption with the exact server OAEP label',async() => {const f=await workflow({encryption:true});try{await f.api.login({username:'fixture-user',password:'长密码-'.repeat(60)});assert.equal(f.suppliedPassword,'长密码-'.repeat(60));const login=f.seen.find(s => s.endpoint === '/api/user/login')!;assert.equal(login.body.password,undefined);assert.ok(login.body.password_encrypted.startsWith('v2.'));}finally{await f.close();}});
test('2FA login keeps challenge secrets out of the renderer and persists only after verification',async() => {const f=await workflow({twoFA:true});try{const result=await f.api.login({username:'fixture-user',password:'pw'});assert.equal(result.state,'verification');assert.ok(!JSON.stringify(result).includes('server-flow-secret'));assert.equal(f.store.activeSite().accessTokenConfigured,false);if(result.state !== 'verification')throw new Error();await assert.rejects(f.api.verifyLogin({challengeId:result.challengeId,code:'wrong'}),/验证码/);const final=await f.api.verifyLogin({challengeId:result.challengeId,code:'123456'});assert.equal(final.state,'success');await assert.rejects(f.api.verifyLogin({challengeId:result.challengeId,code:'123456'}),/过期/);}finally{await f.close();}});
test('Turnstile sites require the secure window and never submit an unverified password',async() => {const f=await workflow({captcha:true});try{await assert.rejects(f.api.login({username:'fixture-user',password:'pw'}),/安全登录/);assert.equal(f.seen.filter(s => s.endpoint === '/api/user/login').length,0);}finally{await f.close();}});
test('legacy cookie login automatically obtains a personal access token',async() => {const f=await workflow({legacy:true});try{await f.api.login({username:'fixture-user',password:'pw'});assert.equal(f.store.credentials().accessToken,'legacy-account-PAT');assert.equal(f.legacyPAT,1);}finally{await f.close();}});
test('concurrent dashboard requests share one refresh and save rotated cookies for the auth path',async() => {const f=await workflow({expires:true});try{await f.api.login({username:'fixture-user',password:'pw'});const d=await f.api.dashboard(7);assert.equal(d.warnings.length,0);assert.equal(f.refreshCount,1);assert.equal(f.store.credentials().accessToken,'session-rotated');assert.equal(f.store.credentials().cookies?.[0].value,'refresh-rotated');assert.ok(f.seen.filter(s => !s.endpoint.startsWith('/api/user/auth/')).every(s => !s.cookie.includes('new_api_refresh')));}finally{await f.close();}});
test('logout clears authentication and cannot expose previous account tool bindings',async() => {const f=await workflow();try{await f.api.login({username:'fixture-user',password:'pw'});await f.api.ensureToolToken({tool:'codex',model:'model-a',group:'standard'});await f.api.logout(f.store.activeSite().id);assert.equal(f.store.activeSite().accessTokenConfigured,false);assert.deepEqual(f.store.preferences.managedTokens,[]);assert.equal(f.store.toolKey('codex'),'');assert.equal((await f.api.dashboard(7)).user,null);}finally{await f.close();}});
test('automatic provisioning validates model/route, creates once concurrently, reuses and records tool cost',async() => {const f=await workflow();try{await f.api.login({username:'fixture-user',password:'pw'});const req={tool:'codex' as const,model:'model-a',group:'standard'};const [a,b]=await Promise.all([f.api.ensureToolToken(req),f.api.ensureToolToken(req)]);assert.equal(f.created,1);assert.equal(a.tokenId,b.tokenId);assert.equal(a.tokenName,'Lumi-Codex');assert.equal(b.created,false);assert.deepEqual(a.models?.map(m=>m.model_name),['model-a']);const switched=await f.api.ensureToolToken({...req,group:'premium'});assert.equal(f.created,1);assert.equal(switched.tokenId,a.tokenId);assert.equal(switched.key,a.key);assert.equal(f.tokens[0].group,'premium');await assert.rejects(f.api.ensureToolToken({...req,model:'model-b'}),/渠道/);const d=await f.api.dashboard(7);assert.equal(d.toolStats?.find(t => t.tool === 'codex')?.stat?.quota,10);assert.ok(!JSON.stringify(d).includes('must-never-display'));}finally{await f.close();}});
test('stable tool token does not bypass model restrictions or revive stopped or expired keys',async()=>{const f=await workflow();try{
 await f.api.login({username:'fixture-user',password:'pw'});const a=await f.api.ensureToolToken({tool:'codex',model:'model-a',group:'premium'});const token=f.tokens.find(t=>t.id===a.tokenId)!;
 token.model_limits_enabled=true;token.model_limits='model-a';await f.api.toggleToken(token.id,true);
 await assert.rejects(f.api.ensureToolToken({tool:'codex',model:'model-b',group:'premium'}),/模型限制/);assert.equal(f.created,1);
 await f.api.toggleToken(token.id,false);await assert.rejects(f.api.ensureToolToken({tool:'codex',model:'model-a',group:'premium'}),/不可用/);assert.equal(token.status,2);
 const c=await f.api.ensureToolToken({tool:'claude',model:'model-a',group:'premium'});assert.notEqual(c.tokenId,a.tokenId);assert.equal(c.tokenName,'Lumi-Claude');
 token.status=1;token.expired_time=Math.floor(Date.now()/1000)-1;await f.api.toggleToken(token.id,true);await assert.rejects(f.api.ensureToolToken({tool:'codex',model:'model-a',group:'premium'}),/有效期/);assert.equal(f.created,2);
}finally{await f.close();}});
test('both tools provision all site models regardless of missing or unrelated protocol metadata, while retaining model and route checks',async()=>{
 for(const endpointTypes of [[],['gemini'],['openai-response']]){const f=await workflow({endpointTypes});try{
  await f.api.login({username:'fixture-user',password:'pw'});
  const codex=await f.api.ensureToolToken({tool:'codex',model:'model-a',group:'standard'});
  const configs=new ConfigService(f.store,f.root,path.join(f.root,'home'),req=>f.api.ensureToolToken(req));
  const preview=await configs.preview({tool:'claude',model:'model-a',group:'standard'});assert.equal(preview.files.length,1);await configs.apply(preview.id);
  const cli=JSON.parse(await readFile(path.join(f.root,'home','.claude','settings.json'),'utf8'));assert.equal(cli.env.ANTHROPIC_MODEL,'model-a');assert.ok(cli.env.ANTHROPIC_AUTH_TOKEN);
  assert.notEqual(preview.token?.id,codex.tokenId);assert.equal(f.created,2);
  await assert.rejects(f.api.ensureToolToken({tool:'claude',model:'missing',group:'standard'}),/站点提供/);
  await assert.rejects(f.api.ensureToolToken({tool:'claude',model:'model-b',group:'standard'}),/渠道/);assert.equal(f.created,2);
 }finally{await f.close();}}
});
test('masked keys fail closed and do not fall back to a manual/shared key',async() => {const f=await workflow({maskKey:true});try{await f.api.login({username:'fixture-user',password:'pw'});await assert.rejects(f.api.ensureToolToken({tool:'codex',model:'model-a',group:'standard'}),/完整令牌/);assert.equal(f.store.toolKey('codex'),'');assert.equal(f.created,1);await assert.rejects(f.api.ensureToolToken({tool:'codex',model:'model-a',group:'standard'}));assert.equal(f.created,1);}finally{await f.close();}});
test('404 key endpoint supports legacy key retrieval without suppressing permission errors',async() => {const f=await workflow({key404:true});try{await f.api.login({username:'fixture-user',password:'pw'});const t=await f.api.ensureToolToken({tool:'codex',model:'model-a',group:'standard'});assert.equal(t.key,'sk-legacy-key');}finally{await f.close();}});
test('channel changes serialize on the same tool key and retain quota, usage, IP rules and expiration',async()=>{const f=await workflow();try{
 await f.api.login({username:'fixture-user',password:'pw'});const a=await f.api.ensureToolToken({tool:'codex',model:'model-a',group:'standard'}),token=f.tokens[0];
 token.remain_quota=12345;token.used_quota=54321;token.allow_ips='192.0.2.0/24';token.expired_time=Math.floor(Date.now()/1000)+86400;token.unlimited_quota=false;
 await f.api.toggleToken(token.id,true);
 const [b,c]=await Promise.all([f.api.ensureToolToken({tool:'codex',model:'model-a',group:'premium'}),f.api.ensureToolToken({tool:'codex',model:'model-a',group:'standard'})]);
 assert.equal(f.created,1);assert.equal(b.key,a.key);assert.equal(c.key,a.key);assert.equal(token.group,'standard');assert.equal(token.name,'Lumi-Codex');assert.equal(token.remain_quota,12345);assert.equal(token.used_quota,54321);assert.equal(token.allow_ips,'192.0.2.0/24');assert.equal(token.unlimited_quota,false);
 const writes=f.seen.filter(r=>r.endpoint==='/api/token/' && r.method==='PUT' && r.body.group);assert.equal(writes.length,2);assert.ok(writes.every(r=>r.body.key===undefined && r.body.status===undefined && r.body.used_quota===undefined));
}finally{await f.close();}});
test('legacy channel token migrates to a stable name without rotating the key or losing historical tool names',async()=>{const f=await workflow();try{
 await f.api.login({username:'fixture-user',password:'pw'});const a=await f.api.ensureToolToken({tool:'codex',model:'model-a',group:'standard'}),token=f.tokens[0],site=f.store.activeSite();token.name='Lumi-Codex-standard';
 await f.store.registerToken({siteId:site.id,tool:'codex',id:token.id,name:token.name,group:'standard'},site.url);await f.store.saveBinding({siteId:site.id,tool:'codex',tokenName:token.name,tokenId:token.id,model:'model-a',group:'standard'});await f.api.toggleToken(token.id,true);
 const b=await f.api.ensureToolToken({tool:'codex',model:'model-a',group:'premium'});assert.equal(b.key,a.key);assert.equal(b.tokenId,a.tokenId);assert.equal(b.tokenName,'Lumi-Codex');assert.equal(f.created,1);
 assert.ok(f.store.preferences.managedTokens[0].previousNames?.includes('Lumi-Codex-standard'));assert.equal(f.store.preferences.bindings[0].tokenName,'Lumi-Codex');assert.equal(f.store.preferences.bindings[0].group,'premium');
 assert.equal((await f.api.dashboard(7)).toolStats?.find(t=>t.tool==='codex')?.stat?.quota,20);
}finally{await f.close();}});
test('changing a shared dedicated key route invalidates an earlier local config preview',async()=>{const f=await workflow();try{
 await f.api.login({username:'fixture-user',password:'pw'});const configs=new ConfigService(f.store,f.root,path.join(f.root,'home'),req=>f.api.ensureToolToken(req)),preview=await configs.preview({tool:'codex',model:'model-a',group:'standard'});
 await f.api.ensureToolToken({tool:'codex',model:'model-a',group:'premium'});await assert.rejects(configs.apply(preview.id),/渠道已变更/);assert.equal((await configs.inspect())[0].exists,false);
}finally{await f.close();}});
test('menu bar fetches only current account and today summaries and shares site request cache',async()=>{const f=await workflow();try{
 await f.api.login({username:'fixture-user',password:'pw'});await f.api.ensureToolToken({tool:'codex',model:'model-a',group:'standard'});f.seen.length=0;
 const a=await f.api.menuBarUsage();assert.equal(a.user?.id,42);assert.equal(a.today.quota,10);assert.equal(a.tools.find(t=>t.tool==='codex')?.quota,10);assert.equal(a.siteName,'Fixture');
 const before=f.seen.length;await f.api.menuBarUsage();assert.equal(f.seen.length,before);assert.ok(f.seen.every(r=>!['/api/pricing','/api/log/self','/api/perf-metrics/summary'].includes(r.endpoint)));assert.ok(!JSON.stringify(a).includes('private-key'));
 await f.api.logout(f.store.activeSite().id);assert.equal((await f.api.menuBarUsage()).user,null);
}finally{await f.close();}});

test('native menu details use real token IDs, keep cache counts distinct and share bounded history',async()=>{
 const ts=Math.floor(Date.now()/1000)-1,base={created_at:ts,type:2,model_name:'model-a',token_name:'Lumi-Codex',token_id:1,prompt_tokens:1000,completion_tokens:200,quota:100,use_time:2,is_stream:true,group:'standard',other:JSON.stringify({cache_tokens:400,cache_creation_tokens:50})};
 const f=await workflow({logs:[{...base,id:1},{...base,id:2,token_id:2,token_name:'Lumi-Claude',other:'{}'}],points:[{created_at:ts,quota:200,count:2,token_used:2400,model_name:'model-a'}]});try{
  await f.api.login({username:'fixture-user',password:'pw'});await f.api.ensureToolToken({tool:'codex',model:'model-a',group:'standard'});await f.api.ensureToolToken({tool:'claude',model:'model-a',group:'standard'});f.seen.length=0;
  const summary=await f.api.menuBarUsage(false,{days:30,tool:'all'});assert.equal(summary.period?.tokens,2400);assert.ok(!f.seen.some(r=>r.endpoint==='/api/log/self'));
  const details=await f.api.menuBarDetails({days:30,tool:'codex'});assert.equal(details.points.length,1);assert.equal(details.inputTokens,1000);assert.equal(details.outputTokens,200);assert.equal(details.cacheReadTokens,400);assert.equal(details.cacheWriteTokens,50);assert.equal(details.quality.cacheHitRate,.4);assert.equal(details.quality.averageTokenSpeed,100);assert.ok(!JSON.stringify(details).includes('Lumi-Codex'));assert.ok(!JSON.stringify(details).includes('other'));
  const pages=f.seen.filter(r=>r.endpoint==='/api/log/self').length;await f.api.menuBarDetails({days:30,tool:'codex'});assert.equal(f.seen.filter(r=>r.endpoint==='/api/log/self').length,pages);
  const claude=await f.api.menuBarDetails({days:30,tool:'claude'});assert.equal(claude.cacheReadTokens,null);assert.equal(f.seen.filter(r=>r.endpoint==='/api/log/self').length,pages);
 }finally{await f.close();}
});

test('unavailable menu history and incomplete tool attribution never become zero usage',async()=>{
 const f=await workflow({detailFailure:true,pointFailure:true});try{await f.api.login({username:'fixture-user',password:'pw'});const summary=await f.api.menuBarUsage();assert.equal(summary.user?.quota,10000000);assert.equal(summary.period?.quota,10);assert.equal(summary.period?.tokens,null);assert.equal(summary.period?.points,null);await assert.rejects(f.api.menuBarDetails(),/无权/);}finally{await f.close();}
 const ts=Math.floor(Date.now()/1000)-1,unknown=await workflow({logs:[{id:1,created_at:ts,type:2,model_name:'model-a',token_name:'Lumi-Codex',prompt_tokens:2,completion_tokens:1,quota:1,use_time:1,is_stream:false,group:'standard'}]});try{await unknown.api.login({username:'fixture-user',password:'pw'});await unknown.api.ensureToolToken({tool:'codex',model:'model-a',group:'standard'});await assert.rejects(unknown.api.menuBarDetails({days:1,tool:'codex'}),/令牌 ID/);}finally{await unknown.close();}
});
test('catalog accepts modern object groups, effective zero ratios and auto-route membership',() => {const c=normalizeCatalog({data:[model],usable_group:{standard:{desc:'免费组',ratio:0},auto:{desc:'自动路由'}},auto_groups:['standard'],group_ratio:{standard:0}});assert.equal(c.usableGroups.standard,'免费组');assert.equal(groupRatio(c,'standard'),0);assert.equal(groupRatio(c,'auto'),undefined);assert.deepEqual(availableGroups(model,c),['standard','auto']);});
test('new settings migrate obsolete demo and reasoning fields without keeping fabricated state',async() => {await mkdir('.test-data',{recursive:true});const root=await mkdtemp(path.resolve('.test-data/migrate-'));await writeFile(path.join(root,'settings.json'),JSON.stringify({preferences:{demoMode:true,bindings:[{tool:'codex',model:'old',reasoning:'high',tokenName:'Lumi-Codex',siteId:'cyg-default'}]}}));const store=new SettingsStore(root,cipher);await store.load();assert.equal((store.preferences as any).demoMode,undefined);assert.equal((store.preferences.bindings[0] as any).reasoning,undefined);assert.equal(store.preferences.tokenPrefix,'Lumi-');});
test('Codex configuration defers reasoning to the tool/model and removes an inherited forced value',() => {const r=buildCodex('model_reasoning_effort = "high"',null,{tool:'codex',model:'model-a',group:'standard'},'https://fixture.invalid','sk-fixture');assert.equal((parse(r.config) as any).model_reasoning_effort,undefined);});
test('published tier rows retain each actual condition without selecting a simulated request tier',()=>{const m={...model,billing_expr:'v1: len <= 200000 ? tier("standard", p * 3 + c * 15 + cr * 0.3 + cc * 3.75 + cc1h * 6) : tier("long", p * 6 + c * 22.5 + cr * 0.6 + cc * 7.5 + cc1h * 12)'};const rows=publishedPriceSections(m,status);assert.equal(rows.length,2);assert.equal(rows[0].label,'standard');assert.match(rows[0].condition,/上下文长度 ≤ 200000/);assert.equal(rows[1].label,'long');assert.equal(rows[1].rows.find(r=>r.key==='p')?.usd,6);});
test('literal price extraction never substitutes unpublished token or cache categories',()=>{const rows=publishedPriceSections({...model,billing_expr:'p*3+c*15'},status)[0].rows;assert.deepEqual(rows.map(r=>r.key),['p','c']);});
test('fixed published prices and conditional schedules remain static descriptions',()=>{const rows=publishedPriceSections({...model,billing_expr:'tier("request",fixed(0.01))'},status);assert.equal(rows[0].rows[0].usd,.01);assert.equal(rows[0].rows[0].unit,'次');const timed=publishedPriceSections({...model,billing_expr:'hour("Asia/Shanghai") < 12 ? tier("am",p*2) : tier("pm",p*4)'},status);assert.equal(timed.length,2);assert.match(timed[0].condition,/hour/);assert.equal(timed[1].rows[0].usd,4);});
test('task and request-context rules are not evaluated using fabricated usage or request bodies',()=>{for(const billing_expr of ['u("duration")*.1','p*param("price")'])assert.deepEqual(publishedPriceSections({...model,billing_expr,billing_usage_schema:billing_expr.includes('u(') ? {duration:{type:'number'}} : undefined},status),[]);});
test('legacy prices preserve explicit zero cache costs without inventing model-specific cache options',() => {const rows=legacyPrices({...model,model_name:'claude-fixture',cache_ratio:0},status);assert.equal(rows.find(r => r.key === 'cr')?.usd,0);assert.equal(rows.find(r => r.key === 'cc1h'),undefined);assert.equal(rows.find(r => r.key === 'cc')?.usd,3.75);});
test('published pricing parser cannot execute script and omits invalid or nonconstant prices',()=>{for(const billing_expr of ['globalThis.fetch("evil")','constructor("return process")()','v2: p*3','p/0','unsupported(p)','("a").constructor','fixed(-1)'])assert.deepEqual(publishedPriceSections({...model,billing_expr},status),[]);assert.throws(()=>compilePrice('constructor("return process")()'));});

test('automatic token provisioning and local preview/apply/restore form one reversible workflow',async() => {const f=await workflow();try{await f.api.login({username:'fixture-user',password:'pw'});const home=path.join(f.root,'home');const configs=new ConfigService(f.store,f.root,home,req => f.api.ensureToolToken(req));const p=await configs.preview({tool:'codex',model:'model-a',group:'standard'});assert.equal(p.token?.created,true);assert.ok(p.files.every(file => !file.after.includes('private-key')));assert.equal(f.store.preferences.bindings.length,0);await configs.apply(p.id);assert.equal((await configs.inspect())[0].model,'model-a');const binding=f.store.preferences.bindings.find(b => b.tool === 'codex')!;assert.equal(binding.group,'standard');assert.equal(binding.tokenName,p.token!.name);assert.equal(binding.tokenId,p.token!.id);const [backup]=await configs.backups();await configs.restore(backup.id);assert.equal((await configs.inspect())[0].exists,false);}finally{await f.close();}});
test('logout invalidates an outstanding local configuration preview',async() => {const f=await workflow();try{await f.api.login({username:'fixture-user',password:'pw'});const configs=new ConfigService(f.store,f.root,path.join(f.root,'home'),req => f.api.ensureToolToken(req));const p=await configs.preview({tool:'codex',model:'model-a',group:'standard'});await f.api.logout(f.store.activeSite().id);await assert.rejects(configs.apply(p.id),/登录账户/);assert.equal((await configs.inspect())[0].exists,false);}finally{await f.close();}});
test('invalid local syntax does not create an unused server token',async() => {const f=await workflow();try{await f.api.login({username:'fixture-user',password:'pw'});const home=path.join(f.root,'home');await mkdir(path.join(home,'.codex'),{recursive:true});await writeFile(path.join(home,'.codex','config.toml'),'model = [' );const configs=new ConfigService(f.store,f.root,home,req => f.api.ensureToolToken(req));await assert.rejects(configs.preview({tool:'codex',model:'model-a',group:'standard'}),/语法/);assert.equal(f.created,0);}finally{await f.close();}});
test('inactive saved expressions do not override published ratio prices',()=>{const rows=publishedPriceSections({...model,billing_mode:'ratio',billing_expr:'tier("inactive",p*100)'},status);assert.equal(rows[0].rows[0].usd,3);});
test('nonlinear and unknown pricing rules do not turn into invented unit prices',()=>{for(const billing_expr of ['min(p*3,100)','p*p','p*len','tier("base",p*3+c/0)'])assert.deepEqual(publishedPriceSections({...model,billing_expr},status),[]);});
test('browser session acceptance validates user identity and respects a cancelled window before saving',async() => {const f=await workflow();try{await assert.rejects(f.api.acceptBrowserSession(f.store.activeSite().id,f.url,'browser-session',[{name:'new_api_refresh',value:'browser-refresh',path:'/api/user/auth'}],() => false),/取消/);assert.equal(f.store.activeSite().accessTokenConfigured,false);await f.api.acceptBrowserSession(f.store.activeSite().id,f.url,'browser-session',[{name:'new_api_refresh',value:'browser-refresh',path:'/api/user/auth'}]);assert.equal(f.store.activeSite().userId,42);assert.equal(f.store.credentials().accessToken,'browser-session');assert.equal(f.store.credentials().sessionAuth,true);}finally{await f.close();}});

import { BrowserCredentialCapture } from '../electron/services/login-capture';
test('browser login retries the newest bearer arriving during an anonymous validation without parallel saves',async() => {
  let release!: () => void;
  const initial=new Promise<void>(resolve => {release=resolve;});
  const seen:string[]=[];
  const capture=new BrowserCredentialCapture(async token => {
    seen.push(token);
    if (!token) {await initial;throw new Error('Anonymous /self returned 401');}
    assert.equal(token,'current-bearer');
  });
  const pending=capture.capture();
  void capture.capture('old-bearer');
  void capture.capture('current-bearer');
  assert.deepEqual(seen,['']);
  release();await pending;
  assert.deepEqual(seen,['','current-bearer']);
  await capture.capture('duplicate-event');
  assert.deepEqual(seen,['','current-bearer']);
});
test('closing the browser login cancels queued credential retries',async() => {
  let release!: () => void;
  const initial=new Promise<void>(resolve => {release=resolve;});
  const seen:string[]=[];
  const capture=new BrowserCredentialCapture(async token => {seen.push(token);await initial;throw new Error('Anonymous');});
  const pending=capture.capture();void capture.capture('must-not-save');capture.stop();
  release();await pending;await capture.capture('late-event');
  assert.deepEqual(seen,['']);
});
