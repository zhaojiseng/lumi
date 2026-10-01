import test from 'node:test';
import assert from 'node:assert/strict';
import {MenuBarService,menuBarTemplate} from '../electron/services/menu-bar';
import {macMenu} from '../electron/window-layout';
import {trackedToolTokenNames,toolForLog} from '../shared/utils';
import {DEFAULT_PREFERENCES,type MenuBarUsage,type UsageLog} from '../shared/types';
import {nativeMenuBarState,menuBarSelection} from '../shared/menu-bar';
import {parseNativeMenuEvent} from '../electron/services/native-menu-bar';
function usage(time=1000):MenuBarUsage{return {siteId:'site',siteName:'Fixture',status:{system_name:'Fixture',quota_per_unit:500000},user:{id:42,username:'fixture',display_name:'Fixture',quota:5000000,used_quota:200000,request_count:2,group:'default'},today:{quota:500000,tokens:12000,requests:3},tools:[{tool:'codex',quota:250000},{tool:'claude',quota:null}],fetchedAt:time,warnings:[]};}
test('menu bar caches requests for a minute, deduplicates clicks and returns isolated snapshots',async()=>{
 let now=1000,calls=0;let release!:()=>void;const gate=new Promise<void>(r=>release=r);
 const service=new MenuBarService({identity:()=> 'account',now:()=>now,load:async()=>{calls++;await gate;return usage(now);}});
 const [a,b]=[service.refresh(),service.refresh()];release();await Promise.all([a,b]);assert.equal(calls,1);service.snapshot().usage!.siteName='mutated';assert.equal(service.snapshot().usage?.siteName,'Fixture');
 await service.refresh();assert.equal(calls,1);now+=60001;await service.refresh();assert.equal(calls,2);await service.refresh(true);assert.equal(calls,3);
});
test('menu bar clears prior account immediately and discards old in-flight replies',async()=>{
 let account='old',release!:()=>void;const gate=new Promise<void>(r=>release=r);
 const service=new MenuBarService({identity:()=>account,load:async()=>{await gate;return usage();}});const pending=service.refresh();account='new';assert.equal(service.snapshot().usage,undefined);release();await pending;assert.equal(service.snapshot().usage,undefined);
});
test('native menu keeps unknown statistics as dashes and exposes navigation, refresh and quit actions',()=>{
 const events:string[]=[],actions={navigate:(page:string)=>events.push(page),refresh:()=>events.push('refresh'),quit:()=>events.push('quit')};
 const items=menuBarTemplate({phase:'ready',usage:usage()},actions);assert.ok(items.some(i=>i.label==='账户余额　$10.00'));assert.ok(items.some(i=>i.label==='Claude Code 今日　—'));
 for(const label of ['用量分析','刷新用量','退出 Lumi'])items.find(i=>i.label===label)!.click!(null as never,null as never,null as never);
 assert.deepEqual(events,['usage','refresh','quit']);assert.ok(menuBarTemplate({phase:'ready',usage:{...usage(),user:null}},actions).some(i=>i.label==='登录后查看余额与用量'));
 const menu=macMenu({...actions,show:()=>events.push('show'),checkUpdate:()=>events.push('update')});const app=menu[0].submenu as Exclude<typeof items,undefined>;
 assert.ok(app.some(i=>i.accelerator==='Command+,'));app.find(i=>i.label==='检查更新…')!.click!(null as never,null as never,null as never);assert.equal(events.at(-1),'update');
});
test('historical token names remain attributed and collisions are excluded from tool totals',()=>{
 const prefs=structuredClone(DEFAULT_PREFERENCES);prefs.bindings=[];prefs.managedTokens=[{siteId:'site',tool:'codex',id:7,name:'Lumi-Codex',previousNames:['Lumi-Codex-old'],group:'standard'}];
 const tokens=[{id:7,name:'Lumi-Codex'}] as never;
 assert.deepEqual(trackedToolTokenNames(prefs,'site',tokens).map(t=>t.name),['Lumi-Codex','Lumi-Codex-old']);assert.equal(toolForLog({token_name:'Lumi-Codex-old'} as UsageLog,[],prefs.managedTokens),'codex');
 assert.deepEqual(trackedToolTokenNames(prefs,'site',[{id:7,name:'Lumi-Codex'},{id:8,name:'Lumi-Codex-old'}] as never).map(t=>t.name),['Lumi-Codex']);
});

test('native usage card respects reported currency, calendar buckets and unknown tool totals',()=>{
 const time=new Date(2026,9,2,12,30).getTime(),data=usage(time);data.status={...data.status,quota_display_type:'CUSTOM',custom_currency_symbol:'✾',custom_currency_exchange_rate:2};
 data.period={selection:{days:7,tool:'all'},quota:500000,tokens:12000,requests:3,points:[{created_at:time/1000,quota:500000,token_used:12000,count:3,model_name:'model-a'}]};
 const state=nativeMenuBarState({phase:'ready',usage:data},{days:7,tool:'all'});assert.equal(state.cost,'✾2.00');assert.equal(state.chart!.length,7);assert.equal(state.chart!.at(-1)!.cost,'✾2.00');assert.equal(state.models[0].name,'model-a');assert.equal(state.models[0].share,1);
 data.period={selection:{days:1,tool:'codex'},quota:null,tokens:null,requests:null,points:null};const unavailable=nativeMenuBarState({phase:'ready',usage:data},{days:1,tool:'codex'});assert.equal(unavailable.cost,'—');assert.equal(unavailable.tokens,'—');assert.equal(unavailable.chart,null);
 assert.deepEqual(menuBarSelection({'menuBar.days':30,'menuBar.tool':'claude'}),{days:30,tool:'claude'});assert.deepEqual(menuBarSelection({'menuBar.days':90,'menuBar.tool':'shell'}),{days:1,tool:'all'});
});

test('native helper receives formatted usage only and cannot emit arbitrary actions or paths',()=>{
 const data=usage();data.user!.email='private@example.test';const serialized=JSON.stringify(nativeMenuBarState({phase:'ready',usage:data},{days:1,tool:'all'}));assert.ok(!serialized.includes('private@example.test'));assert.ok(!serialized.includes('userId'));assert.ok(!serialized.includes('subscription'));assert.ok(!serialized.includes('quota_per_unit'));
 assert.deepEqual(parseNativeMenuEvent('{"type":"select","days":30,"tool":"codex"}'),{type:'select',selection:{days:30,tool:'codex'}});
 assert.deepEqual(parseNativeMenuEvent('{"type":"navigate","page":"usage"}'),{type:'navigate',page:'usage'});
 for(const line of ['{"type":"select","days":90,"tool":"codex"}','{"type":"navigate","page":"https://evil.test"}','{"type":"refresh","command":"sh"}','{"type":"quit","path":"/tmp"}','not-json'])assert.equal(parseNativeMenuEvent(line),null);
});

test('detailed menu metrics deduplicate, attach only to their account and preserve summary on failure',async()=>{
 let identity='old',loads=0,release!:()=>void;const gate=new Promise<void>(r=>release=r),details={points:[],quality:{requestCount:0,cacheSamples:0,speedSamples:0,inputTokens:0,cacheReadTokens:0,outputTokens:0,durationSeconds:0,cacheHitRate:null,averageTokenSpeed:null,fetchedAt:1000},inputTokens:0,outputTokens:0,cacheReadTokens:0,cacheWriteTokens:0};
 const service=new MenuBarService({identity:()=>identity,now:()=>1000,load:async()=>usage(),loadDetails:async()=>{loads++;await gate;return details;}});await service.refresh();const [a,b]=[service.details(),service.details()];assert.equal(loads,1);identity='new';assert.equal(service.snapshot().usage,undefined);release();await Promise.all([a,b]);assert.equal(service.snapshot().usage,undefined);
 const failed=new MenuBarService({identity:()=>identity,load:async()=>usage(),loadDetails:async()=>{throw new Error('page limit');}});await failed.refresh();await failed.details();assert.equal(failed.snapshot().usage?.user?.quota,5000000);assert.ok(failed.snapshot().detailsError);assert.equal(failed.snapshot().usage?.details,undefined);
});

test('minute summary refresh retains valid detailed metrics without another history scan',async()=>{
 let now=1000,calls=0;const details={points:[],quality:{requestCount:0,cacheSamples:0,speedSamples:0,inputTokens:0,cacheReadTokens:0,outputTokens:0,durationSeconds:0,cacheHitRate:null,averageTokenSpeed:null,fetchedAt:now},inputTokens:0,outputTokens:0,cacheReadTokens:0,cacheWriteTokens:0};
 const service=new MenuBarService({identity:()=> 'same',now:()=>now,load:async()=>usage(now),loadDetails:async()=>{calls++;return details;}});await service.refresh();await service.details();now+=60001;await service.refresh();assert.ok(service.snapshot().usage?.details);await service.details();assert.equal(calls,1);now+=300001;await service.refresh();await service.details();assert.equal(calls,2);
});
