import test,{type TestContext} from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {mkdir,mkdtemp,rm} from 'node:fs/promises';
import path from 'node:path';
import {SettingsStore} from '../electron/services/store';
import {NewApiClient} from '../electron/services/new-api';

function deferred(){let resolve!:()=>void;const promise=new Promise<void>(yes=>resolve=yes);return {promise,resolve};}
async function fixture(t:TestContext,loggedIn=true){
  const base=path.resolve('.test-data');await mkdir(base,{recursive:true});const root=await mkdtemp(path.join(base,'plugin-catalog-'));
  t.after(async()=>{const relative=path.relative(base,root);assert.ok(relative && !relative.startsWith('..') && !path.isAbsolute(relative));await rm(root,{recursive:true,force:true});});
  const state={pricingStatus:200,healthStatus:200,userStatus:200,holdPath:'',entered:deferred(),release:deferred()};
  const requests:{path:string;authorization?:string;cookie?:string}[]=[];
  const server=createServer(async(req,res)=>{
    const pathname=new URL(req.url!,'http://localhost').pathname;
    requests.push({path:pathname,authorization:req.headers.authorization,cookie:req.headers.cookie});
    if(pathname===state.holdPath){state.entered.resolve();await state.release.promise;}
    if(res.destroyed)return;
    const status=pathname==='/api/pricing' ? state.pricingStatus : pathname==='/api/perf-metrics/summary' ? state.healthStatus : pathname==='/api/user/self' ? state.userStatus : 200;
    res.writeHead(status,{'content-type':'application/json'});
    if(status!==200){res.end(JSON.stringify({success:false,message:'fixture endpoint unavailable'}));return;}
    const pricing={success:true,data:[{model_name:'fixture-model',model_ratio:2,completion_ratio:3,vendor_id:1,enable_groups:['default'],supported_endpoint_types:['responses']}],group_ratio:{default:0.8},usable_group:{default:'Fixture channel'},vendors:[{id:1,name:'Fixture vendor'}]};
    res.end(JSON.stringify(pathname==='/api/pricing' ? pricing : {success:true,data:pathname==='/api/status' ? {system_name:'Fixture',quota_per_unit:500000,custom_currency_symbol:'¥'} : pathname==='/api/perf-metrics/summary' ? {models:[{model_name:'fixture-model',success_rate:99}],window_start:1,window_end:2} : {id:1,username:'fixture-user',quota:42}}));
  });
  await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));
  t.after(async()=>{state.release.resolve();server.closeAllConnections();await new Promise<void>(resolve=>server.close(()=>resolve()));});
  const siteUrl='http://127.0.0.1:'+(server.address() as {port:number}).port;
  const store=new SettingsStore(root,{available:()=>true,encrypt:value=>Buffer.from(value).toString('base64'),decrypt:value=>Buffer.from(value,'base64').toString()});await store.load();
  await store.saveSite({id:store.activeSite().id,name:'Fixture',url:siteUrl,allowHttp:true});
  const siteId=store.activeSite().id;
  if(loggedIn)await store.saveSession(siteId,siteUrl,{accessToken:'fixture-token-a',userId:1,username:'fixture-user'});
  const api=new NewApiClient(store),input={siteId,siteUrl};
  return {state,requests,api,store,input};
}

test('catalog provider normalizes independent data, shares caches and never loads usage or token inventory',async t=>{
  const {api,input,requests}=await fixture(t);
  const [first,second]=await Promise.all([api.readCatalog(input),api.readCatalog(input)]);
  assert.equal(first.loggedIn,true);assert.equal(first.catalog.models[0].vendor,'Fixture vendor');assert.equal(first.catalog.groupRatio.default,0.8);
  assert.equal(first.health?.models[0].success_rate,99);assert.equal(first.status.custom_currency_symbol,'¥');assert.deepEqual(first.warnings,[]);
  assert.equal('tokens' in first,false);assert.equal('user' in first,false);assert.deepEqual(second.catalog,first.catalog);
  assert.deepEqual(requests.map(req=>req.path).sort(),['/api/perf-metrics/summary','/api/pricing','/api/status','/api/user/self']);
  const publicRead=requests.find(req=>req.path==='/api/status')!;assert.equal(publicRead.authorization,undefined);assert.equal(publicRead.cookie,undefined);
  for(const req of requests.filter(req=>req.path!=='/api/status'))assert.equal(req.authorization,'Bearer fixture-token-a');
  await api.readCatalog(input);assert.equal(requests.length,4);
  await api.readCatalog({...input,force:true});assert.equal(requests.length,8);
});

test('optional catalog/health errors are explicit while authentication errors reject instead of returning stale data',async t=>{
  const {api,input,state}=await fixture(t);state.pricingStatus=503;state.healthStatus=404;
  const value=await api.readCatalog(input);assert.deepEqual(value.catalog.models,[]);assert.match(value.warnings[0],/^模型广场/);assert.equal(value.health,null);assert.match(value.healthError!,/^健康度暂不可用/);
  state.pricingStatus=200;state.healthStatus=200;state.userStatus=403;
  await assert.rejects(api.readCatalog({...input,force:true}),/无权访问/);
});

for(const change of ['site','account','logout'] as const){
  test('catalog in-flight result is rejected after '+change+' changes',async t=>{
    const {api,input,state,store}=await fixture(t);state.holdPath='/api/pricing';
    const result=api.readCatalog(input),rejected=assert.rejects(result,/切换|变更/);
    await state.entered.promise;
    try{
      if(change==='site')await store.saveSite({name:'Another fixture',url:input.siteUrl+'/other',allowHttp:true});
      else if(change==='account')await store.saveSession(input.siteId,input.siteUrl,{accessToken:'fixture-token-b',userId:2,username:'other-user'});
      else await store.clearSession(input.siteId,input.siteUrl);
    }finally{state.release.resolve();}
    await rejected;
  });
}

test('anonymous catalog read does not fetch authenticated endpoints and rejects a late public response after login',async t=>{
  const {api,input,state,store,requests}=await fixture(t,false);state.holdPath='/api/status';
  const read=api.readCatalog(input),rejected=assert.rejects(read,/登录状态已变更/);await state.entered.promise;
  try{await store.saveSession(input.siteId,input.siteUrl,{accessToken:'fixture-token-a',userId:1});}finally{state.release.resolve();}
  await rejected;assert.deepEqual(requests.map(req=>req.path),['/api/status']);assert.equal(requests[0].authorization,undefined);
});
