import {StrictMode,useEffect,useLayoutEffect,useRef,useState} from 'react';
import {createRoot} from 'react-dom/client';
import {ArrowUpRight,Clock3,RefreshCw,X} from 'lucide-react';
import {Logo} from './components/ui';
import {ProviderIcon} from './components/BrandIcon';
import type {WidgetAction,WidgetBridge,WidgetModel,WidgetState} from '../shared/widget';
import './widget.css';

declare global {interface Window {lumiWidget?:WidgetBridge;}}

type Motion='snapshot'|'number'|'row';
function useDataMotion<T extends HTMLElement>(identity:string,kind:Motion,enter=false) {
  const element=useRef<T>(null),previous=useRef<string|null>(null);
  useLayoutEffect(()=>{
    const changed=previous.current!==null ? previous.current!==identity : enter;
    previous.current=identity;
    const node=element.current;
    if(!changed || !node || typeof node.animate!=='function')return;
    const media=window.matchMedia('(prefers-reduced-motion: reduce)');
    if(media.matches)return;
    const frames:Keyframe[]=kind==='row'
      ? [{opacity:.72,backgroundColor:getComputedStyle(node).getPropertyValue('--accent-soft')},{opacity:1,backgroundColor:'transparent'}]
      : kind==='number' ? [{opacity:.6,transform:'translateY(2px)'},{opacity:1,transform:'translateY(0)'}]
      : [{opacity:.82},{opacity:1}];
    // Animate the current DOM only; superseding data cancels the previous emphasis.
    const animation=node.animate(frames,{duration:kind==='row' ? 220 : kind==='number' ? 180 : 200,easing:'ease-out'});
    const reduce=()=>{if(media.matches)animation.cancel();};
    media.addEventListener('change',reduce);
    return ()=>{media.removeEventListener('change',reduce);animation.cancel();};
  },[identity,kind,enter]);
  return element;
}

function Value({value}:{value:string}) {
  const ref=useDataMotion<HTMLSpanElement>(value,'number');
  return <span className="widget-value" ref={ref} title={value}>{value}</span>;
}

function ModelRow({model}:{model:WidgetModel}) {
  const identity=JSON.stringify([model.cost,model.requests,model.input,model.output,model.cacheRead,model.cacheWrite]);
  const ref=useDataMotion<HTMLLIElement>(identity,'row',true);
  return <li className="widget-model" ref={ref}>
    <div className="widget-model-heading">
      <ProviderIcon modelName={model.name} size={16} className="widget-model-icon"/>
      <h3 title={model.name}>{model.name}</h3>
      <div className="widget-model-charge"><strong aria-label={'消费 '+model.cost}><Value value={model.cost}/></strong><span><Value value={model.requests}/> 次请求</span></div>
    </div>
    <dl className="widget-tokens" aria-label={model.name+' 的 Tokens'}>
      {([['输入',model.input],['输出',model.output],['缓存读取',model.cacheRead],['缓存写入',model.cacheWrite]] as const).map(([label,value])=><div key={label}><dt>{label}</dt><dd><Value value={value}/></dd></div>)}
    </dl>
  </li>;
}

const initialState:WidgetState={phase:'idle',enabled:false,siteName:'Lumi',balance:'—',cost:'—',minuteLabel:'暂无消费分钟',historical:false,models:[],message:'正在读取用量…',updatedAt:0,viewKey:'',dataKey:'',theme:'light'};

export function WidgetApp() {
  const [state,setState]=useState<WidgetState>(initialState),[error,setError]=useState(''),[refreshing,setRefreshing]=useState(false);
  const alive=useRef(false),pending=useRef(false),data=useDataMotion<HTMLDivElement>(state.dataKey,'snapshot');
  useEffect(()=>{
    alive.current=true;
    const bridge=window.lumiWidget;
    if(!bridge){setError('请从 Lumi 工作台打开悬浮窗。');return ()=>{alive.current=false;};}
    let active=true,streamed=false;
    const receive=(next:WidgetState)=>{if(active){setState(next);setError('');}};
    // Subscribe first. Any streamed state takes precedence over a late bootstrap.
    const stop=bridge.onState(next=>{streamed=true;receive(next);});
    void bridge.snapshot().then(next=>{if(!streamed)receive(next);}).catch(()=>{if(active && !streamed)setError('用量暂不可用，请刷新重试。');});
    return ()=>{active=false;alive.current=false;stop();};
  },[]);

  const action=async(event:WidgetAction)=>{
    const bridge=window.lumiWidget;
    if(!bridge || (event.type==='refresh' && (pending.current || state.phase==='loading')))return;
    if(event.type==='refresh'){pending.current=true;setRefreshing(true);}
    setError('');
    try{await bridge.action(event);}
    catch{if(alive.current)setError(event.type==='refresh' ? '刷新失败，请重试。' : '操作失败，请重试。');}
    finally{if(event.type==='refresh'){pending.current=false;if(alive.current)setRefreshing(false);}}
  };
  const loading=state.phase==='loading' || refreshing;
  const updated=state.updatedAt>0 && Number.isFinite(state.updatedAt) ? new Date(state.updatedAt) : null;
  const updatedLabel=updated && Number.isFinite(updated.getTime()) ? updated.toLocaleTimeString('zh-CN',{hour:'2-digit',minute:'2-digit',second:'2-digit',hour12:false}) : null;
  const costLabel=state.historical ? '最近付费分钟消费' : '上一完整分钟消费';
  const message=error || state.message;
  return <main className="widget-card" data-theme={state.theme} aria-label="Lumi 悬浮用量">
    <header className="widget-header">
      <Logo small/>
      <div className="widget-brand"><h1 title={state.siteName}>{state.siteName}</h1><span>分钟用量 · 拖动此处移动</span></div>
      <nav className="widget-actions" aria-label="悬浮窗操作">
        <button type="button" title="打开工作台" aria-label="打开工作台" disabled={!window.lumiWidget} onClick={()=>void action({type:'open'})}><ArrowUpRight size={17}/></button>
        <button type="button" title="关闭悬浮窗" aria-label="关闭悬浮窗" disabled={!window.lumiWidget} onClick={()=>void action({type:'close'})}><X size={16}/></button>
      </nav>
    </header>
    <div className="widget-data" ref={data}>
      <section className="widget-summary" aria-label="余额与分钟消费">
        <dl className="widget-totals"><div><dt>账户余额</dt><dd><Value value={state.balance}/></dd></div><div><dt>{costLabel}</dt><dd><Value value={state.cost}/></dd></div></dl>
        <div className="widget-minute" aria-label="消费分钟" title={state.historical ? '显示最近一次有付费消费的分钟' : '显示上一已结束的完整分钟'}><Clock3 size={12} aria-hidden="true"/><span title={state.minuteLabel}>{state.minuteLabel}</span>{state.historical && <small>历史分钟</small>}</div>
      </section>
      <section className="widget-models" aria-labelledby="widget-models-title">
        <div className="widget-models-heading"><h2 id="widget-models-title">模型用量</h2><span>Tokens · {state.models.length} 个模型</span></div>
        <div className="widget-model-scroll" tabIndex={0} role="region" aria-label="分钟内全部模型用量">
          {state.models.length>0 ? <ul className="widget-model-list">{state.models.map(model=><ModelRow key={model.name} model={model}/>)}</ul> : <p className="widget-empty">{loading ? '正在读取模型用量…' : state.phase==='error' || error ? '模型用量暂不可用' : '暂无消费模型'}</p>}
        </div>
      </section>
    </div>
    <footer className="widget-footer">
      <div className="widget-status"><p role="status" aria-live="polite" title={message}>{loading && <i className="widget-loading" aria-hidden="true"/>}<span>{message}</span></p><span title={updated ? updated.toLocaleString('zh-CN') : undefined}>{updatedLabel ? '更新于 '+updatedLabel : '尚未更新'}</span></div>
      <button type="button" className="widget-refresh" disabled={!window.lumiWidget || loading} aria-label="刷新用量" onClick={()=>void action({type:'refresh'})}><RefreshCw size={13}/><span>{loading ? '同步中' : '刷新'}</span></button>
    </footer>
  </main>;
}

const root=document.getElementById('root');
if(root)createRoot(root).render(<StrictMode><WidgetApp/></StrictMode>);
