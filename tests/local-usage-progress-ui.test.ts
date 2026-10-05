import test from 'node:test';
import assert from 'node:assert/strict';
import {build} from 'esbuild';
import {createRequire} from 'node:module';
import {runInNewContext} from 'node:vm';
import {webcrypto} from 'node:crypto';
import * as React from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import {applyPreferencePatch} from '../shared/selections';
import {resolveRange} from '../shared/range';
import {DEFAULT_PREFERENCES,type DashboardQuery,type LocalSessionSummary,type LocalUsage,type LocalUsagePoint,type LocalUsageProgress} from '../shared/types';
import type {AppState} from '../src/context';

const bundle=build({
  stdin:{contents:"export {default as Usage} from './plugins/source.local-sessions/renderer/Usage'; export {LocalUsageProgress} from './src/components/LocalUsageProgress'; export {SourcePreferencesProvider} from './src/host/source-preferences'; export {TrendChart} from './src/components/charts';",resolveDir:process.cwd(),loader:'tsx'},
  bundle:true,platform:'node',format:'cjs',write:false,external:['react','react/jsx-runtime','react-dom','recharts'],loader:{'.css':'empty','.svg':'text'},logLevel:'silent',
});
type Element=React.ReactElement<Record<string,any>>;
function elements(node:React.ReactNode):Element[]{
  return React.Children.toArray(node).flatMap(child=>React.isValidElement<Record<string,any>>(child) ? [child,...elements(child.props.children),...elements(child.props.action)] : []);
}
function content(node:React.ReactNode):string{
  return React.Children.toArray(node).map(child=>React.isValidElement<Record<string,any>>(child) ? content(child.props.children) : String(child)).join('');
}
function deferred<T>(){
  let resolve!:(value:T)=>void,reject!:(reason:unknown)=>void;
  const promise=new Promise<T>((yes,no)=>{resolve=yes;reject=no;});return {promise,resolve,reject};
}
const now=new Date(2026,9,2,12,34,56),query={range:{startDate:'2026-10-01',endDate:'2026-10-01',startTime:'09:05',endTime:'09:06'}};
function fixture(model='fixture-model',scannedAt=now.getTime()):LocalUsage{
  const start=resolveRange(query,now).start_timestamp;
  const points:LocalUsagePoint[]=[{tool:'codex',created_at:start+4,model,inputTokens:11,outputTokens:7,cacheReadTokens:5,cacheWriteTokens:3,requests:2},
    {tool:'claude',created_at:start+119,model:'claude-fixture',inputTokens:20,outputTokens:10,cacheReadTokens:2,cacheWriteTokens:1,requests:1}];
  return {points,rows:points.map(p=>({...p,date:'2026-10-01',sessions:1})),sessions:points.map(p=>({...p,id:p.tool+'-session',startedAt:p.created_at,updatedAt:p.created_at})),filesScanned:5,warnings:[],scannedAt};
}
const progress=(requestId:string,phase:LocalUsageProgress['phase']='read',patch:Partial<LocalUsageProgress>={}):LocalUsageProgress=>({requestId,phase,filesDone:1,filesTotal:100,bytesRead:600,bytesTotal:1000,...patch});
type Request=ReturnType<typeof deferred<LocalUsage>> & {query:DashboardQuery;id:string};
async function harness(){
  const listeners=new Set<(p:LocalUsageProgress)=>void>(),retired:((p:LocalUsageProgress)=>void)[]=[],requests:Request[]=[],notices:string[]=[];
  let unsubscribed=0,network=0,onInvoke=(request:Request)=>{};
  const bridge={
    onLocalUsageProgress:(listener:(p:LocalUsageProgress)=>void)=>{listeners.add(listener);return()=>{unsubscribed++;listeners.delete(listener);retired.push(listener);};},
    localUsage:(query:DashboardQuery,id:string)=>{assert.equal(listeners.size,1,'subscribe before invoke');const request={...deferred<LocalUsage>(),query,id};requests.push(request);onInvoke(request);return request.promise;},
    tokenUsage:async()=>{network++;throw new Error('unexpected remote request');},
    logs:async()=>{network++;return {items:[],total:0,page:1,pageSize:15};},
  };
  const preferences=structuredClone(DEFAULT_PREFERENCES);
  preferences.sites[0]={...preferences.sites[0],url:'https://fixture.invalid',userId:1,accessTokenConfigured:true};
  preferences.sourceSelections={'source.local-sessions':{range:structuredClone(query.range)}};
  const app:AppState={
    preferences,bootstrap:{preferences,desktop:true,version:'0.4.31',secureStorage:true,configs:[]},
    dashboard:{status:{system_name:'Fixture',quota_per_unit:500000},user:{id:1,username:'fixture',display_name:'Fixture',quota:0,used_quota:0,request_count:0,group:'standard'},
      logs:{items:[],total:0,page:1,pageSize:15},series:[],stat:null,tokens:[],warnings:[],fetchedAt:new Date(2026,8,1).getTime(),days:7,
      catalog:{models:[],groupRatio:{},usableGroups:{},autoGroups:[],vendors:[]}},
    page:'usage',setPage:()=>{},days:7,setDays:()=>{},overviewQuery:7,setOverviewQuery:()=>{},statisticsQuery:structuredClone(query),loading:false,error:'',
    openLogin:()=>{},setPreferences:()=>{},configureModel:()=>{},reloadBootstrap:async()=>{},refresh:async()=>{},toast:message=>{notices.push(message);},
    updatePreferences:async patch=>{app.preferences=applyPreferencePatch(app.preferences,patch);},
  };
  const source={
    get selections(){return app.preferences.sourceSelections;},desktop:true,
    onError:(message:string)=>notices.push(message),update:async(patch:any)=>{await app.updatePreferences(patch);},
  };
  function setRange(range:any){app.preferences=applyPreferencePatch(app.preferences,{sourceSelection:{sourceId:'source.local-sessions',values:{range}}});app.statisticsQuery={range};}
  type Effect={setup:()=>void|(()=>void);deps?:React.DependencyList;cleanup?:()=>void;pending:boolean};
  const slots:any[]=[],effects:Effect[]=[];
  let cursor=0,inPage=false,mounted=true,writes=0,staleWrites=0;
  const hooks={...React,
    useContext:(context:React.Context<unknown>)=>inPage ? source : React.useContext(context),
    useRef:(initial:any)=>{if(!inPage)return React.useRef(initial);const index=cursor++;if(!(index in slots))slots[index]={current:initial};return slots[index];},
    useState:(initial:any)=>{
      if(!inPage)return React.useState(initial);const index=cursor++;
      if(!(index in slots))slots[index]=typeof initial==='function' ? initial() : initial;
      return [slots[index],(value:any)=>{writes++;if(!mounted)staleWrites++;slots[index]=typeof value==='function' ? value(slots[index]) : value;}];
    },
    useEffect:(setup:Effect['setup'],deps?:React.DependencyList)=>{
      if(!inPage)return React.useEffect(setup,deps);const index=cursor++;
      if(!(index in slots)){const effect={setup,deps,pending:true};slots[index]=effect;effects.push(effect);}
      else{const effect=slots[index] as Effect;if(!deps || !effect.deps || deps.length!==effect.deps.length || deps.some((value,i)=>!Object.is(value,effect.deps![i]))){effect.setup=setup;effect.deps=deps;effect.pending=true;}}
    },
  };
  const module={exports:{} as Record<string,any>},nodeRequire=createRequire(import.meta.url);
  runInNewContext((await bundle).outputFiles[0].text,{module,exports:module.exports,structuredClone,crypto:webcrypto,window:{lumi:bridge},
    require:(name:string)=>name==='react' ? hooks : nodeRequire(name)});
  const {Usage,SourcePreferencesProvider,LocalUsageProgress,TrendChart}=module.exports;
  function render(runEffects=true):Element{
    cursor=0;inPage=true;let tree:Element;try{tree=Usage();}finally{inPage=false;}
    if(runEffects)for(const effect of effects)if(effect.pending){effect.pending=false;effect.cleanup?.();const cleanup=effect.setup();effect.cleanup=typeof cleanup==='function' ? cleanup : undefined;}
    return tree;
  }
  function html(){return renderToStaticMarkup(React.createElement(SourcePreferencesProvider,{value:source},render()));}
  function button(label:string){const button=elements(render()).find(node=>(node.type==='button' || typeof node.type==='function' && node.type.name==='Button') && content(node.props.children)===label);assert.ok(button,label+' exists');return button.props;}
  function chart(){const chart=elements(render()).find(node=>node.type===TrendChart);assert.ok(chart,'local chart exists');return chart.props;}
  function sessionList(){const list=elements(render()).find(node=>typeof node.type==='function' && node.type.name==='LocalSessions');assert.ok(list);return list.props;}
  function sessionDetail(runEffects=true){return elements(render(runEffects)).find(node=>typeof node.type==='function' && node.type.name==='LocalSessionDetails')?.props;}
  function emit(value:LocalUsageProgress){for(const listener of listeners)listener(value);}
  function unmount(){mounted=false;for(const effect of effects)effect.cleanup?.();}
  async function flush(){for(let i=0;i<6;i++)await Promise.resolve();}
  render();
  return {app,setRange,bridge,requests,listeners,retired,notices,render,html,button,chart,sessionList,sessionDetail,emit,unmount,flush,
    onInvoke:(callback:(request:Request)=>void)=>{onInvoke=callback;},
    feedback:(value:LocalUsageProgress|null)=>renderToStaticMarkup(React.createElement(LocalUsageProgress,{progress:value})),
    counts:()=>({unsubscribed,network,writes,staleWrites}),
  };
}

test('discovery shows actual files with no percentage; reads use bytes rather than file counts',async()=>{
  const h=await harness(),id=h.requests[0].id;
  assert.match(id,/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i);
  h.emit(progress(id,'discover',{filesTotal:47}));assert.match(h.html(),/已发现 47 个会话文件/);
  assert.doesNotMatch(h.html(),/progressbar|aria-valuenow|\d+%/);
  h.emit(progress(id));assert.match(h.html(),/60%/);assert.match(h.html(),/aria-valuenow="60"/);assert.match(h.html(),/已读取 600 B \/ 1,000 B/);assert.match(h.html(),/文件 1 \/ 100/);
  h.emit(progress(id,'discover'));assert.match(h.html(),/60%/);assert.doesNotMatch(h.html(),/正在查找本机会话/);
  assert.doesNotMatch(h.feedback(progress(id,'read',{bytesRead:9999,bytesTotal:10000})),/100%/);
  for(const size of [0,NaN,Infinity,-1])assert.doesNotMatch(h.feedback(progress(id,'read',{bytesTotal:size})),/aria-valuenow|\d+%|NaN|Infinity/);
  assert.equal(h.feedback(progress(id,'complete')),'');assert.equal(h.feedback(null),'');h.unmount();
});

test('completion hides progress immediately and ignores late notifications and post-unmount responses',async()=>{
  const h=await harness(),request=h.requests[0];
  h.emit(progress(request.id));assert.match(h.html(),/progressbar/);
  h.emit(progress(request.id,'complete'));assert.doesNotMatch(h.html(),/local-usage-progress/);
  h.emit(progress(request.id));assert.doesNotMatch(h.html(),/local-usage-progress/);
  h.unmount();assert.equal(h.listeners.size,0);const writes=h.counts().writes;
  h.retired[0](progress(request.id));request.resolve(fixture());await h.flush();
  assert.equal(h.counts().writes,writes);assert.equal(h.counts().staleWrites,0);assert.equal(h.counts().unsubscribed,1);
});

test('a query change rejects old progress even before cleanup and never lets an old result replace newer content',async()=>{
  const h=await harness(),old=h.requests[0],oldListener=[...h.listeners][0];
  h.setRange({...query.range,startTime:'09:06'});h.render(false);
  const writes=h.counts().writes;oldListener(progress(old.id));assert.equal(h.counts().writes,writes);
  h.render();const next=h.requests[1];assert.notEqual(next.id,old.id);assert.equal(h.listeners.size,1);
  h.emit(progress(old.id));assert.doesNotMatch(h.html(),/progressbar/);
  h.emit(progress(next.id));assert.match(h.html(),/progressbar/);
  next.resolve(fixture('new-query-model'));await h.flush();assert.match(h.html(),/new-query-model/);assert.doesNotMatch(h.html(),/local-usage-progress/);
  old.resolve(fixture('old-query-model'));await h.flush();assert.match(h.html(),/new-query-model/);assert.doesNotMatch(h.html(),/old-query-model/);
  assert.equal(h.counts().staleWrites,0);h.unmount();assert.equal(h.listeners.size,0);
});

test('site, URL and New API account changes retain the independent local read and details',async()=>{
  for(const change of ['site','url','profile-account','dashboard-account'] as const){
    const h=await harness(),current=h.requests[0];
    if(change==='site')h.app.preferences={...h.app.preferences,activeSiteId:'other'};
    if(change==='url')h.app.preferences={...h.app.preferences,sites:[{...h.app.preferences.sites[0],url:'https://other.invalid'}]};
    if(change==='profile-account')h.app.preferences={...h.app.preferences,sites:[{...h.app.preferences.sites[0],userId:2}]};
    if(change==='dashboard-account')h.app.dashboard=null;
    h.render();assert.equal(h.requests.length,1,change+' does not restart local scan');
    h.emit(progress(current.id));assert.match(h.html(),/progressbar/);
    current.resolve(fixture('local-account-independent'));await h.flush();assert.match(h.html(),/local-account-independent/);
    const list=h.sessionList();list.onOpen(list.sessions[0]);assert.ok(h.sessionDetail());
    h.app.preferences={...h.app.preferences,activeSiteId:'another-site'};h.render();assert.ok(h.sessionDetail());
    assert.equal(h.counts().network,0);h.unmount();assert.equal(h.listeners.size,0);assert.equal(h.counts().staleWrites,0);
  }
});

test('cached completion during invoke stays hidden; rescanning preserves old data while scanning',async()=>{
  const h=await harness();h.requests[0].resolve(fixture());await h.flush();
  assert.match(h.html(),/fixture-model/);assert.equal(h.listeners.size,0);
  h.onInvoke(request=>{h.emit(progress(request.id,'complete'));request.resolve(fixture('cached-model'));});
  h.button('重新扫描').onClick();h.render();assert.doesNotMatch(h.html(),/local-usage-progress/);
  await h.flush();assert.match(h.html(),/cached-model/);assert.equal(h.listeners.size,0);
  h.onInvoke(()=>{});h.setRange(7);h.render();
  assert.match(h.html(),/cached-model/);assert.ok(h.chart().data.some((row:any)=>row.tokens>0));assert.match(h.html(),/正在查找本机会话/);
  h.requests.at(-1)!.reject(new Error('active scan failed'));await h.flush();
  assert.match(h.html(),/cached-model/);assert.deepEqual(h.notices,['Error: active scan failed']);assert.doesNotMatch(h.html(),/local-usage-progress/);h.unmount();
});

test('local tool switching filters timestamped points into thirty buckets with no bridge or remote requests',async()=>{
  const h=await harness();h.requests[0].resolve(fixture());await h.flush();
  const all=h.chart().data;assert.equal(all.length,30);assert.equal(all[1].tokens,26);assert.equal(all[29].tokens,33);
  assert.equal(all[0].timestamp,resolveRange(query,now).start_timestamp,'local scan clock ignores stale site dashboard time');
  h.button('Codex').onClick();const codex=h.chart().data;assert.equal(codex[1].tokens,26);assert.equal(codex[29].tokens,0);
  h.button('Claude Code').onClick();const claude=h.chart().data;assert.equal(claude[1].tokens,0);assert.equal(claude[29].tokens,33);
  h.button('全部').onClick();assert.deepEqual(h.chart().data,all);assert.equal(h.requests.length,1);assert.equal(h.counts().network,0);
  assert.match(h.html(),/2026-10-01/);assert.equal(h.listeners.size,0);h.unmount();
});

test('the local source closes session details immediately on query/rescan/tool changes and disables opens on retained stale summaries',async()=>{
  for(const change of ['query','rescan','tool'] as const){
    const h=await harness();h.requests[0].resolve(fixture());await h.flush();
    const list=h.sessionList();assert.equal(list.stale,false);assert.equal(list.sessions.length,2);
    list.onOpen(list.sessions[0] as LocalSessionSummary);assert.ok(h.sessionDetail());assert.equal(h.sessionDetail()!.session.id,'codex-session');
    assert.notStrictEqual(h.sessionDetail()!.query,h.app.statisticsQuery,'detail locks a query snapshot');assert.equal(JSON.stringify(h.sessionDetail()!.query),JSON.stringify({...h.app.statisticsQuery as object,models:[],tokenIds:[]}));
    if(change==='query')h.setRange(1);
    if(change==='rescan')h.button('重新扫描').onClick();
    if(change==='tool')h.button('Claude Code').onClick();
    h.render(false);assert.equal(h.sessionDetail(false),undefined,change+' clears detail on render');h.render();
    if(change==='query' || change==='rescan'){assert.equal(h.sessionList().stale,true);assert.equal(h.sessionList().sessions.length,2,'retained summaries stay visible during the scan');}
    assert.equal(h.counts().network,0);h.unmount();assert.equal(h.listeners.size,0);
  }
});
