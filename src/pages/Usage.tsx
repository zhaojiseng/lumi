import {StatisticsFilter} from '../components/StatisticsFilter';
import {MotionSwap} from '../components/MotionSwap';
import {resolveRange,rangeLabel,isRollingRange} from '../../shared/range';
import {LogColumnsControl,RequestLogTable,RequestDetail} from '../components/RequestLogs';
import { useEffect, useState } from 'react';
import {useSavedSelection} from '../selections';
import { Download, ChevronRight, Info, Monitor, Cloud, FileText, Loader2 } from 'lucide-react';
import { useApp } from '../context';
import { bridge } from '../bridge';
import { Button, PageIntro, SectionHeading, Select, Pill, ToolIcon, Empty } from '../components/ui';
import { TrendChart } from '../components/charts';
import {UsageTrend} from '../components/UsageTrend';
import {UsageQuality} from '../components/UsageQuality';
import { compact, formatMoney, dailySeries, usageGranularity } from '../../shared/utils';
import type { LocalUsage, LogPage, UsageLog } from '../../shared/types';
export default function Usage() {
  const { dashboard: d, preferences, days, statisticsQuery, toast, setPage } = useApp();
  const [tab, setTab] = useSavedSelection<'billing' | 'logs' | 'local'>('usage.tab','billing',v=>['billing','logs','local'].includes(v));
  const [metric, setMetric] = useSavedSelection<'cost' | 'tokens' | 'requests'>('usage.metric','cost',v=>['cost','tokens','requests'].includes(v));
  const [type, setType] = useSavedSelection<number>('usage.type',0,v=>[0,2,5].includes(v));
  const [page, setLogPage] = useState(1); const [logs, setLogs] = useState<LogPage | null>(null); const [busy, setBusy] = useState(false);
  const [local, setLocal] = useState<LocalUsage | null>(null); const [detail, setDetail] = useState<UsageLog | null>(null);
  const [localFilter, setLocalFilter] = useSavedSelection<string>('usage.localTool','all',v=>['all','codex','claude'].includes(v)); const [exporting, setExporting] = useState(false);
  const filterKey=JSON.stringify(statisticsQuery),resolved=resolveRange(statisticsQuery);
  const logQuery={days:resolved.days,range:statisticsQuery.range,models:statisticsQuery.models,tokenIds:statisticsQuery.tokenIds,type};
  useEffect(() => { setLogPage(1); }, [filterKey,type]);
  useEffect(() => {
    let active = true; setBusy(true);
    if (tab === 'logs') bridge.logs({ ...logQuery, page, pageSize: 15 }).then(r => { if (active) setLogs(r); }).catch(e => { if (active) { setLogs(null); toast(e.message, 'error'); } }).finally(() => { if (active) setBusy(false); });
    else if (tab === 'local') bridge.localUsage(statisticsQuery).then(r => { if (active) setLocal(r); }).catch(e => { if (active) toast(e.message, 'error'); }).finally(() => { if (active) setBusy(false); });
    else setBusy(false);
    return () => { active = false; };
  }, [tab, filterKey, page, type, preferences.activeSiteId, tab === 'logs' ? d?.fetchedAt : undefined]);
  if (!d) return null;
  const seriesModel = new Map<string, { quota: number; tokens: number; count: number }>();
  for (const p of d.series) { const r = seriesModel.get(p.model_name) || { quota: 0, tokens: 0, count: 0 }; r.quota += p.quota; r.tokens += p.token_used || 0; r.count += p.count || 0; seriesModel.set(p.model_name, r); }
  const bindingList = preferences.bindings.filter(b => b.siteId === preferences.activeSiteId);
  const rows = (local?.rows || []).filter(r => localFilter === 'all' || r.tool === localFilter);
  const localTrend = dailySeries(d.series,days,d.status,d.range,new Date(d.fetchedAt)).map(r => ({ ...r, tokens: rows.filter(x => x.date === r.date).reduce((s, x) => s + x.inputTokens + x.outputTokens + x.cacheReadTokens + x.cacheWriteTokens, 0), requests: rows.filter(x => x.date === r.date).reduce((s, x) => s + x.requests, 0) }));
  async function doExport() { setExporting(true); try { const r = await bridge.exportLogs({ ...logQuery, page: 1, pageSize: 100 }); if (r.count) toast(`已导出 ${r.count} 条记录`, 'success'); } catch (e: any) { toast(e.message, 'error'); } finally { setExporting(false); } }
  return <div className="page"><PageIntro title="每一份消耗，尽在掌握" description="从站点账单到本地会话，了解你的 AI 如何工作。"/><StatisticsFilter/>
    <div className="page-tabs">{([['billing', Cloud, '站点消费'], ['logs', FileText, '请求明细'], ['local', Monitor, '本机会话']] as const).map(([key, Icon, title]) => <button className={tab === key ? 'active' : ''} key={key} onClick={() => setTab(key)}><Icon size={16}/>{title}{tab === key && <span className="tab-dot"/>}</button>)}</div>
    <MotionSwap identity={tab} className="usage-tab-content">{tab === 'billing' && <>
      <UsageQuality dashboard={d}/>
      <div className="billing-summary-grid"><div className="surface billing-total"><span className="muted">当前筛选 · 消费</span><strong>{formatMoney(d.stat?.quota ?? d.series.reduce((s, p) => s + p.quota, 0), d.status)}</strong><p>{compact(d.series.reduce((s, p) => s + (p.token_used || 0), 0))} Tokens · {d.series.reduce((s, p) => s + (p.count || 0), 0).toLocaleString()} 次调用</p></div>{(['codex', 'claude'] as const).map(tool => { const b = bindingList.find(x => x.tool === tool); const st = d.toolStats?.find(s => s.tool === tool); return <div className="surface billing-tool" key={tool}><div><ToolIcon tool={tool} size={32}/><span>{tool === 'codex' ? 'Codex' : 'Claude Code'}</span><Pill tone="muted">独立令牌</Pill></div><strong>{st?.stat ? formatMoney(st.stat.quota, d.status) : '—'}</strong><p>{st?.stat ? `最近 ${days} 天 · ${st.tokenName}` : b?.tokenName ? '需要可用的账户访问令牌' : '尚未绑定独立令牌'}</p><button className="text-link" onClick={() => setPage('tools')}>管理绑定<ChevronRight size={13}/></button></div>; })}</div>
      <section className="surface panel"><SectionHeading title="消费与调用趋势" sub={usageGranularity(isRollingRange(d.query || d.range || d.days) ? 1 : d.range?.startTime || d.range?.endTime ? resolveRange(d.range,new Date(d.fetchedAt)).durationDays : d.days).label+'汇总'} action={<div className="segmented">{(['cost', 'tokens', 'requests'] as const).map((m, i) => <button className={metric === m ? 'active' : ''} key={m} onClick={() => setMetric(m)}>{['消费', 'Tokens', '请求'][i]}</button>)}</div>}/><UsageTrend dashboard={d} metric={metric} preferenceKey="usage.trend"/></section>
      <section className="surface panel"><SectionHeading title="模型消费排行" sub="按照当前时间、模型与令牌筛选统计"/>{seriesModel.size ? <div className="table-scroll"><table className="data-table"><thead><tr><th>模型</th><th>调用次数</th><th>Tokens</th><th>消费金额</th><th>消费占比</th></tr></thead><tbody>{[...seriesModel].sort((a, b) => b[1].quota - a[1].quota).map(([name, s]) => { const all = d.series.reduce((sum, p) => sum + p.quota, 0); const ratio = all ? s.quota / all * 100 : 0; return <tr key={name}><td className="font-medium">{name}</td><td>{s.count.toLocaleString()}</td><td>{compact(s.tokens)}</td><td className="money-cell">{formatMoney(s.quota, d.status, 3)}</td><td><div className="ratio-cell"><div><i style={{ width: `${ratio}%` }}/></div><span>{ratio.toFixed(1)}%</span></div></td></tr>; })}</tbody></table></div> : <Empty title="暂无消费记录" description="连接账户后自动同步。"/>}</section>
      <div className="info-note"><Info size={15}/><span>工具消费按绑定的独立令牌查询，遵循当前时间与筛选。共享令牌的消耗无法区分应用；本地 Tokens 可在“本机会话”中查看。</span></div>
    </>}
    {tab === 'logs' && <section className="surface panel logs-panel"><SectionHeading title="请求明细" sub={rangeLabel(d.range,new Date(d.fetchedAt))} action={<div className="request-log-actions"><LogColumnsControl/><Button busy={exporting} onClick={doExport}><Download size={15}/>导出 CSV</Button></div>}/><div className="filter-bar"><Select label="筛选状态" value={type} onChange={v => setType(Number(v))}><option value="0">全部状态</option><option value="2">成功调用</option><option value="5">错误请求</option></Select><span className="filter-count">{busy ? <Loader2 size={15} className="spin"/> : `共 ${logs?.total || 0} 条`}</span></div><RequestLogTable logs={logs} busy={busy} page={page} onPage={setLogPage} onDetail={setDetail} status={d.status} catalog={d.catalog}/></section>}
    {tab === 'local' && <><div className="info-note"><Monitor size={16}/><span>读取本机 ~/.codex/sessions、archived_sessions 和 ~/.claude/projects。只提取用量元数据，会话内容不会上传。缓存 Tokens 单独列出，不重复计入普通输入。</span></div><div className="stats-grid local-stats">{[['普通输入', rows.reduce((s, r) => s + r.inputTokens, 0)], ['模型输出', rows.reduce((s, r) => s + r.outputTokens, 0)], ['缓存读取', rows.reduce((s, r) => s + r.cacheReadTokens, 0)], ['缓存写入', rows.reduce((s, r) => s + r.cacheWriteTokens, 0)]].map(([label, value]) => <div className="surface stat-card" key={label}><span className="muted">{label}</span><div className="stat-number">{compact(Number(value))}</div><span className="muted small-text">Tokens · 最近 {days} 天</span></div>)}</div><section className="surface panel"><SectionHeading title="本地 Tokens 趋势" sub="普通输入 + 输出 + 缓存读取 + 缓存写入"/>{rows.length ? <TrendChart data={localTrend} metric="tokens"/> : <Empty title="暂无会话曲线" description="读取到本机会话后显示。"/>}</section><section className="surface panel"><SectionHeading title="本地模型用量" sub={busy ? '正在扫描会话…' : `已扫描 ${local?.filesScanned || 0} 个会话文件`} action={<div className="segmented">{['all', 'codex', 'claude'].map((t, i) => <button key={t} className={localFilter === t ? 'active' : ''} onClick={() => setLocalFilter(t)}>{['全部', 'Codex', 'Claude Code'][i]}</button>)}</div>}/>{rows.length ? <div className="table-scroll"><table className="data-table"><thead><tr><th>日期</th><th>工具 / 模型</th><th>输入</th><th>输出</th><th>缓存读取</th><th>缓存写入</th><th>用量事件</th></tr></thead><tbody>{rows.slice().reverse().map((r, i) => <tr key={`${r.date}-${r.tool}-${r.model}-${i}`}><td className="muted">{r.date}</td><td><div className="model-cell"><ToolIcon tool={r.tool} size={28}/><strong>{r.model}</strong></div></td><td>{compact(r.inputTokens)}</td><td>{compact(r.outputTokens)}</td><td>{compact(r.cacheReadTokens)}</td><td>{compact(r.cacheWriteTokens)}</td><td>{r.requests}</td></tr>)}</tbody></table></div> : <Empty title={busy ? '正在读取本地会话' : '没有找到会话记录'} description="使用 Codex 或 Claude Code 后，保存在本机的用量记录将显示在这里。"/>}</section>{local?.warnings.map((w, i) => <div className="warning-banner" key={i}><Info size={15}/>{w}</div>)}<div className="info-note"><Info size={15}/><span>本地记录反映工具的使用情况，费用以站点账单为准。用量事件是日志采样次数，可能与站点请求数不同；继承历史的分支会话可能包含父会话用量。</span></div></>}
    </MotionSwap>{detail && <RequestDetail log={detail} status={d.status} onClose={() => setDetail(null)}/>}
  </div>;
}
