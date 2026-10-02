import test from 'node:test';
import assert from 'node:assert/strict';
import {build} from 'esbuild';
import {createRequire} from 'node:module';
import {runInNewContext} from 'node:vm';
import * as React from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import type {DashboardQuery,LocalSessionPage,LocalSessionRecord,LocalSessionSummary} from '../shared/types';

const bundle=build({
  stdin:{contents:"export {LocalSessionDetails,mergeSessionRecords} from './src/components/LocalSessionDetails'; export {LocalSessions} from './src/components/LocalSessions';",resolveDir:process.cwd(),loader:'tsx'},
  bundle:true,platform:'node',format:'cjs',write:false,external:['react','react/jsx-runtime','react-dom'],loader:{'.css':'empty','.svg':'text'},logLevel:'silent',
});
type Element=React.ReactElement<Record<string,any>>;
function elements(node:React.ReactNode):Element[]{return React.Children.toArray(node).flatMap(child=>React.isValidElement<Record<string,any>>(child) ? [child,...elements(child.props.children)] : []);}
function content(node:React.ReactNode):string{return React.Children.toArray(node).map(child=>React.isValidElement<Record<string,any>>(child) ? content(child.props.children) : String(child)).join('');}
function deferred<T>(){let resolve!:(value:T)=>void,reject!:(reason:unknown)=>void;const promise=new Promise<T>((yes,no)=>{resolve=yes;reject=no;});return {promise,resolve,reject};}
const timestamp=new Date(2026,9,1,9,5).getTime()/1000;
const summary=(id='session-codex',tool:LocalSessionSummary['tool']='codex'):LocalSessionSummary=>({id,tool,model:'summary-'+id,startedAt:timestamp,updatedAt:timestamp+60,inputTokens:11,outputTokens:7,cacheReadTokens:5,cacheWriteTokens:3,requests:2});
const record=(i:number,reasoning?:string):LocalSessionRecord=>({id:'record-'+i,created_at:timestamp+i,model:'model-'+i,inputTokens:11,outputTokens:7,cacheReadTokens:5,cacheWriteTokens:3,contextTokens:128000,...reasoning ? {reasoning} : {}});
const page=(items:LocalSessionRecord[],nextCursor?:string,scannedBytes=1024,totalBytes=4096):LocalSessionPage=>({items,nextCursor,scannedBytes,totalBytes});
type Request=ReturnType<typeof deferred<LocalSessionPage>> & {input:{sessionId:string;query:DashboardQuery;cursor?:string}};
async function harness(list=false){
  const requests:Request[]=[],opened:LocalSessionSummary[]=[];
  const bridge={localSessionDetails:(input:Request['input'])=>{const request={input,...deferred<LocalSessionPage>()};requests.push(request);return request.promise;}};
  type Effect={setup:()=>void|(()=>void);deps?:React.DependencyList;pending:boolean;cleanup?:()=>void};
  const slots:any[]=[],effects:Effect[]=[];let cursor=0,inComponent=false,mounted=true,writes=0,staleWrites=0;
  const hooks={...React,
    useMemo:<T,>(compute:()=>T,deps:React.DependencyList)=>inComponent ? compute() : React.useMemo(compute,deps),
    useRef:(initial:any)=>{if(!inComponent)return React.useRef(initial);const i=cursor++;if(!(i in slots))slots[i]={current:initial};return slots[i];},
    useState:(initial:any)=>{if(!inComponent)return React.useState(initial);const i=cursor++;if(!(i in slots))slots[i]=typeof initial==='function' ? initial() : initial;return [slots[i],(value:any)=>{writes++;if(!mounted)staleWrites++;slots[i]=typeof value==='function' ? value(slots[i]) : value;}];},
    useEffect:(setup:Effect['setup'],deps?:React.DependencyList)=>{
      if(!inComponent)return React.useEffect(setup,deps);const i=cursor++;
      if(!(i in slots)){const effect={setup,deps,pending:true};slots[i]=effect;effects.push(effect);}
      else{const effect=slots[i] as Effect;if(!deps || !effect.deps || deps.some((value,i)=>!Object.is(value,effect.deps![i]))){effect.setup=setup;effect.deps=deps;effect.pending=true;}}
    },
  };
  const module={exports:{} as Record<string,any>},nodeRequire=createRequire(import.meta.url);
  runInNewContext((await bundle).outputFiles[0].text,{module,exports:module.exports,structuredClone,window:{lumi:bridge},require:(name:string)=>name==='react' ? hooks : nodeRequire(name)});
  const {LocalSessionDetails,LocalSessions,mergeSessionRecords}=module.exports;
  let props:Record<string,any>=list ? {sessions:Array.from({length:65},(_,i)=>({...summary('s-'+i,i%2 ? 'claude' : 'codex'),updatedAt:timestamp+i})),tool:'all',scope:'list-scope',busy:false,stale:false,onOpen:(session:LocalSessionSummary)=>opened.push(session)}
    : {session:summary(),query:{range:7},accountKey:'account-1',onClose:()=>{}};
  function render(runEffects=true):Element{
    cursor=0;inComponent=true;let tree:Element;try{tree=(list ? LocalSessions : LocalSessionDetails)(props);}finally{inComponent=false;}
    if(runEffects)for(const effect of effects)if(effect.pending){effect.pending=false;effect.cleanup?.();const cleanup=effect.setup();effect.cleanup=typeof cleanup==='function' ? cleanup : undefined;}
    return tree;
  }
  function html(){return renderToStaticMarkup(render());}
  function rows(runEffects=true){return elements(render(runEffects)).filter(node=>node.type==='tr' && node.props.children && elements(node.props.children).some(child=>child.type==='td'));}
  function button(label:string){const found=elements(render()).find(node=>(node.type==='button' || typeof node.type==='function' && node.type.name==='Button') && content(node.props.children)===label);assert.ok(found,label+' exists');return found.props;}
  function update(patch:Record<string,any>,runEffects=true){props={...props,...patch};render(runEffects);}
  function unmount(){mounted=false;for(const effect of effects)effect.cleanup?.();}
  async function flush(){for(let i=0;i<6;i++)await Promise.resolve();}
  render();return {requests,opened,render,html,rows,button,update,unmount,flush,mergeSessionRecords,counts:()=>({writes,staleWrites})};
}

test('session summaries render twenty at a time, reset on scope/tool changes, and prevent stale detail opens',async()=>{
  const h=await harness(true);assert.equal(h.rows().length,20);assert.match(h.html(),/已显示 20 \/ 65 个会话/);
  h.button('查看用量').onClick();assert.equal(h.opened[0].id,'s-64','newest summary comes first');
  for(const count of [40,60,65]){h.button('再显示 20 条').onClick();assert.equal(h.rows().length,count);}
  assert.doesNotMatch(h.html(),/再显示 20 条/);assert.equal(h.requests.length,0);
  h.update({scope:'new-query'});assert.equal(h.rows().length,20);
  h.button('再显示 20 条').onClick();h.update({tool:'codex'});assert.equal(h.rows().length,20);assert.match(h.html(),/共 33 个匹配会话/);
  h.update({stale:true});assert.equal(h.button('查看用量').disabled,true);h.unmount();
});

test('details read the initial page, show real usage/time/reasoning and byte progress, and can continue through an empty page',async()=>{
  const h=await harness();assert.equal(h.requests.length,1);assert.equal(h.requests[0].input.sessionId,'session-codex');assert.equal(h.requests[0].input.cursor,undefined);
  assert.match(h.html(),/正在读取会话用量/);assert.doesNotMatch(h.html(),/model-1/);
  h.requests[0].resolve(page([record(1,'high')],'cursor-1'));await h.flush();
  assert.match(h.html(),/model-1/);assert.match(h.html(),/思考强度/);assert.match(h.html(),/high/);assert.match(h.html(),/2026\/10\/01 09:05:01/);assert.match(h.html(),/128.0K/);
  assert.match(h.html(),/已扫描 1 KB \/ 4 KB · 25%/);assert.match(h.html(),/aria-valuenow="25"/);
  const more=h.button('继续读取');more.onClick();more.onClick();assert.equal(h.requests.length,2,'duplicate clicks do not read twice');assert.equal(h.requests[1].input.cursor,'cursor-1');assert.equal(h.button('继续读取').busy,true);
  h.requests[1].resolve(page([],'cursor-2',2048));await h.flush();assert.equal(h.rows().length,1);assert.match(h.html(),/50%/);
  h.button('继续读取').onClick();assert.equal(h.requests[2].input.cursor,'cursor-2');
  h.requests[2].resolve(page([record(2)],undefined,4096));await h.flush();assert.equal(h.rows().length,2);assert.doesNotMatch(h.html(),/继续读取/);h.unmount();
  const empty=await harness();empty.requests[0].resolve(page([],'empty-next'));await empty.flush();assert.match(empty.html(),/本页没有匹配的调用/);assert.ok(empty.button('继续读取'));empty.unmount();
});

test('paged records retain only the newest two hundred entries, deduplicate and announce the bounded window',async()=>{
  const h=await harness();
  for(let i=0;i<5;i++){
    h.requests[i].resolve(page(Array.from({length:50},(_,j)=>record(i*50+j)),'cursor-'+(i+1),(i+1)*1024,8192));await h.flush();
    assert.equal(h.rows().length,Math.min(200,(i+1)*50));if(i<4)h.button('继续读取').onClick();
  }
  assert.match(h.html(),/仅显示最近 200 条调用/);assert.doesNotMatch(h.html(),/>model-0<|>model-49</);assert.match(h.html(),/>model-50</);assert.match(h.html(),/>model-249</);
  h.button('继续读取').onClick();h.requests[5].resolve(page([record(249,'xhigh'),record(250)],undefined,8192,8192));await h.flush();
  assert.equal(h.rows().length,200);assert.match(h.html(),/xhigh/);assert.doesNotMatch(h.html(),/>model-50</);assert.match(h.html(),/>model-250</);
  const merged=h.mergeSessionRecords([record(4),record(2)],[record(3),record(2,'medium')]);assert.deepEqual(Array.from(merged.items,(item:LocalSessionRecord)=>item.id),['record-2','record-3','record-4']);assert.equal(merged.items[0].reasoning,'medium');h.unmount();
});

test('switching session, query or account clears old records immediately and isolates late results/errors before cleanup',async()=>{
  for(const change of ['session','query','account'] as const){
    const h=await harness();h.requests[0].resolve(page([record(1)],'old-next'));await h.flush();h.button('继续读取').onClick();const old=h.requests[1];
    const patch=change==='session' ? {session:summary('session-new')} : change==='query' ? {query:{range:1,models:['model-2']}} : {accountKey:'account-new'};
    h.update(patch,false);assert.equal(h.rows(false).length,0);const writes=h.counts().writes;
    if(change==='account')old.reject(new Error('late account error'));else old.resolve(page([record(999)]));await h.flush();assert.equal(h.counts().writes,writes,change+' late write before cleanup');
    h.render();const current=h.requests[2];assert.equal(current.input.cursor,undefined);current.resolve(page([record(2)]));await h.flush();
    assert.match(h.html(),/>model-2</);assert.doesNotMatch(h.html(),/>model-1<|model-999|late account error/);h.unmount();assert.equal(h.counts().staleWrites,0);
  }
});

test('detail page failures preserve existing rows and retry the failed cursor, while unmount ignores delayed work',async()=>{
  const h=await harness();h.requests[0].reject(new Error('initial read failed'));await h.flush();assert.match(h.html(),/role="alert"/);assert.match(h.html(),/initial read failed/);
  h.button('重试').onClick();assert.equal(h.requests[1].input.cursor,undefined);h.requests[1].resolve(page([record(1)],'next'));await h.flush();
  h.button('继续读取').onClick();h.requests[2].reject(new Error('page read failed'));await h.flush();assert.equal(h.rows().length,1);assert.match(h.html(),/page read failed/);
  h.button('重试').onClick();assert.equal(h.requests[3].input.cursor,'next');h.unmount();const writes=h.counts().writes;
  h.requests[3].resolve(page([record(2)]));await h.flush();assert.equal(h.counts().writes,writes);assert.equal(h.counts().staleWrites,0);
});
