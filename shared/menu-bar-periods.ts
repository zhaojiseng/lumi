import type {MenuBarRange,MenuBarSelection,MenuBarUsage,MenuBarDetails,Preferences} from './types';
export function normalizeMenuBarRange(value:unknown):MenuBarRange {
  return value==='24h' || value===1 || value===7 || value===30 ? value : 'follow';
}
export function barPeriodSelection(selection:MenuBarSelection,value:unknown):MenuBarSelection {
  const range=normalizeMenuBarRange(value);
  return range==='follow' ? {...selection} : {days:range==='24h' ? 1 : range,tool:selection.tool,range};
}
export function barPeriodLabel(selection:MenuBarSelection) {
  return selection.range==='24h' ? '最近 24 小时' : selection.days===1 ? '今日' : '最近 '+selection.days+' 天';
}
export function barPeriods(preferences:Pick<Preferences,'menuBarTotalsRange'|'menuBarChartRange'>,selection:MenuBarSelection) {
  return {totals:barPeriodSelection(selection,preferences.menuBarTotalsRange),chart:barPeriodSelection(selection,preferences.menuBarChartRange)};
}
export function sameBarPeriod(a:MenuBarSelection,b:MenuBarSelection) {
  return (a.range || a.days)===(b.range || b.days) && a.tool===b.tool;
}
type Source={menuBarUsage(force:boolean,selection:MenuBarSelection):Promise<MenuBarUsage>;menuBarDetails(selection:MenuBarSelection):Promise<MenuBarDetails>};
/** Reuse the normal summary/cache path and skip the independent chart query when hidden. */
export async function loadBarPeriods(source:Source,force:boolean,totals:MenuBarSelection,chart:MenuBarSelection,showChart:boolean):Promise<MenuBarUsage> {
  const totalsTask=source.menuBarUsage(force,totals);
  if(!showChart || sameBarPeriod(totals,chart))return totalsTask;
  const [usage,chartResult]=await Promise.all([totalsTask,source.menuBarUsage(false,chart).then(value=>({value})).catch(()=>({value:null}))]);
  return {...usage,chartPeriod:{selection:chart,points:chartResult.value?.period?.points ?? null},warnings:[...usage.warnings,...(!chartResult.value ? ['独立消费趋势暂不可用'] : [])]};
}
export async function loadBarPeriodDetails(source:Source,totals:MenuBarSelection,chart:MenuBarSelection,showChart:boolean):Promise<MenuBarDetails> {
  const details=await source.menuBarDetails(totals);
  if(!showChart || sameBarPeriod(totals,chart) || chart.tool==='all' && chart.range!=='24h')return details;
  // A chart failure must not erase valid total/efficiency metrics.
  const chartDetails=await source.menuBarDetails(chart).catch(()=>null);
  return {...details,chartPoints:chartDetails?.points ?? null};
}
