import type { DashboardQuery, DateRange } from './types';
export function dateKey(date: Date) { return date.toLocaleDateString('sv-SE'); }
function parseDate(value: string) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) throw new Error('请选择有效日期。');
  const [y,m,d]=value.split('-').map(Number); const date=new Date(y,m-1,d);
  if (dateKey(date) !== value) throw new Error('请选择有效日期。');
  return date;
}
/** Local calendar dates, inclusive; timestamps are always seconds for New API. */
export function resolveRange(query: DashboardQuery, now = new Date()) {
  const endToday=new Date(now); endToday.setHours(0,0,0,0);
  let start: Date; let end: Date;
  if (typeof query === 'number') {
    if (!Number.isInteger(query) || query < 1 || query > 90) throw new Error('时间范围须为 1 至 90 天。');
    end=new Date(endToday); start=new Date(end); start.setDate(start.getDate()-query+1);
  } else { start=parseDate(query.startDate); end=parseDate(query.endDate); }
  const calendarValue=(d:Date) => Date.UTC(d.getFullYear(),d.getMonth(),d.getDate());
  const days=(calendarValue(end)-calendarValue(start))/86400000+1;
  if (days < 1 || days > 90 || end > endToday) throw new Error('请选择不超过今天、顺序正确且最多 90 天的日期范围。');
  const exclusive=new Date(end); exclusive.setDate(exclusive.getDate()+1);
  const range: DateRange={startDate:dateKey(start),endDate:dateKey(end)};
  return { days, range, start_timestamp:Math.floor(start.getTime()/1000), end_timestamp:Math.min(Math.floor(now.getTime()/1000),Math.floor(exclusive.getTime()/1000)-1) };
}
