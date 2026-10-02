import {Welcome} from '../../../src/components/Login';
import {StatisticsFilter} from '../../../src/components/StatisticsFilter';
import {MotionSwap} from '../../../src/components/MotionSwap';
import {resolveRange,rangeLabel} from '../../../shared/range';
import {LogColumnsControl,RequestLogTable,RequestDetail} from '../../../src/components/RequestLogs';
import { useEffect, useState } from 'react';
import {useSavedSelection} from '../../../src/selections';
import { Download, ChevronRight, Info, Loader2 } from 'lucide-react';
import { useApp } from '../../../src/context';
import { bridge } from '../../../src/bridge';
import { Button, SectionHeading, Select, Pill, ToolIcon, Empty } from '../../../src/components/ui';
import {UsageTrend} from '../../../src/components/UsageTrend';
import {UsageQuality} from '../../../src/components/UsageQuality';
import {DataRefreshMotion} from '../../../src/components/DataRefreshMotion';
import { compact, formatMoney } from '../../../shared/utils';
import type { LogPage, UsageLog } from '../../../shared/types';
export default function OnlineUsage({view:tab}:{view:'billing'|'logs'}) {
  const { dashboard: d, preferences, days, statisticsQuery, toast, setPage,openLogin } = useApp();
  const [type, setType] = useSavedSelection<number>('usage.type',0,v=>[0,2,5].includes(v));
  const [page, setLogPage] = useState(1); const [logs, setLogs] = useState<LogPage | null>(null); const [busy, setBusy] = useState(false);
  const [detail, setDetail] = useState<UsageLog | null>(null);
  const [exporting,setExporting]=useState(false);
  const filterKey=JSON.stringify(statisticsQuery),resolved=resolveRange(statisticsQuery);
  const logQuery={days:resolved.days,range:statisticsQuery.range,models:statisticsQuery.models,tokenIds:statisticsQuery.tokenIds,type};
  useEffect(() => { setLogPage(1); }, [filterKey,type]);
  useEffect(() => {
    let active = true; setBusy(true);
    if (tab === 'logs' && d?.user) bridge.logs({ ...logQuery, page, pageSize: 15 }).then(r => { if (active) setLogs(r); }).catch(e => { if (active) { setLogs(null); toast(e.message, 'error'); } }).finally(() => { if (active) setBusy(false); });
    else setBusy(false);
    return () => { active = false; };
  }, [tab, filterKey, page, type, preferences.activeSiteId, tab === 'logs' ? d?.fetchedAt : undefined]);
  if (!d?.user) return <Welcome onLogin={openLogin}/>;
  const seriesModel = new Map<string, { quota: number; tokens: number; count: number }>();
  for (const p of d.series) { const r = seriesModel.get(p.model_name) || { quota: 0, tokens: 0, count: 0 }; r.quota += p.quota; r.tokens += p.token_used || 0; r.count += p.count || 0; seriesModel.set(p.model_name, r); }
  const refreshScope=JSON.stringify([preferences.activeSiteId,d.user?.id]);
  const motion={animation:preferences.dataRefreshAnimation,resetKey:refreshScope};
  const bindingList = preferences.bindings.filter(b => b.siteId === preferences.activeSiteId);
  async function doExport() { setExporting(true); try { const r = await bridge.exportLogs({ ...logQuery, page: 1, pageSize: 100 }); if (r.count) toast(`已导出 ${r.count} 条记录`, 'success'); } catch (e: any) { toast(e.message, 'error'); } finally { setExporting(false); } }
  return <><StatisticsFilter/>
    <MotionSwap identity={tab} className="usage-tab-content">{tab === 'billing' && <>
      <UsageQuality dashboard={d}/>
      <DataRefreshMotion {...motion} identity={JSON.stringify([d.stat,d.series,d.toolStats])} className="billing-summary-grid"><div className="surface billing-total"><span className="muted">当前筛选 · 消费</span><strong>{formatMoney(d.stat?.quota ?? d.series.reduce((s, p) => s + p.quota, 0), d.status)}</strong><p>{compact(d.series.reduce((s, p) => s + (p.token_used || 0), 0))} Tokens · {d.series.reduce((s, p) => s + (p.count || 0), 0).toLocaleString()} 次调用</p></div>{(['codex', 'claude'] as const).map(tool => { const b = bindingList.find(x => x.tool === tool); const st = d.toolStats?.find(s => s.tool === tool); return <div className="surface billing-tool" key={tool}><div><ToolIcon tool={tool} size={32}/><span>{tool === 'codex' ? 'Codex' : 'Claude Code'}</span><Pill tone="muted">独立令牌</Pill></div><strong>{st?.stat ? formatMoney(st.stat.quota, d.status) : '—'}</strong><p>{st?.stat ? `最近 ${days} 天 · ${st.tokenName}` : b?.tokenName ? '需要可用的账户访问令牌' : '尚未绑定独立令牌'}</p><button className="text-link" onClick={() => setPage('tools')}>管理绑定<ChevronRight size={13}/></button></div>; })}</DataRefreshMotion>
      <section className="surface panel trend-panel"><UsageTrend dashboard={d} title="消费与调用趋势" preferenceKey="usage.trend"/></section>
      <section className="surface panel"><SectionHeading title="模型消费排行" sub="按照当前时间、模型与令牌筛选统计"/><DataRefreshMotion {...motion} identity={JSON.stringify([...seriesModel])}>{seriesModel.size ? <div className="table-scroll"><table className="data-table"><thead><tr><th>模型</th><th>调用次数</th><th>Tokens</th><th>消费金额</th><th>消费占比</th></tr></thead><tbody>{[...seriesModel].sort((a, b) => b[1].quota - a[1].quota).map(([name, s]) => { const all = d.series.reduce((sum, p) => sum + p.quota, 0); const ratio = all ? s.quota / all * 100 : 0; return <tr key={name}><td className="font-medium">{name}</td><td>{s.count.toLocaleString()}</td><td>{compact(s.tokens)}</td><td className="money-cell">{formatMoney(s.quota, d.status, 3)}</td><td><div className="ratio-cell"><div><i style={{ width: `${ratio}%` }}/></div><span>{ratio.toFixed(1)}%</span></div></td></tr>; })}</tbody></table></div> : <Empty title="暂无消费记录" description="连接账户后自动同步。"/>}</DataRefreshMotion></section>
      <div className="info-note"><Info size={15}/><span>工具消费按绑定的独立令牌查询，遵循当前时间与筛选。共享令牌的消耗无法区分应用；本地 Tokens 可在“本机会话”中查看。</span></div>
    </>}
    {tab === 'logs' && <section className="surface panel logs-panel"><SectionHeading title="请求明细" sub={rangeLabel(d.range,new Date(d.fetchedAt))} action={<div className="request-log-actions"><LogColumnsControl/><Button busy={exporting} onClick={doExport}><Download size={15}/>导出 CSV</Button></div>}/><div className="filter-bar"><Select label="筛选状态" value={type} onChange={v => setType(Number(v))}><option value="0">全部状态</option><option value="2">成功调用</option><option value="5">错误请求</option></Select><span className="filter-count">{busy ? <Loader2 size={15} className="spin"/> : `共 ${logs?.total || 0} 条`}</span></div><DataRefreshMotion {...motion} resetKey={JSON.stringify([refreshScope,page,type])} identity={JSON.stringify(logs)}><RequestLogTable logs={logs} busy={busy} page={page} onPage={setLogPage} onDetail={setDetail} status={d.status} catalog={d.catalog}/></DataRefreshMotion></section>}

    </MotionSwap>{detail && <RequestDetail log={detail} status={d.status} onClose={() => setDetail(null)}/>}

  </>;
}
