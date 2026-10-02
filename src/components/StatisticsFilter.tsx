import {useCallback,useEffect,useRef,useState} from 'react';
import {createPortal} from 'react-dom';
import {Check,ChevronDown,Search,SlidersHorizontal,Loader2} from 'lucide-react';
import {useApp} from '../context';
import {useSavedSelection} from '../selections';
import {resolveRange} from '../../shared/range';
import {refreshLabel} from '../../shared/refresh';
import {DateRangePicker} from './DateRangePicker';
import {Button} from './ui';

export function MultiSelect({label,options,value,onApply}:{label:string;options:{value:string;label:string}[];value:string[];onApply(value:string[]):void}) {
  const trigger=useRef<HTMLButtonElement>(null),panel=useRef<HTMLDivElement>(null),search=useRef<HTMLInputElement>(null);
  const [open,setOpen]=useState(false),[mounted,setMounted]=useState(false),[draft,setDraft]=useState(value),[query,setQuery]=useState('');
  const [position,setPosition]=useState({top:0,left:0});
  const close=useCallback(()=>{setOpen(false);trigger.current?.focus();},[]);
  useEffect(()=>{if(open){setMounted(true);return;}const timer=setTimeout(()=>setMounted(false),130);return()=>clearTimeout(timer);},[open]);
  useEffect(()=>{
    if(!open)return;
    const outside=(e:PointerEvent)=>{if(!panel.current?.contains(e.target as Node) && !trigger.current?.contains(e.target as Node))close();};
    const keyboard=(e:KeyboardEvent)=>{if(e.key==='Escape'){e.preventDefault();close();}};
    const timer=setTimeout(()=>search.current?.focus(),20);
    document.addEventListener('pointerdown',outside);document.addEventListener('keydown',keyboard);window.addEventListener('resize',close);
    return()=>{clearTimeout(timer);document.removeEventListener('pointerdown',outside);document.removeEventListener('keydown',keyboard);window.removeEventListener('resize',close);};
  },[open,close]);
  function show(){if(open){close();return;}const rect=trigger.current!.getBoundingClientRect();setPosition({top:Math.min(rect.bottom+7,window.innerHeight-420),left:Math.min(rect.left,window.innerWidth-330)});setDraft(value);setQuery('');setMounted(true);setOpen(true);}
  const available=[...options,...value.filter(v=>!options.some(o=>o.value===v)).map(v=>({value:v,label:v+'（历史选择）'}))];
  const shown=available.filter(o=>o.label.toLowerCase().includes(query.toLowerCase()));
  return <><button ref={trigger} type="button" className={'multi-trigger '+(value.length ? 'has-selection' : '')} aria-label={'筛选'+label} aria-haspopup="dialog" aria-expanded={open} onClick={show}><span>{value.length ? label+' · '+value.length : '全部'+label}</span><ChevronDown size={14}/></button>{mounted && createPortal(<div ref={panel} role="dialog" aria-label={label+'多选筛选'} aria-modal="false" aria-hidden={!open} inert={!open} className={'multi-popover '+(open ? 'open' : 'closing')} style={position}><div className="multi-heading"><strong>筛选{label}</strong><span>可多选</span></div><div className="search-input"><Search size={15}/><input ref={search} aria-label={'搜索'+label} placeholder={'搜索'+label} value={query} onChange={e=>setQuery(e.target.value)}/></div><div className="multi-options">{shown.length ? shown.map(option=><label key={option.value}><input type="checkbox" checked={draft.includes(option.value)} onChange={e=>setDraft(current=>e.target.checked ? [...current,option.value].slice(0,500) : current.filter(v=>v!==option.value))}/><span className="multi-check"><Check size={12}/></span><span title={option.label}>{option.label}</span></label>) : <p>没有匹配的{label}</p>}</div><div className="multi-actions"><button type="button" onClick={()=>setDraft([])}>全部{label}</button><span>{draft.length ? '已选 '+draft.length+' 项' : '不限'}</span><Button variant="primary" onClick={()=>{onApply(draft);close();}}>应用</Button></div></div>,document.body)}</>;
}

export function StatisticsFilter() {
  const {dashboard:d,overviewQuery,setOverviewQuery,loading,preferences,updatePreferences,toast}=useApp();
  const [models,setModels]=useSavedSelection<string[]>('statistics.models',[],Array.isArray),[tokens,setTokens]=useSavedSelection<string[]>('statistics.tokens',[],Array.isArray);
  const names=[...new Set([...(d?.catalog.models.map(m=>m.model_name) || []),...(d?.series.map(p=>p.model_name) || []),...(d?.logs.items.map(l=>l.model_name) || [])])].filter(Boolean).sort((a,b)=>a.localeCompare(b));
  return <div className="surface statistics-filter"><div className="statistics-controls"><span className="statistics-title"><SlidersHorizontal size={15}/>统计筛选</span><div className="segmented range-presets">{(['24h',1,7,30] as const).map(n=><button type="button" key={n} className={overviewQuery===n ? 'active' : ''} aria-pressed={overviewQuery===n} title={n==='24h' ? '当前时间回推 24 小时' : n===1 ? '今天 00:00 至当前时间' : undefined} onClick={()=>setOverviewQuery(n)}>{n==='24h' ? '24h' : n+' 天'}</button>)}</div><DateRangePicker range={resolveRange(overviewQuery).range} onApply={setOverviewQuery}/><MultiSelect label="模型" options={names.map(value=>({value,label:value}))} value={models} onApply={setModels}/><span className="filter-and">AND</span><MultiSelect label="令牌" options={(d?.tokens || []).map(t=>({value:String(t.id),label:t.name+((d?.tokens.filter(x=>x.name===t.name).length || 0)>1 ? ' #'+t.id : '')}))} value={tokens} onApply={setTokens}/>{(models.length>0 || tokens.length>0) && <button className="text-link filter-reset" onClick={()=>void updatePreferences({selection:{siteId:preferences.activeSiteId,values:{'statistics.models':[],'statistics.tokens':[]}}}).catch(e=>toast(e.message,'error'))}>清除筛选</button>}</div><div className="statistics-status" role="status">{loading ? <><Loader2 size={12} className="spin"/>更新中，保留当前结果</> : <><span className="tiny-dot"/>{refreshLabel(preferences.refreshInterval)}</>}</div></div>;
}
