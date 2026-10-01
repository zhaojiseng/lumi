import {useState} from 'react';
import {createPortal} from 'react-dom';
import {CalendarDays,ChevronLeft,ChevronRight} from 'lucide-react';
import {dateKey} from '../../shared/range';
import {CalendarMonth} from './CalendarMonth';
import {Button,Modal,Select} from './ui';
export function DateTimePicker({value,onChange,label,disabled=false}:{value:string;onChange(value:string):void;label:string;disabled?:boolean}) {
  const [open,setOpen]=useState(false),[date,setDate]=useState(''),[hour,setHour]=useState('23'),[minute,setMinute]=useState('59'),[month,setMonth]=useState(()=>new Date());
  const today=dateKey(new Date()),stamp=new Date(date+'T'+hour+':'+minute).getTime(),valid=Number.isFinite(stamp) && stamp>Date.now();
  function show(){const next=value ? new Date(value.replace(' ','T')) : new Date(Date.now()+86400000);setDate(dateKey(next));setHour(String(next.getHours()).padStart(2,'0'));setMinute(String(next.getMinutes()).padStart(2,'0'));setMonth(new Date(next.getFullYear(),next.getMonth(),1));setOpen(true);}
  return <><Button type="button" className="date-time-trigger" aria-label={label} disabled={disabled} onClick={show} aria-haspopup="dialog"><CalendarDays size={15}/><span>{value || '选择到期日期与时间'}</span></Button>{open && createPortal(<Modal className="date-time-modal" title="选择到期时间" subtitle="按本地时间设置令牌有效期" onClose={()=>setOpen(false)}>
    <div className="calendar-navigation"><Button type="button" aria-label="上个月" disabled={month.getFullYear()===new Date().getFullYear() && month.getMonth()<=new Date().getMonth()} onClick={()=>setMonth(m=>new Date(m.getFullYear(),m.getMonth()-1,1))}><ChevronLeft size={16}/></Button><div className="date-time-month"><Select label="到期年份" value={month.getFullYear()} onChange={v=>setMonth(m=>new Date(Number(v),m.getMonth(),1))}>{Array.from({length:Math.max(6,month.getFullYear()-new Date().getFullYear()+1)},(_,i)=>new Date().getFullYear()+i).map(y=><option value={y} key={y}>{y} 年</option>)}</Select><Select label="到期月份" value={month.getMonth()} onChange={v=>setMonth(m=>new Date(m.getFullYear(),Number(v),1))}>{Array.from({length:12},(_,i)=><option value={i} key={i}>{i+1} 月</option>)}</Select></div><Button type="button" aria-label="下个月" onClick={()=>setMonth(m=>new Date(m.getFullYear(),m.getMonth()+1,1))}><ChevronRight size={16}/></Button></div>
    <CalendarMonth month={month} draft={{startDate:date,endDate:date}} today={today} minDate={today} maxDate="9999-12-31" onPick={setDate}/>
    <div className="date-time-hours"><span>到期时间</span><Select decorated={false} label="到期小时" value={hour} onChange={setHour}>{Array.from({length:24},(_,i)=><option value={String(i).padStart(2,'0')} key={i}>{String(i).padStart(2,'0')}</option>)}</Select><span>:</span><Select decorated={false} label="到期分钟" value={minute} onChange={setMinute}>{Array.from({length:60},(_,i)=><option value={String(i).padStart(2,'0')} key={i}>{String(i).padStart(2,'0')}</option>)}</Select></div>
    <div className="calendar-summary">{valid ? <><strong>{date}</strong><span>{hour}:{minute}</span></> : <span className="error-text">请选择未来的日期与时间。</span>}</div><div className="modal-actions"><Button type="button" onClick={()=>setOpen(false)}>取消</Button><Button type="button" variant="primary" disabled={!valid} onClick={()=>{onChange(date+' '+hour+':'+minute);setOpen(false);}}>确定时间</Button></div>
  </Modal>,document.body)}</>;
}
