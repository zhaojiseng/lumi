import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdir,mkdtemp,readFile} from 'node:fs/promises';
import path from 'node:path';
import {logMetrics,normalizeLogColumns,upstreamChannel} from '../shared/logs';
import {legacyPrices,publishedPriceSections,routePriceSummary} from '../shared/pricing';
import {DEFAULT_LOG_COLUMNS,type UsageLog,type ModelInfo} from '../shared/types';
import {logsToCsv} from '../shared/utils';
import {SettingsStore} from '../electron/services/store';
const status={system_name:'Fixture',quota_per_unit:500000,quota_display_type:'USD'};
const model:ModelInfo={model_name:'gpt-fixture',quota_type:0,model_ratio:1.5,model_price:0,completion_ratio:5,cache_ratio:.1,create_cache_ratio:1.25,enable_groups:['default'],supported_endpoint_types:[]};
const log:UsageLog={id:1,created_at:1,type:2,model_name:'gpt-fixture',token_name:'Lumi-Codex',prompt_tokens:1500,completion_tokens:1200,quota:500000,use_time:4,is_stream:true,group:'standard'};
test('request cache fields preserve zero, merge real breakdowns once, and do not duplicate the aggregate',() => {
 assert.deepEqual(logMetrics({...log,other:JSON.stringify({cache_tokens:0,cache_creation_tokens:200,cache_creation_tokens_5m:100,cache_creation_tokens_1h:150,frt:750})}),{cacheRead:0,cacheWrite:250,speed:300,netSpeed:1200/3.25,firstTokenMs:750});
 assert.equal(logMetrics({...log,other:JSON.stringify({cache_creation_tokens:200})}).cacheWrite,200);
 assert.equal(logMetrics({...log,other:JSON.stringify({billing_tokens:{cr:30,cc:40,cc1h:50}})}).cacheWrite,90);
 assert.equal(logMetrics({...log,other:JSON.stringify({cache_creation_tokens_5m:0,cache_creation_tokens_1h:0})}).cacheWrite,0);
});
test('missing or malformed log metadata and invalid durations never turn into fabricated cache or speeds',() => {
 for(const other of [undefined,'not-json','null','[]','{"cache_tokens":-1,"cache_creation_tokens":"100","frt":"2"}']) {
  const m=logMetrics({...log,other,use_time:0});assert.equal(m.cacheRead,null);assert.equal(m.cacheWrite,null);assert.equal(m.firstTokenMs,null);assert.equal(m.speed,null);
 }
 for(const use_time of [-1,0,NaN,Infinity])assert.equal(logMetrics({...log,use_time}).speed,null);
 assert.equal(logMetrics({...log,type:1}).speed,null);assert.equal(logMetrics({...log,completion_tokens:0}).speed,null);
});
test('channel display only uses supplied top-level upstream identity and does not mistake a route group for upstream',() => {
 assert.equal(upstreamChannel(log),null);assert.equal(upstreamChannel({...log,channel:7,channel_name:'Upstream'}),'Upstream #7');assert.equal(upstreamChannel({...log,channel:0}),null);
 assert.equal(upstreamChannel({...log,other:'{"channel_name":"hidden"}'}),null);
});
test('custom request columns save and reload with valid order, migrate old settings, and remove invalid ids',async() => {
 assert.deepEqual(normalizeLogColumns(['speed','bad','cacheRead','speed']),['speed','cacheRead']);assert.deepEqual(normalizeLogColumns([]),DEFAULT_LOG_COLUMNS);
 await mkdir('.test-data',{recursive:true});const root=await mkdtemp(path.resolve('.test-data/log-columns-'));const cipher={available:()=>true,encrypt:(s:string)=>s,decrypt:(s:string)=>s};
 const store=new SettingsStore(root,cipher);await store.load();assert.deepEqual(store.preferences.logColumns,DEFAULT_LOG_COLUMNS);await store.update({logColumns:['channel','input','cacheRead','speed']});
 const reloaded=new SettingsStore(root,cipher);await reloaded.load();assert.deepEqual(reloaded.preferences.logColumns,['channel','input','cacheRead','speed']);
 const persisted=JSON.parse(await readFile(path.join(root,'settings.json'),'utf8'));assert.deepEqual(persisted.preferences.logColumns,['channel','input','cacheRead','speed']);
});
test('ratio pricing never infers cache TTLs from a model name and excludes unpublished categories',() => {
 for(const model_name of ['gpt-fixture','claude-fixture','arbitrary']) {
  const m={...model,model_name};const rows=legacyPrices(m,status);assert.deepEqual(rows.map(r=>r.key),['p','c','cr','cc']);assert.equal(rows.find(r=>r.key==='cc')?.label,'缓存写入');assert.ok(!rows.some(r=>/1h|5m/.test(r.label)));
 }
 const m={...model,cache_ratio:0,create_cache_ratio:undefined};assert.deepEqual(legacyPrices(m,status).map(f=>f.key),['p','c','cr']);assert.equal(legacyPrices(m,status).find(r=>r.key==='cr')?.usd,0);
});
test('published expression rows use only literal categories, with split labels only when explicitly declared',() => {
 const generic={...model,billing_expr:'tier("base", p*3+c*15+cr*.3+cc*3.75)'};
 const rows=publishedPriceSections(generic,status)[0].rows;assert.deepEqual(rows.map(f=>f.key),['p','c','cr','cc']);assert.equal(rows.at(-1)?.label,'缓存写入');assert.equal(rows.at(-1)?.usd,3.75);
 const split={...generic,billing_expr:'p*3+c*15+cc*3.75+cc1h*6'};assert.deepEqual(publishedPriceSections(split,status)[0].rows.filter(f=>f.key.startsWith('cc')).map(f=>f.label),['缓存写入 · 5m','缓存写入 · 1h']);
 assert.deepEqual(publishedPriceSections({...generic,billing_expr:'p*3+c*15'},status)[0].rows.map(r=>r.key),['p','c']);
});
test('channel summaries show published unit prices and conditions, never sample request or task cost',() => {
 assert.match(routePriceSummary(model,status,.5),/输入 \$1\.5\/1M Tokens.*输出 \$7\.5\/1M Tokens/);assert.match(routePriceSummary(model,status,0),/输入 \$0/);assert.equal(routePriceSummary(model,status,undefined),'价格未固定');
 const timed={...model,billing_expr:'hour("Asia/Shanghai")<12 ? p*2+c*10 : p*4+c*20'};assert.equal(routePriceSummary(timed,status,1),'条件定价 · 2 个档位');
 assert.equal(routePriceSummary({...model,quota_type:1,model_price:.05},status,1),'每次调用 $0.05/次');
 const task={...model,billing_expr:'u("seconds")*.1',billing_usage_schema:{seconds:{type:'number' as const,unit:'second'}},billing_usage_examples:[{label:'5s',facts:{seconds:5}}]};assert.equal(routePriceSummary(task,status,2),'任务用量定价');assert.deepEqual(publishedPriceSections(task,status),[]);
});
test('CSV keeps cache, speed and upstream fields regardless of table column preferences',() => {
 const csv=logsToCsv([{...log,channel:7,channel_name:'=unsafe',other:'{"cache_tokens":0,"cache_creation_tokens":200,"frt":750}'}],status);
 assert.match(csv,/缓存读取 Tokens/);assert.match(csv,/Token 速度 \(t\/s\)/);assert.match(csv,/"0","200","300","750"/);assert.match(csv,/'=unsafe #7/);
});

test('CSV includes reported reasoning effort and leaves unavailable effort blank',()=>{
 const csv=logsToCsv([{...log,other:'{"reasoning_effort":"high"}'},{...log,id:2,other:undefined}],status);
 assert.match(csv,/思考强度/);
 const rows=csv.split('\r\n');
 assert.ok(rows[1].endsWith(',"high","",""'));
 assert.ok(rows[2].endsWith(',"","",""'));
});
