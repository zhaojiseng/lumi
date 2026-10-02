import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdir,mkdtemp,writeFile,rm} from 'node:fs/promises';
import path from 'node:path';
import {localUsageSeries} from '../shared/local-trends';
import {LocalUsageService} from '../electron/services/local-usage';
import {resolveRange} from '../shared/range';
import {usageSeries} from '../shared/utils';
import type {DashboardQuery,LocalUsagePoint} from '../shared/types';

const now=new Date(2026,9,2,12,34,56);
const point=(created_at:number,tool:LocalUsagePoint['tool']='codex'):LocalUsagePoint=>({
  created_at,tool,model:tool==='codex' ? 'gpt-5' : 'claude-sonnet',
  inputTokens:11,outputTokens:7,cacheReadTokens:5,cacheWriteTokens:3,requests:2,
});
const totals=(rows:ReturnType<typeof localUsageSeries>)=>rows.reduce((sum,row)=>[sum[0]+row.tokens,sum[1]+row.requests],[0,0]);

test('local sparse points partition inclusive minute ranges at exact second edges and conserve every token counter',()=>{
  const query={range:{startDate:'2026-10-01',endDate:'2026-10-01',startTime:'09:05',endTime:'09:06'}},window=resolveRange(query,now);
  const edge=window.start_timestamp+4;
  const points=[point(window.start_timestamp),point(edge-1),point(edge,'claude'),point(window.end_timestamp,'claude'),point(window.start_timestamp-1),point(window.end_timestamp+1),point(NaN),point(Infinity)];
  const rows=localUsageSeries(points,query,now);
  assert.equal(rows.length,30);assert.equal(rows[0].tokens,52);assert.equal(rows[1].tokens,26);assert.equal(rows.at(-1)?.tokens,26);
  assert.equal(rows[1].timestamp,edge);assert.equal(rows[0].end_timestamp,edge-1);assert.deepEqual(totals(rows),[104,8]);
  assert.equal(rows[0].label,'10/1 09:05:00');assert.equal(rows.at(-1)?.end_timestamp,window.end_timestamp);
  assert.equal(rows.filter(row=>row.requests===0).length,27);
  const codex=localUsageSeries(points,query,now,'codex'),claude=localUsageSeries(points,query,now,'claude');
  assert.deepEqual(totals(codex),[52,4]);assert.deepEqual(totals(claude),[52,4]);
  for(let i=0;i<rows.length;i++)assert.equal(rows[i].tokens,codex[i].tokens+claude[i].tokens);
  // Points already aggregated by the scan keep their seconds; repeated models/tools
  // in a bucket must not be snapped to midnight or duplicated on an edge.
  const aggregate=[point(edge),{...point(edge,'claude'),inputTokens:22,requests:4}];
  assert.equal(localUsageSeries(aggregate,query,now)[1].tokens,63);
});

test('local ranges reuse site thirty-bucket edges across day/month boundaries and rolling seconds',()=>{
  const queries:DashboardQuery[]=[1,2,7,30,90,'24h',{range:{startDate:'2026-08-31',endDate:'2026-10-02'}},{range:{startDate:'2026-10-01',endDate:'2026-10-02',startTime:'23:59',endTime:'00:01'}}];
  for(const query of queries){
    const window=resolveRange(query,now),duration=window.end_timestamp-window.start_timestamp+1;
    const starts=Array.from({length:30},(_,i)=>window.start_timestamp+Math.floor(i*duration/30));
    const points=[point(window.start_timestamp),point(starts[13]-1),point(starts[13],'claude'),point(window.end_timestamp,'claude'),point(window.start_timestamp-1),point(window.end_timestamp+1)];
    const rows=localUsageSeries(points,query,now);
    assert.equal(rows.length,30);assert.deepEqual(rows.map(row=>row.timestamp),starts);
    assert.deepEqual(totals(rows),[104,8]);assert.equal(rows[12].tokens,26);assert.equal(rows[13].tokens,26);
    assert.ok(rows.every((row,i)=>row.timestamp<=row.end_timestamp && (i===0 || row.timestamp===rows[i-1].end_timestamp+1)));
    assert.equal(rows.at(-1)?.end_timestamp,window.end_timestamp);
    const site=usageSeries([],window.days,{system_name:'Fixture',quota_per_unit:1},typeof query==='object' && 'range' in query ? query.range : query,now);
    assert.deepEqual(rows.map(row=>[row.timestamp,row.end_timestamp,row.label,row.tooltipLabel]),site.map(row=>[row.timestamp,row.end_timestamp,row.label,row.tooltipLabel]));
  }
});

test('short live windows use at most one bucket per second and retain backend scan-time boundaries on cache reads',()=>{
  const start=new Date(2026,9,2,12,34).getTime()/1000,query={range:{startDate:'2026-10-02',endDate:'2026-10-02',startTime:'12:34'}};
  for(const duration of [1,2,7,29,30,31,61]){
    const scanClock=new Date((start+duration-1)*1000),points=Array.from({length:duration},(_,i)=>point(start+i,i%2 ? 'claude' : 'codex'));
    const rows=localUsageSeries(points,query,scanClock);
    assert.equal(rows.length,Math.min(30,duration));assert.deepEqual(totals(rows),[duration*26,duration*2]);
    assert.equal(rows.reduce((sum,row)=>sum+row.end_timestamp-row.timestamp+1,0),duration);
  }
  const window=resolveRange('24h',now),cached=[point(window.start_timestamp),point(window.end_timestamp,'claude')];
  assert.deepEqual(totals(localUsageSeries(cached,'24h',now)),[52,4]);
  assert.equal(localUsageSeries(cached,'24h',now)[0].timestamp,window.start_timestamp);
  assert.equal(new Date(window.start_timestamp*1000).getSeconds(),56);
  assert.ok(localUsageSeries([],'24h',now).every(row=>row.tokens===0 && row.requests===0));
});

test('real sparse Codex/Claude session scans preserve second bucket starts and agree with the daily table totals',async t=>{
  const base=path.resolve('.test-data');await mkdir(base,{recursive:true});
  const home=await mkdtemp(path.join(base,'local-trends-ui-'));
  t.after(async()=>{const relative=path.relative(base,home);assert.ok(relative && !relative.startsWith('..') && !path.isAbsolute(relative));await rm(home,{recursive:true,force:true});});
  const sessions=path.join(home,'.codex','archived_sessions'),projects=path.join(home,'.claude','projects','fixture');
  await Promise.all([mkdir(sessions,{recursive:true}),mkdir(projects,{recursive:true})]);
  const query={range:{startDate:'2026-09-20',endDate:'2026-09-20',startTime:'09:05',endTime:'09:06'}},window=resolveRange(query,now),start=window.start_timestamp,end=window.end_timestamp;
  const codex=[{type:'session_meta',payload:{id:'sparse-codex'}},{type:'turn_context',payload:{model:'gpt-5'}},
    ...[start-1,start,start+3,start+4,end,end+1].map((timestamp,i)=>({type:'event_msg',timestamp:new Date(timestamp*1000).toISOString(),payload:{type:'token_count',info:{total_token_usage:{input_tokens:16*(i+1),output_tokens:7*(i+1),cached_input_tokens:5*(i+1),cache_creation_input_tokens:3*(i+1)}}}}))];
  const claude=[start-1,start+4,end,end+1].map((timestamp,i)=>({type:'assistant',sessionId:'sparse-claude',timestamp:new Date(timestamp*1000).toISOString(),message:{id:'message-'+i,model:'claude-sonnet',usage:{input_tokens:20,output_tokens:10,cache_read_input_tokens:2,cache_creation_input_tokens:1}}}));
  await Promise.all([writeFile(path.join(sessions,'fixture.jsonl'),codex.map(event=>JSON.stringify(event)).join('\n')),writeFile(path.join(projects,'fixture.jsonl'),claude.map(event=>JSON.stringify(event)).join('\n'))]);
  const service=new LocalUsageService(home),local=await service.scan(query);
  assert.ok(local.points,'scan returns timestamped local points');assert.equal(local.filesScanned,2);
  assert.deepEqual([...new Set(local.points.map(point=>point.created_at))].sort((a,b)=>a-b),[start,start+4,start+116]);
  const chart=localUsageSeries(local.points,query,new Date(local.scannedAt));
  assert.equal(chart.length,30);assert.equal(chart[0].tokens,52);assert.equal(chart[1].tokens,59);assert.equal(chart[29].tokens,59);
  const table=local.rows.reduce((sum,row)=>[sum[0]+row.inputTokens+row.outputTokens+row.cacheReadTokens+row.cacheWriteTokens,sum[1]+row.requests],[0,0]);
  assert.deepEqual(totals(chart),[170,6]);assert.deepEqual(totals(chart),table);
  assert.deepEqual(totals(localUsageSeries(local.points,query,new Date(local.scannedAt),'codex')),[104,4]);
  assert.deepEqual(totals(localUsageSeries(local.points,query,new Date(local.scannedAt),'claude')),[66,2]);
  const cached=await service.scan(query);assert.equal(cached.scannedAt,local.scannedAt);assert.deepEqual(localUsageSeries(cached.points!,query,new Date(cached.scannedAt)),chart);
});

test('a rolling scan that crosses seconds keeps its first sparse bucket and the scan clock on cached reads',async t=>{
  const base=path.resolve('.test-data');await mkdir(base,{recursive:true});
  const home=await mkdtemp(path.join(base,'local-trends-clock-'));
  t.after(async()=>{const relative=path.relative(base,home);assert.ok(relative && !relative.startsWith('..') && !path.isAbsolute(relative));await rm(home,{recursive:true,force:true});});
  t.mock.timers.enable({apis:['Date'],now:now.getTime()});
  const sessions=path.join(home,'.codex','sessions');await mkdir(sessions,{recursive:true});
  const window=resolveRange('24h',now),start=window.start_timestamp;
  const events=[{type:'turn_context',payload:{model:'gpt-5'}},...[start,start+2880,window.end_timestamp].map((timestamp,i)=>({type:'event_msg',timestamp:new Date(timestamp*1000).toISOString(),payload:{type:'token_count',info:{total_token_usage:{input_tokens:16*(i+1),output_tokens:7*(i+1),cached_input_tokens:5*(i+1),cache_creation_input_tokens:3*(i+1)}}}}))];
  await writeFile(path.join(sessions,'fixture.jsonl'),events.map(event=>JSON.stringify(event)).join('\n'));
  const service=new LocalUsageService(home);let advanced=false;
  const local=await service.scan('24h',value=>{if(value.phase==='read' && !advanced){advanced=true;t.mock.timers.tick(2000);}});
  assert.ok(advanced,'reading intentionally crosses two seconds');assert.ok(local.points);
  assert.equal(local.scannedAt,now.getTime(),'scannedAt anchors the actual query buckets, before reading');
  const chart=localUsageSeries(local.points,'24h',new Date(local.scannedAt));
  assert.equal(chart[0].timestamp,start);assert.equal(chart[0].tokens,26);assert.equal(chart[1].tokens,26);assert.equal(chart[29].tokens,26);assert.deepEqual(totals(chart),[78,3]);
  t.mock.timers.tick(15000);const cached=await service.scan('24h');
  assert.equal(cached.scannedAt,local.scannedAt);assert.deepEqual(localUsageSeries(cached.points!,'24h',new Date(cached.scannedAt)),chart);
});
