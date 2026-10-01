import test from 'node:test';
import assert from 'node:assert/strict';
import {barPeriods,barPeriodSelection,loadBarPeriods,loadBarPeriodDetails,normalizeMenuBarRange} from '../shared/menu-bar-periods';
import {nativeMenuBarState} from '../shared/menu-bar';
import {DEFAULT_PREFERENCES,type MenuBarSelection,type MenuBarUsage,type MenuBarDetails} from '../shared/types';

const now=new Date(2026,9,2,12,30).getTime();
const detail=(selection:MenuBarSelection):MenuBarDetails=>({points:[{created_at:now/1000,model_name:'model-a',quota:100*(selection.range==='24h' ? 24 : selection.days),count:1,token_used:20}],quality:{requestCount:1,cacheSamples:1,speedSamples:1,inputTokens:10,cacheReadTokens:5,outputTokens:10,durationSeconds:2,cacheHitRate:.5,averageTokenSpeed:5,fetchedAt:now},inputTokens:10,outputTokens:10,cacheReadTokens:5,cacheWriteTokens:0});
function source(){
  const calls:{selection:MenuBarSelection;force:boolean}[]=[],details:MenuBarSelection[]=[];
  return {calls,details,async menuBarUsage(force:boolean,selection:MenuBarSelection):Promise<MenuBarUsage>{calls.push({selection,force});return {siteId:'fixture',siteName:'Fixture',status:{system_name:'Fixture',quota_per_unit:100},user:null,today:{quota:0,tokens:0,requests:0},tools:[],period:{selection,quota:selection.days*100,tokens:20,requests:1,points:detail(selection).points},fetchedAt:now,warnings:[]};},async menuBarDetails(selection:MenuBarSelection){details.push(selection);return detail(selection);}};
}
test('independent bar periods preserve tool selection and default to following panel',()=>{
  for(const value of [null,undefined,0,90,'7',{},[]])assert.equal(normalizeMenuBarRange(value),'follow');
  const selection={days:30,tool:'codex'} as const;
  assert.deepEqual(barPeriods(DEFAULT_PREFERENCES,selection),{totals:selection,chart:selection});
  assert.deepEqual(barPeriodSelection(selection,'24h'),{days:1,tool:'codex',range:'24h'});
  assert.deepEqual(barPeriodSelection(selection,7),{days:7,tool:'codex',range:7});
});
test('different chart period affects only chart values/caption and skips duplicate or hidden work',async()=>{
  const api=source(),totals={days:7,tool:'all'} as const,chart={days:1,range:'24h',tool:'all'} as const;
  const usage=await loadBarPeriods(api,true,totals,chart,true);
  assert.deepEqual(api.calls.map(c=>c.force),[true,false]);
  const state=nativeMenuBarState({phase:'ready',usage},{days:30,tool:'all'});
  assert.equal(state.cost,'$7.00');assert.equal(state.totalsCaption,'最近 7 天');
  assert.equal(state.chartCaption,'最近 24 小时 · 按小时');assert.equal(state.chart?.length,24);assert.equal(state.chart?.reduce((sum,p)=>sum+p.value,0),24);
  api.calls.length=0;await loadBarPeriods(api,false,totals,chart,false);assert.equal(api.calls.length,1);
  api.calls.length=0;await loadBarPeriods(api,false,totals,{...totals,range:7},true);assert.equal(api.calls.length,1);
});
test('tool or rolling chart details use the independent period and partial failures retain totals',async()=>{
  const api=source(),totals={days:7,tool:'codex'} as const,chart={days:1,tool:'codex'} as const;
  const result=await loadBarPeriodDetails(api,totals,chart,true);
  assert.equal(result.points[0].quota,700);assert.equal(result.chartPoints?.[0].quota,100);
  assert.deepEqual(api.details,[totals,chart]);
  const broken={...api,menuBarDetails:async(selection:MenuBarSelection)=>{if(selection.days===1)throw new Error('chart unavailable');return detail(selection);}};
  const partial=await loadBarPeriodDetails(broken,totals,chart,true);assert.equal(partial.inputTokens,10);assert.equal(partial.chartPoints,null);
  api.details.length=0;await loadBarPeriodDetails(api,totals,chart,false);assert.deepEqual(api.details,[totals]);
});
