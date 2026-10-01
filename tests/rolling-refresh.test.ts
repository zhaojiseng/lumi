import test from 'node:test';
import assert from 'node:assert/strict';
import {resolveRange,isRollingRange,rangeLabel} from '../shared/range';
import {usageSeries} from '../shared/utils';
import {groupedTrend} from '../shared/trends';
import {selectionValue,applyPreferencePatch} from '../shared/selections';
import {refreshSeconds,refreshLabel} from '../shared/refresh';
import {DEFAULT_PREFERENCES} from '../shared/types';
import {createServer} from 'node:http';
import {mkdtemp} from 'node:fs/promises';
import path from 'node:path';
import {SettingsStore} from '../electron/services/store';
import {NewApiClient} from '../electron/services/new-api';

test('24h follows the current clock across midnight; 1 day starts at local midnight',()=>{
  const now=new Date(2026,9,2,12,34,56),rolling=resolveRange('24h',now),today=resolveRange(1,now);
  assert.equal(rolling.end_timestamp-rolling.start_timestamp,86400);
  assert.equal(rolling.durationDays,1);
  assert.equal(rolling.range.startDate,'2026-10-01');
  assert.equal(rolling.range.startTime,'12:34');
  assert.equal(today.start_timestamp,new Date(2026,9,2).getTime()/1000);
  assert.equal(today.end_timestamp,now.getTime()/1000);
  assert.equal(rangeLabel(today.range,now),'2026-10-02 00:00 — 2026-10-02 12:34');
  assert.equal(rangeLabel({startDate:'2026-10-01',endDate:'2026-10-01'},now),'2026-10-01 00:00 — 2026-10-01 23:59');
  const later=resolveRange('24h',new Date(now.getTime()+90*60000));
  assert.equal(later.start_timestamp-rolling.start_timestamp,5400);
  assert.equal(isRollingRange({range:'24h',models:['a']}),true);
  const midnight=resolveRange('24h',new Date(2026,9,3,0,0,0));
  assert.equal(midnight.end_timestamp-midnight.start_timestamp,86400);
});

test('saved rolling selection stays relative, has 24 hourly buckets and preserves filtered totals',()=>{
  const prefs=applyPreferencePatch(structuredClone(DEFAULT_PREFERENCES),{selection:{siteId:DEFAULT_PREFERENCES.activeSiteId,values:{'statistics.range':'24h'}}});
  assert.equal(selectionValue(prefs,'statistics.range',7,q=>{try{resolveRange(q);return true;}catch{return false;}}),'24h');
  const now=new Date(2026,9,2,12,34,56),w=resolveRange('24h',now);
  const points=[w.start_timestamp-1,w.start_timestamp,w.start_timestamp+3600,w.end_timestamp,w.end_timestamp+1].map(created_at=>({created_at,model_name:'model-a',quota:100,token_used:5,count:1}));
  const status={system_name:'Fixture',quota_per_unit:100};
  const rows=usageSeries(points,2,status,'24h',now);
  assert.equal(rows.length,24);assert.equal(rows.reduce((s,r)=>s+r.cost,0),3);
  assert.equal(rows[0].label,'10/1 12:34');assert.equal(rows.at(-1)?.requests,1);
  const chart=groupedTrend(points,2,status,'24h',now,'model','cost');
  assert.equal(chart.rows.length,24);assert.equal(chart.lines.length,1);
  assert.equal(chart.rows.reduce((s,r)=>s+r.values[chart.lines[0].id],0),3);
});

test('refresh controls preserve disabled intervals, accept configured intervals and bound invalid values',()=>{
  assert.equal(refreshSeconds(0),0);assert.equal(refreshLabel(0),'自动刷新已关闭');
  assert.equal(refreshSeconds(30),30);assert.equal(refreshSeconds(300),300);
  assert.equal(refreshSeconds(1),15);assert.equal(refreshSeconds(-1),60);
  assert.equal(refreshSeconds(3601),60);assert.equal(refreshSeconds(NaN),60);
  assert.equal(refreshLabel(300),'每 5 分钟自动刷新');
});

test('rolling dashboard and log filters use request timestamps rather than partial hourly aggregates',async()=>{
  const now=Math.floor(Date.now()/1000),seen:URL[]=[];
  const logs=[now-90000,now-82800,now-5].map((created_at,i)=>({id:i+1,created_at,type:2,model_name:i===2 ? 'model-b' : 'model-a',token_name:'Fixture',token_id:i===2 ? 2 : 1,prompt_tokens:100,completion_tokens:20,quota:100,use_time:2,is_stream:true,group:'default',other:'{"cache_tokens":50}'}));
  const server=createServer((req,res)=>{
    const url=new URL(req.url!,'http://fixture.invalid');seen.push(url);let data:unknown={};
    if(url.pathname==='/api/status')data={system_name:'Fixture',quota_per_unit:100};
    if(url.pathname==='/api/user/self')data={id:42,username:'Fixture',quota:1000};
    if(url.pathname==='/api/pricing')data=[];
    if(url.pathname==='/api/token/')data={items:[{id:1,name:'Lumi-Codex'},{id:2,name:'Lumi-Claude'}],total:2};
    if(url.pathname==='/api/data/self')data=[{created_at:now-90000,model_name:'model-a',quota:99999,count:999,token_used:999}];
    if(url.pathname==='/api/log/self/stat')data={quota:99999,rpm:0,tpm:0};
    if(url.pathname==='/api/log/self'){
      const start=Number(url.searchParams.get('start_timestamp')),end=Number(url.searchParams.get('end_timestamp'));
      const items=logs.filter(row=>row.created_at>=start && row.created_at<=end);data={items,total:items.length};
    }
    if(url.pathname==='/api/perf-metrics/summary')data={models:[]};
    res.setHeader('Content-Type','application/json');res.end(JSON.stringify({success:true,data}));
  });
  await new Promise<void>(r=>server.listen(0,'127.0.0.1',r));
  try {
    const root=await mkdtemp(path.resolve('.test-data/rolling-refresh-'));
    const store=new SettingsStore(root,{available:()=>true,encrypt:s=>s,decrypt:s=>s});await store.load();
    await store.saveSite({id:store.activeSite().id,name:'Fixture',url:'http://127.0.0.1:'+(server.address() as {port:number}).port,allowHttp:true,userId:42,accessToken:'fixture-credential'});
    store.preferences.managedTokens=[{id:1,name:'Lumi-Codex',tool:'codex',siteId:store.activeSite().id,group:'default'},{id:2,name:'Lumi-Claude',tool:'claude',siteId:store.activeSite().id,group:'default'}];
    await store.update({menuBarContents:[],refreshInterval:300,menuBarRefreshInterval:120,menuBarTotalsRange:7,menuBarChartRange:'24h'});
    const restored=new SettingsStore(root,store.cipher);await restored.load();
    assert.deepEqual(restored.preferences.menuBarContents,[]);assert.equal(restored.preferences.refreshInterval,300);assert.equal(restored.preferences.menuBarRefreshInterval,120);
    assert.equal(restored.preferences.menuBarTotalsRange,7);assert.equal(restored.preferences.menuBarChartRange,'24h');
    const api=new NewApiClient(store),[dashboard,other]=await Promise.all([api.dashboard('24h'),api.dashboard('24h')]);
    assert.equal(dashboard.detailed,true);assert.equal(dashboard.stat?.quota,200);
    assert.deepEqual(dashboard.interval,{quota:200,tokens:240,requests:2});
    assert.equal(dashboard.logs.total,2);assert.deepEqual(dashboard.logs.items.map(r=>r.id),[2,3]);
    assert.equal(other.series.reduce((n,p)=>n+p.token_used,0),240);
    const requests=seen.filter(url=>url.pathname==='/api/log/self');assert.equal(requests.length,1);
    assert.equal(Number(requests[0].searchParams.get('end_timestamp'))-Number(requests[0].searchParams.get('start_timestamp')),86400);
    const detail=await api.logs({range:'24h',days:2,page:1,pageSize:15,models:['model-a']});
    assert.equal(detail.total,1);assert.equal(seen.filter(url=>url.pathname==='/api/log/self').length,1);
    assert.equal(usageSeries(dashboard.series,2,dashboard.status,'24h',new Date(dashboard.fetchedAt)).length,24);
    const filtered=await api.dashboard({range:'24h',models:['absent-model'],tokenIds:[1]});
    assert.deepEqual(filtered.interval,{quota:0,tokens:0,requests:0});assert.equal(filtered.logs.total,0);assert.equal(filtered.series.length,0);
    const matched=await api.dashboard({range:'24h',models:['model-b'],tokenIds:[2]});
    assert.deepEqual(matched.interval,{quota:100,tokens:120,requests:1});assert.deepEqual(matched.logs.items.map(r=>r.id),[3]);
    assert.equal(matched.toolStats?.find(t=>t.tool==='claude')?.stat?.quota,100);assert.equal(matched.toolStats?.find(t=>t.tool==='codex')?.stat?.quota,0);
    const intersection=await api.dashboard({range:'24h',models:['model-b'],tokenIds:[1]});assert.equal(intersection.interval?.quota,0);
    assert.ok(!seen.filter(url=>url.pathname==='/api/data/self' || url.pathname==='/api/log/self/stat').length,'Detailed filtered dashboard does not fetch unrelated today summaries');
  } finally {await new Promise<void>(r=>server.close(()=>r()));}
});
