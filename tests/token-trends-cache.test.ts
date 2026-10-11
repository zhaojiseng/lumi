import test from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {mkdtemp} from 'node:fs/promises';
import path from 'node:path';
import {SettingsStore} from '../electron/services/store';
import {NewApiClient} from '../electron/services/new-api';
import {resolveRange} from '../shared/range';
import type {UsageLog} from '../shared/types';

async function fixture(){
  const seen:{path:string;query:URLSearchParams;auth:string|undefined;}[]=[];let status=1,total=150,legacy=false,displayIds=false,rows:UsageLog[]|undefined,broken='';
  let statusWait=Promise.resolve(),releaseStatus:(()=>void)|undefined,logWait=Promise.resolve(),releaseLogs:(()=>void)|undefined;
  const timestamp=resolveRange(1).start_timestamp+10;
  const server=createServer(async(req,res)=>{
    const url=new URL(req.url!,'http://fixture.invalid');seen.push({path:url.pathname,query:url.searchParams,auth:req.headers.authorization});
    let data:unknown={};
    if(url.pathname==='/api/log/self'){
      const page=Number(url.searchParams.get('p')),size=Number(url.searchParams.get('page_size'));
      let items=Array.from({length:Math.min(size,Math.max(0,total-(page-1)*size))},(_,i)=>({id:(page-1)*size+i+1,created_at:timestamp,type:2,model_name:i%2 ? 'model-a' : 'model-b',token_name:i%2 ? 'Token A' : 'Token B',token_id:i%2 ? 1 : 2,prompt_tokens:10,completion_tokens:5,use_time:2,is_stream:true,quota:100,content:'Content must not reach the curve',other:JSON.stringify({cache_tokens:5,frt:1000,metadata:'Private metadata must not reach the curve'})}));
      const start=Number(url.searchParams.get('start_timestamp')),end=Number(url.searchParams.get('end_timestamp')),type=Number(url.searchParams.get('type'));
      let matchingTotal=total;
      if(rows){const matching=rows.filter(row=>row.created_at>=start && row.created_at<=end && (!type || row.type===type)).sort((a,b)=>b.created_at-a.created_at || b.id-a.id);matchingTotal=matching.length;items=matching.slice((page-1)*size,page*size) as typeof items;}
      else if(timestamp<start || timestamp>end){items=[];matchingTotal=0;}
      // New API exposes query-local display ordinals rather than database IDs.
      if(displayIds)items=items.map((row,index)=>({...row,id:(page-1)*size+index+1}));
      if(broken==='duplicate' && page===2)items[0]={...items[0],id:1};
      if(broken==='empty' && page===2)items=[];
      if(broken==='total' && page===2)matchingTotal++;
      data=legacy ? items : {items,total:broken==='invalid' ? -1 : matchingTotal};await logWait;
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
  return {api,seen,store,site,setTotal:(n:number)=>{total=n;},setLegacy:()=>{legacy=true;},setDisplayIds:()=>{displayIds=true;},setRows:(value:UsageLog[])=>{rows=value;},breakPages:(value:string)=>{broken=value;},holdLogs:()=>{logWait=new Promise<void>(resolve=>{releaseLogs=resolve;});},releaseLogs:()=>releaseLogs?.(),holdStatus:()=>{statusWait=new Promise<void>(resolve=>{releaseStatus=resolve;});},close:()=>new Promise<void>(resolve=>{releaseStatus?.();releaseLogs?.();server.close(()=>resolve());})};
}
test('token curves read every page at a fixed range, share concurrent reads and return only usage metadata',async(t)=>{
  const f=await fixture();try{
    t.mock.timers.enable({apis:['Date'],now:Math.floor(Date.now()/60000)*60000+10000});
    const [a,b]=await Promise.all([f.api.tokenUsage(1),f.api.tokenUsage(1)]);
    assert.equal(a.logCount,150);assert.equal(b.logCount,150);assert.equal(a.points.reduce((n,p)=>n+p.count,0),150);assert.equal(a.points.reduce((n,p)=>n+p.token_used,0),2250);
    const reads=f.seen.filter(r=>r.path==='/api/log/self');assert.equal(reads.length,2);assert.deepEqual(reads.map(r=>r.query.get('p')),['1','2']);assert.ok(reads.every(r=>r.query.get('type')==='2'));assert.equal(reads[0].query.get('end_timestamp'),reads[1].query.get('end_timestamp'));
    assert.ok(!JSON.stringify(a).includes('Content must not'));assert.ok(!JSON.stringify(a).includes('Private metadata'));
    t.mock.timers.tick(1000);
    await f.api.tokenUsage(1);assert.equal(f.seen.filter(r=>r.path==='/api/log/self').length,2);
  }finally{await f.close();}
});
test('token curves support legacy pagination and exceed the former record/page ceiling without dropping totals',async()=>{
  const legacy=await fixture();try{legacy.setLegacy();assert.equal((await legacy.api.tokenUsage(1)).logCount,150);}finally{await legacy.close();}
  const large=await fixture();try{large.setTotal(25001);const curve=await large.api.tokenUsage(1);assert.equal(curve.logCount,25001);assert.equal(curve.points.reduce((sum,point)=>sum+point.count,0),25001);assert.equal(curve.quality.requestCount,25001);assert.equal(large.seen.filter(r=>r.path==='/api/log/self').length,251);}finally{await large.close();}
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
    assert.equal(quality.averageNetTokenSpeed,5);assert.equal(quality.netSpeedSamples,150);
    assert.equal(curve.points.reduce((n,p)=>n+(p.netOutputTokens || 0),0),750);
    assert.equal(curve.points.reduce((n,p)=>n+(p.subsequentDurationSeconds || 0),0),150);
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
    assert.equal(a.quality?.averageNetTokenSpeed,5);assert.equal(a.quality?.netSpeedSamples,75);
    const reads=f.seen.filter(r=>r.path==='/api/log/self');assert.equal(reads.length,2);assert.ok(reads.every(r=>r.query.get('type')==='0'));
    const second=await f.api.dashboard({range:1,models:['model-a','model-b'],tokenIds:[2]});assert.equal(second.logs.total,75);assert.ok(second.series.every(p=>p.token_id===2));
    const logs=await f.api.logs({days:1,page:2,pageSize:15,models:['model-a'],tokenIds:[1]});assert.equal(logs.total,75);assert.equal(logs.items.length,15);
    assert.equal(f.seen.filter(r=>r.path==='/api/log/self').length,2);
    assert.equal(f.seen.filter(r=>r.path==='/api/data/self').length,0,'filtered summaries use their complete logs without an unrelated today query');
  }finally{await f.close();}
});
test('minute dashboard uses exact log times and large detailed filters keep complete statistics',async()=>{
  const f=await fixture();try{
    const range={...resolveRange(1).range,startTime:'00:00',endTime:'00:01'},d=await f.api.dashboard(range);assert.equal(d.series.reduce((s,p)=>s+p.count,0),150);assert.equal(d.logs.total,150);assert.equal(d.quality?.requestCount,150);
    const read=f.seen.find(r=>r.path==='/api/log/self')!;assert.equal(Number(read.query.get('end_timestamp'))-Number(read.query.get('start_timestamp')),119);
    f.setTotal(10001);const large=await f.api.dashboard({range:1,models:['model-a']},true);assert.equal(large.logs.total,5000);assert.equal(large.series.reduce((sum,point)=>sum+point.count,0),5000);assert.equal(large.stat?.quota,500000);
  }finally{await f.close();}
});

test('pagination inconsistencies reject the entire curve and recovery rereads pages without stale page caches',async()=>{
  for(const problem of ['duplicate','empty','total','invalid']){
    const f=await fixture();try{f.breakPages(problem);await assert.rejects(f.api.tokenUsage(1),/分页|记录已变化/);const reads=f.seen.filter(row=>row.path==='/api/log/self').length;
      f.breakPages('');assert.equal((await f.api.tokenUsage(1)).logCount,150);assert.equal(f.seen.filter(row=>row.path==='/api/log/self').length,reads+2);
    }finally{await f.close();}
  }
});
test('automatic trend refresh reads a small recent overlap while historical/nested ranges reuse cached records',async(t)=>{
  t.mock.timers.enable({apis:['Date'],now:new Date(2026,9,11,12,0,0).getTime()});
  const f=await fixture(),end=Math.floor(Date.now()/1000),make=(id:number,time:number):UsageLog=>({id,created_at:time,type:2,model_name:'fixture',token_name:'fixture',token_id:1,prompt_tokens:10,completion_tokens:5,use_time:1,is_stream:true,quota:1,group:'fixture'});
  const history=Array.from({length:20000},(_,i)=>make(i+1,end-86400-i)),recent=[make(20001,end-200),make(20002,end-10)];
  try{f.setRows([...history,...recent]);assert.equal((await f.api.tokenUsage(7)).logCount,20002);const initial=f.seen.filter(row=>row.path==='/api/log/self').length;
    t.mock.timers.tick(60000);f.setRows([...history,...recent,make(20003,end-240),make(20004,end+50)]);
    const updated=await f.api.tokenUsage(7);assert.equal(updated.logCount,20004);assert.equal(updated.points.reduce((sum,point)=>sum+point.count,0),20004);
    const reads=f.seen.filter(row=>row.path==='/api/log/self');assert.equal(reads.length,initial+1);assert.equal(Number(reads.at(-1)!.query.get('start_timestamp')),end-300);
    assert.equal((await f.api.tokenUsage(1)).logCount,4);assert.equal(f.seen.filter(row=>row.path==='/api/log/self').length,initial+1);
    await f.api.tokenUsage(30);const expanded=f.seen.filter(row=>row.path==='/api/log/self');assert.equal(expanded.length,initial+2);assert.equal(Number(expanded.at(-1)!.query.get('end_timestamp')),resolveRange(7).start_timestamp-1);
  }finally{await f.close();}
});
test('New API display IDs can restart during recent refresh and range expansion without losing usage',async(t)=>{
  t.mock.timers.enable({apis:['Date'],now:new Date(2026,9,11,12,0,0).getTime()});
  const f=await fixture(),end=Math.floor(Date.now()/1000),make=(id:number,time:number):UsageLog=>({id,created_at:time,type:2,model_name:'fixture',token_name:'fixture',token_id:1,prompt_tokens:10,completion_tokens:5,use_time:1,is_stream:true,quota:2,group:'fixture'});
  const history=Array.from({length:150},(_,i)=>make(i+1,end-86400-i)),recent=[make(151,end-200),make(152,end-10)],older=[make(153,end-10*86400)];
  try{
    f.setDisplayIds();f.setRows([...history,...recent,...older]);
    assert.equal((await f.api.tokenUsage(7)).logCount,152);
    t.mock.timers.tick(60000);f.setRows([...history,...recent,...older,make(154,end+50)]);
    const refreshed=await f.api.tokenUsage(7);
    assert.equal(refreshed.logCount,153);assert.equal(refreshed.quality.requestCount,153);
    assert.equal(refreshed.points.reduce((sum,p)=>sum+p.token_used,0),153*15);
    assert.equal(f.seen.filter(r=>r.path==='/api/log/self').length,3,'refresh reads only the recent gap');
    const expanded=await f.api.tokenUsage(30);
    assert.equal(expanded.logCount,154);assert.equal(expanded.points.reduce((sum,p)=>sum+p.quota,0),308);
    assert.equal(f.seen.filter(r=>r.path==='/api/log/self').length,4,'expansion reads only older history');
    const filtered=await f.api.dashboard({range:1,models:['fixture']});
    assert.equal(filtered.logs.total,3);
    assert.equal((await f.api.tokenUsage(30)).logCount,154,'type-0 and type-2 snapshots can share display ordinals');
  }finally{await f.close();}
});

test('filtered log pages retain same-second requests and repeated display IDs across cached ranges',async(t)=>{
  t.mock.timers.enable({apis:['Date'],now:new Date(2026,9,11,12,0,0).getTime()});
  const f=await fixture(),end=Math.floor(Date.now()/1000);
  const rows=Array.from({length:3},(_,i):UsageLog=>({id:i+100,created_at:end-86400,type:2,model_name:'fixture',token_name:'fixture',token_id:1,prompt_tokens:10,completion_tokens:5,use_time:1,is_stream:true,quota:2,group:'fixture'}));
  rows.push({...rows[0],id:200,created_at:end-10});
  try{
    f.setDisplayIds();f.setRows(rows);
    await f.api.dashboard({range:1,models:['fixture']});
    const expanded=await f.api.dashboard({range:7,models:['fixture']});
    assert.equal(expanded.logs.total,4);assert.equal(expanded.stat?.quota,8);
    const page=await f.api.logs({days:7,page:1,pageSize:15,models:['fixture']});
    assert.equal(page.items.length,4);assert.equal(new Set(page.items.map(row=>row.id)).size,3);
    assert.equal(new Set(page.items.map(row=>`${row.created_at}:${row.id}`)).size,4);
    assert.equal((await f.api.tokenUsage(7)).logCount,4);
  }finally{await f.close();}
});

test('filtered dashboard snapshots serve unfiltered consumption curves and isolate caller mutations',async()=>{
  const f=await fixture();try{const dashboard=await f.api.dashboard({range:1,models:['model-a']});const reads=f.seen.filter(row=>row.path==='/api/log/self').length;
    dashboard.logs.items[0].quota=99999;
    const logs=await f.api.logs({days:1,page:1,pageSize:15,models:['model-a']});assert.equal(logs.items[0].quota,100);logs.items[0].quota=99999;
    const curve=await f.api.tokenUsage(1);assert.equal(curve.logCount,150);assert.equal(curve.points.reduce((sum,point)=>sum+point.quota,0),15000);assert.equal(f.seen.filter(row=>row.path==='/api/log/self').length,reads);
    curve.points[0].quota=99999;assert.equal((await f.api.tokenUsage(1)).points.reduce((sum,point)=>sum+point.quota,0),15000);
  }finally{await f.close();}
});
test('logout during complete pagination rejects late account results and a new login cannot inherit them',async()=>{
  const f=await fixture();try{f.holdLogs();const pending=f.api.tokenUsage(1);const rejected=assert.rejects(pending,/登录|失效/);
    while(!f.seen.some(row=>row.path==='/api/log/self'))await new Promise(resolve=>setTimeout(resolve,1));
    await f.api.logout(f.site.id);f.releaseLogs();await rejected;
    f.setTotal(3);await f.store.saveSite({...f.site,accessToken:'fixture-next-account',userId:43});assert.equal((await f.api.tokenUsage(1)).logCount,3);
  }finally{await f.close();}
});

test('changing a cookie identity during pagination rejects the old result even when the user id stays the same',async()=>{
  const f=await fixture();try{
    await f.store.saveSession(f.site.id,f.site.url,{userId:42,cookies:[{name:'session',value:'fixture-cookie-a',path:'/'}]});
    f.holdLogs();const pending=f.api.tokenUsage(1),rejected=assert.rejects(pending,/登录状态/);
    while(!f.seen.some(row=>row.path==='/api/log/self'))await new Promise(resolve=>setTimeout(resolve,1));
    await f.store.saveSession(f.site.id,f.site.url,{userId:42,cookies:[{name:'session',value:'fixture-cookie-b',path:'/'}]});
    f.releaseLogs();await rejected;f.setTotal(3);assert.equal((await f.api.tokenUsage(1)).logCount,3);
  }finally{await f.close();}
});
