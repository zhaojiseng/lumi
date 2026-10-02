import test,{type TestContext} from 'node:test';
import assert from 'node:assert/strict';
import {build} from 'esbuild';
import {createRequire} from 'node:module';
import {runInNewContext} from 'node:vm';
import {mkdir,mkdtemp,readFile,writeFile,rm} from 'node:fs/promises';
import path from 'node:path';
import * as React from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import {DATA_REFRESH_ANIMATIONS,refreshAnimation,refreshKeyframes,refreshExitKeyframes,type DataRefreshAnimation} from '../shared/motion';
import {DEFAULT_PREFERENCES,type PreferencePatch} from '../shared/types';
import {SettingsStore} from '../electron/services/store';

// Bundle the actual component in memory; mock only hooks, DOM nodes and WAAPI.
// Every animation finishes explicitly. No browser, network or account is used.
const bundle=build({entryPoints:['src/components/DataRefreshMotion.tsx'],bundle:true,platform:'node',format:'cjs',write:false,
  external:['react','react/jsx-runtime'],logLevel:'silent'});
type Props={identity:string;animation:DataRefreshAnimation;children:React.ReactNode;className?:string;resetKey?:string};
type Effect={setup:()=>void|(()=>void);deps?:React.DependencyList;cleanup?:()=>void;dirty:boolean};
type Store={slots:any[];mounted:boolean};
type Motion={frames:Keyframe[];options:KeyframeAnimationOptions;finished:Promise<void>;cancelled:boolean;finish():void;cancel():void};
type Native={props:Record<string,any>;animations:Motion[];animate(frames:Keyframe[],options:KeyframeAnimationOptions):Motion};
const equalDeps=(a?:React.DependencyList,b?:React.DependencyList)=>!!a && !!b && a.length===b.length && a.every((value,i)=>Object.is(value,b[i]));
const content=(name:string,metadata='ready')=>React.createElement('section',{'data-content':name,title:metadata},
  React.createElement('strong',null,name),React.createElement('span',null,metadata));

async function harness(t:TestContext,options:{reduced?:boolean;animation?:DataRefreshAnimation}={}) {
  const stores=new Map<string,Store>(),nodes=new Map<string,Native>(),mediaListeners=new Set<()=>void>(),animations:Motion[]=[];
  let owner:Store,cursor=0,dirty=false,mounted=true,stateWrites=0,staleWrites=0,tree:React.ReactNode,nativeOrder:Native[]=[];
  let props:Props={identity:'A',animation:options.animation || 'slide-up',children:content('A'),className:'refresh-data',resetKey:'account-a'};
  const media={matches:!!options.reduced,
    addEventListener:(event:string,fn:()=>void)=>{assert.equal(event,'change');mediaListeners.add(fn);},
    removeEventListener:(event:string,fn:()=>void)=>{assert.equal(event,'change');mediaListeners.delete(fn);}};
  const nextSlot=(initial:()=>any)=>{const index=cursor++;if(!(index in owner.slots))owner.slots[index]=initial();return index;};
  const effect=(setup:Effect['setup'],deps?:React.DependencyList)=>{
    const index=nextSlot(()=>({setup,deps,dirty:true} satisfies Effect)),slot=owner.slots[index] as Effect;
    if(!equalDeps(slot.deps,deps)){slot.setup=setup;slot.deps=deps;slot.dirty=true;}
  };
  const hooks={...React,
    useRef:(initial:any)=>owner.slots[nextSlot(()=>({current:initial}))],
    useState:(initial:any)=>{const store=owner,index=nextSlot(()=>typeof initial==='function' ? initial() : initial);return [store.slots[index],(value:any)=>{
      stateWrites++;if(!store.mounted){staleWrites++;return;}
      const next=typeof value==='function' ? value(store.slots[index]) : value;
      if(!Object.is(next,store.slots[index])){store.slots[index]=next;dirty=true;}
    }];},
    useLayoutEffect:effect,useEffect:effect,
  };
  const module={exports:{} as {DataRefreshMotion:(props:Props)=>React.ReactNode}},nodeRequire=createRequire(import.meta.url);
  runInNewContext((await bundle).outputFiles[0].text,{module,exports:module.exports,
    window:{matchMedia:(query:string)=>{assert.equal(query,'(prefers-reduced-motion: reduce)');return media;}},
    require:(name:string)=>name==='react' ? hooks : nodeRequire(name)});

  function animation(frames:Keyframe[],options:KeyframeAnimationOptions):Motion {
    let resolve!:()=>void,reject!:(error:Error)=>void;
    const finished=new Promise<void>((yes,no)=>{resolve=yes;reject=no;});
    // A canceled mock enter need not be read by the component to be safely rejected.
    void finished.catch(()=>{});
    const motion:Motion={frames,options,finished,cancelled:false,finish:()=>resolve(),cancel(){this.cancelled=true;reject(new Error('Animation canceled'));}};
    animations.push(motion);return motion;
  }
  function cleanup(store:Store) {
    store.mounted=false;
    for(const slot of store.slots)if(slot && typeof slot.setup==='function')slot.cleanup?.();
  }
  function render() {
    if(!mounted)return;
    for(let pass=0;pass<10;pass++) {
      dirty=false;nativeOrder=[];const usedStores=new Set<string>(),usedNodes=new Set<string>();
      function visit(value:React.ReactNode,location:string):React.ReactNode {
        if(!React.isValidElement<Record<string,any>>(value))return value;
        if(typeof value.type==='function') {
          const id=location+'/'+value.type.name,store=stores.get(id) || {slots:[],mounted:true};
          stores.set(id,store);usedStores.add(id);owner=store;cursor=0;
          return visit((value.type as (props:any)=>React.ReactNode)(value.props),id);
        }
        assert.equal(typeof value.type,'string');const id=location+'/'+value.type;usedNodes.add(id);
        let node=nodes.get(id);
        if(!node){node={props:value.props,animations:[],animate(frames,options){const motion=animation(frames,options);this.animations.push(motion);return motion;}};nodes.set(id,node);}
        node.props=value.props;nativeOrder.push(node);if(value.props.ref)value.props.ref.current=node;
        const children=React.Children.toArray(value.props.children).map((child,i)=>visit(child,id+'/'+(React.isValidElement(child) && child.key!==null ? child.key : i)));
        return React.cloneElement(value,{ref:undefined},...children);
      }
      tree=visit(React.createElement(module.exports.DataRefreshMotion,props),'root');
      for(const [id,store] of stores)if(!usedStores.has(id)){cleanup(store);stores.delete(id);}
      for(const id of nodes.keys())if(!usedNodes.has(id))nodes.delete(id);
      const effects=[...stores.values()].reverse().flatMap(store=>store.slots.filter(slot=>slot && typeof slot.setup==='function' && slot.dirty) as Effect[]);
      for(const slot of effects){slot.dirty=false;slot.cleanup?.();slot.cleanup=undefined;}
      for(const slot of effects){const stop=slot.setup();slot.cleanup=typeof stop==='function' ? stop : undefined;}
      if(!dirty)return;
    }
    throw new Error('Mock layout effects did not settle within ten renders');
  }
  const unmount=()=>{if(!mounted)return;mounted=false;for(const store of stores.values())cleanup(store);stores.clear();nodes.clear();nativeOrder=[];};
  t.after(unmount);render();
  return {
    animations,mediaListeners,
    update:(patch:Partial<Props>)=>{assert.ok(mounted);props={...props,...patch};render();},
    flush:async()=>{await Promise.resolve();await Promise.resolve();if(dirty)render();},
    html:()=>renderToStaticMarkup(tree),
    content:()=>{const list=nativeOrder.filter(node=>Object.hasOwn(node.props,'data-content'));assert.equal(list.length,1,'only one content tree is mounted');return list[0];},
    root:()=>nativeOrder[0],
    assertOneTree:()=>{assert.equal(nativeOrder.filter(node=>Object.hasOwn(node.props,'data-content')).length,1);assert.ok(nativeOrder.slice(1).every(node=>node.animations.length===0),'only the wrapper animates');},
    reduced:(matches:boolean)=>{media.matches=matches;for(const fn of [...mediaListeners])fn();render();},
    unmount,stateWrites:()=>stateWrites,staleWrites:()=>staleWrites,
  };
}

test('refresh presets normalize invalid preferences and encode complementary exit/enter directions',()=>{
  assert.equal(DEFAULT_PREFERENCES.dataRefreshAnimation,'slide-up');
  for(const value of DATA_REFRESH_ANIMATIONS)assert.equal(refreshAnimation(value),value);
  for(const value of [undefined,null,'','invalid','SLIDE-UP',0,{},[]])assert.equal(refreshAnimation(value),'slide-up');
  for(const mode of DATA_REFRESH_ANIMATIONS.filter(mode=>mode!=='none')) {
    const exit=refreshExitKeyframes(mode),enter=refreshKeyframes(mode);
    assert.equal(exit[0].opacity,1);assert.ok(Number(exit.at(-1)!.opacity)<1);
    assert.ok(Number(enter[0].opacity)<1);assert.equal(enter.at(-1)!.opacity,1);
    if(mode==='slide-up' || mode==='slide-down') {
      const direction=mode==='slide-up' ? 1 : -1;
      assert.ok(Number(String(enter[0].transform).match(/-?\d+/)![0])*direction>0);
      assert.ok(Number(String(exit.at(-1)!.transform).match(/-?\d+/)![0])*direction<0);
      assert.equal(enter.at(-1)!.transform,'translateY(0)');
    }
    if(mode==='blur'){assert.equal(exit[0].filter,'blur(0)');assert.equal(enter.at(-1)!.filter,'blur(0)');assert.notEqual(enter[0].filter,'blur(0)');}
    if(mode==='scale'){assert.equal(exit[0].transform,'scale(1)');assert.equal(enter.at(-1)!.transform,'scale(1)');assert.ok(Number(String(enter[0].transform).match(/[\d.]+/)![0])<1);}
    if(mode==='fade')assert.ok([...exit,...enter].every(frame=>frame.transform===undefined && frame.filter===undefined));
  }
});

test('all animated modes retain old content through exit, then swap one tree and enter the latest content',async(t)=>{
  for(const mode of DATA_REFRESH_ANIMATIONS.filter(mode=>mode!=='none')) {
    const h=await harness(t,{animation:mode}),root=h.root(),child=h.content();
    assert.equal(h.animations.length,0,'mount does not animate');
    h.update({identity:'B',children:content('B')});
    assert.equal(h.content().props['data-content'],'A');assert.strictEqual(h.root(),root);h.assertOneTree();
    assert.equal(h.animations.length,1);const exit=h.animations[0];
    assert.ok(Number(exit.frames.at(-1)!.opacity)<Number(exit.frames[0].opacity));assert.equal(exit.options.fill,'forwards');
    await h.flush();assert.equal(h.content().props['data-content'],'A','a microtask alone cannot finish exit');
    exit.finish();await h.flush();
    assert.equal(h.content().props['data-content'],'B');assert.strictEqual(h.root(),root);assert.strictEqual(h.content(),child);h.assertOneTree();
    assert.equal(h.animations.length,2);const enter=h.animations[1];
    assert.ok(Number(enter.frames[0].opacity)<Number(enter.frames.at(-1)!.opacity));
    assert.ok(Number(exit.options.duration)>0 && Number(exit.options.duration)<Number(enter.options.duration));
    enter.finish();await h.flush();assert.equal(h.animations.length,2);assert.equal(h.content().props['data-content'],'B');
    h.unmount();assert.equal(h.mediaListeners.size,0);assert.equal(h.staleWrites(),0);
  }
});

test('same-identity metadata updates show immediately and preserve an active enter animation',async(t)=>{
  const h=await harness(t);
  h.update({children:content('A','loading'),className:'refresh-data dark'});
  assert.equal(h.content().props.title,'loading');assert.match(h.html(),/refresh-data dark/);assert.equal(h.animations.length,0);
  h.update({identity:'B',children:content('B')});h.animations[0].finish();await h.flush();
  const enter=h.animations[1],writes=h.stateWrites();
  for(const metadata of ['loading','error','new timestamp','new theme']) {
    h.update({children:content('B',metadata)});
    assert.equal(h.content().props.title,metadata);assert.equal(h.animations.length,2);assert.equal(enter.cancelled,false);
  }
  assert.equal(h.stateWrites(),writes,'metadata must not schedule another data swap');
});

test('exit retains the last visible same-identity content rather than reverting to its initial metadata',async(t)=>{
  const h=await harness(t);
  h.update({children:content('A','latest metadata')});assert.equal(h.content().props.title,'latest metadata');
  h.update({identity:'B',children:content('B')});
  assert.equal(h.content().props['data-content'],'A');assert.equal(h.content().props.title,'latest metadata');
  h.animations[0].finish();await h.flush();assert.equal(h.content().props['data-content'],'B');
});

test('rapid updates during exit cancel superseded work and swap only the latest payload',async(t)=>{
  const h=await harness(t);
  h.update({identity:'B',children:content('B')});const first=h.animations[0];
  first.finish(); // Its fulfillment is queued, but C supersedes it before that microtask runs.
  h.update({identity:'C',children:content('C')});assert.equal(first.cancelled,true);
  h.update({identity:'D',children:content('D')});assert.equal(h.animations[1].cancelled,true);
  assert.equal(h.animations.length,3);assert.equal(h.content().props['data-content'],'A');h.assertOneTree();
  await h.flush();assert.equal(h.content().props['data-content'],'A','stale fulfilled exit cannot commit B or C');
  h.update({children:content('D','latest metadata')});assert.equal(h.animations.length,3);
  h.animations[2].finish();await h.flush();
  assert.equal(h.content().props['data-content'],'D');assert.equal(h.content().props.title,'latest metadata');
  assert.equal(h.animations.length,4);h.assertOneTree();assert.equal(h.staleWrites(),0);
});

test('an update during enter cancels that animation immediately before starting the next exit',async(t)=>{
  const h=await harness(t);
  h.update({identity:'B',children:content('B')});h.animations[0].finish();await h.flush();
  const enter=h.animations[1];h.update({identity:'C',children:content('C')});
  assert.equal(enter.cancelled,true,'superseded enter must not animate the wrapper alongside the new exit');
  assert.equal(h.animations.length,3);assert.equal(h.content().props['data-content'],'B');
  h.animations[2].finish();await h.flush();assert.equal(h.content().props['data-content'],'C');h.assertOneTree();
});

test('none and initially reduced motion swap immediately without either animation phase',async(t)=>{
  for(const options of [{animation:'none' as const},{reduced:true}]) {
    const h=await harness(t,options);
    h.update({identity:'B',children:content('B')});assert.equal(h.content().props['data-content'],'B');
    h.update({identity:'C',children:content('C')});assert.equal(h.content().props['data-content'],'C');
    assert.equal(h.animations.length,0);assert.equal(h.mediaListeners.size,0);h.assertOneTree();
    await h.flush();assert.equal(h.content().props['data-content'],'C');
  }
});

test('changing animation mode during exit cancels the old phase and uses the new mode for both phases',async(t)=>{
  const h=await harness(t);
  h.update({identity:'B',children:content('B')});const first=h.animations[0];first.finish();
  h.update({animation:'blur'});assert.equal(first.cancelled,true);assert.equal(h.animations.length,2);
  assert.ok(h.animations[1].frames.at(-1)!.filter);assert.equal(h.content().props['data-content'],'A');
  await h.flush();assert.equal(h.content().props['data-content'],'A');
  h.animations[1].finish();await h.flush();assert.equal(h.content().props['data-content'],'B');
  assert.equal(h.animations.length,3);assert.ok(h.animations[2].frames[0].filter);
});

test('changing mode to none cancels exit or enter and leaves the latest content immediately visible',async(t)=>{
  for(const phase of ['exit','enter']) {
    const h=await harness(t);h.update({identity:'B',children:content('B')});
    if(phase==='enter'){h.animations[0].finish();await h.flush();}
    const active=h.animations.at(-1)!,count=h.animations.length;active.finish();h.update({animation:'none'});
    assert.equal(active.cancelled,true);assert.equal(h.content().props['data-content'],'B');assert.equal(h.animations.length,count);
    assert.equal(h.mediaListeners.size,0);await h.flush();assert.equal(h.animations.length,count);h.assertOneTree();
  }
});

test('reduced motion enabled mid-exit or mid-enter cancels motion and cannot replay a queued completion',async(t)=>{
  for(const phase of ['exit','enter']) {
    const h=await harness(t);h.update({identity:'B',children:content('B')});
    if(phase==='enter'){h.animations[0].finish();await h.flush();}
    const active=h.animations.at(-1)!,count=h.animations.length;
    active.finish();h.reduced(true);assert.equal(active.cancelled,true);assert.equal(h.content().props['data-content'],'B');
    await h.flush();assert.equal(h.animations.length,count,'queued exit must not start enter after reduction is enabled');
    h.update({identity:'C',children:content('C')});assert.equal(h.content().props['data-content'],'C');assert.equal(h.animations.length,count);
    assert.equal(h.mediaListeners.size,0);h.reduced(false);assert.equal(h.animations.length,count,'reenabling motion alone does not replay data');
    h.update({identity:'D',children:content('D')});assert.equal(h.animations.length,count+1);assert.equal(h.content().props['data-content'],'C');
  }
});

test('resetKey clears the previous account immediately during exit or enter and rejects stale completions',async(t)=>{
  for(const phase of ['exit','enter']) {
    const h=await harness(t);h.update({identity:'B',children:content('B')});
    if(phase==='enter'){h.animations[0].finish();await h.flush();}
    const active=h.animations.at(-1)!,count=h.animations.length;active.finish();
    h.update({identity:'empty-account-b',resetKey:'account-b',children:content('No account data')});
    assert.equal(active.cancelled,true);assert.equal(h.animations.length,count);assert.equal(h.content().props['data-content'],'No account data');
    assert.doesNotMatch(h.html(),/data-content="[AB]"/);h.assertOneTree();
    await h.flush();assert.equal(h.animations.length,count);assert.equal(h.content().props['data-content'],'No account data');assert.equal(h.mediaListeners.size,0);
  }
});

test('unmount cancels both phases, removes listeners and prevents fulfilled exit from writing state',async(t)=>{
  for(const phase of ['exit','enter'])for(const queued of [false,true]) {
    const h=await harness(t);h.update({identity:'B',children:content('B')});
    if(phase==='enter'){h.animations[0].finish();await h.flush();}
    const active=h.animations.at(-1)!;if(queued)active.finish();const writes=h.stateWrites(),count=h.animations.length;
    h.unmount();assert.equal(active.cancelled,true);assert.equal(h.mediaListeners.size,0);
    active.finish();await h.flush();
    assert.equal(h.stateWrites(),writes,'unmounted completion cannot call setState');assert.equal(h.staleWrites(),0);assert.equal(h.animations.length,count);
  }
});

async function isolatedStore(t:TestContext) {
  const parent=path.resolve('.test-data');await mkdir(parent,{recursive:true});const root=await mkdtemp(path.join(parent,'data-refresh-motion-'));
  t.after(async()=>{assert.equal(path.dirname(root),parent,'only the isolated fixture directory may be removed');await rm(root,{recursive:true,force:true});});
  const cipher={available:()=>false,encrypt:()=>{throw new Error('Fixture must never store credentials');},decrypt:()=>{throw new Error('Fixture must never read credentials');}};
  const store=new SettingsStore(root,cipher);await store.load();
  return {store,root,cipher};
}

test('animation preferences roundtrip every mode through an isolated SettingsStore with no credentials',async(t)=>{
  const {store,root,cipher}=await isolatedStore(t);
  assert.equal(store.preferences.dataRefreshAnimation,'slide-up');
  const siteIdentity=(site:typeof store.preferences.sites[number])=>({id:site.id,name:site.name,url:site.url,allowHttp:site.allowHttp});
  const sites=store.preferences.sites.map(siteIdentity),activeSiteId=store.preferences.activeSiteId;
  for(const mode of DATA_REFRESH_ANIMATIONS) {
    const saved=await store.update({dataRefreshAnimation:mode});assert.equal(saved.dataRefreshAnimation,mode);
    const persisted=JSON.parse(await readFile(path.join(root,'settings.json'),'utf8'));
    assert.equal(persisted.preferences.dataRefreshAnimation,mode);assert.equal(persisted.vault,'');
    const restored=new SettingsStore(root,cipher);await restored.load();assert.equal(restored.preferences.dataRefreshAnimation,mode);
    assert.equal(restored.preferences.activeSiteId,activeSiteId);assert.deepEqual(restored.preferences.sites.map(siteIdentity),sites);
    assert.ok(restored.preferences.sites.every(site=>!site.accessTokenConfigured && !site.apiKeyConfigured && !site.sessionAuth && site.username===undefined));
    assert.deepEqual(restored.credentials(),{});
  }
});

test('invalid or absent saved animation falls back to slide-up on load and on update',async(t)=>{
  const {store,root,cipher}=await isolatedStore(t),file=path.join(root,'settings.json');
  for(const value of [undefined,null,'invalid','SLIDE-UP',0,{}]) {
    const preferences={...structuredClone(DEFAULT_PREFERENCES),dataRefreshAnimation:value};
    await writeFile(file,JSON.stringify({version:2,preferences,vault:''}),'utf8');
    const restored=new SettingsStore(root,cipher);await restored.load();assert.equal(restored.preferences.dataRefreshAnimation,'slide-up');
    await store.update({dataRefreshAnimation:'none'});
    const saved=await store.update({dataRefreshAnimation:value} as unknown as PreferencePatch);
    assert.equal(saved.dataRefreshAnimation,'slide-up');
    assert.equal(JSON.parse(await readFile(file,'utf8')).preferences.dataRefreshAnimation,'slide-up');
  }
});
