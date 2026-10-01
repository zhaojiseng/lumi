import test from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {mkdir,mkdtemp,writeFile} from 'node:fs/promises';
import path from 'node:path';
import {publishedPricingStates} from '../shared/pricing';
import {visibleLogColumns,migrateLogColumns} from '../shared/logs';
import {DEFAULT_LOG_COLUMNS,type ModelInfo,type ModelCatalog} from '../shared/types';
import {tokenSettings} from '../electron/services/token-controls';
import {SettingsStore} from '../electron/services/store';
import {NewApiClient} from '../electron/services/new-api';
import {ConfigService} from '../electron/services/config';
const status={system_name:'Fixture',quota_per_unit:500000};
const model:ModelInfo={model_name:'test-model',quota_type:0,model_ratio:1.5,model_price:0,completion_ratio:5,enable_groups:['standard','premium'],supported_endpoint_types:[]};
const catalog:ModelCatalog={models:[model],groupRatio:{standard:1,premium:.5},usableGroups:{standard:'Standard',premium:'Premium',auto:'Auto'},autoGroups:['standard'],vendors:[]};
test('published pricing picker preserves real 272K conditions, all categories and separate plugins without cost simulation',()=>{
  const expr='len <= 272000 ? tier("base", p*3+c*15+cr*.3+cc*3.75+img*4+ai*5) : tier("long", p*6+c*30+cr*.6+cc*7.5+img*8+ai*10)';
  const states=publishedPricingStates({...model,billing_expr:expr},status);
  assert.deepEqual(states.map(s=>s.label),['上下文 ≤ 272K','上下文 > 272K']);
  assert.equal(states[0].section?.rows.length,6);assert.equal(states[1].section?.rows[0].usd,6);
  const plugins=publishedPricingStates({...model,billing_plugin_variants:[{plugin_key:'alternate',plugin_name:'插件 A',billing_expr:expr}]} as ModelInfo,status);
  assert.ok(plugins.every(s=>s.label.startsWith('插件 A')));
  assert.equal(new Set(plugins.map(s=>s.key)).size,plugins.length);
  assert.equal(publishedPricingStates({...model,billing_expr:'p*len'},status)[0].section,undefined);
});
test('log columns merge input/cache read, default cache write stays hidden and explicit custom columns survive migration',async()=>{
  assert.ok(!DEFAULT_LOG_COLUMNS.includes('cacheWrite'));assert.ok(!visibleLogColumns(DEFAULT_LOG_COLUMNS).includes('cacheRead'));
  assert.deepEqual(visibleLogColumns(['cacheRead','output']),['cacheRead','output']);
  assert.deepEqual(migrateLogColumns(['input','cacheWrite']),['input','cacheWrite']);
  const old=['time','model','token','input','output','cacheRead','cacheWrite','cost','duration','speed','channel','status'];
  await mkdir('.test-data',{recursive:true});const root=await mkdtemp(path.resolve('.test-data/columns-migration-'));
  await writeFile(path.join(root,'settings.json'),JSON.stringify({preferences:{logColumns:old}}));
  const store=new SettingsStore(root,{available:()=>true,encrypt:s=>s,decrypt:s=>s});await store.load();assert.deepEqual(store.preferences.logColumns,DEFAULT_LOG_COLUMNS);
});
test('token settings validate IP/CIDR, future expiration, accessible models and quota; retry only applies to auto',()=>{
  const input={name:' Test ',group:'standard',unlimited:false,quota:123.6,models:'test-model,test-model',allowIps:'192.0.2.0/24\n2001:db8::1',crossGroupRetry:true};
  const body=tokenSettings(input,catalog);assert.equal(body.name,'Test');assert.equal(body.remain_quota,124);assert.equal(body.model_limits,'test-model');assert.equal(body.cross_group_retry,false);
  assert.equal(tokenSettings({...input,group:'auto'},catalog).cross_group_retry,true);
  for(const allowIps of ['host.example','192.0.2.1/33','2001:db8::/129','127.0.0.1/-1'])assert.throws(()=>tokenSettings({...input,allowIps},catalog),/IP/);
  assert.throws(()=>tokenSettings({...input,expiredTime:1},catalog),/有效期/);
  assert.throws(()=>tokenSettings({...input,models:'unknown'},catalog),/限制模型/);
  assert.throws(()=>tokenSettings({...input,quota:NaN},catalog),/额度/);
});
test('token control updates only editable fields, protects managed names, syncs route and leaves historical usage/status intact',async()=>{
  await mkdir('.test-data',{recursive:true});const root=await mkdtemp(path.resolve('.test-data/token-control-'));
  const store=new SettingsStore(root,{available:()=>true,encrypt:s=>Buffer.from(s).toString('base64'),decrypt:s=>Buffer.from(s,'base64').toString()});await store.load();
  let token={id:7,name:'Lumi-Codex-standard',status:2,remain_quota:500000,used_quota:250000,unlimited_quota:false,expired_time:-1,created_time:1,group:'standard',key:'not-for-renderer'};
  const writes:any[]=[];
  const server=createServer(async(req,res)=>{
    let raw='';for await(const c of req)raw+=c;res.setHeader('Content-Type','application/json');
    const send=(data:any,extra:any={})=>res.end(JSON.stringify({success:true,data,...extra}));
    if(req.url?.startsWith('/api/pricing'))return send([model],{usable_group:catalog.usableGroups,group_ratio:catalog.groupRatio});
    if(req.url?.startsWith('/api/token/') && req.method==='GET')return send({items:[token],total:1});
    if(req.url==='/api/token/' && req.method==='PUT'){const body=JSON.parse(raw);writes.push(body);token={...token,...body};return send({});}
    res.statusCode=404;res.end(JSON.stringify({success:false}));
  });
  await new Promise<void>(r=>server.listen(0,'127.0.0.1',r));const url='http://127.0.0.1:'+(server.address() as any).port;
  try{
    await store.saveSite({id:store.activeSite().id,name:'Fixture',url,allowHttp:true,accessToken:'isolated-account'});
    const siteId=store.activeSite().id;await store.registerToken({siteId,tool:'codex',id:7,name:token.name,group:'standard'},url);await store.saveBinding({siteId,tool:'codex',tokenId:7,tokenName:token.name,group:'standard',model:model.model_name});
    const api=new NewApiClient(store),input={id:7,name:token.name,group:'premium',quota:1250000,unlimited:false,models:model.model_name,allowIps:'192.0.2.0/24',expiredTime:Math.floor(Date.now()/1000)+86400};
    await assert.rejects(api.updateToken({...input,name:'Renamed'}),/名称/);assert.equal(writes.length,0);
    await api.updateToken(input);assert.equal(writes.length,1);assert.equal(writes[0].status,undefined);assert.equal(writes[0].used_quota,undefined);assert.equal(writes[0].key,undefined);
    assert.equal(token.used_quota,250000);assert.equal(token.status,2);assert.equal(store.preferences.bindings.find(b=>b.tokenId===7)?.group,'premium');
    assert.equal((await api.tokens())[0].allow_ips,'192.0.2.0/24');assert.ok(!('key' in (await api.tokens())[0]));
  }finally{await new Promise<void>(r=>server.close(()=>r()));}
});
test('token control invalidation prevents applying a previously prepared tool configuration',async()=>{
  await mkdir('.test-data',{recursive:true});const root=await mkdtemp(path.resolve('.test-data/token-preview-'));
  const store=new SettingsStore(path.join(root,'app'),{available:()=>true,encrypt:s=>s,decrypt:s=>s});await store.load();await store.saveSite({id:store.activeSite().id,name:'Fixture',url:'https://fixture.invalid',allowHttp:false});
  const service=new ConfigService(store,path.join(root,'app'),path.join(root,'home'),async()=>({key:'sk-isolated',tokenName:'Lumi-Codex-standard',tokenId:7,group:'standard',created:false,siteId:store.activeSite().id,siteUrl:store.activeSite().url}));
  const preview=await service.preview({tool:'codex',model:model.model_name,group:'standard'});service.invalidateTokenPreviews(7);await assert.rejects(service.apply(preview.id),/过期/);
});
