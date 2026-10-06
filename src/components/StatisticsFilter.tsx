import {useCallback,useLayoutEffect,useRef,useState} from 'react';
import {PopupLayer} from './Popup';
import {PopupPresence} from './PopupPresence';
import {Check,ChevronDown,Search,SlidersHorizontal,Loader2} from 'lucide-react';
import {useApp} from '../context';
import {useSavedSelection} from '../selections';
import {resolveRange} from '../../shared/range';
import {refreshLabel} from '../../shared/refresh';
import {DateRangePicker} from './DateRangePicker';
import {Button,SegmentedSwitch} from './ui';

export function MultiSelect({label,options,value,onApply}:{label:string;options:{value:string;label:string}[];value:string[];onApply(value:string[]):void}) {
  const trigger=useRef<HTMLButtonElement>(null),search=useRef<HTMLInputElement>(null);
  // A portal may attach after the first layout pass; its node starts anchor measurement.
  const [panel,setPanel]=useState<HTMLDivElement|null>(null);
  const [open,setOpen]=useState(false),[draft,setDraft]=useState(value),[query,setQuery]=useState('');
  const [position,setPosition]=useState({top:0,left:0});
  const available=[...options,...value.filter(v=>!options.some(o=>o.value===v)).map(v=>({value:v,label:v+'（历史选择）'}))];
  const shown=available.filter(o=>o.label.toLowerCase().includes(query.toLowerCase()));
  const close=useCallback(()=>setOpen(false),[]);
  useLayoutEffect(()=>{
    if(!open || !panel || !trigger.current)return;
    const rect=trigger.current.getBoundingClientRect(),height=panel.offsetHeight,width=panel.offsetWidth;
    const below=rect.bottom+7,above=rect.top-height-7;
    const top=Math.max(8,Math.min(below+height<=window.innerHeight-8 ? below : above,window.innerHeight-height-8));
    const left=Math.max(8,Math.min(rect.left,window.innerWidth-width-8));
    setPosition(current=>current.top===top && current.left===left ? current : {top,left});
  },[open,panel,query,options,value]);
  function show(){if(open){close();return;}setDraft(value);setQuery('');setOpen(true);}
  return <><button ref={trigger} type="button" className={'multi-trigger '+(value.length ? 'has-selection' : '')} aria-label={'筛选'+label} aria-haspopup="dialog" aria-expanded={open} onClick={show}><span>{value.length ? label+' · '+value.length : '全部'+label}</span><ChevronDown size={14}/></button><PopupPresence exitMs={200}>{open && <PopupLayer kind="popover" label={label+'多选筛选'} className="multi-popover" panelRef={setPanel} initialFocus={search} returnFocus={trigger.current} anchorRef={trigger} onClose={close} style={position}><div className="multi-heading"><strong>筛选{label}</strong><span>可多选</span></div><div className="search-input"><Search size={15}/><input ref={search} aria-label={'搜索'+label} placeholder={'搜索'+label} value={query} onChange={e=>setQuery(e.target.value)}/></div><div className="multi-options">{shown.length ? shown.map(option=><label key={option.value}><input type="checkbox" checked={draft.includes(option.value)} onChange={e=>setDraft(current=>e.target.checked ? [...current,option.value].slice(0,500) : current.filter(v=>v!==option.value))}/><span className="multi-check"><Check size={12}/></span><span title={option.label}>{option.label}</span></label>) : <p>没有匹配的{label}</p>}</div><div className="multi-actions"><button type="button" onClick={()=>setDraft([])}>全部{label}</button><span>{draft.length ? '已选 '+draft.length+' 项' : '不限'}</span><Button variant="primary" onClick={()=>{onApply(draft);close();}}>应用</Button></div></PopupLayer>}</PopupPresence></>;
}

export function StatisticsFilter() {
  const {dashboard:d,overviewQuery,setOverviewQuery,loading,preferences,updatePreferences,toast}=useApp();
  const [models,setModels]=useSavedSelection<string[]>('statistics.models',[],Array.isArray),[tokens,setTokens]=useSavedSelection<string[]>('statistics.tokens',[],Array.isArray);
  const names=[...new Set([...(d?.catalog.models.map(m=>m.model_name) || []),...(d?.series.map(p=>p.model_name) || []),...(d?.logs.items.map(l=>l.model_name) || [])])].filter(Boolean).sort((a,b)=>a.localeCompare(b));
  return <div className="surface statistics-filter"><div className="statistics-controls"><span className="statistics-title"><SlidersHorizontal size={15}/>统计筛选</span><SegmentedSwitch label="统计时间范围" className="segmented range-presets">{(['24h',1,7,30] as const).map(n=><button type="button" key={n} className={overviewQuery===n ? 'active' : ''} aria-pressed={overviewQuery===n} title={n==='24h' ? '当前时间回推 24 小时' : n===1 ? '今天 00:00 至当前时间' : undefined} onClick={()=>setOverviewQuery(n)}>{n==='24h' ? '24h' : n+' 天'}</button>)}</SegmentedSwitch><DateRangePicker range={resolveRange(overviewQuery).range} onApply={setOverviewQuery}/><MultiSelect label="模型" options={names.map(value=>({value,label:value}))} value={models} onApply={setModels}/><span className="filter-and">AND</span><MultiSelect label="令牌" options={(d?.tokens || []).map(t=>({value:String(t.id),label:t.name+((d?.tokens.filter(x=>x.name===t.name).length || 0)>1 ? ' #'+t.id : '')}))} value={tokens} onApply={setTokens}/>{(models.length>0 || tokens.length>0) && <button className="text-link filter-reset" onClick={()=>void updatePreferences({selection:{siteId:preferences.activeSiteId,values:{'statistics.models':[],'statistics.tokens':[]}}}).catch(e=>toast(e.message,'error'))}>清除筛选</button>}</div><div className="statistics-status" role="status">{loading ? <><Loader2 size={12} className="spin"/>更新中，保留当前结果</> : <><span className="tiny-dot"/>{refreshLabel(preferences.refreshInterval)}</>}</div></div>;
}
