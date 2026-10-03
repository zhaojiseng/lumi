import {ModalPresence} from '../../../src/components/ModalPresence';
import {useEffect,useState} from 'react';
import {Info,Monitor,RefreshCw} from 'lucide-react';
import {useSourcePreferences,useSourceSelection} from '../../../src/host/source-preferences';
import {resolveRange,rangeLabel} from '../../../shared/range';
import {Button,SectionHeading,ToolIcon,Empty} from '../../../src/components/ui';
import {DateRangePicker} from '../../../src/components/DateRangePicker';
import {MultiSelect} from '../../../src/components/StatisticsFilter';
import {TrendChart} from '../../../src/components/charts';
import {LocalUsageProgress} from '../../../src/components/LocalUsageProgress';
import {useLocalUsage} from '../../../src/components/useLocalUsage';
import {LocalSessions} from '../../../src/components/LocalSessions';
import {LocalSessionDetails} from '../../../src/components/LocalSessionDetails';
import {localUsageSeries} from '../../../shared/local-trends';
import {compact,usageGranularity} from '../../../shared/utils';
import type {LocalSessionSummary,Tool,StatisticsQuery,RangeQuery} from '../../../shared/types';
import '../../../src/local-usage.css';
export default function LocalUsageView(){
  const {desktop,onError}=useSourcePreferences();
  const [range,setRange]=useSourceSelection<RangeQuery>('source.local-sessions','range',7,value=>{try{resolveRange(value);return true;}catch{return false;}});
  const [models,setModels]=useSourceSelection<string[]>('source.local-sessions','models',[],Array.isArray);
  const [localFilter,setLocalFilter]=useSourceSelection<string>('source.local-sessions','tool','all',value=>['all','codex','claude'].includes(value));
  const [revision,setRevision]=useState(0);
  const statisticsQuery:StatisticsQuery={range,models,tokenIds:[]},localAccountKey='source.local-sessions:'+revision;
  const localDetailScope=JSON.stringify([localAccountKey,statisticsQuery]);
  const [sessionDetail,setSessionDetail]=useState<{scope:string;session:LocalSessionSummary;query:StatisticsQuery}|null>(null);
  const {local,query:localQuery,busy:localBusy,progress:localProgress,stale:localStale}=useLocalUsage(desktop,statisticsQuery,localAccountKey,onError);
  useEffect(()=>{setSessionDetail(null);},[localDetailScope,localFilter]);
  const rows=(local?.rows || []).filter(row=>localFilter==='all' || row.tool===localFilter);
  const localNow=new Date(local?.scannedAt || Date.now()),localWindow=resolveRange(localQuery,localNow);
  const localTrend=localUsageSeries(local?.points || [],localQuery,localNow,localFilter as Tool|'all');
  const localHasTrend=localTrend.some(row=>row.tokens>0 || row.requests>0);
  const names=[...new Set([...(local?.rows.map(row=>row.model) || []),...models])].sort();
  if(!desktop)return <Empty title="本机会话仅在桌面应用中可用" description="无需连接 New API；读取本机保存的会话文件。"/>;
  return <><div className="surface statistics-filter"><div className="statistics-controls"><span className="statistics-title">本地筛选</span><div className="segmented range-presets">{(['24h',1,7,30] as const).map(value=><button key={value} className={range===value ? 'active' : ''} onClick={()=>setRange(value)}>{value==='24h' ? '24h' : value+' 天'}</button>)}</div><DateRangePicker range={resolveRange(range).range} onApply={setRange}/><MultiSelect label="本地模型" options={names.map(value=>({value,label:value}))} value={models} onApply={setModels}/>{models.length>0 && <button className="text-link" onClick={()=>setModels([])}>全部模型</button>}<Button busy={localBusy} onClick={()=>setRevision(value=>value+1)}><RefreshCw size={15}/>重新扫描</Button></div></div>
    <><div className="info-note"><Monitor size={16}/><span>只读本机 Codex / Claude Code 会话。完整载入调用索引后分页浏览，支持查看消息、回复与工具记录；内容仅在本机显示。缓存 Tokens 单独列出，不重复计入普通输入。</span></div><LocalUsageProgress progress={localProgress}/><div className="stats-grid local-stats">{[['普通输入', rows.reduce((s, r) => s + r.inputTokens, 0)], ['模型输出', rows.reduce((s, r) => s + r.outputTokens, 0)], ['缓存读取', rows.reduce((s, r) => s + r.cacheReadTokens, 0)], ['缓存写入', rows.reduce((s, r) => s + r.cacheWriteTokens, 0)]].map(([label, value]) => <div className="surface stat-card" key={label}><span className="muted">{label}</span><div className="stat-number">{compact(Number(value))}</div><span className="muted small-text">Tokens · 所选 {localWindow.days} 天</span></div>)}</div><section className="surface panel"><SectionHeading title="本地 Tokens 趋势" sub={rangeLabel(localWindow.range,localNow)}/>{localHasTrend ? <TrendChart data={localTrend} metric="tokens"/> : <Empty title="暂无会话曲线" description={localBusy ? "正在读取所选时间段的本机会话。" : local && !local.points && rows.length ? "当前会话数据缺少时间记录，重新扫描后显示。" : "所选时间段没有本机会话用量。"}/>}<div className="chart-note"><span>{usageGranularity(localWindow.durationDays).label} · 时长 ÷ 30 · 普通输入 + 输出 + 缓存读取 + 缓存写入</span></div></section><section className="surface panel"><SectionHeading title="本地模型用量" sub={localBusy ? '正在扫描会话…' : `已扫描 ${local?.filesScanned || 0} 个会话文件`} action={<div className="segmented">{['all', 'codex', 'claude'].map((t, i) => <button key={t} className={localFilter === t ? 'active' : ''} onClick={() => setLocalFilter(t)}>{['全部', 'Codex', 'Claude Code'][i]}</button>)}</div>}/>{rows.length ? <div className="table-scroll"><table className="data-table"><thead><tr><th>日期</th><th>工具 / 模型</th><th>输入</th><th>输出</th><th>缓存读取</th><th>缓存写入</th><th>用量事件</th></tr></thead><tbody>{rows.slice().reverse().map((r, i) => <tr key={`${r.date}-${r.tool}-${r.model}-${i}`}><td className="muted">{r.date}</td><td><div className="model-cell"><ToolIcon tool={r.tool} size={28}/><strong>{r.model}</strong></div></td><td>{compact(r.inputTokens)}</td><td>{compact(r.outputTokens)}</td><td>{compact(r.cacheReadTokens)}</td><td>{compact(r.cacheWriteTokens)}</td><td>{r.requests}</td></tr>)}</tbody></table></div> : <Empty title={localBusy ? '正在读取本地会话' : '没有找到会话记录'} description="使用 Codex 或 Claude Code 后，保存在本机的用量记录将显示在这里。"/>}</section><LocalSessions sessions={local?.sessions} tool={localFilter as Tool|'all'} scope={JSON.stringify([localDetailScope,local?.scannedAt])} busy={localBusy} stale={localStale} onOpen={session=>setSessionDetail({scope:localDetailScope,session,query:structuredClone(statisticsQuery)})}/>{local?.warnings.map((w, i) => <div className="warning-banner" key={i}><Info size={15}/>{w}</div>)}<div className="info-note"><Info size={15}/><span>本地记录反映工具的使用情况，费用以站点账单为准。用量事件是日志采样次数，可能与站点请求数不同；继承历史的分支会话可能包含父会话用量。</span></div></>
    <ModalPresence key={localDetailScope+'|'+localFilter}>{sessionDetail?.scope===localDetailScope && (localFilter==='all' || sessionDetail.session.tool===localFilter) && <LocalSessionDetails session={sessionDetail.session} query={sessionDetail.query} accountKey={localAccountKey} onClose={()=>setSessionDetail(null)}/>}</ModalPresence>
  </>;
}
