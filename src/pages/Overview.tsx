import {RecentActivity} from '../components/RecentActivity';
import {StatisticsFilter} from '../components/StatisticsFilter';
import {rangeLabel} from '../../shared/range';
import {useSavedSelection} from '../selections';
import { Wallet, ArrowDownLeft, Layers, Activity, ArrowUpRight, ArrowRight, Clock3, Zap, CircleCheck, ExternalLink, ChevronRight } from 'lucide-react';
import { useApp } from '../context';
import { Pill, SectionHeading, ToolIcon, Button, Empty } from '../components/ui';
import { ModelDonut } from '../components/charts';
import {UsageTrend} from '../components/UsageTrend';
import {UsageQuality} from '../components/UsageQuality';
import { currency, formatMoney, compact } from '../../shared/utils';
export default function Overview() {
  const { dashboard: d, preferences, bootstrap, overviewQuery, setOverviewQuery, setPage, toast } = useApp();
  const [metric, setMetric] = useSavedSelection<'cost' | 'tokens' | 'requests'>('overview.metric','cost',v=>['cost','tokens','requests'].includes(v));
  if (!d) return null;
  const days=d.days; const label=rangeLabel(d.range);
  const c = currency(d.status); const todayQuota=d.today?.quota;
  const totalTokens = d.series.reduce((s, p) => s + (p.token_used || 0), 0);
  const totalRequests = d.series.reduce((s, p) => s + (p.count || 0), 0);
  const cost = d.stat?.quota ?? d.series.reduce((s, p) => s + p.quota, 0);
  const modelTotals = new Map<string, number>(); for (const p of d.series) modelTotals.set(p.model_name, (modelTotals.get(p.model_name) || 0) + c.value(p.quota));
  const modelData = [...modelTotals].map(([name, value]) => ({ name, value })).filter(x => x.value > 0).sort((a, b) => b.value - a.value);
  const hour = new Date().getHours(); const greeting = hour < 11 ? '早上好' : hour < 14 ? '中午好' : hour < 19 ? '下午好' : '晚上好';
  const user = d.user?.display_name || d.user?.username || '开发者';
  return <div className="page overview-page">
    <div className="page-intro"><div><div className="eyebrow"><span className="tiny-dot"/> YOUR AI, IN ONE PLACE</div><h1>{greeting}，{user}<span className="greeting-orb">✳</span></h1><p>让每一次灵感，都有迹可循。这里是你的 AI 工作台。</p></div><Button onClick={() => setPage('tools')}><Zap size={15}/>配置开发工具<ArrowUpRight size={14}/></Button></div>
    <StatisticsFilter/>
    <div className="stats-grid">
      <div className="stat-card balance-card surface"><div className="stat-top"><span><Wallet size={15}/>账户余额</span><Pill tone="green">{d.user ? '可用' : '未连接'}</Pill></div><div className="stat-number">{d.user ? <><small>{c.symbol}</small>{c.value(d.user.quota).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</> : '—'}</div><div className="stat-bottom"><span>累计消耗 {d.user ? formatMoney(d.user.used_quota, d.status) : '—'}</span><button onClick={() => setPage('settings')} aria-label="查看账户设置"><ArrowUpRight size={17}/></button></div></div>
      <div className="stat-card surface"><div className="stat-top"><span><ArrowDownLeft size={15}/>今日消费</span><span className="stat-symbol mint"><ArrowDownLeft size={16}/></span></div><div className="stat-number"><small>{c.symbol}</small>{todayQuota == null ? '—' : c.value(todayQuota).toFixed(2)}</div><div className="stat-bottom"><span className="subtle-badge"><Clock3 size={11}/>当天 00:00 起</span><span>{d.today?.requests != null ? compact(d.today.requests)+' 次请求' : '暂无今日数据'}</span></div></div>
      <div className="stat-card surface"><div className="stat-top"><span><Layers size={15}/>Token 用量</span><span className="stat-symbol lavender"><Layers size={16}/></span></div><div className="stat-number">{compact(totalTokens)}</div><div className="stat-bottom"><span>{label}</span><span className="mini-bars">{[8, 15, 10, 21, 17, 25, 19, 28].map((h, i) => <i style={{ height: h }} key={i}/>)}</span></div></div>
      <div className="stat-card surface"><div className="stat-top"><span><Activity size={15}/>请求次数</span><span className="stat-symbol blue"><Activity size={16}/></span></div><div className="stat-number">{totalRequests.toLocaleString()}</div><div className="stat-bottom"><span>{label}</span><span className="muted">{d.stat ? `${d.stat.rpm} RPM` : '暂无速率数据'}</span></div></div>
    </div>
    <UsageQuality dashboard={d}/>
    <div className="overview-charts">
      <section className="surface panel trend-panel"><SectionHeading title="用量趋势" sub="每一点消耗，清晰可见" action={<span className="muted range-chart-label">{label}</span>}/><div className="chart-topline"><div><strong>{metric === 'cost' ? formatMoney(cost, d.status) : metric === 'tokens' ? compact(totalTokens) : totalRequests.toLocaleString()}</strong><span>{label} · {metric === 'cost' ? '消费金额' : metric === 'tokens' ? 'Token 用量' : '请求次数'}</span></div><div className="metric-tabs">{(['cost', 'tokens', 'requests'] as const).map((m, i) => <button className={metric === m ? 'active' : ''} onClick={() => setMetric(m)} key={m}>{['消费', 'Tokens', '请求'][i]}</button>)}</div></div><UsageTrend dashboard={d} metric={metric} preferenceKey="overview.trend"/></section>
      <section className="surface panel distribution-panel"><SectionHeading title="模型分布" action={<button className="icon-button" onClick={() => setPage('usage')} aria-label="查看详细用量"><ArrowUpRight size={17}/></button>}/>{modelData.length ? <ModelDonut data={modelData} total={formatMoney(d.series.reduce((s, p) => s + p.quota, 0), d.status)} symbol={c.symbol}/> : <Empty title="暂无模型消耗" description="开始使用后即可查看分布。"/>}<button className="panel-bottom-link" onClick={() => setPage('usage')}>探索用量详情<ArrowRight size={14}/></button></section>
    </div>
    <div className="section-title-row"><h3>你的开发伙伴<span>CONNECTED TO YOUR FLOW</span></h3><button className="text-link" onClick={() => setPage('tools')}>管理工具<ChevronRight size={14}/></button></div>
    <div className="tools-summary-grid">{(['codex', 'claude'] as const).map(tool => {
      const b = preferences.bindings.find(x => x.tool === tool && x.siteId === preferences.activeSiteId);
      const token = d.tokens.find(t => t.name === b?.tokenName); const config = bootstrap.configs.find(x => x.tool === tool);
      const connected = !!config?.baseUrl; const model = config?.model || b?.model;
      return <button className="surface tool-summary" key={tool} onClick={() => setPage('tools')}><ToolIcon tool={tool}/><div className="tool-summary-name"><h3>{tool === 'codex' ? 'Codex' : 'Claude Code'}<span className={`connection-dot ${connected ? '' : 'inactive'}`}/></h3><p>{model || '尚未配置模型'}</p></div><div className="tool-summary-cost"><strong>{token ? formatMoney(token.used_quota, d.status) : '—'}</strong><span>令牌累计消耗</span></div><ChevronRight size={16} className="muted"/></button>;
    })}</div>
    <section className="surface panel recent-panel"><SectionHeading title="最近活动" sub="每一次调用，都有记录" action={<button className="text-link" onClick={() => setPage('usage')}>查看全部<ArrowUpRight size={14}/></button>}/>{d.logs.items.length ? <RecentActivity logs={d.logs.items} status={d.status} catalog={d.catalog}/> : <Empty title="还没有请求记录" description="连接站点或开始调用模型后，记录会自动更新。"/>}</section>
    <div className="page-footer"><span><CircleCheck size={13}/>数据来自当前 New API 站点</span><span>Lumi · 为专注而设计</span></div>
  </div>;
}
