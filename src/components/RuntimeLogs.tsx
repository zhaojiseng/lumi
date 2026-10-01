import {useEffect,useMemo,useRef,useState} from 'react';
import {Pause,Play,Search,ChevronsUp,ChevronLeft,ChevronRight,ScrollText} from 'lucide-react';
import {bridge} from '../bridge';
import {useApp} from '../context';
import {Button,Select} from './ui';
import type {AppLogEntry,AppLogSnapshot} from '../../shared/types';
const labels={debug:'调试',info:'信息',warn:'警告',error:'错误'};
const LIMIT=10000,PAGE=300;
export default function RuntimeLogs(){
  const {bootstrap,toast}=useApp();
  const [snapshot,setSnapshot]=useState<AppLogSnapshot>({startedAt:0,entries:[],dropped:0});
  const [frozen,setFrozen]=useState<AppLogSnapshot|null>(null),[level,setLevel]=useState('all'),[query,setQuery]=useState(''),[follow,setFollow]=useState(true),[page,setPage]=useState(0);
  const scroll=useRef<HTMLDivElement>(null);
  useEffect(()=>{
    let active=true;let pending:AppLogEntry[]=[];
    const merge=(base:AppLogSnapshot,entries:AppLogEntry[])=>{const all=[...new Map([...base.entries,...entries].map(entry=>[entry.id,entry])).values()].sort((a,b)=>a.id-b.id).slice(-LIMIT);return {...base,entries:all,dropped:Math.max(base.dropped,(all[0]?.id || 1)-1)};};
    const stop=bridge.onAppLog(entry=>{pending.push(entry);});
    const timer=setInterval(()=>{if(pending.length){const entries=pending;pending=[];setSnapshot(current=>merge(current,entries));}},150);
    void bridge.appLogs().then(initial=>{if(active)setSnapshot(current=>merge(initial,current.entries));}).catch(e=>{if(active)toast(e.message,'error');});
    return()=>{active=false;clearInterval(timer);stop();};
  },[]);
  const shown=frozen || snapshot;
  const rows=useMemo(()=>shown.entries.filter(entry=>(level==='all' || entry.level===level) && `${entry.source} ${entry.message}`.toLowerCase().includes(query.toLowerCase())),[shown.entries,level,query]);
  const pages=Math.max(1,Math.ceil(rows.length/PAGE)),index=follow ? pages-1 : Math.min(page,pages-1),visible=rows.slice(index*PAGE,(index+1)*PAGE);
  useEffect(()=>{if(follow && !frozen && scroll.current)scroll.current.scrollTop=scroll.current.scrollHeight;},[rows.length,follow,frozen]);
  return <section className="surface panel runtime-log-panel">
    <div className="runtime-log-heading"><ScrollText size={20}/><div><h3>实时日志</h3><p>{shown.startedAt ? '本次启动 '+new Date(shown.startedAt).toLocaleString('zh-CN') : '正在读取启动日志…'} · 仅保存在内存，退出后清空</p></div><span className={'log-live '+(frozen ? 'paused' : '')}>{frozen ? '显示已暂停' : '实时接收'}</span></div>
    {!bootstrap.desktop ? <p className="muted">实时日志需要在 Lumi 桌面应用中查看。</p> : <>
      <div className="runtime-log-toolbar"><div className="search-input"><Search size={15}/><input aria-label="搜索实时日志" placeholder="搜索日志内容或来源" value={query} onChange={e=>{setQuery(e.target.value);setPage(0);}}/></div><Select label="日志级别" value={level} onChange={value=>{setLevel(value);setPage(0);}}><option value="all">全部级别</option>{Object.entries(labels).map(([value,label])=><option key={value} value={value}>{label}</option>)}</Select><Button onClick={()=>setFrozen(frozen ? null : snapshot)}>{frozen ? <Play size={14}/> : <Pause size={14}/>}{frozen ? '继续显示' : '暂停显示'}</Button><label className="checkbox-label"><input type="checkbox" checked={follow} onChange={e=>{setFollow(e.target.checked);setPage(pages-1);}}/>跟随最新</label></div>
      <div className="runtime-log-scroll" ref={scroll} role="region" aria-label="本次启动运行日志"><div className="runtime-log-table"><div className="runtime-log-columns"><span>时间</span><span>级别</span><span>来源</span><span>内容</span></div>{visible.map(entry=><div className={'runtime-log-row '+entry.level} key={entry.id}><time title={new Date(entry.timestamp).toLocaleString('zh-CN')}>{new Date(entry.timestamp).toLocaleTimeString('zh-CN',{hour12:false})}.{String(entry.timestamp%1000).padStart(3,'0')}</time><span className={'log-level '+entry.level}>{labels[entry.level]}</span><span>{entry.source}</span><code>{entry.message}</code></div>)}{!visible.length && <p className="log-empty">{shown.entries.length ? '没有符合筛选条件的日志。' : '等待日志…'}</p>}</div></div>
      <div className="runtime-log-footer"><span>{rows.length} 条{shown.dropped>0 ? ` · 已释放最早 ${shown.dropped} 条` : ''} · 最多保留 {LIMIT.toLocaleString()} 条，不自动保存</span><div><Button onClick={()=>{setFollow(false);setPage(0);scroll.current?.scrollTo({top:0});}}><ChevronsUp size={14}/>启动日志</Button><button className="icon-button" aria-label="更早日志" disabled={index===0} onClick={()=>{setFollow(false);setPage(index-1);}}><ChevronLeft size={16}/></button><span>{index+1} / {pages}</span><button className="icon-button" aria-label="更新日志" disabled={index===pages-1} onClick={()=>{setFollow(false);setPage(index+1);}}><ChevronRight size={16}/></button></div></div>
    </>}
  </section>;
}
