import test from 'node:test';
import assert from 'node:assert/strict';
import {MenuBarService,menuBarTemplate} from '../electron/services/menu-bar';
import {macMenu} from '../electron/window-layout';
import {trackedToolTokenNames,toolForLog} from '../shared/utils';
import {DEFAULT_PREFERENCES,type MenuBarUsage,type UsageLog} from '../shared/types';
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
