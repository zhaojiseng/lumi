import test from 'node:test';
import assert from 'node:assert/strict';
import {build} from 'esbuild';
import {createRequire} from 'node:module';
import {runInNewContext} from 'node:vm';
import * as React from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import type {WidgetAction,WidgetBridge,WidgetModel,WidgetState} from '../shared/widget';

// The actual renderer is bundled in memory. Only hooks, DOM animation targets,
// and the narrow widget bridge are mocked; no account, app or CLI is contacted.
const bundle=build({entryPoints:['src/widget.tsx'],bundle:true,platform:'node',format:'cjs',write:false,
  external:['react','react/jsx-runtime','react-dom/client','lucide-react'],loader:{'.css':'empty','.svg':'text'},logLevel:'silent'});
function deferred<T>() {
  let resolve!:(value:T)=>void,reject!:(error:unknown)=>void;
  const promise=new Promise<T>((yes,no)=>{resolve=yes;reject=no;});
  return {promise,resolve,reject};
}
const model=(name:string,patch:Partial<WidgetModel>={}):WidgetModel=>({name,cost:'$0.0123',requests:'2',input:'1.2K',output:'240',cacheRead:'—',cacheWrite:'0',...patch});
const state=(patch:Partial<WidgetState>={}):WidgetState=>({phase:'ready',enabled:true,siteName:'隔离测试站点',balance:'$23.45',cost:'$0.0123',minuteLabel:'10/02 09:41',historical:false,
  models:[model('gpt-6'),model('claude-opus-4.6')],message:'上一分钟',updatedAt:1790905320000,viewKey:'isolated-account',dataKey:'minute-1',theme:'light',...patch});
type Element=React.ReactElement<Record<string,any>>;
type Effect={deps?:React.DependencyList;setup:()=>void|(()=>void);cleanup?:()=>void;dirty:boolean;layout:boolean};
type Store={slots:any[];mounted:boolean};
type AnimationRecord={frames:Keyframe[];options:KeyframeAnimationOptions;cancelled:boolean;cancel():void};
type Native={props:Record<string,any>;scrollTop:number;animations:AnimationRecord[];animate(frames:Keyframe[],options:KeyframeAnimationOptions):AnimationRecord};
const equalDeps=(a?:React.DependencyList,b?:React.DependencyList)=>!!a && !!b && a.length===b.length && a.every((value,index)=>Object.is(value,b[index]));

async function harness(options:{missingBridge?:boolean;reduced?:boolean}={}) {
  const snapshot=deferred<WidgetState>(),listeners=new Set<(next:WidgetState)=>void>(),mediaListeners=new Set<()=>void>();
  const actions:WidgetAction[]=[],events:string[]=[],stores=new Map<string,Store>(),nodes=new Map<string,Native>();
  let actionHandler:WidgetBridge['action']=async()=>{},owner:Store,cursor=0,dirty=false,staleWrites=0,tree:React.ReactNode,nativeOrder:Native[]=[];
  const media={matches:!!options.reduced,addEventListener:(_event:string,fn:()=>void)=>mediaListeners.add(fn),removeEventListener:(_event:string,fn:()=>void)=>mediaListeners.delete(fn)};
  const bridge:WidgetBridge={snapshot:()=>{events.push('snapshot');return snapshot.promise;},action:event=>{actions.push(event);return actionHandler(event);},
    onState:fn=>{events.push('subscribe');listeners.add(fn);return ()=>listeners.delete(fn);}};
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
  runInNewContext((await bundle).outputFiles[0].text,{module,exports:module.exports,window:windowMock,document:{getElementById:()=>null},
    getComputedStyle:()=>({getPropertyValue:()=>media.matches ? '#2a4535' : '#e8f3ec'}),
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
        if(!node){node={props:value.props,scrollTop:0,animations:[],animate(frames,options){const animation={frames,options,cancelled:false,cancel(){this.cancelled=true;}};this.animations.push(animation);return animation;}};nodes.set(id,node);}
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
  return {snapshot,actions,events,listeners,mediaListeners,render,flush,
    emit:(next:WidgetState)=>{for(const fn of listeners)fn(next);render();},
    html:()=>renderToStaticMarkup(render()),nodes:matching,
    button:(label:string)=>{render();const node=[...nodes.values()].find(node=>node.props['aria-label']===label && typeof node.props.onClick==='function');assert.ok(node,label);return node.props;},
    setAction:(fn:WidgetBridge['action'])=>{actionHandler=fn;},
    reduced:(matches:boolean)=>{media.matches=matches;for(const fn of mediaListeners)fn();},
    unmount:()=>{for(const store of stores.values())cleanup(store);stores.clear();nodes.clear();},
    staleWrites:()=>staleWrites,
  };
}

test('subscription wins over delayed initial snapshots and failures, and unmount stops delivery',async()=>{
  for(const reject of [false,true]){
    const h=await harness();assert.deepEqual(h.events,['subscribe','snapshot']);
    h.emit(state({siteName:'订阅中的新站点',viewKey:'new-site',balance:'—'}));
    if(reject)h.snapshot.reject(new Error('stale bootstrap failed'));else h.snapshot.resolve(state({siteName:'过时站点',balance:'$999'}));
    await h.flush();const html=h.html();assert.match(html,/订阅中的新站点/);assert.doesNotMatch(html,/过时站点|\$999|刷新重试/);
    h.unmount();assert.equal(h.listeners.size,0);assert.equal(h.mediaListeners.size,0);assert.equal(h.staleWrites(),0);
  }
  const h=await harness();h.unmount();h.snapshot.resolve(state());await Promise.resolve();await Promise.resolve();assert.equal(h.listeners.size,0);assert.equal(h.staleWrites(),0);
});

test('all formatted models, cache read/write and unknown values render with accurate minute labels',async()=>{
  const h=await harness(),models=Array.from({length:12},(_,i)=>model('isolated-model-'+i,{input:i===0 ? '—' : '1K',cacheRead:'—',cacheWrite:i===0 ? '—' : '0'}));
  h.emit(state({models,balance:'—',cost:'—'}));
  let html=h.html();assert.match(html,/上一完整分钟消费/);assert.match(html,/10\/02 09:41/);assert.match(html,/Tokens · 12 个模型/);
  assert.equal(h.nodes('widget-model').length,12);assert.equal(h.nodes('widget-model-list').length,1);
  for(const label of ['输入','输出','缓存读取','缓存写入'])assert.equal(html.split('<dt>'+label+'</dt>').length-1,12);
  assert.match(html,/账户余额<\/dt><dd><span[^>]*title="—">—<\/span>/);assert.doesNotMatch(html,/NaN|undefined|null/);
  assert.match(html,/<dt>缓存读取<\/dt><dd><span[^>]*title="—">—<\/span>/);
  assert.match(html,/<dt>缓存写入<\/dt><dd><span[^>]*title="—">—<\/span>/);
  h.emit(state({models,historical:true,minuteLabel:'09/30 17:26',message:'最近有消耗的一分钟',dataKey:'historical'}));
  html=h.html();assert.match(html,/最近付费分钟消费/);assert.match(html,/历史分钟/);assert.match(html,/09\/30 17:26/);assert.doesNotMatch(html,/上一完整分钟消费/);h.unmount();
});

test('new data animates one existing list; metadata preserves rows, scroll and active animation',async()=>{
  const h=await harness(),first=state();h.emit(first);
  const scroll=h.nodes('widget-model-scroll')[0],list=h.nodes('widget-model-list')[0],rows=h.nodes('widget-model'),data=h.nodes('widget-data')[0];scroll.scrollTop=37;
  const counts=[data,...rows,...h.nodes('widget-value')].map(node=>node.animations.length),initialFade=data.animations.at(-1)!;
  for(const patch of [{phase:'loading' as const,message:'正在同步…'},{updatedAt:first.updatedAt+1000},{theme:'dark' as const},{phase:'error' as const,message:'保留上次结果'}]){
    h.emit({...first,...patch});assert.strictEqual(h.nodes('widget-model-list')[0],list);assert.strictEqual(h.nodes('widget-model')[0],rows[0]);assert.equal(scroll.scrollTop,37);
    assert.deepEqual([data,...rows,...h.nodes('widget-value')].map(node=>node.animations.length),counts);assert.equal(initialFade.cancelled,false);
  }
  const next={...first,balance:'$23.40',cost:'$0.0200',models:[model('gpt-6',{cost:'$0.0200',output:'320'}),first.models[1]],dataKey:'minute-2'};
  h.emit(next);assert.equal(initialFade.cancelled,true);assert.strictEqual(h.nodes('widget-model-list')[0],list);assert.strictEqual(h.nodes('widget-model')[0],rows[0]);assert.equal(scroll.scrollTop,37);
  assert.equal(rows[0].animations.length,counts[1]+1);assert.equal(rows[1].animations.length,counts[2]);
  assert.equal(h.nodes('widget-model-list').length,1);assert.equal(h.nodes('widget-model').length,2);assert.match(h.html(),/\$23.40/);
  const fade=data.animations.at(-1)!;h.emit({...next,balance:'$23.30',dataKey:'minute-3'});assert.equal(fade.cancelled,true);
  for(const node of [data,...h.nodes('widget-model'),...h.nodes('widget-value')])for(const animation of node.animations)assert.ok(Number(animation.options.duration)>=150 && Number(animation.options.duration)<=250);
  h.unmount();assert.equal(h.mediaListeners.size,0);
});

test('model insertion, deletion and reordering keep surviving rows and never render outgoing duplicates',async()=>{
  const h=await harness(),first=state();h.emit(first);const rows=h.nodes('widget-model'),list=h.nodes('widget-model-list')[0];
  h.emit({...first,models:[first.models[1],model('gemini-3'),first.models[0]],dataKey:'insert'});
  assert.strictEqual(h.nodes('widget-model-list')[0],list);assert.strictEqual(h.nodes('widget-model')[0],rows[1]);assert.strictEqual(h.nodes('widget-model')[2],rows[0]);
  h.emit({...first,models:[first.models[1]],dataKey:'delete'});assert.equal(h.nodes('widget-model').length,1);assert.strictEqual(h.nodes('widget-model')[0],rows[1]);assert.doesNotMatch(h.html(),/gpt-6|gemini-3/);h.unmount();
});

test('reduced motion skips new-data animations and cancels any running emphasis immediately',async()=>{
  const h=await harness({reduced:true});h.emit(state());
  assert.ok([...h.nodes('widget-data'),...h.nodes('widget-model'),...h.nodes('widget-value')].every(node=>node.animations.length===0));
  h.reduced(false);h.emit(state({balance:'$12',dataKey:'motion'}));const animations=[...h.nodes('widget-data'),...h.nodes('widget-value')].flatMap(node=>node.animations);assert.ok(animations.length>0);
  h.reduced(true);assert.ok(animations.every(animation=>animation.cancelled));
  const count=animations.length;h.emit(state({balance:'—',dataKey:'no-motion'}));assert.equal([...h.nodes('widget-data'),...h.nodes('widget-value')].flatMap(node=>node.animations).length,count);assert.match(h.html(),/title="—">—/);h.unmount();
});

test('only close, open and refresh actions are sent; pending refresh locks and failures retain real data',async()=>{
  const h=await harness();h.emit(state());h.button('打开工作台').onClick();h.button('关闭悬浮窗').onClick();await h.flush();
  const pending=deferred<void>();h.setAction(()=>pending.promise);const refresh=h.button('刷新用量');refresh.onClick();refresh.onClick();h.render();assert.equal(h.button('刷新用量').disabled,true);
  assert.deepEqual(JSON.parse(JSON.stringify(h.actions)),[{type:'open'},{type:'close'},{type:'refresh'}]);
  pending.reject(new Error('isolated action failure'));await h.flush();assert.match(h.html(),/刷新失败，请重试/);assert.match(h.html(),/\$23.45/);assert.equal(h.button('刷新用量').disabled,false);
  h.setAction(async()=>{});h.button('刷新用量').onClick();await h.flush();assert.doesNotMatch(h.html(),/刷新失败/);
  const late=deferred<void>();h.setAction(()=>late.promise);h.button('刷新用量').onClick();h.unmount();late.reject(new Error('late failure'));await Promise.resolve();await Promise.resolve();assert.equal(h.staleWrites(),0);
});

test('missing bridge and failed bootstrap show honest placeholders and useful recovery',async()=>{
  const missing=await harness({missingBridge:true});assert.match(missing.html(),/请从 Lumi 工作台打开悬浮窗/);assert.equal(missing.button('刷新用量').disabled,true);assert.match(missing.html(),/title="—">—/);missing.unmount();
  const failed=await harness();failed.snapshot.reject(new Error('isolated bootstrap failure'));await failed.flush();assert.match(failed.html(),/用量暂不可用，请刷新重试/);assert.equal(failed.button('刷新用量').disabled,false);
  failed.emit(state({models:[],balance:'—',cost:'—',minuteLabel:'暂无消费分钟',message:'尚无额度消耗'}));assert.doesNotMatch(failed.html(),/刷新重试/);assert.match(failed.html(),/暂无消费模型/);failed.unmount();
});
