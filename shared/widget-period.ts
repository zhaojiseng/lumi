export const WIDGET_PERIODS=[
  {value:'latest',label:'最近一次'},
  {value:60,label:'最近 1 分钟'},{value:180,label:'最近 3 分钟'},{value:300,label:'最近 5 分钟'},
  {value:600,label:'最近 10 分钟'},{value:900,label:'最近 15 分钟'},{value:1800,label:'最近 30 分钟'},
  {value:3600,label:'最近 1 小时'},{value:10800,label:'最近 3 小时'},{value:21600,label:'最近 6 小时'},{value:43200,label:'最近 12 小时'},
  {value:86400,label:'最近 1 天'},{value:259200,label:'最近 3 天'},{value:604800,label:'最近 7 天'},
  {value:1209600,label:'最近 14 天'},{value:2592000,label:'最近 30 天'},
] as const;
export type WidgetPeriod=typeof WIDGET_PERIODS[number]['value'];
export function normalizeWidgetPeriod(value:unknown):WidgetPeriod{return WIDGET_PERIODS.some(option=>option.value===value) ? value as WidgetPeriod : 60;}
export function widgetPeriodLabel(period:WidgetPeriod){return WIDGET_PERIODS.find(option=>option.value===period)?.label || '最近 1 分钟';}
export function widgetPeriodWindow(period:WidgetPeriod,now=Date.now()){
  const end_timestamp=period==='latest' ? Math.floor(now/1000) : Math.floor(now/60000)*60-1;
  return {start_timestamp:period==='latest' ? 0 : Math.max(0,end_timestamp-period+1),end_timestamp};
}
