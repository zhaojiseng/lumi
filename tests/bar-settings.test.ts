import test from 'node:test';
import assert from 'node:assert/strict';
import {DEFAULT_PREFERENCES,MENU_BAR_SECTION_IDS,type MenuBarSectionId,type MenuBarUsage} from '../shared/types';
import {applyPreferencePatch} from '../shared/selections';
import {menuBarNeedsDetails,menuBarPanelHeight,nativeMenuBarState,normalizeMenuBarContents} from '../shared/menu-bar';
import {MenuBarService,menuBarTemplate} from '../electron/services/menu-bar';
import {build} from 'esbuild';
import {createRequire} from 'node:module';
import {runInNewContext} from 'node:vm';
import {createElement} from 'react';
import {renderToStaticMarkup} from 'react-dom/server';

function usage(fetchedAt=1000):MenuBarUsage{return {siteId:'fixture',siteName:'Fixture',status:{system_name:'Fixture',quota_per_unit:500000},user:{id:42,username:'fixture',display_name:'Fixture',quota:5000000,used_quota:200000,request_count:2,group:'default'},today:{quota:500000,tokens:12000,requests:3},tools:[],fetchedAt,warnings:[]};}
function selections(){return Array.from({length:2**MENU_BAR_SECTION_IDS.length},(_,mask)=>MENU_BAR_SECTION_IDS.filter((_,index)=>!!(mask & 1<<index)));}

test('section migration defaults older values to all and preserves an intentional empty selection',()=>{
  for(const invalid of [undefined,null,false,0,'balance',{}])assert.deepEqual(normalizeMenuBarContents(invalid),[...MENU_BAR_SECTION_IDS]);
  assert.deepEqual(normalizeMenuBarContents([]),[]);
  assert.deepEqual(normalizeMenuBarContents(['models','balance','models','unknown',null,'efficiency']),['balance','efficiency','models']);
  assert.deepEqual(normalizeMenuBarContents(['unknown']),[]);
  const selected=normalizeMenuBarContents(undefined);selected.pop();assert.equal(MENU_BAR_SECTION_IDS.length,6);
});

test('bar preferences allow all, none and independent intervals without mutating page preferences',()=>{
  const original=structuredClone(DEFAULT_PREFERENCES);
  assert.deepEqual(original.menuBarContents,[...MENU_BAR_SECTION_IDS]);
  for(const menuBarRefreshInterval of [0,30,60,120,300,600]){
    const next=applyPreferencePatch(original,{menuBarContents:[],menuBarRefreshInterval});
    assert.deepEqual(next.menuBarContents,[]);assert.equal(next.menuBarRefreshInterval,menuBarRefreshInterval);
    assert.equal(next.refreshInterval,original.refreshInterval);assert.deepEqual(next.viewSelections,original.viewSelections);
  }
  assert.deepEqual(original,DEFAULT_PREFERENCES);
});

test('bar settings renders all six accessible checkboxes and independently selectable refresh intervals',async()=>{
  const result=await build({stdin:{contents:"export {default as BarSettings} from './src/components/BarSettings'; export {AppContext} from './src/context';",resolveDir:process.cwd(),loader:'tsx'},bundle:true,platform:'node',format:'cjs',write:false,external:['react','react/jsx-runtime'],loader:{'.svg':'text'},logLevel:'silent'});
  const module={exports:{} as Record<string,any>};
  runInNewContext(result.outputFiles[0].text,{module,exports:module.exports,require:createRequire(import.meta.url)});
  const {BarSettings,AppContext}=module.exports;
  for(const contents of [[...MENU_BAR_SECTION_IDS],[]]){
    const html=renderToStaticMarkup(createElement(AppContext.Provider,{value:{preferences:{...DEFAULT_PREFERENCES,menuBarContents:contents,menuBarRefreshInterval:120},updatePreferences:async()=>{},toast:()=>{}}},createElement(BarSettings)));
    assert.equal([...html.matchAll(/type="checkbox"/g)].length,6);
    assert.equal([...html.matchAll(/checked=""/g)].length,contents.length);
    for(const id of MENU_BAR_SECTION_IDS)assert.ok(html.includes('aria-labelledby="bar-section-'+id+'"'));
    for(const interval of [0,30,60,120,300,600])assert.ok(html.includes('value="'+interval+'"'));
    assert.ok(/<option(?=[^>]*value="120")(?=[^>]*selected="")[^>]*>/.test(html));
    assert.ok(html.includes('全部隐藏') && html.includes('全选'));
  }
});

test('all section combinations request detailed history only for visible data requiring it',()=>{
  for(const contents of selections())for(const tool of ['all','codex','claude'] as const){
    const expected=contents.includes('tokenDetail') || contents.includes('efficiency') || tool!=='all' && contents.some(id=>['totals','chart','models'].includes(id));
    assert.equal(menuBarNeedsDetails(contents,{days:30,tool}),expected,JSON.stringify({contents,tool}));
  }
});

test('formatted state propagates section selections, omits hidden chart/model work and ignores hidden detail errors',()=>{
  const data=usage(new Date(2026,9,2,12,30).getTime());
  data.period={selection:{days:1,tool:'all'},quota:500000,tokens:12000,requests:3,points:[{created_at:data.fetchedAt/1000,quota:500000,token_used:12000,count:3,model_name:'fixture-model'}]};
  const full=nativeMenuBarState({phase:'ready',usage:data},{days:1,tool:'all'});
  assert.deepEqual(full.contents,[...MENU_BAR_SECTION_IDS]);assert.equal(full.chart?.length,13);assert.equal(full.models[0].name,'fixture-model');
  for(const contents of selections()){
    const state=nativeMenuBarState({phase:'ready',usage:data,detailsError:'fixture failure'},{days:1,tool:'all'},contents);
    assert.deepEqual(state.contents,contents);
    assert.equal(state.chart!==null,contents.includes('chart'));assert.equal(state.models.length,contents.includes('models') ? 1 : 0);
    assert.equal(state.message==='详细统计暂不可用',contents.includes('tokenDetail') || contents.includes('efficiency'));
  }
  const chosen:MenuBarSectionId[]=['balance'],state=nativeMenuBarState({phase:'ready',usage:data},{days:1,tool:'all'},chosen);
  state.contents.push('models');assert.deepEqual(chosen,['balance']);
});

test('popup height is compact and monotonic across all selections within its existing maximum',()=>{
  const empty=menuBarPanelHeight([]),full=menuBarPanelHeight();
  assert.ok(empty<full);assert.ok(full<=648);
  for(const contents of selections()){
    const height=menuBarPanelHeight(contents);
    assert.ok(height>=empty && height<=648);
    for(const section of MENU_BAR_SECTION_IDS)if(!contents.includes(section))assert.ok(menuBarPanelHeight([...contents,section])>=height);
  }
  assert.ok(menuBarPanelHeight(['models'],0)<menuBarPanelHeight(['models'],3));
  assert.equal(menuBarPanelHeight(['models'],9),menuBarPanelHeight(['models'],3));
});

test('fallback menu hides optional sections while preserving actions for an empty selection',()=>{
  const actions={navigate:()=>{},refresh:()=>{},quit:()=>{}},snapshot={phase:'ready' as const,usage:usage()};
  const empty=menuBarTemplate(snapshot,actions,[]),labels=empty.map(item=>item.label || '');
  for(const label of ['刷新用量','打开工作台','用量分析','设置…','退出 Lumi'])assert.ok(labels.includes(label));
  assert.ok(!labels.some(label=>/账户余额|消费趋势|Tokens|缓存命中率|主要模型/.test(label)));
  const balance=menuBarTemplate(snapshot,actions,['balance']);assert.ok(balance.some(item=>item.label==='账户余额　$10.00'));
  assert.ok(!balance.some(item=>item.label?.includes('本期消费') || item.label?.includes('今日消费')));
  for(const contents of selections()){
    const items=menuBarTemplate(snapshot,actions,contents);
    assert.ok(!items.some((item,index)=>item.type==='separator' && items[index+1]?.type==='separator'));
    assert.ok(items.some(item=>item.label==='刷新用量' && item.enabled));
  }
});

test('configured 30-second summary caching honors dynamic intervals and keeps five-minute details',async()=>{
  let now=1000,ttl=30000,loads=0,detailsLoads=0;
  const service=new MenuBarService({identity:()=> 'fixture',now:()=>now,summaryTtl:()=>ttl,load:async()=>{loads++;return usage(now);},loadDetails:async()=>{detailsLoads++;return {points:[],inputTokens:0,outputTokens:0,cacheReadTokens:0,cacheWriteTokens:0,quality:{requestCount:0,cacheSamples:0,speedSamples:0,inputTokens:0,cacheReadTokens:0,outputTokens:0,durationSeconds:0,cacheHitRate:null,averageTokenSpeed:null,fetchedAt:now}};}});
  await service.refresh();await service.details();now+=29999;await service.refresh();assert.equal(loads,1);
  now++;await service.refresh();await service.details();assert.equal(loads,2);assert.equal(detailsLoads,1);
  ttl=120000;now+=60000;await service.refresh();assert.equal(loads,2);
  ttl=30000;await service.refresh();assert.equal(loads,3);await service.details();assert.equal(detailsLoads,1);
  now+=210000;await service.refresh();await service.details();assert.equal(detailsLoads,2);
  await service.refresh(true);assert.equal(loads,5);
});
