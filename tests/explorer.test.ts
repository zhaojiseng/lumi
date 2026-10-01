import test from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {mkdir,mkdtemp} from 'node:fs/promises';
import path from 'node:path';
import {resolveRange} from '../shared/range';
import {dailySeries} from '../shared/utils';
import {normalizeHealth,normalizeHealthDetails} from '../shared/health';
import {normalizeCatalog} from '../shared/catalog';
import {SettingsStore} from '../electron/services/store';
import {NewApiClient} from '../electron/services/new-api';
const now=new Date(2026,8,30,12,30);
test('custom date windows include both local calendar days and stop at now for today',() => {
 const r=resolveRange({startDate:'2026-09-01',endDate:'2026-09-03'},now);assert.equal(r.days,3);
 assert.equal(r.start_timestamp,new Date(2026,8,1).getTime()/1000);assert.equal(r.end_timestamp,new Date(2026,8,4).getTime()/1000-1);
 assert.equal(resolveRange(1,now).end_timestamp,now.getTime()/1000);assert.deepEqual(resolveRange(7,now).range,{startDate:'2026-09-24',endDate:'2026-09-30'});
});
test('custom ranges reject invalid dates, reversed windows, future dates and over 90 days',() => {
 for(const range of [{startDate:'2026-02-30',endDate:'2026-03-01'},{startDate:'2026-09-04',endDate:'2026-09-03'},{startDate:'2026-09-30',endDate:'2026-10-01'},{startDate:'2026-01-01',endDate:'2026-09-30'}])assert.throws(() => resolveRange(range,now));
 for(const n of [0,91,1.5,NaN])assert.throws(() => resolveRange(n,now));
});
test('custom historical charts fill missing dates and do not include out-of-range usage',() => {
 const rows=dailySeries([{created_at:new Date(2026,8,2,12).getTime()/1000,model_name:'x',quota:500000,token_used:12,count:1},{created_at:new Date(2026,8,10).getTime()/1000,model_name:'x',quota:900000,token_used:99,count:3}],3,{system_name:'Test',quota_per_unit:500000},{startDate:'2026-09-01',endDate:'2026-09-03'});
 assert.deepEqual(rows.map(r => [r.date,r.cost,r.tokens,r.requests]),[['2026-09-01',0,0,0],['2026-09-02',1,12,1],['2026-09-03',0,0,0]]);
});
test('catalog preserves model IDs and raw protocol metadata, including missing metadata',() => {
 const c=normalizeCatalog({data:[{model_name:'claude',supported_endpoint_types:['anthropic']},{model_name:'gemini',supported_endpoint_types:['gemini']},{model_name:'missing'}]});
 assert.deepEqual(c.models.map(m=>m.model_name),['claude','gemini','missing']);assert.deepEqual(c.models[2].supported_endpoint_types,[]);
});
test('health normalization preserves real zero rates and excludes missing or invalid rates',() => {
 const h=normalizeHealth({models:[{model_name:'zero',success_rate:0,avg_latency_ms:1800,avg_tps:15,recent_success_series:[{ts:1,success_rate:0},{ts:2,success_rate:null}]},{model_name:'bad',success_rate:null},{model_name:'over',success_rate:110}]});
 assert.equal(h.models.length,1);assert.equal(h.models[0].success_rate,0);assert.equal(h.models[0].recent_success_series?.length,1);
 const groups=normalizeHealthDetails({groups:[{group:'free',success_rate:100,avg_ttft_ms:0},{group:'bad',success_rate:NaN}]}).groups;assert.equal(groups.length,1);assert.equal(groups[0].avg_ttft_ms,0);
 assert.throws(() => normalizeHealth({}));assert.throws(() => normalizeHealthDetails({}));
});
test('dashboard uses one custom window for charts, stats and logs, but keeps today separate and authenticates health',async() => {
 const seen:{path:string;query:URLSearchParams;auth:string}[]=[];let healthStatus=200;
 const server=createServer((req,res) => {const u=new URL(req.url!,'http://localhost');seen.push({path:u.pathname,query:u.searchParams,auth:req.headers.authorization || ''});res.setHeader('Content-Type','application/json');let data:any={};
 if(u.pathname === '/api/status')data={system_name:'Fixture',quota_per_unit:500000};
 if(u.pathname === '/api/user/self')data={id:42,username:'test',quota:1000};
 if(u.pathname === '/api/log/self')data={items:[],total:0};
 if(u.pathname === '/api/data/self'){
  const start=Number(u.searchParams.get('start_timestamp')),end=Number(u.searchParams.get('end_timestamp'));
  if(end-start+1>28*86400){res.statusCode=400;res.end(JSON.stringify({success:false,message:'时间跨度不能超过 1 个月'}));return;}
  data=[{created_at:start,model_name:'fixture',quota:1,token_used:2,count:1}];
 }
 if(u.pathname === '/api/log/self/stat')data={quota:u.searchParams.get('start_timestamp') === String(new Date(2026,8,1).getTime()/1000) ? 100 : 20,rpm:0,tpm:0};
 if(u.pathname === '/api/token/')data={items:[],total:0};
 if(u.pathname === '/api/pricing')data=[];
 if(u.pathname === '/api/perf-metrics/summary'){if(healthStatus !== 200){res.statusCode=healthStatus;res.end(JSON.stringify({success:false,message:'not enabled'}));return;}data={models:[{model_name:'claude',success_rate:98.5,avg_latency_ms:1250,avg_tps:30}],window_start:1,window_end:2};}
 if(u.pathname === '/api/perf-metrics')data={model_name:'claude',groups:[{group:'default',success_rate:95,avg_latency_ms:1500,avg_ttft_ms:300,avg_tps:25}]};
 res.end(JSON.stringify({success:true,data}));});
 await new Promise<void>(r => server.listen(0,'127.0.0.1',r));const port=(server.address() as {port:number}).port;
 try {await mkdir('.test-data',{recursive:true});const root=await mkdtemp(path.resolve('.test-data/explorer-'));const store=new SettingsStore(root,{available:() => true,encrypt:s => Buffer.from(s).toString('base64'),decrypt:s => Buffer.from(s,'base64').toString()});await store.load();await store.saveSite({id:store.activeSite().id,name:'Fixture',url:'http://127.0.0.1:'+port,allowHttp:true,accessToken:'fixture-account',userId:42});const api=new NewApiClient(store);
 const d=await api.dashboard({startDate:'2026-09-01',endDate:'2026-09-03'});const range=resolveRange({startDate:'2026-09-01',endDate:'2026-09-03'});assert.equal(d.days,3);assert.equal(d.stat?.quota,100);assert.equal(d.today?.quota,20);assert.equal(d.health?.models[0].success_rate,98.5);
 for(const endpoint of ['/api/data/self','/api/log/self','/api/log/self/stat']){const r=seen.find(x => x.path === endpoint && x.query.get('start_timestamp') === String(range.start_timestamp));assert.ok(r,endpoint);assert.equal(r.query.get('end_timestamp'),String(range.end_timestamp));}
 const beforeLong=seen.length,earliestEnd=resolveRange(90).end_timestamp;const long=await api.dashboard(90);
 const dataWindows=seen.slice(beforeLong).filter(x=>x.path==='/api/data/self' && x.query.get('start_timestamp')!==String(resolveRange(1).start_timestamp));
 assert.ok(dataWindows.length>=3);assert.ok(dataWindows.every(x=>Number(x.query.get('end_timestamp'))-Number(x.query.get('start_timestamp'))+1<=28*86400));
 const ordered=dataWindows.map(x=>[Number(x.query.get('start_timestamp')),Number(x.query.get('end_timestamp'))]).sort((a,b)=>a[0]-b[0]);
 assert.equal(ordered[0][0],resolveRange(long.range!).start_timestamp);
 assert.ok(ordered.at(-1)![1]>=earliestEnd && ordered.at(-1)![1]<=Math.floor(long.fetchedAt/1000));
 for(let i=1;i<ordered.length;i++)assert.equal(ordered[i][0],ordered[i-1][1]+1);
 assert.equal(long.series.length,dataWindows.length);
 assert.ok(!long.warnings.some(w=>w.startsWith('用量曲线')));
 const h=seen.find(x => x.path === '/api/perf-metrics/summary')!;assert.equal(h.query.get('hours'),'24');assert.equal(h.auth,'Bearer fixture-account');const detail=await api.modelHealth('claude');assert.equal(detail.groups[0].avg_ttft_ms,300);
 healthStatus=404;const cached=await api.dashboard(7);assert.equal(cached.health?.models[0].success_rate,98.5);const unavailable=await api.dashboard(7,true);assert.equal(unavailable.health,null);assert.match(unavailable.healthError!,/健康度/);assert.equal(unavailable.user?.id,42);assert.equal(unavailable.warnings.length,0);
 } finally {await new Promise<void>(r => server.close(() => r()));}
});
