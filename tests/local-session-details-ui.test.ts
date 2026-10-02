import test from 'node:test';
import assert from 'node:assert/strict';
import {build} from 'esbuild';
import {createRequire} from 'node:module';
import {runInNewContext} from 'node:vm';
import * as React from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import type {LocalSessionContentPage,LocalSessionContentQuery,LocalSessionEvent,LocalSessionLoad,LocalSessionProgress,LocalSessionRawPage,LocalSessionRawQuery,LocalSessionRecord,LocalSessionRecordsPage,LocalSessionRecordsQuery,LocalSessionSnapshot,LocalSessionSummary} from '../shared/types';
import type {useLocalSessionDetails} from '../src/components/LocalSessionDetails';

const bundle=build({
  stdin:{contents:"export {LocalSessionDetails,useLocalSessionDetails} from './src/components/LocalSessionDetails'; export {LocalSessions} from './src/components/LocalSessions';",resolveDir:process.cwd(),loader:'tsx'},
  bundle:true,platform:'node',format:'cjs',write:false,external:['react','react/jsx-runtime','react-dom'],loader:{'.css':'empty','.svg':'text'},logLevel:'silent',
});
type Element=React.ReactElement<Record<string,any>>;
function elements(node:React.ReactNode):Element[]{return React.Children.toArray(node).flatMap(child=>React.isValidElement<Record<string,any>>(child) ? [child,...elements(child.props.children)] : []);}
function content(node:React.ReactNode):string{return React.Children.toArray(node).map(child=>React.isValidElement<Record<string,any>>(child) ? content(child.props.children) : String(child)).join('');}
function deferred<T>(){let resolve!:(value:T)=>void,reject!:(reason:unknown)=>void;const promise=new Promise<T>((yes,no)=>{resolve=yes;reject=no;});return {promise,resolve,reject};}
type Request<Input,Output>=ReturnType<typeof deferred<Output>> & {input:Input};
const timestamp=1790816700;
const summary=(id='session-codex',tool:LocalSessionSummary['tool']='codex'):LocalSessionSummary=>({id,tool,model:'summary-'+id,startedAt:timestamp,updatedAt:timestamp+60,inputTokens:11,outputTokens:7,cacheReadTokens:5,cacheWriteTokens:3,requests:2,metadata:{title:'标题 '+id,cwd:'E:\\fixture\\project',sessionKey:'key-'+id}});
const record=(i:number):LocalSessionRecord=>({id:'record-'+i,created_at:timestamp+i,model:'model-'+i,inputTokens:11,outputTokens:7,cacheReadTokens:5,cacheWriteTokens:3,contextTokens:128000,reasoning:'high'});
const snapshot=(id='snapshot-1',total=251,eventTotal=43):LocalSessionSnapshot=>({snapshotId:id,total,eventTotal,totalBytes:8192,metadata:{title:'官方索引标题',project:'fixture project',gitBranch:'fixture-branch',version:'1.0',source:'fixture',firstPrompt:'首条用户消息 <script>unsafe</script>'},warnings:['缺损记录 <img src=x onerror=unsafe()>']});
const recordsPage=(page=1,total=251):LocalSessionRecordsPage=>({items:Array.from({length:Math.max(0,Math.min(50,total-(page-1)*50))},(_,i)=>record(total-1-(page-1)*50-i)),page,pageSize:50,total});
const event=(i:number):LocalSessionEvent=>({id:'event-'+i,createdAt:timestamp+i,role:(['user','assistant','tool','system','event'] as const)[i%5],kind:i%5===4 ? 'usage / turn_context' : 'message',text:'event text '+i,details:[{label:'真实字段',value:'value-'+i}],...i%5===2 ? {toolName:'fixture_tool',toolCallId:'call-'+i} : {}});
const contentPage=(page=1,total=43,association:LocalSessionContentPage['association']='session'):LocalSessionContentPage=>({items:Array.from({length:Math.max(0,Math.min(20,total-(page-1)*20))},(_,i)=>event((page-1)*20+i)),page,pageSize:20,total,association});

async function harness(mode:'details'|'list'|'hook'='details'){
  const loads:Request<LocalSessionLoad,LocalSessionSnapshot>[]=[],records:Request<LocalSessionRecordsQuery,LocalSessionRecordsPage>[]=[],contents:Request<LocalSessionContentQuery,LocalSessionContentPage>[]=[],raws:Request<LocalSessionRawQuery,LocalSessionRawPage>[]=[];
  const releases:{requestId?:string;snapshotId?:string}[]=[],opened:LocalSessionSummary[]=[],order:string[]=[],listeners=new Set<(progress:LocalSessionProgress)=>void>(),savedListeners:((progress:LocalSessionProgress)=>void)[]=[];
  function request<I,O>(queue:Request<I,O>[],input:I){const pending={input,...deferred<O>()};queue.push(pending);return pending.promise;}
  const bridge={
    onLocalSessionProgress:(listener:(progress:LocalSessionProgress)=>void)=>{order.push('subscribe');listeners.add(listener);savedListeners.push(listener);return()=>{order.push('unsubscribe');listeners.delete(listener);};},
    loadLocalSession:(input:LocalSessionLoad)=>{order.push('load');for(const listener of listeners)listener({requestId:input.requestId,phase:'read',bytesRead:1024,totalBytes:8192,calls:0});return request(loads,input);},
    localSessionRecords:(input:LocalSessionRecordsQuery)=>request(records,input),
    localSessionContent:(input:LocalSessionContentQuery)=>request(contents,input),
    localSessionRaw:(input:LocalSessionRawQuery)=>request(raws,input),
    releaseLocalSession:async(input:{requestId?:string;snapshotId?:string})=>{releases.push(input);},
    localSessionDetails:()=>{throw new Error('Legacy incremental scanner must not be called');},
  };
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
  runInNewContext((await bundle).outputFiles[0].text,{module,exports:module.exports,structuredClone,crypto:globalThis.crypto,window:{lumi:bridge},require:(name:string)=>name==='react' ? hooks : nodeRequire(name)});
  const {LocalSessionDetails,LocalSessions,useLocalSessionDetails}=module.exports;
  let props:Record<string,any>=mode==='list' ? {sessions:Array.from({length:65},(_,i)=>({...summary('s-'+i,i%2 ? 'claude' : 'codex'),updatedAt:timestamp+i})),tool:'all',scope:'list-scope',busy:false,stale:false,onOpen:(session:LocalSessionSummary)=>opened.push(session)}
    : {session:summary(),query:{range:7},accountKey:'account-1',onClose:()=>{}};
  function render(runEffects=true):any{
    cursor=0;inComponent=true;let tree:any;try{tree=mode==='hook' ? useLocalSessionDetails(props.session.id,props.query,props.accountKey) : (mode==='list' ? LocalSessions : LocalSessionDetails)(props);}finally{inComponent=false;}
    if(runEffects)for(const effect of effects)if(effect.pending){effect.pending=false;effect.cleanup?.();const cleanup=effect.setup();effect.cleanup=typeof cleanup==='function' ? cleanup : undefined;}
    return tree;
  }
  const html=()=>renderToStaticMarkup(render());
  const rows=(runEffects=true)=>elements(render(runEffects)).filter(node=>node.type==='tr' && elements(node.props.children).some(child=>child.type==='td'));
  function button(label:string){const found=elements(render()).find(node=>(node.type==='button' || typeof node.type==='function' && node.type.name==='Button') && content(node.props.children)===label);assert.ok(found,label+' exists');return found.props;}
  function update(patch:Record<string,any>,runEffects=true){props={...props,...patch};render(runEffects);}
  function unmount(){mounted=false;for(const effect of effects)effect.cleanup?.();}
  async function flush(){for(let i=0;i<8;i++)await Promise.resolve();}
  async function loaded(total=251,eventTotal=43){loads[loads.length-1].resolve(snapshot('snapshot-'+loads.length,total,eventTotal));await flush();records[records.length-1].resolve(recordsPage(1,total));await flush();}
  render();return {loads,records,contents,raws,releases,opened,order,listeners,savedListeners,render,view:(runEffects=true)=>render(runEffects) as ReturnType<typeof useLocalSessionDetails>,html,rows,button,update,unmount,flush,loaded,counts:()=>({writes,staleWrites})};
}

test('summary titles, projects and session identifiers stay distinguishable, safe, and reachable in twenty-row batches',async()=>{
  const h=await harness('list');assert.equal(h.rows().length,20);assert.match(h.html(),/已显示 20 \/ 65 个会话/);
  assert.match(h.html(),/标题 s-64/);assert.match(h.html(),/key-s-64/);assert.match(h.html(),/fixture/);
  h.button('查看详情').onClick();assert.equal(h.opened[0].id,'s-64');
  for(const count of [40,60,65]){h.button('再显示 20 条').onClick();assert.equal(h.rows().length,count);}
  assert.doesNotMatch(h.html(),/再显示 20 条/);assert.equal(h.loads.length,0);
  h.update({scope:'new-query'});assert.equal(h.rows().length,20);
  h.button('再显示 20 条').onClick();h.update({tool:'codex'});assert.equal(h.rows().length,20);assert.match(h.html(),/共 33 个匹配会话/);
  h.update({stale:true});assert.equal(h.button('查看详情').disabled,true);h.button('查看详情').onClick();assert.equal(h.opened.length,1);
  h.update({tool:'all',sessions:[{...summary('fallback'),metadata:{firstPrompt:'<script>unsafe()</script>\nsecond line',cwd:'fixture-cwd'}},{...summary('unnamed'),metadata:{}}]});
  assert.match(h.html(),/&lt;script&gt;unsafe/);assert.doesNotMatch(h.html(),/<script>|second line/);assert.match(h.html(),/未命名会话/);assert.match(h.html(),/会话：unnamed/);h.unmount();
});

test('one automatic full load subscribes before invoke, tracks byte progress independently of calls, then uses the fixed snapshot',async()=>{
  const h=await harness();assert.deepEqual(h.order,['subscribe','load']);assert.equal(h.loads.length,1);assert.equal(h.loads[0].input.sessionId,'session-codex');assert.ok(h.loads[0].input.requestId);
  assert.match(h.html(),/正在完整载入会话/);assert.match(h.html(),/12.5%/);assert.match(h.html(),/0 条调用/);assert.equal(h.records.length,0);
  const emit=h.savedListeners[0],requestId=h.loads[0].input.requestId;
  const writes=h.counts().writes;emit({requestId:'other',phase:'read',bytesRead:4096,totalBytes:8192,calls:19});assert.equal(h.counts().writes,writes);
  emit({requestId,phase:'read',bytesRead:4096,totalBytes:8192,calls:2});assert.match(h.html(),/aria-valuenow="50"/);
  emit({requestId,phase:'complete',bytesRead:8192,totalBytes:8192,calls:251});assert.equal(h.records.length,0,'complete progress alone does not expose an unfinished snapshot');
  await h.loaded();assert.equal(h.records.length,1);assert.deepEqual({...h.records[0].input},{snapshotId:'snapshot-1',page:1,pageSize:50});assert.equal(h.listeners.size,0);
  const html=h.html();assert.match(html,/官方索引标题/);assert.match(html,/fixture project/);assert.match(html,/key-session-codex/);assert.match(html,/fixture-branch/);assert.match(html,/会话已完整载入 · 251 条调用 · 43 条内容/);
  assert.match(html,/思考强度/);assert.match(html,/high/);assert.match(html,/128.0K/);assert.match(html,/&lt;script&gt;unsafe/);assert.match(html,/&lt;img/);assert.doesNotMatch(html,/<script>|<img src=x|继续读取|最近 200/);
  for(let i=0;i<5;i++)h.render();assert.equal(h.loads.length,1);
  h.unmount();assert.ok(h.releases.some(input=>input.requestId===requestId && input.snapshotId==='snapshot-1'));
});

test('all 251 calls are reachable in descending pages without a display window cap or another scan',async()=>{
  const h=await harness();await h.loaded();const seen=new Set<string>();
  for(let page=1;page<=6;page++){
    if(page>1){h.button('下一页').onClick();assert.equal(h.records.at(-1)!.input.page,page);assert.equal(h.button('下一页').disabled,true);assert.equal(h.rows().length,0);h.records.at(-1)!.resolve(recordsPage(page));await h.flush();}
    const rows=h.rows();assert.equal(rows.length,page===6 ? 1 : 50);for(const row of rows){const model=content(row.props.children).match(/model-\d+/)![0];seen.add(model);}
  }
  assert.equal(seen.size,251);assert.match(h.html(),/model-0/);assert.equal(h.button('下一页').disabled,true);
  h.button('首页').onClick();h.records.at(-1)!.resolve(recordsPage(1));await h.flush();assert.match(h.html(),/model-250/);assert.doesNotMatch(h.html(),/>model-0</);
  h.button('末页').onClick();assert.equal(h.records.at(-1)!.input.page,6);h.records.at(-1)!.reject(new Error('last page failed'));await h.flush();assert.match(h.html(),/last page failed/);
  h.button('重试').onClick();assert.equal(h.records.at(-1)!.input.page,6);assert.equal(h.records.at(-1)!.input.snapshotId,'snapshot-1');h.records.at(-1)!.resolve(recordsPage(6));await h.flush();
  assert.match(h.html(),/第 6 \/ 6 页/);assert.equal(h.loads.length,1);h.unmount();
});

test('full content includes messages, tools and non-call events in twenty-event pages even when there are no matching calls',async()=>{
  const h=await harness();await h.loaded(0);assert.match(h.html(),/没有模型调用记录/);h.button('完整会话内容').onClick();
  assert.deepEqual({...h.contents[0].input},{snapshotId:'snapshot-1',page:1,pageSize:20});
  h.contents[0].resolve(contentPage());await h.flush();const html=h.html();
  for(const text of ['用户消息','助手回复','fixture_tool','call-2','系统','usage / turn_context','真实字段'])assert.ok(html.includes(text),text);
  assert.match(html,/不受调用记录的时间或模型筛选限制/);
  for(const page of [2,3]){h.button('下一页').onClick();assert.equal(h.contents.at(-1)!.input.page,page);assert.equal(h.contents.at(-1)!.input.pageSize,20);h.contents.at(-1)!.resolve(contentPage(page));await h.flush();}
  assert.match(h.html(),/event text 42/);assert.doesNotMatch(h.html(),/event text 0</);assert.equal(h.button('下一页').disabled,true);
  h.button('调用记录').onClick();assert.match(h.html(),/没有模型调用记录/);assert.equal(h.loads.length,1);h.unmount();
});

test('related content labels turn/message/unavailable associations honestly and returning to calls preserves the current page',async()=>{
  const h=await harness();await h.loaded();h.button('末页').onClick();h.records.at(-1)!.resolve(recordsPage(6));await h.flush();
  for(const association of ['turn','message','unavailable'] as const){
    h.button('查看相关内容').onClick();assert.equal(h.contents.at(-1)!.input.recordId,'record-0');
    h.contents.at(-1)!.resolve(contentPage(1,association==='unavailable' ? 0 : 23,association));await h.flush();
    assert.match(h.html(),association==='turn' ? /同轮上下文.*无法精确对应这一次模型请求/ : association==='message' ? /消息关联/ : /无法关联这条调用/);
    if(association==='turn'){
      h.button('下一页').onClick();h.contents.at(-1)!.reject(new Error('content page failed'));await h.flush();h.button('重试').onClick();
      assert.equal(h.contents.at(-1)!.input.recordId,'record-0');assert.equal(h.contents.at(-1)!.input.page,2);h.contents.at(-1)!.resolve(contentPage(2,23,'turn'));await h.flush();
      h.button('查看完整会话').onClick();assert.equal(h.contents.at(-1)!.input.recordId,undefined);h.contents.at(-1)!.resolve(contentPage());await h.flush();
    }
    h.button('调用记录').onClick();assert.match(h.html(),/第 6 \/ 6 页/);assert.match(h.html(),/model-0/);assert.equal(h.records.length,2);
  }
  assert.equal(h.loads.length,1);h.unmount();
});

test('raw previews are escaped, replace each 64KiB chunk, retry offsets, navigate backwards, and invalidate hidden requests',async()=>{
  const h=await harness();await h.loaded(1);h.button('完整会话内容').onClick();h.contents[0].resolve({...contentPage(1,1),items:[{...event(0),text:'<img src=x onerror=unsafe()>',truncated:true,rawBytes:131072,details:[{label:'<script>',value:'<svg onload=unsafe()>'}]}]});await h.flush();
  assert.match(h.html(),/&lt;img src/);assert.match(h.html(),/&lt;svg/);assert.match(h.html(),/内容预览已截断/);
  const rawButton='查看原始记录 · 128 KB';h.button(rawButton).onClick();assert.deepEqual({...h.raws[0].input},{snapshotId:'snapshot-1',eventId:'event-0',offset:0});
  const first='<script>globalThis.unsafe=1</script>'+ 'a'.repeat(65500);h.raws[0].resolve({text:first,offset:0,nextOffset:65536,totalBytes:131072});await h.flush();
  assert.match(h.html(),/&lt;script&gt;globalThis.unsafe/);assert.doesNotMatch(h.html(),/<script>|<svg onload|<img src=x/);
  h.button('下一块').onClick();assert.equal(h.raws[1].input.offset,65536);assert.doesNotMatch(h.html(),/globalThis.unsafe/);
  h.raws[1].reject(new Error('raw failed'));await h.flush();h.button('重试').onClick();assert.equal(h.raws[2].input.offset,65536);
  h.raws[2].resolve({text:'second block',offset:65536,totalBytes:131072});await h.flush();assert.match(h.html(),/second block/);assert.doesNotMatch(h.html(),/globalThis.unsafe/);assert.equal(h.button('下一块').disabled,true);
  h.button('上一块').onClick();assert.equal(h.raws[3].input.offset,0);h.button('收起原始记录').onClick();const writes=h.counts().writes;h.raws[3].resolve({text:'late hidden raw',offset:0,totalBytes:131072});await h.flush();assert.equal(h.counts().writes,writes);assert.doesNotMatch(h.html(),/late hidden raw/);
  h.button(rawButton).onClick();const old=h.raws.at(-1)!;h.button('调用记录').onClick();old.reject(new Error('late tab raw'));await h.flush();assert.doesNotMatch(h.html(),/late tab raw/);h.unmount();
});

test('invalid, non-finite and out-of-range timestamps render a fallback without invalid datetime attributes',async()=>{
  const list=await harness('list');
  list.update({sessions:[{...summary('nan'),updatedAt:NaN},{...summary('infinity'),updatedAt:Infinity},{...summary('out-of-range'),updatedAt:1e100}]});
  assert.equal((list.html().match(/时间未知/g) || []).length,3);assert.doesNotMatch(list.html(),/dateTime=|Invalid Date/);list.unmount();
  const h=await harness();h.update({session:{...summary(),startedAt:NaN,updatedAt:1e100}});await h.loaded(1);
  h.button('完整会话内容').onClick();h.contents[0].resolve({...contentPage(1,3),items:[NaN,Infinity,1e100].map((createdAt,i)=>({...event(i),createdAt}))});await h.flush();
  assert.match(h.html(),/开始 时间未知 · 最近调用 时间未知/);assert.doesNotMatch(h.html(),/dateTime=|Invalid Date/);assert.equal((h.html().match(/时间未知/g) || []).length,5);h.unmount();
});

test('arbitrarily many variable UTF8-sized raw pages keep one chunk and one previous offset, with an exact backward step and return to start',async()=>{
  const h=await harness('hook');await h.loaded(1);h.view().openRaw('event-0');let offset=0,previousOffset=0;
  for(let i=0;i<70;i++){
    const nextOffset=offset+65536-i%4;
    h.raws.at(-1)!.resolve({text:'UTF8 中文🙂 block '+i,offset,nextOffset,totalBytes:10_000_000});await h.flush();
    const raw=h.view().raw!;assert.equal(raw.chunk!.text,'UTF8 中文🙂 block '+i);assert.equal(raw.previousOffset,i ? previousOffset : undefined);
    assert.ok(!Object.values(raw).some(Array.isArray),'No accumulating raw offset history');
    if(i<69){h.view().nextRaw();previousOffset=offset;offset=nextOffset;}
  }
  h.view().previousRaw();assert.equal(h.raws.at(-1)!.input.offset,previousOffset);
  h.raws.at(-1)!.resolve({text:'previous block',offset:previousOffset,nextOffset:offset,totalBytes:10_000_000});await h.flush();
  h.view().firstRaw();assert.equal(h.raws.at(-1)!.input.offset,0);h.raws.at(-1)!.resolve({text:'first block',offset:0,nextOffset:65536,totalBytes:10_000_000});await h.flush();assert.equal(h.view().raw!.previousOffset,undefined);h.unmount();
});

test('session/query/account changes hide old data before effect cleanup and release late snapshots without issuing pages',async()=>{
  for(const change of ['session','query','account'] as const){
    const h=await harness('hook'),old=h.loads[0],emit=h.savedListeners[0];
    const patch=change==='session' ? {session:summary('session-new')} : change==='query' ? {query:{range:1,models:['new-model']}} : {accountKey:'account-new'};
    h.update(patch,false);assert.equal(h.view(false).snapshot,null);const writes=h.counts().writes;
    emit({requestId:old.input.requestId,phase:'complete',bytesRead:8192,totalBytes:8192,calls:999});old.resolve(snapshot('late-'+change));await h.flush();assert.equal(h.counts().writes,writes);
    assert.ok(h.releases.some(input=>input.snapshotId==='late-'+change));assert.equal(h.records.length,0);assert.equal(h.loads.length,1);h.render();assert.equal(h.loads.length,2);
    assert.ok(h.releases.some(input=>input.requestId===old.input.requestId));assert.notEqual(h.loads[1].input.requestId,old.input.requestId);
    await h.loaded(1);assert.equal(h.view().records.items[0].id,'record-0');h.unmount();assert.equal(h.counts().staleWrites,0);
  }
});

test('late page/content/raw results and errors are isolated across scope changes, tabs, associations and newer page requests',async()=>{
  const h=await harness('hook');await h.loaded();
  h.view().setRecordPage(2);const older=h.records.at(-1)!;h.view().setRecordPage(3);const newer=h.records.at(-1)!;
  newer.resolve(recordsPage(3));await h.flush();older.resolve(recordsPage(2));await h.flush();assert.equal(h.view().records.page,3);
  h.view().showRelated(record(1));const related=h.contents.at(-1)!;h.view().showContent();const full=h.contents.at(-1)!;
  full.resolve(contentPage());await h.flush();related.reject(new Error('late association'));await h.flush();assert.equal(h.view().record,null);assert.equal(h.view().content.error,'');
  h.view().openRaw('event-0');const firstRaw=h.raws.at(-1)!;h.view().openRaw('event-1');const secondRaw=h.raws.at(-1)!;
  secondRaw.resolve({text:'current raw',offset:0,totalBytes:10});await h.flush();firstRaw.resolve({text:'stale raw',offset:0,totalBytes:10});await h.flush();assert.equal(h.view().raw!.chunk!.text,'current raw');
  h.view().setContentPage(2);const tabRequest=h.contents.at(-1)!;h.view().showRecords();tabRequest.resolve(contentPage(2));await h.flush();assert.equal(h.view().tab,'records');assert.equal(h.view().content.items.length,0);
  h.view().setRecordPage(4);const staleRecords=h.records.at(-1)!;h.view().showContent();const staleContent=h.contents.at(-1)!;h.view().openRaw('event-2');const staleRaw=h.raws.at(-1)!;
  h.update({accountKey:'new-account'},false);const writes=h.counts().writes;
  staleRecords.reject(new Error('late records'));staleContent.resolve(contentPage(3));staleRaw.reject(new Error('late raw'));await h.flush();assert.equal(h.counts().writes,writes);assert.equal(h.view().snapshot,null);
  h.unmount();h.loads.at(-1)!.resolve(snapshot('after-unmount'));await h.flush();assert.ok(h.releases.some(input=>input.snapshotId==='after-unmount'));assert.equal(h.counts().staleWrites,0);
});

test('cancel, retry, close and unmount cancel the request and release both existing and late snapshots',async()=>{
  const h=await harness();const first=h.loads[0];h.button('取消载入').onClick();assert.match(h.html(),/已取消会话载入/);assert.equal(h.listeners.size,0);assert.ok(h.releases.some(input=>input.requestId===first.input.requestId));
  first.resolve(snapshot('canceled-snapshot'));await h.flush();assert.equal(h.records.length,0);assert.ok(h.releases.some(input=>input.snapshotId==='canceled-snapshot'));
  h.button('重新载入').onClick();assert.equal(h.loads.length,2);h.loads[1].reject(new Error('load failed'));await h.flush();assert.match(h.html(),/load failed/);assert.equal(h.listeners.size,0);
  h.button('重试').onClick();await h.loaded(1);h.button('完整会话内容').onClick();const pending=h.contents.at(-1)!;
  h.button('关闭').onClick();assert.ok(h.releases.some(input=>input.snapshotId==='snapshot-3'));const writes=h.counts().writes;pending.resolve(contentPage());await h.flush();assert.equal(h.counts().writes,writes);h.unmount();
  const late=await harness('hook'),actions=late.view(),load=late.loads[0];late.unmount();const before=late.counts().writes;actions.retryLoad();actions.showContent();actions.openRaw('event-0');
  load.resolve(snapshot('unmounted-snapshot'));await late.flush();assert.equal(late.loads.length,1);assert.equal(late.counts().writes,before);assert.equal(late.counts().staleWrites,0);assert.ok(late.releases.some(input=>input.snapshotId==='unmounted-snapshot'));
});
