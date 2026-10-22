import test from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {mkdir,mkdtemp,rm} from 'node:fs/promises';
import path from 'node:path';
import {NewApiClient} from '../electron/services/new-api';
import {SettingsStore} from '../electron/services/store';
import {resolveRange} from '../shared/range';

function deferred(){let resolve!:()=>void;const promise=new Promise<void>(done=>resolve=done);return {promise,resolve};}
async function fixture(t:test.TestContext){
  await mkdir('.test-data',{recursive:true});const root=await mkdtemp(path.resolve('.test-data/newapi-cache-'));
  const seen:{path:string;method:string;query:URLSearchParams}[]=[],holds=new Map<string,ReturnType<typeof deferred>&{entered:ReturnType<typeof deferred>}>();
  const state={tokenStatus:1,records:2,keyReads:0,failWrite:false};
  const server=createServer(async(req,res)=>{
    const url=new URL(req.url!,'http://fixture.invalid'),method=req.method || 'GET';seen.push({path:url.pathname,method,query:url.searchParams});
    let data:unknown={},status=200;
    if(url.pathname==='/api/status')data={system_name:'Fixture',quota_per_unit:100};
    if(url.pathname==='/api/user/self')data={id:42,username:'fixture-user',quota:1234};
    if(url.pathname==='/api/pricing')data=[];
    if(url.pathname.startsWith('/api/perf-metrics'))data={models:[]};
    if(url.pathname==='/api/token/'){
      if(method!=='GET'){if(state.failWrite)status=403;else state.tokenStatus=2;}
      data={items:[{id:1,name:'Token A',status:state.tokenStatus}],total:1};
    }
    if(url.pathname==='/api/token/1/key')data='fixture-key-'+(++state.keyReads);
    const start=Number(url.searchParams.get('start_timestamp')),end=Number(url.searchParams.get('end_timestamp'));
    const rows=Array.from({length:state.records},(_,i)=>({id:i+1,created_at:Math.min(start+10,end),type:2,token_id:1,token_name:'Token A',model_name:'fixture',quota:10,prompt_tokens:20,completion_tokens:5,use_time:1,is_stream:true}));
    if(url.pathname==='/api/log/self'){
      const page=Number(url.searchParams.get('p')),size=Number(url.searchParams.get('page_size'));
      data={items:rows.slice((page-1)*size,page*size),total:rows.length};
    }
    if(url.pathname==='/api/data/self')data=[{created_at:Math.min(start+10,end),model_name:'fixture',quota:10*rows.length,token_used:25*rows.length,count:rows.length}];
    if(url.pathname==='/api/log/self/stat')data={quota:rows.length*10,rpm:0,tpm:0};
    const hold=holds.get(method+' '+url.pathname);if(hold){holds.delete(method+' '+url.pathname);hold.entered.resolve();await hold.promise;}
    if(res.destroyed)return;
    res.writeHead(status,{'Content-Type':'application/json'});res.end(JSON.stringify({success:status===200,data}));
  });
  await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));
  const store=new SettingsStore(root,{available:()=>true,encrypt:s=>Buffer.from(s).toString('base64'),decrypt:s=>Buffer.from(s,'base64').toString()});await store.load();
  await store.saveSite({id:store.activeSite().id,name:'Fixture',url:'http://127.0.0.1:'+(server.address() as {port:number}).port,allowHttp:true,userId:42,accessToken:'fixture-account'});
  const api=new NewApiClient(store),allHolds:ReturnType<typeof deferred>[]=[];
  t.after(async()=>{for(const hold of allHolds)hold.resolve();api.close();server.closeAllConnections();await new Promise<void>(resolve=>server.close(()=>resolve()));await rm(root,{recursive:true,force:true,maxRetries:5,retryDelay:100});});
  const hold=(method:string,endpoint:string)=>{const gate={...deferred(),entered:deferred()};holds.set(method+' '+endpoint,gate);allHolds.push(gate);return gate;};
  return {api,state,seen,hold,store,count:(endpoint:string)=>seen.filter(read=>read.path===endpoint && read.method==='GET').length};
}

test('revealing token keys stays uncached and preserves account, metadata and complete usage caches',async t=>{
  t.mock.timers.enable({apis:['Date'],now:new Date(2026,9,23,12).getTime()});
  const f=await fixture(t);await f.api.dashboard(1);const curve=await f.api.tokenUsage(1);await f.api.usageQuality(1);await f.api.menuBarDetails();
  const before=f.seen.length;
  assert.equal(await f.api.getTokenKey(1),'sk-fixture-key-1');assert.equal(await f.api.getTokenKey(1),'sk-fixture-key-2');
  await f.api.dashboard(1);assert.deepEqual(await f.api.tokenUsage(1),curve);await f.api.usageQuality(1);await f.api.menuBarDetails();
  assert.deepEqual(f.seen.slice(before).map(read=>read.method+' '+read.path),['POST /api/token/1/key','POST /api/token/1/key']);
  await f.api.dashboard(1,true);const gate=f.hold('GET','/api/log/self');
  // A pending complete history fill must also survive a read-only key reveal.
  const pending=f.api.tokenUsage(1);await gate.entered.promise;
  assert.equal(await f.api.getTokenKey(1),'sk-fixture-key-3');gate.resolve();assert.equal((await pending).logCount,2);
});

test('token writes refresh affected reads and derived usage while retaining unrelated site metadata',async t=>{
  t.mock.timers.enable({apis:['Date'],now:new Date(2026,9,23,12).getTime()});
  const f=await fixture(t);await f.api.dashboard(1);assert.equal((await f.api.usageQuality(1)).requestCount,2);await f.api.menuBarDetails();
  f.state.records=3;const before=f.seen.length;await f.api.toggleToken(1,false);const updated=await f.api.dashboard(1);
  assert.equal(updated.tokens[0].status,2);assert.equal(updated.stat?.quota,30);assert.equal((await f.api.usageQuality(1)).requestCount,3);assert.equal((await f.api.menuBarDetails()).quality.requestCount,3);
  for(const endpoint of ['/api/status','/api/pricing','/api/perf-metrics/summary'])assert.equal(f.count(endpoint),1,endpoint+' should survive token writes');
  for(const endpoint of ['/api/token/','/api/user/self','/api/data/self','/api/log/self/stat'])assert.equal(f.count(endpoint),2,endpoint+' must refresh');
  t.diagnostic(JSON.stringify({fixture:'token update followed by dashboard',requests:f.seen.slice(before).filter(read=>read.path!=='/api/log/self' || read.query.get('type')==='0').length,retainedMetadataReads:3}));
});

test('token writes revoke pending account cache fills while retaining a pending metadata request',async t=>{
  const f=await fixture(t),tokensGate=f.hold('GET','/api/token/'),pricingGate=f.hold('GET','/api/pricing');
  const oldTokens=f.api.tokens(),catalog=f.api.catalog();await Promise.all([tokensGate.entered.promise,pricingGate.entered.promise]);
  await f.api.toggleToken(1,false);const parallelCatalog=f.api.catalog();tokensGate.resolve();pricingGate.resolve();
  assert.equal((await oldTokens)[0].status,1);assert.deepEqual(await catalog,await parallelCatalog);
  assert.equal((await f.api.tokens())[0].status,2);assert.equal(f.count('/api/token/'),2);assert.equal(f.count('/api/pricing'),1);
});

test('a rejected token write invalidates affected reads without discarding unrelated metadata',async t=>{
  const f=await fixture(t);await f.api.dashboard(1);f.state.failWrite=true;
  await assert.rejects(f.api.toggleToken(1,false),/无权/);await f.api.dashboard(1);
  assert.equal(f.count('/api/token/'),2);assert.equal(f.count('/api/user/self'),2);assert.equal(f.count('/api/pricing'),1);assert.equal(f.count('/api/status'),1);
});

test('completed-date aggregates expire after thirty minutes and explicit refresh bypasses their cache',async t=>{
  t.mock.timers.enable({apis:['Date'],now:new Date(2026,9,23,12).getTime()});
  const f=await fixture(t),range={startDate:'2026-10-01',endDate:'2026-10-21'};
  await f.api.dashboard(range);t.mock.timers.tick(61000);await f.api.dashboard(range);
  assert.equal(f.count('/api/data/self'),1);assert.equal(f.count('/api/log/self/stat'),2,'stat can contain live RPM/TPM');assert.equal(f.count('/api/user/self'),2,'balance keeps the live TTL');
  t.mock.timers.tick(30*60000-61000);await f.api.dashboard(range);assert.equal(f.count('/api/data/self'),2);assert.equal(f.count('/api/log/self/stat'),3);
  await f.api.dashboard(range,true);assert.equal(f.count('/api/data/self'),3);assert.equal(f.count('/api/log/self/stat'),4);
});

test('long ranges revalidate only the live aggregate chunk while sharing closed chunks with the menu',async t=>{
  t.mock.timers.enable({apis:['Date'],now:new Date(2026,9,23,12).getTime()});
  const f=await fixture(t);await f.api.dashboard(90);
  const initial=f.count('/api/data/self');assert.equal(initial,4);t.mock.timers.tick(61000);
  await f.api.dashboard(90);const repeated=f.count('/api/data/self')-initial;assert.equal(repeated,1);
  await f.api.dashboard(30);const beforeMenu=f.count('/api/data/self');
  await f.api.menuBarUsage(false,{days:30,tool:'all'});assert.equal(f.count('/api/data/self'),beforeMenu,'main window and menu share aggregate chunks for a supported menu range');
  const end=resolveRange(90).end_timestamp,reads=f.seen.filter(read=>read.path==='/api/data/self');assert.equal(Number(reads.at(-1)!.query.get('end_timestamp')),end);
  t.diagnostic(JSON.stringify({fixture:'90-day summary automatic refresh after 61 seconds',beforeRequests:initial,afterRequests:repeated}));
});
