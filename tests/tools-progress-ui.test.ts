import test from 'node:test';
import assert from 'node:assert/strict';
import {build} from 'esbuild';
import {createRequire} from 'node:module';
import {runInNewContext} from 'node:vm';
import * as React from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import type {AppState} from '../src/context';
import {DEFAULT_PREFERENCES,type BackupInfo,type ConfigPreview,type ConfigProgress,type ConfigRequest,type Tool,type ToolConfigState} from '../shared/types';

// Bundle the real page in memory. Every bridge action is an isolated stub;
// child components render normally through React's server renderer.
const bundle=build({
  stdin:{contents:"export {default as Tools,ConfigFeedback} from './src/pages/Tools'; export {AppContext} from './src/context';",resolveDir:process.cwd(),loader:'tsx'},
  bundle:true,platform:'node',format:'cjs',write:false,external:['react','react/jsx-runtime','react-dom'],loader:{'.css':'empty','.svg':'text'},logLevel:'silent',
});
function deferred<T>() {
  let resolve!:(value:T)=>void,reject!:(reason:unknown)=>void;
  const promise=new Promise<T>((yes,no)=>{resolve=yes;reject=no;});
  return {promise,resolve,reject};
}
async function settlesWithin<T>(promise:Promise<T>) {
  let timer:ReturnType<typeof setTimeout>|undefined;
  try{return await Promise.race([promise,new Promise<never>((_,reject)=>{timer=setTimeout(()=>reject(new Error('operation waited for bootstrap')),1000);})]);}
  finally{clearTimeout(timer);}
}
const request=(tool:Tool='codex'):ConfigRequest=>({tool,model:tool==='codex' ? 'gateway.codex-actual' : 'gateway.claude-actual',group:'standard'});
const previewFor=(tool:Tool='codex'):ConfigPreview=>({id:tool+'-preview',tool,files:[{path:'C:/isolated/'+tool+'/config',before:'original',after:'model = "'+request(tool).model+'"'}],changes:['使用 '+request(tool).model],expiresAt:Date.now()+600000,token:{id:7,name:'Lumi-'+tool,group:'standard',created:false}});
const configFor=(tool:Tool='codex',model=request(tool).model):ToolConfigState=>({tool,exists:true,path:'C:/isolated/'+tool+'/config',model,baseUrl:'https://fixture.invalid/v1',keyConfigured:true});
const backup:BackupInfo={id:'isolated-backup',tool:'claude',createdAt:1,paths:['C:/isolated/claude/config']};
type Element=React.ReactElement<Record<string,any>>;
function elements(node:React.ReactNode):Element[] {
  return React.Children.toArray(node).flatMap(child=>React.isValidElement<Record<string,any>>(child) ? [child,...elements(child.props.children),...elements(child.props.action)] : []);
}
function content(node:React.ReactNode):string {
  return React.Children.toArray(node).map(child=>React.isValidElement<Record<string,any>>(child) ? content(child.props.children) : String(child)).join('');
}
async function harness() {
  const listeners=new Set<(p:ConfigProgress)=>void>(),runtimeListeners=new Set<Function>(),focusListeners=new Set<Function>();
  const calls={preview:0,apply:0,restore:0,backups:0,reload:0,refresh:0};
  const notices:{message:string;kind?:string}[]=[];
  const bridge={
    toolRuntimes:async()=>[],onToolRuntime:(fn:Function)=>{runtimeListeners.add(fn);return()=>runtimeListeners.delete(fn);},
    onConfigProgress:(fn:(p:ConfigProgress)=>void)=>{listeners.add(fn);return()=>listeners.delete(fn);},
    previewConfig:async(req:ConfigRequest)=>{calls.preview++;return previewFor(req.tool);},
    applyConfig:async(_id:string)=>{calls.apply++;return [configFor()];},
    backups:async()=>{calls.backups++;return [backup];},
    restoreBackup:async(_id:string)=>{calls.restore++;return [configFor('claude','restored-real-model')];},
  };
  const preferences=structuredClone(DEFAULT_PREFERENCES);
  preferences.sites[0]={...preferences.sites[0],url:'https://fixture.invalid',accessTokenConfigured:true,userId:1};
  preferences.bindings=preferences.bindings.map(b=>({...b,model:request(b.tool).model,group:'standard'}));
  const app:AppState={
    preferences,bootstrap:{preferences,desktop:true,version:'0.4.28',secureStorage:true,configs:[configFor('codex','original-model')]},
    dashboard:{status:{system_name:'Fixture',quota_per_unit:500000},user:{id:1,username:'fixture',display_name:'Fixture',quota:0,used_quota:0,request_count:0,group:'standard'},
      logs:{items:[],total:0,page:1,pageSize:100},series:[],stat:null,tokens:[],warnings:[],fetchedAt:1,days:7,
      catalog:{models:(['codex','claude'] as const).map(tool=>({model_name:request(tool).model,quota_type:0,model_ratio:1,model_price:0,completion_ratio:1,enable_groups:['standard'],supported_endpoint_types:[]})),groupRatio:{standard:1},usableGroups:{standard:'标准'},autoGroups:[],vendors:[]}},
    openLogin:()=>{},page:'tools',setPage:()=>{},days:7,setDays:()=>{},overviewQuery:7,setOverviewQuery:()=>{},statisticsQuery:{range:7},loading:false,error:'',
    updatePreferences:async()=>{},setPreferences:()=>{},configureModel:()=>{},
    reloadBootstrap:async()=>{calls.reload++;},refresh:async()=>{calls.refresh++;},toast:(message,kind)=>notices.push({message,kind}),
  };
  // Replay only the page's hooks, allowing controlled deferred responses without a DOM.
  // Children still use real hooks; no production internals or hook indices are inspected.
  type Store={slots:any[];effects:{setup:()=>void|(()=>void);cleanup?:()=>void;started:boolean}[];mounted:boolean};
  let store:Store={slots:[],effects:[],mounted:true},cursor=0,inPage=false,key:string|null=null,staleWrites=0;
  const hooks={...React,
    useContext:(ctx:React.Context<unknown>)=>inPage ? app : React.useContext(ctx),
    useState:(initial:any)=>{
      if(!inPage)return React.useState(initial);
      const owner=store,index=cursor++;
      if(!(index in owner.slots))owner.slots[index]=typeof initial==='function' ? initial() : initial;
      return [owner.slots[index],(value:any)=>{if(!owner.mounted)staleWrites++;owner.slots[index]=typeof value==='function' ? value(owner.slots[index]) : value;}];
    },
    useRef:(initial:any)=>{
      if(!inPage)return React.useRef(initial);
      const index=cursor++;if(!(index in store.slots))store.slots[index]={current:initial};return store.slots[index];
    },
    useEffect:(setup:()=>void|(()=>void),deps?:React.DependencyList)=>{
      if(!inPage)return React.useEffect(setup,deps);
      const index=cursor++;if(!(index in store.slots)){const effect={setup,started:false};store.slots[index]=effect;store.effects.push(effect);}
    },
  };
  const module={exports:{} as Record<string,any>},nodeRequire=createRequire(import.meta.url);
  runInNewContext((await bundle).outputFiles[0].text,{module,exports:module.exports,structuredClone,
    window:{lumi:bridge,addEventListener:(_name:string,fn:Function)=>focusListeners.add(fn),removeEventListener:(_name:string,fn:Function)=>focusListeners.delete(fn)},
    require:(name:string)=>name==='react' ? hooks : nodeRequire(name)});
  const {Tools,AppContext,ConfigFeedback}=module.exports;
  function cleanup(){for(const effect of store.effects)effect.cleanup?.();store.mounted=false;}
  function render():Element {
    inPage=true;
    try{
      const root=Tools() as Element;
      if(key!==root.key){if(key!==null)cleanup();store={slots:[],effects:[],mounted:true};key=root.key;}
      cursor=0;const tree=(root.type as Function)() as Element;
      for(const effect of store.effects)if(!effect.started){effect.started=true;const stop=effect.setup();if(typeof stop==='function')effect.cleanup=stop;}
      return tree;
    }finally{inPage=false;}
  }
  function html(){return renderToStaticMarkup(React.createElement(AppContext.Provider,{value:app},render()));}
  function button(label:string) {
    const found=elements(render()).find(node=>(node.type as Function).name==='Button' && content(node.props.children)===label);
    assert.ok(found,'button '+label+' exists');return found.props;
  }
  function form(tool:Tool='codex') {
    const found=elements(render()).find(node=>(node.type as Function).name==='ToolForm' && node.props.tool===tool);
    assert.ok(found);return found.props;
  }
  function modal(title:string){return elements(render()).find(node=>(node.type as Function).name==='Modal' && node.props.title===title)?.props;}
  render();await Promise.resolve();
  return {app,bridge,calls,notices,html,button,form,modal,render,unmount:cleanup,listeners,runtimeListeners,focusListeners,
    emit:(progress:ConfigProgress)=>{for(const listener of listeners)listener(progress);},
    staleWrites:()=>staleWrites,
    feedback:(props:object)=>renderToStaticMarkup(React.createElement(ConfigFeedback,props)),
  };
}

test('each operation renders clear Chinese phases, with no implementation terms or invented percentages',async()=>{
  const h=await harness();
  for(const operation of ['preview','apply','restore'] as const)for(const phase of ['validating','key','history','backup','writing','done'] as const){
    const html=h.feedback({pending:{tool:'codex',operation,progress:{tool:'codex',operation,phase}}});
    assert.match(html,/role="status"/);assert.match(html,/Codex · /);
    assert.doesNotMatch(html,/undefined|SQLite|JSONL|SCPI|IPC|\d+%|progressbar|aria-valuenow|已处理/);
  }
  const waiting=h.feedback({pending:{tool:'claude',operation:'restore'}});
  assert.match(waiting,/Claude Code · 正在恢复配置/);assert.doesNotMatch(waiting,/\d+%|已处理|校验/);
  h.unmount();
});

test('only actual counts are displayed, and unknown or malformed totals never manufacture completion',async()=>{
  const h=await harness();
  const render=(completed?:number,total?:number)=>h.feedback({pending:{tool:'codex',operation:'apply',progress:{tool:'codex',operation:'apply',phase:'history',completed,total}}});
  assert.match(render(3,12),/本阶段已处理 3 \/ 12 项/);
  assert.match(render(0,0),/本阶段已处理 0 项/);
  for(const total of [undefined,-1,NaN,Infinity,2]){assert.match(render(3,total),/本阶段已处理 3 项/);assert.doesNotMatch(render(3,total),/ \/ |100%/);}
  for(const completed of [undefined,-1,NaN,Infinity,1.5])assert.doesNotMatch(render(completed,12),/已处理|NaN|Infinity|%/);
  h.unmount();
});

test('preview locks both tools synchronously, filters unrelated progress and resets counts between phases',async()=>{
  const h=await harness(),pending=deferred<ConfigPreview>();
  h.bridge.previewConfig=async()=>{h.calls.preview++;return pending.promise;};
  const codex=h.form(),claude=h.form('claude');
  const first=codex.onPreview(request());await claude.onPreview(request('claude'));await codex.onPreview(request());
  assert.equal(h.calls.preview,1);assert.equal(h.form().locked,true);assert.equal(h.form('claude').locked,true);
  h.emit({tool:'claude',operation:'preview',phase:'key'});h.emit({tool:'codex',operation:'apply',phase:'history',completed:99,total:100});
  assert.match(h.html(),/正在准备配置预览/);assert.doesNotMatch(h.html(),/已处理|正在准备专用密钥/);
  h.emit({tool:'codex',operation:'preview',phase:'key',completed:1,total:2});assert.match(h.html(),/本阶段已处理 1 \/ 2 项/);
  h.emit({tool:'codex',operation:'preview',phase:'done'});assert.doesNotMatch(h.html(),/已处理/);assert.equal(h.form('claude').locked,true);
  pending.resolve(previewFor());await first;
  assert.ok(h.modal('确认配置变更'));assert.equal(h.calls.apply,0);
  assert.match(h.html(),/gateway.codex-actual|相关历史对话会在应用时检查并同步/);
  h.modal('确认配置变更')!.onClose();assert.equal(h.form().locked,false);h.unmount();
});

test('apply displays returned config and success immediately while bootstrap remains pending, without dashboard refresh',async()=>{
  const h=await harness(),writing=deferred<ToolConfigState[]>(),reload=deferred<void>();
  h.bridge.applyConfig=async()=>{h.calls.apply++;return writing.promise;};
  h.app.reloadBootstrap=async()=>{h.calls.reload++;return reload.promise;};
  await h.form().onPreview(request());
  const apply=h.button('备份并应用').onClick(),duplicate=h.button('备份并应用').onClick();
  await duplicate;assert.equal(h.calls.apply,1);
  h.emit({tool:'codex',operation:'apply',phase:'history',completed:4,total:8});assert.match(h.html(),/本阶段已处理 4 \/ 8 项/);
  h.emit({tool:'codex',operation:'apply',phase:'backup'});assert.doesNotMatch(h.html(),/已处理/);
  h.emit({tool:'codex',operation:'apply',phase:'done'});assert.equal(h.button('取消').disabled,true);
  h.modal('确认配置变更')!.onClose();assert.ok(h.modal('确认配置变更'));
  writing.resolve([configFor('codex','applied-returned-model')]);
  await settlesWithin(apply);
  assert.match(h.html(),/applied-returned-model/);assert.equal(h.modal('确认配置变更'),undefined);
  assert.equal(h.form().locked,false);assert.equal(h.calls.reload,1);assert.equal(h.calls.refresh,0);assert.equal(h.notices.at(-1)?.kind,'success');
  reload.reject(new Error('isolated reload failure'));await Promise.resolve();await Promise.resolve();
  assert.equal(h.notices.at(-1)?.kind,'success');assert.doesNotMatch(h.html(),/isolated reload failure|role="alert"/);assert.match(h.html(),/配置已生效，但同步设置失败/);h.unmount();
});

test('preview and apply failures preserve selections and confirmation, release locks, and allow retry',async()=>{
  const h=await harness();
  h.bridge.previewConfig=async()=>{throw new Error('专用密钥暂不可用');};
  await h.form().onPreview(request());assert.match(h.html(),/role="alert">专用密钥暂不可用/);assert.equal(h.form().locked,false);
  assert.match(h.html(),/<option value="gateway.codex-actual"[^>]*selected="">gateway.codex-actual/);
  h.bridge.previewConfig=async()=>previewFor();await h.form().onPreview(request());
  h.bridge.applyConfig=async()=>{throw new Error('文件被其他程序修改');};
  await h.button('备份并应用').onClick();assert.ok(h.modal('确认配置变更'));assert.equal(h.button('取消').disabled,false);
  assert.match(h.html(),/role="alert">文件被其他程序修改/);assert.equal(h.calls.reload,0);
  h.bridge.applyConfig=async()=>[configFor()];await h.button('备份并应用').onClick();assert.equal(h.modal('确认配置变更'),undefined);h.unmount();
});

test('restore keeps confirmation on failure and blocks cancellation while waiting for real completion',async()=>{
  const h=await harness(),restoring=deferred<ToolConfigState[]>();
  await h.button('配置备份').onClick();h.button('恢复').onClick();
  h.bridge.restoreBackup=async()=>{throw new Error('当前文件已变化');};await h.button('备份并恢复').onClick();
  assert.ok(h.modal('恢复配置'));assert.match(h.html(),/role="alert">当前文件已变化/);assert.equal(h.button('取消').disabled,false);
  h.bridge.restoreBackup=async()=>{h.calls.restore++;return restoring.promise;};
  const first=h.button('备份并恢复').onClick();await h.button('备份并恢复').onClick();assert.equal(h.calls.restore,1);
  h.emit({tool:'codex',operation:'restore',phase:'writing'});assert.doesNotMatch(h.html(),/Codex · 正在恢复配置/);
  h.emit({tool:'claude',operation:'restore',phase:'backup'});assert.match(h.html(),/Claude Code · 正在备份当前配置/);
  h.button('取消').onClick();h.modal('恢复配置')!.onClose();assert.ok(h.modal('恢复配置'));assert.equal(h.button('取消').disabled,true);
  restoring.resolve([configFor('claude','restored-real-model')]);await first;
  assert.equal(h.modal('恢复配置'),undefined);assert.match(h.html(),/restored-real-model/);assert.equal(h.notices.at(-1)?.kind,'success');assert.equal(h.calls.refresh,0);h.unmount();
});

test('late preview, apply, restore and backup-list promises cannot update a new site or an unmounted page',async()=>{
  for(const kind of ['preview','apply','restore','backups'] as const)for(const switchSite of [false,true]){
    const h=await harness(),late=deferred<any>();let waiting:Promise<void>;
    if(kind==='preview'){h.bridge.previewConfig=async()=>late.promise;waiting=h.form().onPreview(request());}
    else if(kind==='apply'){await h.form().onPreview(request());h.bridge.applyConfig=async()=>late.promise;waiting=h.button('备份并应用').onClick();}
    else if(kind==='restore'){await h.button('配置备份').onClick();h.button('恢复').onClick();h.bridge.restoreBackup=async()=>late.promise;waiting=h.button('备份并恢复').onClick();}
    else{h.bridge.backups=async()=>late.promise;waiting=h.button('配置备份').onClick();}
    if(switchSite){h.app.preferences={...h.app.preferences,activeSiteId:'new-site',sites:[{...h.app.preferences.sites[0],id:'new-site',url:'https://other.invalid'}]};h.render();await Promise.resolve();}
    else h.unmount();
    const noticeCount=h.notices.length;
    late.resolve(kind==='preview' ? previewFor() : kind==='backups' ? [backup] : [configFor()]);await waiting;
    assert.equal(h.staleWrites(),0,kind+' stale state write');assert.equal(h.notices.length,noticeCount);assert.equal(h.calls.reload,0);
    if(switchSite){assert.equal(h.modal('确认配置变更'),undefined);assert.equal(h.modal('恢复配置'),undefined);assert.equal(h.modal('配置备份'),undefined);h.unmount();}
    assert.equal(h.listeners.size,0);assert.equal(h.runtimeListeners.size,0);assert.equal(h.focusListeners.size,0);
  }
});

test('site URL and account changes invalidate a prepared preview even when the site ID stays the same',async()=>{
  for(const patch of [{url:'https://new.invalid'},{userId:2},{accessTokenConfigured:false}]){
    const h=await harness();await h.form().onPreview(request());assert.ok(h.modal('确认配置变更'));
    h.app.preferences={...h.app.preferences,sites:[{...h.app.preferences.sites[0],...patch}]};h.render();
    assert.equal(h.modal('确认配置变更'),undefined);assert.equal(h.form().locked,false);assert.equal(h.calls.apply,0);h.unmount();
  }
});

test('late background synchronization errors stay out of a new site, an unmounted page, or a newer operation',async()=>{
  for(const next of ['unmount','site','operation'] as const){
    const h=await harness(),reload=deferred<void>();
    h.app.reloadBootstrap=async()=>reload.promise;
    await h.form().onPreview(request());await h.button('备份并应用').onClick();
    if(next==='unmount')h.unmount();
    else if(next==='site'){h.app.preferences={...h.app.preferences,sites:[{...h.app.preferences.sites[0],url:'https://other.invalid'}]};h.render();await Promise.resolve();}
    else await h.form('claude').onPreview(request('claude'));
    reload.reject(new Error('late synchronization failure'));await Promise.resolve();await Promise.resolve();
    assert.equal(h.staleWrites(),0);assert.equal(h.notices.at(-1)?.kind,'success');
    if(next!=='unmount'){assert.doesNotMatch(h.html(),/同步设置失败|late synchronization failure/);h.unmount();}
  }
});

test('backup-list loading prevents duplicate reads and concurrent previews until the list resolves',async()=>{
  const h=await harness(),reading=deferred<BackupInfo[]>();
  h.bridge.backups=async()=>{h.calls.backups++;return reading.promise;};
  const button=h.button('配置备份'),form=h.form();
  const waiting=button.onClick();await button.onClick();await form.onPreview(request());
  assert.equal(h.calls.backups,1);assert.equal(h.calls.preview,0);assert.equal(h.form('claude').locked,true);
  reading.resolve([backup]);await waiting;assert.ok(h.modal('配置备份'));
  h.modal('配置备份')!.onClose();assert.equal(h.form().locked,false);h.unmount();
});

test('a site change retains the in-flight operation lock and ignores its progress until it settles',async()=>{
  const h=await harness(),old=deferred<ConfigPreview>();
  h.bridge.previewConfig=async()=>{h.calls.preview++;return old.promise;};
  const waiting=h.form().onPreview(request());
  h.app.preferences={...h.app.preferences,sites:[{...h.app.preferences.sites[0],url:'https://new.invalid'}]};h.render();await Promise.resolve();
  assert.equal(h.form().locked,true);assert.match(h.html(),/上一项工具配置操作仍在处理中/);
  await h.form().onPreview(request());assert.equal(h.calls.preview,1);
  h.emit({tool:'codex',operation:'preview',phase:'key',completed:1,total:2});
  assert.doesNotMatch(h.html(),/正在准备专用密钥|已处理/);
  old.resolve(previewFor());await waiting;
  assert.equal(h.form().locked,false);assert.equal(h.modal('确认配置变更'),undefined);assert.equal(h.staleWrites(),0);h.unmount();
});
