import test from 'node:test';
import assert from 'node:assert/strict';
import {hourlySeries,usageSeries} from '../shared/utils';
import {cheapestGroup,defaultModelGroup,groupLabel,normalizeCatalog} from '../shared/catalog';
const now=new Date(2026,8,30,12,30);
const status={system_name:'Test',quota_per_unit:500000,quota_display_type:'CNY',usd_exchange_rate:7};
const stamp=(day:number,hour=0,minute=0,second=0) => new Date(2026,8,day,hour,minute,second).getTime()/1000;
const point=(created_at:number,quota=500000,token_used=10,count=1,model_name='x') => ({created_at,quota,token_used,count,model_name});
test('historical single-day hourly chart preserves totals, boundaries, gaps and per-model aggregation',() => {
 const rows=hourlySeries([point(stamp(29)),point(stamp(29,3),100000,20,2),point(stamp(29,3,59,59),400000,30,3,'y'),point(stamp(29,23,59,59)),point(stamp(28,23,59,59)),point(stamp(30)),point(NaN)],status,{startDate:'2026-09-29',endDate:'2026-09-29'},now);
 assert.equal(rows.length,24);assert.equal(rows[0].label,'00:00');assert.equal(rows[23].label,'23:00');
 assert.ok(Math.abs(rows[3].cost-7)<1e-10);assert.deepEqual([rows[3].tokens,rows[3].requests],[50,5]);assert.equal(rows[2].cost,0);
 assert.deepEqual(rows.reduce((t,r) => [t[0]+r.cost,t[1]+r.tokens,t[2]+r.requests],[0,0,0]),[21,70,7]);
 assert.equal(rows[23].tooltipLabel,'2026-09-29 23:00–23:59');
});
test('today hourly chart stops at current hour and excludes future points within that hour',() => {
 const rows=hourlySeries([point(stamp(30,12,0)),point(stamp(30,12,31)),point(stamp(30,13))],status,undefined,now);
 assert.equal(rows.length,13);assert.equal(rows[12].label,'12:00');assert.equal(rows[12].requests,1);assert.match(rows[12].tooltipLabel,/12:00–12:30$/);
 const midnight=hourlySeries([],status,undefined,new Date(2026,8,30));assert.equal(midnight.length,1);assert.equal(midnight[0].cost,0);
});
test('usage charts use thirty elapsed buckets for today, historical single days and weekly windows',() => {
 const today=usageSeries([],1,status,undefined,now);assert.equal(today.length,30);assert.equal(today[0].timestamp,stamp(30));assert.equal(today.at(-1)?.label,'9/30 12:05');
 const custom=usageSeries([],7,status,{startDate:'2026-09-29',endDate:'2026-09-29'},now);assert.equal(custom.length,30);assert.equal(custom[6].timestamp,stamp(29,4,48));assert.equal(custom[6].label,'9/29 04:48');
 assert.equal(custom.at(-1)?.tooltipLabel,'2026-09-29 23:12 – 2026-09-29 23:59');
 const weekly=usageSeries([],7,status,undefined,now);assert.equal(weekly.length,30);assert.equal(weekly.at(-1)?.label,'9/30 07:17');
 assert.ok([...today,...custom,...weekly].every(row=>row.cost===0 && row.tokens===0 && row.requests===0 && row.cacheHitRate===null));
 assert.throws(() => hourlySeries([],status,{startDate:'2026-09-28',endDate:'2026-09-29'},now));
});
function catalog() {return normalizeCatalog({data:[{model_name:'x',enable_groups:['standard','premium','free','unknown','auto','blocked']}],usable_group:{standard:'标准',premium:'优惠',unknown:'未知',auto:'自动'},group_ratio:{standard:1,premium:.5,auto:0,blocked:0,free:0},auto_groups:['standard']});}
test('default channel uses the lowest reachable account price instead of catalog order',() => {
 const c=catalog();assert.equal(cheapestGroup(c.models[0],c),'premium');assert.equal(defaultModelGroup(c.models[0],c),'premium');
 c.models[0].enable_groups=['standard'];assert.equal(cheapestGroup(c.models[0],c),'standard');
});
test('model-specific channel ratios override account ratios and labels show the effective price',() => {
 const c=catalog();c.models[0].group_ratio={standard:.25,premium:2};assert.equal(cheapestGroup(c.models[0],c),'standard');assert.match(groupLabel(c,'standard',c.models[0]),/×0\.25$/);
});
test('free reachable channels win and price ties remain deterministic',() => {
 const c=catalog();c.usableGroups.free='免费';assert.equal(cheapestGroup(c.models[0],c),'free');
 c.groupRatio.standard=0;assert.equal(cheapestGroup(c.models[0],c),'standard');
});
test('auto, unannounced, invalid and unreachable prices are never declared cheapest',() => {
 const c=catalog();c.models[0].enable_groups=['auto','unknown'];assert.equal(cheapestGroup(c.models[0],c),undefined);assert.equal(defaultModelGroup(c.models[0],c),'unknown');
 c.models[0].enable_groups=['premium','standard'];c.models[0].group_ratio={premium:NaN,standard:-1};assert.equal(cheapestGroup(c.models[0],c),undefined);
 c.models[0].enable_groups=[];assert.equal(defaultModelGroup(c.models[0],c),'');
});
test('valid manual channels persist while invalid preferences fall back to current cheapest',() => {
 const c=catalog();assert.equal(defaultModelGroup(c.models[0],c,'standard'),'standard');assert.equal(defaultModelGroup(c.models[0],c,'blocked'),'premium');
 c.groupRatio.standard=.1;assert.equal(defaultModelGroup(c.models[0],c),'standard');assert.equal(defaultModelGroup(c.models[0],c,'premium'),'premium');
});
