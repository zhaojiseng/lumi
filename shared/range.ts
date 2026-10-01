import type { DashboardQuery, DateRange, StatisticsQuery } from './types';
export function dateKey(date: Date) { return date.toLocaleDateString('sv-SE'); }
function parseDate(value: string) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) throw new Error('请选择有效日期。');
  const [y,m,d]=value.split('-').map(Number); const date=new Date(y,m-1,d);
  if (dateKey(date) !== value) throw new Error('请选择有效日期。');
  return date;
}
export function statisticsFilters(query: DashboardQuery): Pick<StatisticsQuery,'models'|'tokenIds'> {
  return typeof query==='object' && 'range' in query ? {models:query.models,tokenIds:query.tokenIds} : {};
}
function minutes(value: string) {
  if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(value)) throw new Error('请选择有效的小时与分钟。');
  const [h,m]=value.split(':').map(Number); return h*60+m;
}
/** Local calendar dates, inclusive minutes; old date-only preferences retain their meaning. */
export function resolveRange(query: DashboardQuery, now = new Date()) {
  const q=typeof query==='object' && 'range' in query ? query.range : query;
  const endToday=new Date(now); endToday.setHours(0,0,0,0);
  let start: Date; let end: Date;
  if (typeof q === 'number') {
    if (!Number.isInteger(q) || q < 1 || q > 90) throw new Error('时间范围须为 1 至 90 天。');
    end=new Date(endToday); start=new Date(end); start.setDate(start.getDate()-q+1);
  } else { start=parseDate(q.startDate); end=parseDate(q.endDate); }
  const calendarValue=(d:Date) => Date.UTC(d.getFullYear(),d.getMonth(),d.getDate());
  const days=(calendarValue(end)-calendarValue(start))/86400000+1;
  if (days < 1 || days > 90 || end > endToday) throw new Error('请选择不超过今天、顺序正确且最多 90 天的日期范围。');
  const range: DateRange={startDate:dateKey(start),endDate:dateKey(end)};
  const startMinutes=typeof q==='object' && q.startTime!==undefined ? minutes(q.startTime) : 0;
  const endMinutes=typeof q==='object' && q.endTime!==undefined ? minutes(q.endTime) : 1439;
  if(typeof q==='object' && q.startTime!==undefined)range.startTime=q.startTime;
  if(typeof q==='object' && q.endTime!==undefined)range.endTime=q.endTime;
  start.setHours(Math.floor(startMinutes/60),startMinutes%60,0,0);
  end.setHours(Math.floor(endMinutes/60),endMinutes%60,59,999);
  const start_timestamp=Math.floor(start.getTime()/1000),end_timestamp=Math.min(Math.floor(now.getTime()/1000),Math.floor(end.getTime()/1000));
  if(start_timestamp>end_timestamp)throw new Error('开始时间不能晚于结束时间或当前时间。');
  return { days, range, start_timestamp, end_timestamp, durationDays:(end_timestamp-start_timestamp+1)/86400 };
}
export function rangeLabel(range?:DateRange) {
  return range ? `${range.startDate} ${range.startTime || '00:00'} — ${range.endDate} ${range.endTime || '23:59'}` : '';
}
