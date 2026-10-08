import test from 'node:test';
import assert from 'node:assert/strict';
import {build} from 'esbuild';
import {createRequire} from 'node:module';
import {runInNewContext} from 'node:vm';
import {existsSync} from 'node:fs';
import {mkdir,mkdtemp,readFile,writeFile,rm} from 'node:fs/promises';
import {spawn} from 'node:child_process';
import path from 'node:path';
import * as React from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import type {WidgetAction,WidgetBridge,WidgetModel,WidgetState} from '../shared/widget';

// Hook tests bundle the actual renderer in memory with controlled animation promises.
// The Chromium case uses a hidden sandboxed page. All bridges and profiles are fixtures.
const bundle=build({entryPoints:['src/widget.tsx'],bundle:true,platform:'node',format:'cjs',write:false,
  external:['react','react/jsx-runtime','react-dom/client','lucide-react'],loader:{'.css':'empty','.svg':'text'},logLevel:'silent'});
function deferred<T>() {
  let resolve!:(value:T)=>void,reject!:(error:unknown)=>void;
  const promise=new Promise<T>((yes,no)=>{resolve=yes;reject=no;});
  return {promise,resolve,reject};
}
const model=(name:string,patch:Partial<WidgetModel>={}):WidgetModel=>({name,cost:'$0.0123',requests:'2',input:'1.2K',output:'240',cacheRead:'—',cacheWrite:'0',...patch});
const state=(patch:Partial<WidgetState>={}):WidgetState=>({phase:'ready',enabled:true,siteName:'隔离测试站点',balance:'$23.45',cost:'$0.0123',minuteLabel:'10/02 09:41',historical:false,
  models:[model('gpt-6'),model('claude-opus-4.6')],message:'上一分钟',updatedAt:1790905320000,viewKey:'isolated-account',dataKey:'minute-1',theme:'light',animation:'none',...patch});
type Effect={deps?:React.DependencyList;setup:()=>void|(()=>void);cleanup?:()=>void;dirty:boolean;layout:boolean};
type Store={slots:any[];mounted:boolean};
type AnimationRecord={frames:Keyframe[];options:KeyframeAnimationOptions;finished:Promise<void>;cancelled:boolean;cancel():void;finish():void};
type Native={props:Record<string,any>;animations:AnimationRecord[];animate(frames:Keyframe[],options:KeyframeAnimationOptions):AnimationRecord};
const equalDeps=(a?:React.DependencyList,b?:React.DependencyList)=>!!a && !!b && a.length===b.length && a.every((value,index)=>Object.is(value,b[index]));

async function harness(options:{missingBridge?:boolean;reduced?:boolean;subscribeState?:WidgetState}={}) {
  const snapshot=deferred<WidgetState>(),listeners=new Set<(next:WidgetState)=>void>(),mediaListeners=new Set<()=>void>();
  const actions:WidgetAction[]=[],events:string[]=[],stores=new Map<string,Store>(),nodes=new Map<string,Native>();
  let actionHandler:WidgetBridge['action']=async()=>{},owner:Store,cursor=0,dirty=false,staleWrites=0,tree:React.ReactNode,nativeOrder:Native[]=[];
  const media={matches:!!options.reduced,addEventListener:(_event:string,fn:()=>void)=>mediaListeners.add(fn),removeEventListener:(_event:string,fn:()=>void)=>mediaListeners.delete(fn)};
  const bridge:WidgetBridge={snapshot:()=>{events.push('snapshot');return snapshot.promise;},action:event=>{actions.push(event);return actionHandler(event);},
    onState:fn=>{events.push('subscribe');listeners.add(fn);if(options.subscribeState)fn(options.subscribeState);return ()=>listeners.delete(fn);}};
  const nextSlot=(initial:()=>any)=>{const index=cursor++;if(!(index in owner.slots))owner.slots[index]=initial();return index;};
  const effect=(layout:boolean,setup:Effect['setup'],deps?:React.DependencyList)=>{
    const index=nextSlot(()=>({setup,deps,dirty:true,layout} satisfies Effect)),slot=owner.slots[index] as Effect;
    if(!equalDeps(slot.deps,deps)){slot.setup=setup;slot.deps=deps;slot.dirty=true;}
  };
  const hooks={...React,
    useState:(initial:any)=>{const store=owner,index=nextSlot(()=>typeof initial==='function' ? initial() : initial);return [store.slots[index],(value:any)=>{
      if(!store.mounted){staleWrites++;return;}const next=typeof value==='function' ? value(store.slots[index]) : value;
      if(!Object.is(next,store.slots[index])){store.slots[index]=next;dirty=true;}
    }];},
    useRef:(initial:any)=>owner.slots[nextSlot(()=>({current:initial}))],
    useEffect:(setup:Effect['setup'],deps?:React.DependencyList)=>effect(false,setup,deps),
    useLayoutEffect:(setup:Effect['setup'],deps?:React.DependencyList)=>effect(true,setup,deps),
    useMemo:(compute:()=>unknown,deps:React.DependencyList)=>{const index=nextSlot(()=>({value:compute(),deps}));let slot=owner.slots[index];if(!equalDeps(slot.deps,deps))slot=owner.slots[index]={value:compute(),deps};return slot.value;},
    useId:()=>owner.slots[nextSlot(()=>':fixture-'+stores.size+'-'+cursor+':')],
  };
  const module={exports:{} as {WidgetApp:()=>React.ReactNode}},nodeRequire=createRequire(import.meta.url);
  const icon=()=>React.createElement('svg',{'aria-hidden':true});
  const windowMock={lumiWidget:options.missingBridge ? undefined : bridge,matchMedia:()=>media};
  for(const key of ['lumi','lumiTray'])Object.defineProperty(windowMock,key,{get(){throw new Error('Widget must use only its narrow bridge');}});
  runInNewContext((await bundle).outputFiles[0].text,{module,exports:module.exports,window:windowMock,document:{getElementById:()=>null,documentElement:{dataset:{}}},
    require:(name:string)=>name==='react' ? hooks : name==='react-dom/client' ? {createRoot:()=>{throw new Error('Unexpected real root');}} : name==='lucide-react' ? new Proxy({},{get:()=>icon}) : nodeRequire(name)});
  const cleanup=(store:Store)=>{for(const slot of store.slots)if(slot && typeof slot.setup==='function')slot.cleanup?.();store.mounted=false;};
  function render() {
    for(let pass=0;pass<10;pass++){
      dirty=false;nativeOrder=[];const usedStores=new Set<string>(),usedNodes=new Set<string>();
      function visit(value:React.ReactNode,path:string):React.ReactNode {
        if(!React.isValidElement<Record<string,any>>(value))return value;
        if(typeof value.type==='function'){
          const id=path+'/'+value.type.name,store=stores.get(id) || {slots:[],mounted:true};stores.set(id,store);usedStores.add(id);owner=store;cursor=0;
          return visit((value.type as (props:any)=>React.ReactNode)(value.props),id);
        }
        assert.equal(typeof value.type,'string');
        const id=path+'/'+value.type;usedNodes.add(id);
        let node=nodes.get(id);
        if(!node){node={props:value.props,animations:[],animate(frames,options){const done=deferred<void>();void done.promise.catch(()=>{});const animation={frames,options,finished:done.promise,cancelled:false,cancel(){this.cancelled=true;done.reject(new Error('Animation cancelled'));},finish(){done.resolve();}};this.animations.push(animation);return animation;}};nodes.set(id,node);}
        nativeOrder.push(node);node.props=value.props;if(value.props.ref)value.props.ref.current=node;
        const children=React.Children.toArray(value.props.children).map((child,index)=>visit(child,id+'/'+(React.isValidElement(child) && child.key!==null ? child.key : index)));
        return React.cloneElement(value,{ref:undefined},...children);
      }
      tree=visit(React.createElement(module.exports.WidgetApp),'root');
      for(const [id,store] of stores)if(!usedStores.has(id)){cleanup(store);stores.delete(id);}
      for(const id of nodes.keys())if(!usedNodes.has(id))nodes.delete(id);
      for(const layout of [true,false])for(const store of [...stores.values()].reverse())for(const slot of store.slots){
        if(slot && typeof slot.setup==='function' && slot.layout===layout && slot.dirty){const current=slot as Effect;current.dirty=false;current.cleanup?.();const stop=current.setup();current.cleanup=typeof stop==='function' ? stop : undefined;}
      }
      if(!dirty)return tree;
    }
    throw new Error('Mock render did not settle');
  }
  render();
  const matching=(name:string)=>nativeOrder.filter(node=>String(node.props.className || '').split(' ').includes(name));
  const flush=async()=>{await Promise.resolve();await Promise.resolve();render();};
  const visible=(value:React.ReactNode):string=>React.Children.toArray(value).map(child=>React.isValidElement<Record<string,any>>(child) ? visible(child.props.children) : String(child)).join('');
  return {snapshot,actions,events,listeners,mediaListeners,render,flush,
    emit:(next:WidgetState)=>{for(const fn of listeners)fn(next);render();},
    html:()=>renderToStaticMarkup(render()),nodes:matching,
    text:()=>visible(render()),
    button:(label:string)=>{render();const node=[...nodes.values()].find(node=>node.props['aria-label']===label && typeof node.props.onClick==='function');assert.ok(node,label);return node.props;},
    setAction:(fn:WidgetBridge['action'])=>{actionHandler=fn;},
    reduced:(matches:boolean)=>{media.matches=matches;for(const fn of mediaListeners)fn();},
    unmount:()=>{for(const store of stores.values())cleanup(store);stores.clear();nodes.clear();},
    staleWrites:()=>staleWrites,
  };
}

test('subscription wins over late bootstrap success or failure, including synchronous delivery',async()=>{
  for(const synchronous of [false,true])for(const reject of [false,true]){
    const latest=state({siteName:'订阅中的新站点',viewKey:'new-site',balance:'—',latestModel:model('latest-request')});
    const h=await harness(synchronous ? {subscribeState:latest} : {});
    assert.deepEqual(h.events,['subscribe','snapshot']);
    if(!synchronous)h.emit(latest);
    const data=h.nodes('widget-data')[0];
    if(reject)h.snapshot.reject(new Error('stale bootstrap failed'));else h.snapshot.resolve(state({siteName:'过时站点',balance:'$999'}));
    await h.flush();
    assert.match(h.html(),/订阅中的新站点/);assert.match(h.text(),/latest-request/);
    assert.doesNotMatch(h.html(),/过时站点|\$999|用量暂不可用/);
    assert.equal(data.animations.length,0);
    h.unmount();assert.equal(h.listeners.size,0);assert.equal(h.mediaListeners.size,0);assert.equal(h.staleWrites(),0);
  }
  for(const reject of [false,true]){
    const h=await harness();h.unmount();
    if(reject)h.snapshot.reject(new Error('late bootstrap failure'));else h.snapshot.resolve(state());
    await Promise.resolve();await Promise.resolve();await Promise.resolve();
    assert.equal(h.listeners.size,0);assert.equal(h.staleWrites(),0);
  }
});

test('compressed markup shows unlabeled input/output and subtle cache read, with other metadata only in tooltips',async()=>{
  const h=await harness(),latest=model('latest-request',{cost:'$0.000007',requests:'7139',input:'—',output:'240',cacheRead:'—',cacheWrite:'0'});
  const models=Array.from({length:12},(_,i)=>model('cost-ranked-'+i));
  h.emit(state({models,latestModel:latest}));
  const html=h.html(),text=h.text();
  assert.equal(text,'最近消费$0.0123latest-request——/240余额$23.45');
  assert.equal(h.nodes('widget-model').length,1);assert.equal(h.nodes('widget-model-slot').length,1);
  assert.equal(h.nodes('widget-data').length,1);assert.equal(h.nodes('widget-value').length,5);
  assert.doesNotMatch(html,/<(?:header|footer|h[1-6]|ul|li|nav)\b|cost-ranked-|widget-refresh|widget-model-list|widget-model-scroll/);
  assert.equal((html.match(/<button\b/g) || []).length,1);
  assert.doesNotMatch(text,/输入|输出|缓存|站点|Lumi|Tokens|请求|7139|0\.000007|10\/02|09:41|上一分钟|更新|同步|刷新/);
  const tooltip=h.nodes('widget-model')[0].props.title;
  for(const detail of ['latest-request','模型消费：$0.000007','请求数：7139','输入：—','输出：240','缓存读取：—','缓存写入：0','消费范围：10/02 09:41','隔离测试站点','更新：'])assert.ok(tooltip.includes(detail),detail);
  assert.doesNotMatch(html,/NaN|undefined|null/);
  h.emit(state({models,latestModel:latest,historical:true,minuteLabel:'09/30 17:26',dataKey:'historical'}));
  assert.match(h.nodes('widget-model')[0].props.title,/回溯消费时间：09\/30 17:26/);
  assert.doesNotMatch(h.text(),/历史|分钟|09\/30|17:26/);
  h.unmount();
});

test('local estimates keep the consumption label and explain online pricing only in hover details',async()=>{
  const h=await harness();
  h.emit(state({source:'local',latestModel:model('local-model')}));
  assert.match(h.text(),/^最近消费/);assert.doesNotMatch(h.text(),/最近用量|线上定价|账单/);
  assert.match(h.nodes('widget-consumption')[0].props.title,/按线上定价估算，最终以站点账单为准/);
  assert.match(h.nodes('widget-model')[0].props.title,/按线上定价估算，最终以站点账单为准/);
  h.emit(state());assert.doesNotMatch(h.nodes('widget-consumption')[0].props.title,/按线上定价估算/);
  h.unmount();
});

test('legacy model fallback and latest-only DTO keep one current model with honest unknown values',async()=>{
  const h=await harness(),first=state({balance:'—',cost:'—',models:[model('legacy-first',{input:'—',cacheRead:'—',cacheWrite:'—'}),model('legacy-second')]});
  h.emit(first);
  assert.match(h.text(),/最近消费—legacy-first——\/240余额—/);
  assert.doesNotMatch(h.html(),/legacy-second/);
  const data=h.nodes('widget-data')[0],slot=h.nodes('widget-model-slot')[0],current=h.nodes('widget-model')[0];
  h.emit({...first,models:[first.models[1],first.models[0]],dataKey:'reordered'});
  assert.strictEqual(h.nodes('widget-data')[0],data);assert.strictEqual(h.nodes('widget-model-slot')[0],slot);assert.strictEqual(h.nodes('widget-model')[0],current);
  assert.match(h.text(),/legacy-second/);assert.doesNotMatch(h.html(),/legacy-first/);assert.equal(h.nodes('widget-model').length,1);
  h.emit({...first,models:[],latestModel:model('latest-only'),dataKey:'latest-only'});
  assert.match(h.text(),/latest-only/);assert.equal(h.nodes('widget-model').length,1);assert.doesNotMatch(h.html(),/legacy-/);
  h.emit({...first,models:[],dataKey:'empty'});
  assert.equal(h.nodes('widget-model').length,0);assert.match(h.text(),/暂无消费模型/);assert.doesNotMatch(h.html(),/latest-only/);
  h.unmount();
});

test('data changes exit, swap one tree, then enter; metadata never replays and superseded updates lose',async()=>{
  const h=await harness(),first=state({animation:'slide-up',latestModel:model('first-request')});
  h.emit(first);
  const data=h.nodes('widget-data')[0],modelNode=h.nodes('widget-model')[0];
  assert.equal(data.animations.length,0);
  const next={...first,balance:'$23.40',latestModel:model('next-request'),dataKey:'minute-2'};
  h.emit(next);
  const exit=data.animations[0];
  assert.equal(data.animations.length,1);assert.equal(exit.options.duration,120);assert.equal(exit.options.fill,'forwards');
  assert.match(h.text(),/first-request/);assert.match(h.text(),/余额\$23.45/);assert.doesNotMatch(h.text(),/next-request|\$23.40/);
  for(const patch of [
    {phase:'loading' as const,message:'正在同步…'},{updatedAt:next.updatedAt+1000},{theme:'dark' as const},
    {phase:'error' as const,message:'保留上次结果'},{siteName:'另一个站点'},
    {models:[first.models[1],first.models[0]]},{latestModel:{...next.latestModel,requests:'999',output:'321'}},
  ]){
    h.emit({...next,...patch});
    assert.strictEqual(h.nodes('widget-data')[0],data);assert.strictEqual(h.nodes('widget-model')[0],modelNode);
    assert.equal(data.animations.length,1);assert.equal(exit.cancelled,false);
  }
  exit.finish();await h.flush();
  assert.equal(exit.cancelled,true);assert.equal(data.animations.length,2);assert.equal(data.animations[1].options.duration,220);
  assert.match(h.text(),/next-request1.2K—\/321/);assert.match(h.text(),/余额\$23.40/);assert.doesNotMatch(h.html(),/first-request/);
  const entry=data.animations[1];
  h.emit({...next,balance:'$23.30',latestModel:model('superseded-request'),dataKey:'minute-3'});
  assert.equal(entry.cancelled,true);const superseded=data.animations[2];
  h.emit({...next,balance:'$23.20',latestModel:model('newest-request'),dataKey:'minute-4'});
  assert.equal(superseded.cancelled,true);assert.match(h.text(),/next-request/);
  superseded.finish();await h.flush();assert.doesNotMatch(h.html(),/superseded-request|newest-request/);
  data.animations[3].finish();await h.flush();
  assert.equal(data.animations.length,5);assert.match(h.text(),/newest-request/);assert.match(h.text(),/余额\$23.20/);
  assert.equal(h.nodes('widget-data').length,1);assert.equal(h.nodes('widget-model').length,1);assert.strictEqual(h.nodes('widget-model')[0],modelNode);
  assert.ok([...h.nodes('widget-model'),...h.nodes('widget-value')].every(node=>node.animations.length===0));
  h.unmount();assert.equal(h.mediaListeners.size,0);assert.ok(data.animations.every(animation=>animation.cancelled));
});

test('each refresh preset performs full exit and entry on the whole strip; none applies immediately',async()=>{
  const h=await harness(),data=h.nodes('widget-data')[0];h.emit(state({animation:undefined}));
  const presets=[undefined,'slide-up','slide-down','blur','fade','scale','none'] as const;
  for(const [index,animation] of presets.entries()){
    const base=state({animation,dataKey:'preset-base-'+index,balance:'$base'});
    // Changing just the preference cancels motion without starting another one.
    h.emit({...base,dataKey:index===0 ? 'minute-1' : 'preset-'+(index-1)});
    const count=data.animations.length;
    h.emit({...base,dataKey:'preset-'+index,balance:'$'+index});
    if(animation==='none'){assert.equal(data.animations.length,count);assert.match(h.text(),/余额\$6/);continue;}
    assert.equal(data.animations.length,count+1);
    const exit=data.animations.at(-1)!;
    assert.ok(Number(exit.frames[0].opacity)>Number(exit.frames.at(-1)!.opacity));assert.equal(exit.options.duration,120);
    if(!animation || animation==='slide-up')assert.equal(exit.frames.at(-1)!.transform,'translateY(-8px)');
    if(animation==='slide-down')assert.equal(exit.frames.at(-1)!.transform,'translateY(8px)');
    if(animation==='blur'){assert.equal(exit.frames[0].filter,'blur(0)');assert.equal(exit.frames.at(-1)!.filter,'blur(5px)');}
    if(animation==='scale')assert.equal(exit.frames.at(-1)!.transform,'scale(.96)');
    assert.match(h.text(),/余额\$base/);
    exit.finish();await h.flush();
    assert.equal(data.animations.length,count+2);
    const motion=data.animations.at(-1)!,start=motion.frames[0],end=motion.frames.at(-1)!;
    assert.ok(Number(start.opacity)<Number(end.opacity));assert.equal(end.opacity,1);
    if(!animation || animation==='slide-up'){assert.equal(start.transform,'translateY(10px)');assert.equal(end.transform,'translateY(0)');}
    if(animation==='slide-down'){assert.equal(start.transform,'translateY(-10px)');assert.equal(end.transform,'translateY(0)');}
    if(animation==='blur'){assert.equal(start.filter,'blur(5px)');assert.equal(end.filter,'blur(0)');}
    if(animation==='scale'){assert.equal(start.transform,'scale(.96)');assert.equal(end.transform,'scale(1)');}
    if(animation==='fade'){assert.equal(start.transform,undefined);assert.equal(start.filter,undefined);}
    assert.equal(motion.options.duration,animation==='blur' ? 300 : 220);
    assert.match(h.text(),new RegExp('余额\\$'+index));
    assert.equal(h.nodes('widget-data').length,1);assert.equal(h.nodes('widget-model').length,1);
    assert.ok([...h.nodes('widget-model'),...h.nodes('widget-value')].every(node=>node.animations.length===0));
  }
  h.unmount();assert.ok(data.animations.every(animation=>animation.cancelled));assert.equal(h.mediaListeners.size,0);
});

test('account scope and animation changes immediately apply latest data and invalidate pending completion',async()=>{
  const h=await harness(),first=state({animation:'slide-up',latestModel:model('account-a')});h.emit(first);
  const data=h.nodes('widget-data')[0],next={...first,balance:'$20',dataKey:'minute-2'};
  h.emit(next);const pending=data.animations.at(-1)!;assert.match(h.text(),/余额\$23.45/);
  h.emit({...next,animation:'blur'});assert.equal(pending.cancelled,true);assert.match(h.text(),/余额\$20/);assert.equal(data.animations.length,1);
  pending.finish();await h.flush();assert.equal(data.animations.length,1);
  h.emit({...next,animation:'blur',dataKey:'minute-3',balance:'$19'});const previousAccount=data.animations.at(-1)!;
  h.emit({...next,animation:'blur',viewKey:'account-b',dataKey:'account-b-data',balance:'—',cost:'—',models:[],latestModel:undefined});
  assert.equal(previousAccount.cancelled,true);assert.equal(h.text(),'最近消费—暂无消费模型余额—');
  previousAccount.finish();await h.flush();assert.doesNotMatch(h.html(),/account-a|\$19|\$20|\$23.45/);assert.equal(data.animations.length,2);
  // Scope reset must also work when a bridge happens to reuse the data key.
  h.emit({...next,viewKey:'account-c',dataKey:'account-b-data',latestModel:model('account-c')});
  assert.match(h.text(),/account-c/);assert.equal(data.animations.length,2);
  h.emit({...next,viewKey:'account-c',dataKey:'account-c-next',latestModel:model('account-c'),animation:'blur'});
  data.animations.at(-1)!.finish();await h.flush();const entering=data.animations.at(-1)!,count=data.animations.length;
  h.emit({...next,viewKey:'account-c',dataKey:'account-c-next',latestModel:model('account-c'),animation:'none'});
  assert.equal(entering.cancelled,true);assert.equal(data.animations.length,count);assert.match(h.text(),/account-c/);
  h.unmount();assert.equal(h.mediaListeners.size,0);
});

test('reduced motion skips transitions and toggling it immediately applies the latest pending snapshot',async()=>{
  const h=await harness({reduced:true}),data=h.nodes('widget-data')[0],first=state({animation:'slide-up'});
  h.emit(first);h.emit({...first,dataKey:'reduced',balance:'$12'});
  assert.equal(data.animations.length,0);assert.equal(h.mediaListeners.size,0);assert.match(h.text(),/余额\$12/);
  h.reduced(false);h.emit({...first,balance:'$11',dataKey:'motion',animation:'blur'});
  assert.equal(data.animations.length,0); // Preference switch applies immediately.
  h.emit({...first,balance:'$10',dataKey:'motion-2',animation:'blur'});
  assert.equal(data.animations.length,1);assert.match(h.text(),/余额\$11/);const exit=data.animations[0];
  h.reduced(true);h.render();assert.equal(exit.cancelled,true);assert.match(h.text(),/余额\$10/);
  exit.finish();await h.flush();assert.equal(data.animations.length,1);
  h.emit({...first,balance:'—',dataKey:'no-motion',animation:'blur'});
  assert.equal(data.animations.length,1);assert.equal(h.mediaListeners.size,0);assert.match(h.text(),/余额—/);
  h.reduced(false);h.emit({...first,dataKey:'enter-motion',animation:'blur'});
  data.animations.at(-1)!.finish();await h.flush();const entry=data.animations.at(-1)!;
  h.reduced(true);h.render();assert.equal(entry.cancelled,true);assert.match(h.text(),/余额\$23.45/);
  h.unmount();assert.equal(h.mediaListeners.size,0);
});

test('unmount during exit prevents a late animation completion from writing state',async()=>{
  const h=await harness(),first=state({animation:'slide-up'});h.emit(first);
  h.emit({...first,dataKey:'pending-exit',balance:'$1'});const exit=h.nodes('widget-data')[0].animations.at(-1)!;
  h.unmount();assert.equal(exit.cancelled,true);exit.finish();
  await Promise.resolve();await Promise.resolve();assert.equal(h.staleWrites(),0);assert.equal(h.mediaListeners.size,0);
});
test('double-click and keyboard open, close stops propagation, and actions stay within the narrow bridge',async()=>{
  const h=await harness();h.emit(state());
  const root=h.nodes('widget-card')[0].props,content=h.nodes('widget-data')[0];
  root.onDoubleClick();
  let prevented=0;
  content.props.onKeyDown({key:'Enter',repeat:false,target:content,currentTarget:content,preventDefault(){prevented++;}});
  for(const event of [{key:'Enter',repeat:true,target:content},{key:'Escape',repeat:false,target:content},{key:'Enter',repeat:false,target:{}}])
    content.props.onKeyDown({...event,currentTarget:content,preventDefault(){throw new Error('Unexpected key interception');}});
  let stopped=false;
  const event={stopPropagation(){stopped=true;}},close=h.button('关闭悬浮窗');
  close.onDoubleClick(event);if(!stopped)root.onDoubleClick();
  assert.equal(stopped,true);stopped=false;close.onClick(event);assert.equal(stopped,true);
  await h.flush();
  assert.equal(prevented,1);assert.deepEqual(JSON.parse(JSON.stringify(h.actions)),[{type:'open'},{type:'open'},{type:'close'}]);
  assert.equal((h.html().match(/<button\b/g) || []).length,1);assert.equal(close.disabled,false);
  const pending=deferred<void>();h.setAction(()=>pending.promise);root.onDoubleClick();
  pending.reject(new Error('isolated action failure'));await h.flush();
  assert.match(h.text(),/操作失败/);assert.equal(h.nodes('widget-model-notice').length,1);assert.match(h.text(),/余额\$23.45/);
  h.emit(state());assert.doesNotMatch(h.text(),/操作失败/);
  const late=deferred<void>();h.setAction(()=>late.promise);root.onDoubleClick();h.unmount();late.reject(new Error('late failure'));
  await Promise.resolve();await Promise.resolve();assert.equal(h.staleWrites(),0);
});

test('missing bridge, empty data and errors use concise model-slot messages and retain known totals',async()=>{
  const missing=await harness({missingBridge:true});
  assert.match(missing.text(),/最近消费—请在工作台打开余额—/);assert.equal(missing.button('关闭悬浮窗').disabled,true);
  missing.nodes('widget-card')[0].props.onDoubleClick();await missing.flush();assert.equal(missing.actions.length,0);missing.unmount();
  const h=await harness();assert.match(h.text(),/读取中…/);
  h.snapshot.reject(new Error('isolated bootstrap failure'));await h.flush();assert.match(h.text(),/用量暂不可用/);
  assert.doesNotMatch(h.text(),/刷新|同步|更新/);assert.equal(h.nodes('widget-empty').length,1);
  h.emit(state({phase:'ready',models:[],balance:'$23.45',cost:'—',minuteLabel:'暂无消费分钟',message:'尚无额度消耗',updatedAt:NaN}));
  assert.match(h.text(),/暂无消费模型/);assert.doesNotMatch(h.text(),/用量暂不可用|尚无额度消耗/);assert.doesNotMatch(h.html(),/NaN|Invalid Date/);
  h.emit(state({phase:'error',models:[],message:'隔离的完整错误详情',updatedAt:Infinity}));
  assert.match(h.text(),/用量暂不可用/);assert.doesNotMatch(h.text(),/完整错误详情/);assert.match(h.nodes('widget-card')[0].props.title,/隔离的完整错误详情/);
  assert.match(h.text(),/余额\$23.45/);assert.doesNotMatch(h.html(),/Infinity|Invalid Date/);
  h.emit(state({phase:'loading',models:[]}));assert.match(h.text(),/读取中…/);assert.doesNotMatch(h.text(),/用量暂不可用/);
  h.emit(state());assert.equal(h.nodes('widget-empty').length,0);assert.doesNotMatch(h.text(),/读取中|上一分钟/);
  h.unmount();
});


test('244×64 Chromium layout keeps both themes, long values and controls inside the strip', {timeout:20000},async t=>{
  let electron:string;
  try{electron=createRequire(import.meta.url)('electron');}catch(error){if(process.env.CI)throw error;return t.skip('Electron runtime unavailable');}
  if(!existsSync(electron)){if(process.env.CI)assert.fail('CI must install the Electron runtime');return t.skip('Electron runtime unavailable');}
  await mkdir('.test-data',{recursive:true});
  const root=await mkdtemp(path.resolve('.test-data/widget-ui-'));
  t.after(async()=>{
    const relative=path.relative(path.resolve('.test-data'),root);
    assert.ok(relative && !relative.startsWith('..') && !path.isAbsolute(relative));
    await rm(root,{recursive:true,force:true,maxRetries:5,retryDelay:100});
  });
  const renderer=await build({entryPoints:['src/widget.tsx'],bundle:true,platform:'browser',format:'iife',write:false,outfile:'renderer.js',
    define:{'process.env.NODE_ENV':'"production"'},logLevel:'silent'});
  await writeFile(path.join(root,'renderer.js'),renderer.outputFiles.find(file=>file.path.endsWith('.js'))!.contents);
  await writeFile(path.join(root,'renderer.css'),(await readFile('src/theme-tokens.css','utf8'))+(await readFile('src/widget.css','utf8')));
  await writeFile(path.join(root,'fixture.html'),'<!doctype html><html><head><meta charset="utf-8"><link rel="stylesheet" href="renderer.css"></head><body><div id="root"></div><script>'+
    'window.fixtureState='+JSON.stringify(state({latestModel:model('claude-opus-4.6')}))+';window.fixtureActions=[];const listeners=new Set();'+
    'window.fixtureEmit=s=>{window.fixtureState=s;for(const f of listeners)f(s);};'+
    'window.lumiWidget={snapshot:async()=>window.fixtureState,action:async e=>{window.fixtureActions.push(e);},onState:f=>{listeners.add(f);return()=>listeners.delete(f);}};'+
    '</script><script src="renderer.js"></script></body></html>');
  // This executable opens only a hidden, sandboxed fixture page and isolated profile.
  await writeFile(path.join(root,'audit.cjs'),String.raw`
const {app,BrowserWindow}=require('electron');
const fs=require('node:fs/promises'),path=require('node:path');
for(const name of ['userData','sessionData','logs','crashDumps']){
  const folder=path.join(__dirname,name);require('node:fs').mkdirSync(folder,{recursive:true});app.setPath(name,folder);
}
app.disableHardwareAcceleration();
app.whenReady().then(async()=>{
  const win=new BrowserWindow({width:244,height:64,useContentSize:true,show:false,frame:false,thickFrame:false,resizable:false,hasShadow:false,transparent:true,webPreferences:{sandbox:true,contextIsolation:true,nodeIntegration:false,offscreen:true,backgroundThrottling:false}});
  await win.loadFile(path.join(__dirname,'fixture.html'));
  win.webContents.debugger.attach('1.3');
  await win.webContents.debugger.sendCommand('Emulation.setEmulatedMedia',{features:[{name:'prefers-reduced-motion',value:'no-preference'}]});
  for(let i=0;i<40;i++){if(await win.webContents.executeJavaScript("!!document.querySelector('.widget-model-name')"))break;await new Promise(r=>setTimeout(r,25));}
  const results=[];
  for(const [name,patch] of [
    ['light',{theme:'light'}],['dark',{theme:'dark'}],
    ['long',{theme:'light',cost:'$0.00000012',balance:'$123,456,789.99',latestModel:{name:'isolated-very-long-latest-model-name-with-a-provider-prefix',cost:'$0.00000001',requests:'12345',input:'123.45M',output:'456.78K',cacheRead:'789.01M',cacheWrite:'234.56K'}}],
    ['empty',{models:[],latestModel:undefined}],
    ['error',{phase:'error',message:'isolated permission details'}],
  ]){
    await win.webContents.executeJavaScript('window.fixtureEmit({...window.fixtureState,...'+JSON.stringify(patch)+(name==='empty' ? ',latestModel:undefined' : '')+'});');
    await new Promise(r=>setTimeout(r,30));
    results.push(await win.webContents.executeJavaScript('('+function inspect(){
      const rect=node=>{const r=node.getBoundingClientRect();return {x:r.x,y:r.y,width:r.width,height:r.height,right:r.right,bottom:r.bottom};};
      const card=document.querySelector('.widget-card'),data=document.querySelector('.widget-data');
      const bounds=Object.fromEntries(['.widget-card','.widget-data','.widget-consumption','.widget-details','.widget-model-slot','.widget-balance'].map(s=>[s,rect(document.querySelector(s))]));
      const textBounds=[...data.querySelectorAll('dt, dd, .widget-model-name, .widget-model-notice, .widget-empty')].map(node=>({className:node.className,tag:node.tagName,...rect(node)}));
      const style=getComputedStyle(card);
      const islands=[...card.querySelectorAll('*')].filter(node=>getComputedStyle(node).getPropertyValue('-webkit-app-region')==='no-drag');
      const excluded=islands.map(rect),area=rect(data);
      let draggable=0,samples=0;
      for(let y=area.y+1;y<area.bottom;y+=2)for(let x=area.x+1;x<area.right;x+=2){
        samples++;if(!excluded.some(r=>x>=r.x && x<r.right && y>=r.y && y<r.bottom))draggable++;
      }
      return {viewport:[innerWidth,innerHeight],document:[document.documentElement.scrollWidth,document.documentElement.scrollHeight],
        bounds,textBounds,text:data.textContent,background:style.backgroundColor,shadow:style.boxShadow,image:style.backgroundImage,
        drag:style.getPropertyValue('-webkit-app-region'),contentDrag:getComputedStyle(data).getPropertyValue('-webkit-app-region'),
        dragRatio:draggable/samples,interactive:[...data.querySelectorAll('.widget-value, .widget-model-name>span')].every(node=>getComputedStyle(node).getPropertyValue('-webkit-app-region')==='no-drag'),
        closeDrag:getComputedStyle(document.querySelector('.widget-close')).getPropertyValue('-webkit-app-region'),
        closeOpacity:getComputedStyle(document.querySelector('.widget-close')).opacity,
        fonts:[getComputedStyle(document.querySelector('.widget-consumption dd')).fontSize,getComputedStyle(document.querySelector('.widget-balance dd')).fontSize],
        models:document.querySelectorAll('.widget-model').length,content:document.querySelectorAll('.widget-data').length};
    }.toString()+')()'));
    results.at(-1).name=name;
    if(process.env.LUMI_WIDGET_CAPTURE_DIR && (name==='light' || name==='dark' || name==='long')){
      const image=await win.webContents.capturePage();
      await fs.mkdir(process.env.LUMI_WIDGET_CAPTURE_DIR,{recursive:true});
      await fs.writeFile(path.join(process.env.LUMI_WIDGET_CAPTURE_DIR,'widget-'+name+'.png'),image.toPNG());
    }
  }
  const transition=await win.webContents.executeJavaScript('('+async function transition(){
    const next={...window.fixtureState,phase:'ready',viewKey:'animation-fixture',dataKey:'real-1',animation:'slide-up',balance:'$old',latestModel:{name:'old-model',cost:'$1',requests:'1',input:'1',output:'1',cacheRead:'0',cacheWrite:'0'}};
    const data=document.querySelector('.widget-data');
    if(matchMedia('(prefers-reduced-motion: reduce)').matches)throw new Error('Animation fixture requires no-preference media emulation');
    // Pause real WAAPI animations so a busy CI runner cannot finish them before sampling.
    const animate=Element.prototype.animate;
    Element.prototype.animate=function(...args){const motion=animate.apply(this,args);motion.pause();motion.currentTime=0;return motion;};
    const until=async predicate=>{
      const deadline=performance.now()+3000;
      while(!predicate()){if(performance.now()>deadline)throw new Error('Animation fixture condition timed out');await new Promise(r=>setTimeout(r,10));}
    };
    window.fixtureEmit(next);await until(()=>data.textContent.includes('old-model'));
    window.fixtureEmit({...next,dataKey:'real-2',balance:'$new',latestModel:{...next.latestModel,name:'new-model'}});await until(()=>data.getAnimations().length===1);
    const outgoing=data.textContent,exit=data.getAnimations()[0],exitDuration=exit?.effect.getTiming().duration;
    exit.finish();await until(()=>data.textContent.includes('new-model') && data.getAnimations()[0]!==exit);
    const incoming=data.textContent,entry=data.getAnimations()[0],entryDuration=entry?.effect.getTiming().duration;
    window.fixtureEmit({...next,dataKey:'real-3',balance:'$superseded'});await until(()=>data.getAnimations().length===1 && data.getAnimations()[0]!==entry);
    const superseded=data.getAnimations()[0];
    window.fixtureEmit({...next,dataKey:'real-4',balance:'$latest'});await until(()=>data.getAnimations().length===1 && data.getAnimations()[0]!==superseded);
    const supersededState=superseded?.playState;
    data.getAnimations()[0].finish();await until(()=>data.textContent.includes('余额$latest'));const latest=data.textContent;
    window.fixtureEmit({...next,viewKey:'new-account',dataKey:'new-account',balance:'—',cost:'—',models:[],latestModel:undefined});await until(()=>data.textContent==='最近消费—暂无消费模型余额—' && data.getAnimations().length===0);
    Element.prototype.animate=animate;
    return {outgoing,incoming,exitDuration,entryDuration,supersededState,latest,reset:data.textContent,remaining:data.getAnimations().length,content:document.querySelectorAll('.widget-data').length};
  }.toString()+')()');
  const controls=await win.webContents.executeJavaScript('('+function controls(){
    const data=document.querySelector('.widget-data'),close=document.querySelector('.widget-close');
    data.focus();const focusedOpacity=getComputedStyle(close).opacity;
    data.querySelector('.widget-value').dispatchEvent(new MouseEvent('dblclick',{bubbles:true}));
    data.dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',bubbles:true}));
    close.dispatchEvent(new MouseEvent('dblclick',{bubbles:true}));close.click();
    return {focusedOpacity,actions:window.fixtureActions,wideBridge:typeof window.lumi,require:typeof require};
  }.toString()+')()');
  win.setContentSize(Math.ceil(244*24/13),Math.ceil(64*24/13));
  await win.webContents.executeJavaScript('fixtureEmit({...fixtureState,typography:{fontSize:24,fontFamily:"serif"}})');
  for(let i=0;i<80;i++){if(await win.webContents.executeJavaScript('innerWidth>=451 && innerWidth<=452 && innerHeight>=119 && innerHeight<=120 && Math.abs(parseFloat(getComputedStyle(document.querySelector(".widget-consumption dd")).fontSize)-16*24/13)<.02'))break;await new Promise(r=>setTimeout(r,20));}
  const large=await win.webContents.executeJavaScript('('+function(){
    const card=document.querySelector('.widget-card').getBoundingClientRect();
    return {size:[innerWidth,innerHeight],family:getComputedStyle(document.body).fontFamily,font:parseFloat(getComputedStyle(document.querySelector('.widget-consumption dd')).fontSize),inside:[...document.querySelectorAll('.widget-data dt,.widget-data dd,.widget-close')].every(el=>{const r=el.getBoundingClientRect();return r.left>=card.left && r.right<=card.right+.5 && r.top>=card.top && r.bottom<=card.bottom+.5;})};
  }.toString()+')()');
  process.stdout.write('WIDGET_LAYOUT_RESULT '+JSON.stringify({results,transition,controls,large})+'\n');
  win.destroy();app.exit(0);
}).catch(error=>{process.stderr.write(String(error.stack || error));app.exit(1);});
`);
  const env={...process.env};delete env.ELECTRON_RUN_AS_NODE;
  const child=spawn(electron,[path.join(root,'audit.cjs')],{env,windowsHide:true,stdio:['ignore','pipe','pipe'],signal:t.signal});
  let stdout='',stderr='';
  child.stdout.on('data',chunk=>{stdout+=chunk;});child.stderr.on('data',chunk=>{stderr+=chunk;});
  const code=await new Promise<number|null>((resolve,reject)=>{child.once('error',reject);child.once('close',resolve);});
  assert.equal(code,0,stderr);
  const line=stdout.split(/\r?\n/).find(line=>line.startsWith('WIDGET_LAYOUT_RESULT '));assert.ok(line,stdout+stderr);
  const {results,transition,controls,large}=JSON.parse(line.slice('WIDGET_LAYOUT_RESULT '.length));
  assert.ok(large.size[0]>=451 && large.size[0]<=452 && large.size[1]>=119 && large.size[1]<=120,JSON.stringify(large));assert.ok(Math.abs(large.font-16*24/13)<.02);assert.match(large.family,/serif/);assert.equal(large.inside,true);
  for(const result of results){
    assert.deepEqual(result.viewport,[244,64],result.name);assert.deepEqual(result.document,[244,64],result.name);
    const card=result.bounds['.widget-card'],data=result.bounds['.widget-data'];
    assert.equal(result.content,1);assert.ok(result.models<=1);
    for(const bounds of [...Object.values(result.bounds),...result.textBounds] as {x:number;y:number;right:number;bottom:number}[]){
      assert.ok(bounds.x>=card.x && bounds.y>=card.y && bounds.right<=card.right+.5 && bounds.bottom<=card.bottom+.5,JSON.stringify({name:result.name,bounds,card}));
    }
    assert.ok(result.bounds['.widget-consumption'].right<result.bounds['.widget-model-slot'].x);
    assert.ok(result.bounds['.widget-model-slot'].bottom<=result.bounds['.widget-balance'].y);
    assert.ok(data.height<=54);assert.deepEqual(result.fonts,['16px','11px']);
    assert.equal(result.background,result.name==='dark' ? 'rgb(32, 43, 36)' : 'rgb(255, 255, 255)',result.name);
    assert.equal(result.shadow,'none');assert.equal(result.image,'none');assert.equal(result.drag,'drag');assert.equal(result.contentDrag,'drag');
    assert.ok(result.dragRatio>.35,JSON.stringify({name:result.name,dragRatio:result.dragRatio}));
    assert.equal(result.interactive,true);assert.equal(result.closeDrag,'no-drag');
    assert.equal(result.closeOpacity,'0');
  }
  assert.equal(results.find((result:any)=>result.name==='long').models,1);
  assert.match(results.find((result:any)=>result.name==='empty').text,/暂无消费模型/);
  assert.match(results.find((result:any)=>result.name==='error').text,/用量暂不可用/);
  assert.match(transition.outgoing,/old-model/);assert.match(transition.outgoing,/余额\$old/);assert.doesNotMatch(transition.outgoing,/new-model|\$new/);
  assert.match(transition.incoming,/new-model/);assert.match(transition.incoming,/余额\$new/);
  assert.equal(transition.exitDuration,120);assert.equal(transition.entryDuration,220);assert.equal(transition.supersededState,'idle');
  assert.match(transition.latest,/余额\$latest/);assert.doesNotMatch(transition.latest,/\$superseded/);
  assert.equal(transition.reset,'最近消费—暂无消费模型余额—');assert.equal(transition.remaining,0);assert.equal(transition.content,1);
  assert.equal(controls.focusedOpacity,'1');assert.deepEqual(controls.actions,[{type:'open'},{type:'open'},{type:'close'}]);
  assert.equal(controls.wideBridge,'undefined');assert.equal(controls.require,'undefined');
});
