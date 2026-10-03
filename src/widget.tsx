import {StrictMode,useEffect,useLayoutEffect,useRef,useState} from 'react';
import {createRoot} from 'react-dom/client';
import {X} from 'lucide-react';
import type {WidgetBridge,WidgetModel,WidgetState} from '../shared/widget';
import {surfacePaletteStyle} from '../shared/surface-theme';
import {refreshKeyframes,refreshExitKeyframes,type DataRefreshAnimation} from '../shared/motion';
import './theme-tokens.css';
import './widget.css';

declare global {interface Window {lumiWidget?:WidgetBridge;}}

function useDataMotion(next:WidgetState) {
  const mode=next.animation || 'slide-up';
  const [display,setDisplay]=useState(next),element=useRef<HTMLDivElement>(null),latest=useRef(next);
  const previous=useRef({key:next.dataKey,scope:next.viewKey,mode}),enter=useRef<DataRefreshAnimation|null>(null);
  latest.current=next;
  const reset=display.viewKey!==next.viewKey || previous.current.mode!==mode;
  // Keep the outgoing snapshot equal to what was actually shown, including metadata.
  useLayoutEffect(()=>{
    if(display.dataKey===next.dataKey && display.viewKey===next.viewKey && display!==next)setDisplay(next);
  },[next,display]);
  useLayoutEffect(()=>{
    const before=previous.current;
    previous.current={key:next.dataKey,scope:next.viewKey,mode};
    const node=element.current,media=window.matchMedia('(prefers-reduced-motion: reduce)');
    enter.current=null;
    // Scope and preference changes never retain a previous account or snapshot.
    if(before.key===next.dataKey || before.scope!==next.viewKey || before.mode!==mode || mode==='none' || media.matches || !node || typeof node.animate!=='function'){
      setDisplay(latest.current);return;
    }
    let active=true;
    const motion=node.animate(refreshExitKeyframes(mode),{duration:120,easing:'ease-in',fill:'forwards'});
    const reduce=()=>{if(media.matches && active){active=false;enter.current=null;motion.cancel();media.removeEventListener('change',reduce);setDisplay(latest.current);}};
    media.addEventListener('change',reduce);
    void motion.finished.then(()=>{
      if(!active)return;
      active=false;media.removeEventListener('change',reduce);motion.cancel();
      enter.current=mode;setDisplay(latest.current);
    },()=>{});
    return ()=>{active=false;media.removeEventListener('change',reduce);motion.cancel();};
  },[next.dataKey,next.viewKey,mode]);
  // Start entry after React has committed the new content into the same DOM.
  useLayoutEffect(()=>{
    const kind=enter.current;enter.current=null;
    const node=element.current,media=window.matchMedia('(prefers-reduced-motion: reduce)');
    if(!kind || media.matches || !node)return;
    const motion=node.animate(refreshKeyframes(kind),{duration:kind==='blur' ? 300 : 220,easing:'cubic-bezier(.22,.61,.36,1)'});
    const reduce=()=>{if(media.matches){motion.cancel();setDisplay(latest.current);}};
    media.addEventListener('change',reduce);
    return ()=>{media.removeEventListener('change',reduce);motion.cancel();};
  },[display.dataKey,display.viewKey,next.dataKey,next.viewKey,mode]);
  return {data:element,state:reset || display.dataKey===next.dataKey ? next : display};
}

function Value({value}:{value:string}) {
  return <span className="widget-value" title={value}>{value}</span>;
}

function ModelDetails({model,notice,tooltip}:{model:WidgetModel;notice:string;tooltip:string}) {
  const details=[model.name,'模型消费：'+model.cost,'请求数：'+model.requests,'输入：'+model.input,'输出：'+model.output,'缓存读取：'+model.cacheRead,'缓存写入：'+model.cacheWrite,tooltip].join('\n');
  return <div className="widget-model" title={details}>
    <div className="widget-model-heading"><span className="widget-model-name"><span>{model.name}</span></span>{notice && <span className="widget-model-notice" role="status" aria-live="polite">{notice}</span>}</div>
    <div className="widget-tokens" role="group" aria-label={model.name+' 的 Tokens'}>
      <div className="widget-token-input">
        <span className="widget-token-number" aria-label={'输入：'+model.input} title={'输入：'+model.input}><Value value={model.input}/></span>
        <small className="widget-cache-read" aria-label={'缓存读取：'+model.cacheRead} title={'缓存读取：'+model.cacheRead}><Value value={model.cacheRead}/></small>
      </div>
      <span className="widget-token-divider" aria-hidden="true">/</span>
      <span className="widget-token-number" aria-label={'输出：'+model.output} title={'输出：'+model.output}><Value value={model.output}/></span>
    </div>
  </div>;
}

const initialState:WidgetState={phase:'idle',enabled:false,siteName:'Lumi',balance:'—',cost:'—',minuteLabel:'暂无消费分钟',historical:false,models:[],message:'正在读取用量…',updatedAt:0,viewKey:'',dataKey:'',theme:'light'};

export function WidgetApp() {
  const [received,setState]=useState<WidgetState>(initialState),[error,setError]=useState('');
  const alive=useRef(false),{state,data}=useDataMotion(received);
  useLayoutEffect(()=>{document.documentElement.dataset.theme=received.theme;},[received.theme]);
  useEffect(()=>{
    alive.current=true;
    const bridge=window.lumiWidget;
    if(!bridge){setError('请在工作台打开');return ()=>{alive.current=false;};}
    let active=true,streamed=false;
    const receive=(next:WidgetState)=>{if(active){setState(next);setError('');}};
    // Subscribe first. Any streamed state takes precedence over a late bootstrap.
    const stop=bridge.onState(next=>{streamed=true;receive(next);});
    void bridge.snapshot().then(next=>{if(!streamed)receive(next);}).catch(()=>{if(active && !streamed)setError('用量暂不可用');});
    return ()=>{active=false;alive.current=false;stop();};
  },[]);

  const action=async(type:'open'|'close')=>{
    const bridge=window.lumiWidget;
    if(!bridge)return;
    setError('');
    try{await bridge.action({type});}
    catch{if(alive.current)setError('操作失败');}
  };
  const updated=state.updatedAt>0 && Number.isFinite(state.updatedAt) ? new Date(state.updatedAt) : null;
  const updatedLabel=updated && Number.isFinite(updated.getTime()) ? updated.toLocaleString('zh-CN') : '尚未更新';
  const tooltip=[state.siteName,(state.historical ? '回溯消费时间：' : '消费范围：')+state.minuteLabel,'消费：'+state.cost,'余额：'+state.balance,state.source==='local' ? '本地用量按线上定价估算，最终以站点账单为准。' : '', '更新：'+updatedLabel,error || state.message].filter(Boolean).join('\n');
  const model=state.latestModel ?? state.models[0];
  const notice=error || (state.phase==='error' ? '用量暂不可用' : '');
  const empty=notice || (state.phase==='loading' || state.phase==='idle' ? '读取中…' : '暂无消费模型');
  return <main className="widget-card widget-header" style={surfacePaletteStyle(received.palette)} data-theme={received.theme} data-material={received.material} aria-label="Lumi 悬浮用量" title={tooltip} onDoubleClick={()=>void action('open')}>
    <div className="widget-data" ref={data} tabIndex={window.lumiWidget ? 0 : undefined} role="group" aria-label="用量，双击或按 Enter 打开工作台" onKeyDown={event=>{if(event.key==='Enter' && !event.repeat && event.target===event.currentTarget){event.preventDefault();void action('open');}}}>
      <dl className="widget-consumption" title={tooltip}><dt>最近消费</dt><dd><Value value={state.cost}/></dd></dl>
      <div className="widget-details">
        <section className="widget-model-slot" aria-label="最近模型">
          {model ? <ModelDetails model={model} notice={notice} tooltip={tooltip}/> : <p className="widget-empty" role="status" aria-live="polite"><span>{empty}</span></p>}
        </section>
        <dl className="widget-balance" title={tooltip}><dt>余额</dt><dd><Value value={state.balance}/></dd></dl>
      </div>
    </div>
    <button type="button" className="widget-close" title="关闭悬浮窗" aria-label="关闭悬浮窗" disabled={!window.lumiWidget} onDoubleClick={event=>event.stopPropagation()} onClick={event=>{event.stopPropagation();void action('close');}}><X size={12} aria-hidden="true"/></button>
  </main>;
}

const root=document.getElementById('root');
if(root)createRoot(root).render(<StrictMode><WidgetApp/></StrictMode>);
