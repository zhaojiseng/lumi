import {useState,useCallback} from 'react';
import {CalendarDays,ChevronLeft,ChevronRight,ArrowRight} from 'lucide-react';
import {Button,Modal} from './ui';
import {dateKey,resolveRange} from '../../shared/range';
import {CalendarMonth} from './CalendarMonth';
import {usageGranularity} from '../../shared/utils';
import type {DateRange} from '../../shared/types';
const monthStart=(key:string) => {const [y,m]=key.split('-').map(Number);return new Date(y,m-1,1);};
export function DateRangePicker({range,onApply}:{range:DateRange;onApply(range:DateRange):void}) {
  const [open,setOpen]=useState(false);const [draft,setDraft]=useState(range);const [target,setTarget]=useState<'startDate'|'endDate'>('startDate');const [month,setMonth]=useState(() => monthStart(range.endDate));
  const close=useCallback(() => setOpen(false),[]);const today=dateKey(new Date());let error='';let days=0;
  try {days=resolveRange(draft).days;}catch(e:any){error=e.message;}
  const second=new Date(month);second.setMonth(second.getMonth()+1);
  const move=(step:number) => setMonth(m => new Date(m.getFullYear(),m.getMonth()+step,1));
  function show(){setDraft(range);setTarget('startDate');const m=monthStart(range.endDate);m.setMonth(m.getMonth()-1);setMonth(m);setOpen(true);}
  function pick(key:string){setDraft(d => target==='startDate' ? {startDate:key,endDate:d.endDate<key ? key : d.endDate} : {startDate:d.startDate>key ? key : d.startDate,endDate:key});setTarget(target==='startDate' ? 'endDate' : 'startDate');}
  return <><Button className="range-picker-trigger" onClick={show} aria-haspopup="dialog"><CalendarDays size={15}/><span>{range.startDate} <ArrowRight size={12}/> {range.endDate}</span><span className="range-custom-label">选择时间</span></Button>{open && <Modal className="date-range-modal" title="选择统计时间" subtitle="选择开始与结束日期，最多 90 天" wide onClose={close}><div className="calendar-presets">{[1,7,30].map(n => <Button key={n} onClick={() => {const r=resolveRange(n).range;setDraft(r);const m=monthStart(r.endDate);m.setMonth(m.getMonth()-1);setMonth(m);setTarget('startDate');}}>最近 {n} 天</Button>)}</div><div className="calendar-fields">{(['startDate','endDate'] as const).map((key,i) => <label key={key} className={target===key ? 'active' : ''}><span>{i ? '结束日期' : '开始日期'}</span><input type="text" className="text-input" aria-label={'统计'+(i ? '结束' : '开始')+'日期'} placeholder="YYYY-MM-DD" maxLength={10} value={draft[key]} onFocus={() => setTarget(key)} onChange={e => setDraft(d => ({...d,[key]:e.target.value}))}/></label>)}</div><div className="calendar-navigation"><Button aria-label="上个月" onClick={() => move(-1)}><ChevronLeft size={16}/></Button><span>点击选择{target==='startDate' ? '开始' : '结束'}日期</span><Button aria-label="下个月" disabled={dateKey(second)>=today.slice(0,7)+'-01'} onClick={() => move(1)}><ChevronRight size={16}/></Button></div><div className="calendar-months"><CalendarMonth month={month} draft={draft} today={today} onPick={pick}/><CalendarMonth month={second} draft={draft} today={today} onPick={pick}/></div><div className="calendar-summary" aria-live="polite">{error ? <span role="alert" className="error-text">{error}</span> : <><strong>{days} 天</strong><span>曲线按{usageGranularity(days).label}汇总</span></>}</div><div className="modal-actions"><Button onClick={close}>取消</Button><Button variant="primary" disabled={!!error} onClick={() => {onApply({...draft});close();}}>应用时间范围<ArrowRight size={14}/></Button></div></Modal>}</>;
}
