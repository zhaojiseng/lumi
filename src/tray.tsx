import {StrictMode,useEffect,useLayoutEffect,useRef,useState,type ReactNode} from 'react';
import {createRoot} from 'react-dom/client';
import {ArrowUpRight,BarChart3,Loader2,Power,RefreshCw,Settings,X} from 'lucide-react';
import {Logo} from './components/ui';
import {nativeMenuBarState,normalizeMenuBarContents} from '../shared/menu-bar';
import {trayPanelContentHeight,TRAY_CLOSE_DURATION,type TrayAction,type TrayPanelState} from '../shared/tray';
import type {MenuBarSelection} from '../shared/types';
import {surfacePaletteStyle} from '../shared/surface-theme';
import {applyDocumentTypography,disposeDocumentTypography} from './host/typography';
import './theme-tokens.css';
import './tray.css';

function Value({children}:{children:ReactNode}){
  const ref=useRef<HTMLSpanElement>(null),previous=useRef(children);
  useEffect(()=>{if(children!==previous.current && !matchMedia('(prefers-reduced-motion: reduce)').matches){ref.current?.getAnimations().forEach(a=>a.cancel());ref.current?.animate([{opacity:.55},{opacity:1}],{duration:180,easing:'ease-out'});}previous.current=children;},[children]);
  return <span ref={ref} title={typeof children==='string' ? children : undefined}>{children}</span>;
}
function Switch<T extends string|number>({label,options,value,select}:{label:string;options:readonly {label:string;value:T}[];value:T;select(value:T):void}){
  const current=Math.max(0,options.findIndex(o=>o.value===value));
  return <div className="tray-switch" role="radiogroup" aria-label={label}><i className="tray-switch-thumb" aria-hidden="true" style={{transform:`translateX(${current*100}%)`}}/>{options.map((o,i)=><button type="button" key={o.value} role="radio" aria-checked={o.value===value} tabIndex={o.value===value ? 0 : -1} onClick={()=>select(o.value)} onKeyDown={e=>{const next=e.key==='Home' ? 0 : e.key==='End' ? options.length-1 : e.key==='ArrowRight' || e.key==='ArrowDown' ? (i+1)%options.length : e.key==='ArrowLeft' || e.key==='ArrowUp' ? (i+options.length-1)%options.length : -1;if(next>=0){e.preventDefault();select(options[next].value);e.currentTarget.parentElement?.querySelectorAll<HTMLButtonElement>('button')[next]?.focus();}}}>{o.label}</button>)}</div>;
}
function TrayApp(){
  const [state,setState]=useState<TrayPanelState>({usage:nativeMenuBarState({phase:'idle'},{days:1,tool:'all'}),theme:matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light',motion:{id:0,phase:'hidden'}}),[error,setError]=useState(''),[hover,setHover]=useState<number|null>(null);
  const pending=useRef<MenuBarSelection|null>(null),card=useRef<HTMLElement>(null),lastLayout=useRef<{height:number;reducedMotion:boolean}|null>(null);
  useEffect(()=>{
    const bridge=window.lumiTray;if(!bridge){setState(old=>({...old,motion:undefined}));setError('请通过 Lumi 托盘打开用量面板。');return;}
    let active=true,streamed=false;
    const receive=(next:TrayPanelState)=>{if(!active)return;setState(old=>{const selection=pending.current;
      if(selection && old.usage.viewKey && old.usage.viewKey===next.usage.viewKey){
        if(next.usage.days!==selection.days || next.usage.tool!==selection.tool)return {...old,typography:next.typography,theme:next.theme,palette:next.palette,motion:next.motion,usage:{...old.usage,contents:next.usage.contents}};
        if(['idle','loading'].includes(next.usage.phase))return {...next,usage:{...old.usage,...selection,contents:next.usage.contents,phase:'loading',canRefresh:false,message:'正在刷新用量…'}};
      }
      pending.current=null;return next;
    });};
    const stop=bridge.onState(next=>{streamed=true;receive(next);});void bridge.snapshot().then(next=>{if(!streamed)receive(next);}).catch(e=>{if(active)setError(e.message);});return()=>{active=false;stop();};
  },[]);
  useLayoutEffect(()=>{applyDocumentTypography(document,state.typography);},[state.typography?.fontSize,state.typography?.fontFamily]);
  useLayoutEffect(()=>()=>disposeDocumentTypography(document),[]);
  useLayoutEffect(()=>{
    const element=card.current,bridge=window.lumiTray;if(!element || !bridge)return;
    const media=matchMedia('(prefers-reduced-motion: reduce)');let frame=0,active=true;
    const measure=()=>{
      if(!active)return;
      const sections=element.querySelector<HTMLElement>('.tray-sections'),children=sections ? [...sections.children] : [];
      const px=(value:string)=>parseFloat(value) || 0,outerHeight=(child:Element)=>{const style=getComputedStyle(child);return child.getBoundingClientRect().height+px(style.marginTop)+px(style.marginBottom);};
      const style=getComputedStyle(element),chromeHeight=px(style.paddingTop)+px(style.paddingBottom)+px(style.borderTopWidth)+px(style.borderBottomWidth)+[...element.children].filter(child=>!child.classList.contains('tray-sections') && !child.classList.contains('tray-spacer')).reduce((sum,child)=>sum+outerHeight(child),0);
      const sectionStyle=sections ? getComputedStyle(sections) : null;
      const contentHeight=sectionStyle ? children.reduce((sum,child)=>sum+outerHeight(child),0)+Math.max(0,children.length-1)*px(sectionStyle.rowGap)+px(sectionStyle.marginTop)+px(sectionStyle.marginBottom) : 0;
      const height=trayPanelContentHeight(chromeHeight,contentHeight,state.material==='acrylic' ? 0 : 8),reducedMotion=media.matches;
      if(lastLayout.current?.height===height && lastLayout.current.reducedMotion===reducedMotion)return;
      lastLayout.current={height,reducedMotion};void bridge.action({type:'layout',height,reducedMotion}).catch(()=>{lastLayout.current=null;});
    };
    const schedule=()=>{cancelAnimationFrame(frame);frame=requestAnimationFrame(measure);};
    const observer=new ResizeObserver(schedule);observer.observe(element);
    element.querySelectorAll(':scope>*,.tray-sections>*').forEach(child=>observer.observe(child));
    media.addEventListener('change',schedule);schedule();void document.fonts.ready.then(schedule);
    return()=>{active=false;observer.disconnect();media.removeEventListener('change',schedule);cancelAnimationFrame(frame);};
  },[state.usage,state.material]);
  const motionId=state.motion?.id || 0,motionPhase=state.motion?.phase || 'visible';
  useLayoutEffect(()=>{
    const element=card.current;if(!element)return;
    // Establish the hidden style once. Repeated snapshots and StrictMode setup leave it intact.
    if(!element.dataset.visibility)element.getBoundingClientRect();
    element.dataset.visibility=motionPhase;
    if(motionPhase!=='closing')return;
    let active=true,completed=false;
    const finish=()=>{if(!active || completed)return;completed=true;void window.lumiTray?.action({type:'closeComplete',id:motionId}).catch(()=>{});};
    const ended=(event:TransitionEvent)=>{if(event.target===element && event.propertyName==='opacity')finish();};
    element.addEventListener('transitionend',ended);
    const timer=setTimeout(finish,matchMedia('(prefers-reduced-motion: reduce)').matches ? 0 : TRAY_CLOSE_DURATION+50);
    return()=>{active=false;clearTimeout(timer);element.removeEventListener('transitionend',ended);};
  },[motionId,motionPhase]);
  useLayoutEffect(()=>{document.documentElement.dataset.theme=state.theme;},[state.theme]);
  const action=async(event:TrayAction)=>{setError('');try{await window.lumiTray?.action(event);}catch(e){pending.current=null;setError(e instanceof Error ? e.message : '操作失败，请重试。');}};
  useEffect(()=>{const key=(e:KeyboardEvent)=>{if(e.key==='Escape'){e.preventDefault();void window.lumiTray?.action({type:'close'});}};addEventListener('keydown',key);return()=>removeEventListener('keydown',key);},[]);
  const data=state.usage,contents=normalizeMenuBarContents(data.contents),choose=(selection:MenuBarSelection)=>{pending.current=selection;setHover(null);setState(old=>({...old,usage:{...old.usage,...selection,phase:'loading',canRefresh:false,message:'正在刷新用量…'}}));void action({type:'select',selection});};
  const points=data.chart,maximum=Math.max(.001,...(points || []).map(p=>p.value)),point=hover===null ? null : points?.[hover];
  return <main ref={card} className="tray-card" style={surfacePaletteStyle(state.palette)} data-material={state.material} aria-label="Lumi 用量面板">
    <header className="tray-header"><Logo small/><div><strong title={data.siteName}>{data.siteName}</strong><span title={data.accountLabel}>{data.accountLabel}</span></div><button className="tray-icon" title="打开工作台" aria-label="打开工作台" onClick={()=>void action({type:'navigate',page:'overview'})}><ArrowUpRight size={18}/></button><button className="tray-icon" title="关闭面板" aria-label="关闭面板" onClick={()=>void action({type:'close'})}><X size={16}/></button></header>
    <div className="tray-selectors"><Switch label="统计工具" options={[{label:'全部',value:'all'},{label:'Codex',value:'codex'},{label:'Claude',value:'claude'}] as const} value={data.tool as MenuBarSelection['tool']} select={tool=>choose({tool,days:data.days as MenuBarSelection['days']})}/><Switch label="统计时间" options={[{label:'今日',value:1},{label:'7 天',value:7},{label:'30 天',value:30}] as const} value={data.days as MenuBarSelection['days']} select={days=>choose({days,tool:data.tool as MenuBarSelection['tool']})}/></div>
    {contents.length>0 ? <div className="tray-sections">
      {contents.includes('balance') && <section className="tray-balance" data-section="balance"><span>账户余额</span><strong><Value>{data.balance}</Value></strong></section>}
      {contents.includes('totals') && <dl className="tray-totals" data-section="totals">{[[(data.totalsCaption || '本期')+'消费',data.cost],['Tokens',data.tokens],['请求数',data.requests]].map(([label,value])=><div key={label}><dt title={label}>{label}</dt><dd><Value>{value}</Value></dd></div>)}</dl>}
      {contents.includes('tokenDetail') && <p className="tray-token-detail" data-section="tokenDetail" title={data.tokenDetail}>{data.tokenDetail}</p>}
      {contents.includes('efficiency') && <dl className="tray-efficiency" data-section="efficiency"><div title={data.cacheDetail}><dt>缓存命中率</dt><dd><Value>{data.cacheHitRate}</Value></dd></div><div title="输出 Tokens 合计 ÷ 有效请求总耗时，包含首字等待"><dt>平均 Token 速率</dt><dd><Value>{data.tokenSpeed}</Value></dd></div></dl>}
      {contents.includes('chart') && <section className="tray-chart" data-section="chart"><h2>{data.chartCaption}<span>消费趋势</span></h2><div className="tray-bars" aria-label="消费趋势" onMouseLeave={()=>setHover(null)}>{points ? points.map((p,i)=><button key={i} className={'tray-bar '+(p.value>0 ? 'used' : 'empty')} style={{height:(p.value>0 ? Math.max(4,p.value/maximum*100) : 3)+'%'}} aria-label={`${p.label} · ${p.cost} · ${p.tokens} Tokens · ${p.requests} 次`} title={`${p.label} · ${p.cost}`} onMouseEnter={()=>setHover(i)} onFocus={()=>setHover(i)} onBlur={()=>setHover(null)} onClick={()=>setHover(i)}/>) : <p>消费曲线暂不可用</p>}</div><p className="tray-chart-detail" title={point ? `${point.label} · ${point.cost} · ${point.tokens} Tokens · ${point.requests} 次` : data.chartCaption}>{point ? `${point.label} · ${point.cost} · ${point.tokens} Tokens · ${point.requests} 次` : data.chartCaption}</p></section>}
      {contents.includes('models') && <section className="tray-models" data-section="models"><h2>主要模型<span>按消费</span></h2>{data.models.length ? data.models.map(row=><div className="tray-model" key={row.name}><div><span title={row.name}>{row.name}</span><strong>{row.cost}</strong></div><i aria-hidden="true" style={{width:row.share*100+'%'}}/></div>) : <p>{data.modelsMessage}</p>}</section>}
    </div> : <div className="tray-spacer" aria-hidden="true"/>}
    <footer className="tray-footer"><p role="status" title={error || data.message}>{data.phase==='loading' && <Loader2 size={12} className="spin"/>}{error || data.message}</p><span>{data.updatedLabel}</span><nav aria-label="用量面板操作"><button disabled={!data.canRefresh} onClick={()=>void action({type:'refresh'})}><RefreshCw size={14}/>刷新</button><button onClick={()=>void action({type:'navigate',page:'usage'})}><BarChart3 size={14}/>分析</button><button onClick={()=>void action({type:'navigate',page:'settings'})}><Settings size={14}/>设置</button><button onClick={()=>void action({type:'quit'})}><Power size={14}/>退出</button></nav></footer>
  </main>;
}
createRoot(document.getElementById('root')!).render(<StrictMode><TrayApp/></StrictMode>);
