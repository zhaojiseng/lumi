import test from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {mkdtemp} from 'node:fs/promises';
import path from 'node:path';
import {SettingsStore} from '../electron/services/store';
import {NewApiClient} from '../electron/services/new-api';
import {resolveRange} from '../shared/range';

async function fixture(){
  const seen:{path:string;query:URLSearchParams;auth:string|undefined;}[]=[];let status=1,total=150,legacy=false;
  let statusWait=Promise.resolve(),releaseStatus:(()=>void)|undefined;
  const timestamp=resolveRange(1).start_timestamp+10;
  const server=createServer(async(req,res)=>{
    const url=new URL(req.url!,'http://fixture.invalid');seen.push({path:url.pathname,query:url.searchParams,auth:req.headers.authorization});
    let data:unknown={};
    if(url.pathname==='/api/log/self'){
      const page=Number(url.searchParams.get('p')),size=Number(url.searchParams.get('page_size'));
      const items=Array.from({length:Math.min(size,Math.max(0,total-(page-1)*size))},(_,i)=>({id:(page-1)*size+i+1,created_at:timestamp,type:2,model_name:i%2 ? 'model-a' : 'model-b',token_name:i%2 ? 'Token A' : 'Token B',token_id:i%2 ? 1 : 2,prompt_tokens:10,completion_tokens:5,use_time:2,quota:100,content:'Content must not reach the curve',other:JSON.stringify({cache_tokens:5,metadata:'Private metadata must not reach the curve'})}));
      data=legacy ? items : {items,total};
    }
    if(url.pathname==='/api/token/'){
      if(req.method==='PUT')status=2;
      data={items:[{id:1,name:'Token A',status}],total:1};
    }
    if(url.pathname==='/api/pricing')data=[];
    if(url.pathname==='/api/status'){await statusWait;data={system_name:'Fixture',quota_per_unit:100};}
    if(url.pathname==='/api/user/self'){releaseStatus?.();data={id:42,username:'Fixture',quota:100};}
    if(url.pathname==='/api/data/self')data=[];
    if(url.pathname==='/api/log/self/stat')data={quota:0,rpm:0,tpm:0};
    if(url.pathname==='/api/perf-metrics/summary')data={models:[]};
    res.setHeader('Content-Type','application/json');res.end(JSON.stringify({success:true,data}));
  });
  await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));
  const port=(server.address() as {port:number}).port,root=await mkdtemp(path.resolve('.test-data/token-trend-cache-'));
  const store=new SettingsStore(root,{available:()=>true,encrypt:s=>s,decrypt:s=>s});await store.load();
  const site={id:store.activeSite().id,name:'Fixture',url:'http://127.0.0.1:'+port,allowHttp:true,userId:42,accessToken:'fixture-account'};
  await store.saveSite(site);const api=new NewApiClient(store);
  return {api,seen,store,site,setTotal:(n:number)=>{total=n;},setLegacy:()=>{legacy=true;},holdStatus:()=>{statusWait=new Promise<void>(resolve=>{releaseStatus=resolve;});},close:()=>new Promise<void>(resolve=>{releaseStatus?.();server.close(()=>resolve());})};
}
test('token curves read every page at a fixed range, share concurrent reads and return only usage metadata',async()=>{
  const f=await fixture();try{
    const [a,b]=await Promise.all([f.api.tokenUsage(1),f.api.tokenUsage(1)]);
    assert.equal(a.logCount,150);assert.equal(b.logCount,150);assert.equal(a.points.reduce((n,p)=>n+p.count,0),150);assert.equal(a.points.reduce((n,p)=>n+p.token_used,0),2250);
    const reads=f.seen.filter(r=>r.path==='/api/log/self');assert.equal(reads.length,2);assert.deepEqual(reads.map(r=>r.query.get('p')),['1','2']);assert.ok(reads.every(r=>r.query.get('type')==='2'));assert.equal(reads[0].query.get('end_timestamp'),reads[1].query.get('end_timestamp'));
    assert.ok(!JSON.stringify(a).includes('Content must not'));assert.ok(!JSON.stringify(a).includes('Private metadata'));
    await f.api.tokenUsage(1);assert.equal(f.seen.filter(r=>r.path==='/api/log/self').length,2);
  }finally{await f.close();}
});
test('token curves support legacy pagination and reject oversized ranges without presenting a partial total',async()=>{
  const legacy=await fixture();try{legacy.setLegacy();assert.equal((await legacy.api.tokenUsage(1)).logCount,150);}finally{await legacy.close();}
  const large=await fixture();try{large.setTotal(10001);await assert.rejects(large.api.tokenUsage(1),/缩小日期/);assert.equal(large.seen.filter(r=>r.path==='/api/log/self').length,1);}finally{await large.close();}
});
test('account reads are cached, token changes and manual refresh invalidate them, and logged-out data cannot return',async()=>{
  const f=await fixture();try{
    await Promise.all([f.api.tokens(),f.api.tokens()]);assert.equal(f.seen.filter(r=>r.path==='/api/token/').length,1);
    await f.api.toggleToken(1,false);assert.equal((await f.api.tokens())[0].status,2);assert.equal(f.seen.filter(r=>r.path==='/api/token/').length,3);
    await f.api.dashboard(1);const before=f.seen.length;await f.api.dashboard(1);assert.equal(f.seen.length,before);await f.api.dashboard(1,true);assert.ok(f.seen.length>before);
    await f.api.logout(f.site.id);await assert.rejects(f.api.tokens(),/登录/);
    await f.store.saveSite({...f.site,accessToken:'fixture-account-2',userId:43});const again=f.seen.length;await f.api.tokens();assert.equal(f.seen.length,again+1);assert.equal(f.seen.at(-1)?.auth,'Bearer fixture-account-2');
  }finally{await f.close();}
});

test('token curve caches isolate cookie sessions and a changed site address',async()=>{
  const f=await fixture(),other=await fixture();try{
    await f.store.saveSession(f.site.id,f.site.url,{userId:42,accessToken:undefined,cookies:[{name:'session',value:'fixture-cookie-a',path:'/'}]});
    assert.equal((await f.api.tokenUsage(1)).logCount,150);
    f.setTotal(25);
    await f.store.saveSession(f.site.id,f.site.url,{userId:42,accessToken:undefined,cookies:[{name:'session',value:'fixture-cookie-b',path:'/'}]});
    assert.equal((await f.api.tokenUsage(1)).logCount,25);
    other.setTotal(3);
    await f.store.saveSite({...f.site,url:other.site.url});
    assert.equal((await f.api.tokenUsage(1)).logCount,3);
    assert.equal(other.seen.filter(r=>r.path==='/api/log/self').length,1);
  }finally{await f.close();await other.close();}
});

test('efficiency metrics share complete logs with token curves and refresh on manual invalidation',async()=>{
  const f=await fixture();try{
    const [quality,curve]=await Promise.all([f.api.usageQuality(1),f.api.tokenUsage(1)]);
    assert.equal(quality.cacheHitRate,.5);assert.equal(quality.averageTokenSpeed,2.5);assert.equal(quality.requestCount,150);assert.deepEqual(quality,curve.quality);
    assert.equal(f.seen.filter(r=>r.path==='/api/log/self').length,2);
    f.setTotal(10);assert.equal((await f.api.usageQuality(1)).requestCount,150);
    await f.api.dashboard(1,true);assert.equal((await f.api.usageQuality(1)).requestCount,10);
    await f.api.logout(f.site.id);await assert.rejects(f.api.usageQuality(1),/登录/);
  }finally{await f.close();}
});

test('startup account reads begin while public status is still pending',async()=>{
  const f=await fixture();try{
    f.holdStatus();const dashboard=await f.api.dashboard(1);
    assert.equal(dashboard.user?.id,42);assert.equal(dashboard.status.system_name,'Fixture');
    assert.equal(f.seen.filter(r=>r.path==='/api/user/self').length,1);
  }finally{await f.close();}
});
test('multi-filter dashboard and paginated logs share complete cached records across different model/token combinations',async()=>{
  const f=await fixture();try{
    const q={range:1,models:['model-a'],tokenIds:[1]},a=await f.api.dashboard(q);
    assert.equal(a.detailed,true);assert.equal(a.logs.total,75);assert.equal(a.series.reduce((s,p)=>s+p.count,0),75);assert.equal(a.stat?.quota,7500);assert.equal(a.quality?.cacheHitRate,.5);
    const reads=f.seen.filter(r=>r.path==='/api/log/self');assert.equal(reads.length,2);assert.ok(reads.every(r=>r.query.get('type')==='0'));
    const second=await f.api.dashboard({range:1,models:['model-a','model-b'],tokenIds:[2]});assert.equal(second.logs.total,75);assert.ok(second.series.every(p=>p.token_id===2));
    const logs=await f.api.logs({days:1,page:2,pageSize:15,models:['model-a'],tokenIds:[1]});assert.equal(logs.total,75);assert.equal(logs.items.length,15);
    assert.equal(f.seen.filter(r=>r.path==='/api/log/self').length,2);
    assert.equal(f.seen.filter(r=>r.path==='/api/data/self').length,1,'only today summary should use hourly endpoint');
  }finally{await f.close();}
});
test('minute dashboard uses exact log times and oversized detailed filters fail instead of displaying partial zero totals',async()=>{
  const f=await fixture();try{
    const range={...resolveRange(1).range,startTime:'00:00',endTime:'00:01'},d=await f.api.dashboard(range);assert.equal(d.series.reduce((s,p)=>s+p.count,0),150);assert.equal(d.logs.total,150);assert.equal(d.quality?.requestCount,150);
    const read=f.seen.find(r=>r.path==='/api/log/self')!;assert.equal(Number(read.query.get('end_timestamp'))-Number(read.query.get('start_timestamp')),119);
    f.setTotal(10001);await assert.rejects(f.api.dashboard({range:1,models:['model-a']},true),/缩小日期/);
  }finally{await f.close();}
});
