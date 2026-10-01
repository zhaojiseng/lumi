import {useRef} from 'react';
import {dateKey} from '../../shared/range';
import type {DateRange} from '../../shared/types';
export function CalendarMonth({month,draft,today,onPick,minDate,maxDate=today}:{month:Date;draft:DateRange;today:string;onPick(key:string):void;minDate?:string;maxDate?:string}) {
  const ref=useRef<HTMLDivElement>(null);const offset=(month.getDay()+6)%7;
  const cells=Array.from({length:42},(_,i) => {const d=new Date(month);d.setDate(i-offset+1);return d;});
  return <section className="calendar-month" aria-label={month.getFullYear()+'年'+(month.getMonth()+1)+'月'}><h3>{month.getFullYear()} 年 {month.getMonth()+1} 月</h3><div className="calendar-weekdays" aria-hidden="true">{['一','二','三','四','五','六','日'].map(d => <span key={d}>{d}</span>)}</div><div className="calendar-grid" ref={ref}>{cells.map(d => {
    const key=dateKey(d),outside=d.getMonth()!==month.getMonth(),edge=key===draft.startDate || key===draft.endDate,inRange=key>=draft.startDate && key<=draft.endDate;
    return <button type="button" key={key} data-date={key} disabled={outside || key>maxDate || (!!minDate && key<minDate)} aria-label={'选择日期 '+key} aria-pressed={edge} aria-current={key===today ? 'date' : undefined} className={'calendar-day'+(outside ? ' outside' : '')+(inRange ? ' in-range' : '')+(edge ? ' selected' : '')+(key===today ? ' today' : '')} onClick={() => onPick(key)} onKeyDown={e => {
      const shift=({ArrowLeft:-1,ArrowRight:1,ArrowUp:-7,ArrowDown:7} as Record<string,number>)[e.key];if(shift == null)return;e.preventDefault();const next=new Date(d);next.setDate(next.getDate()+shift);ref.current?.querySelector<HTMLButtonElement>('button[data-date="'+dateKey(next)+'"]:not(:disabled)')?.focus();
    }}>{d.getDate()}</button>;
  })}</div></section>;
}
