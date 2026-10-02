import {useEffect,useMemo,useState} from 'react';
import {Loader2,RefreshCw} from 'lucide-react';
import {bridge} from '../bridge';
import {useApp} from '../context';
import {useSavedSelection} from '../selections';
import {groupedTrend,pointGroup} from '../../shared/trends';
import {resolveRange,isRollingRange,rangeLabel} from '../../shared/range';
import {currency,usageGranularity,compact} from '../../shared/utils';
import type {Dashboard,TokenUsage,TrendGrouping,TrendMetric} from '../../shared/types';
import {Empty,Select} from './ui';
import {TrendChart} from './charts';
import {DataRefreshMotion} from './DataRefreshMotion';

export function UsageTrend({dashboard:d,preferenceKey,title='用量趋势'}:{dashboard:Dashboard;preferenceKey:string;title?:string;}){
  const {preferences}=useApp();
  const [metric,setMetric]=useSavedSelection<TrendMetric>(preferenceKey.replace(/\.trend$/,'')+'.metric','cost',v=>['cost','tokens','requests','cacheHitRate'].includes(v));
  const [grouping,setGrouping]=useSavedSelection<TrendGrouping>(preferenceKey+'.group','total',v=>['total','model','token'].includes(v));
  const [model,setModel]=useSavedSelection<string>(preferenceKey+'.model','');
  const [token,setToken]=useSavedSelection<string>(preferenceKey+'.token','');
  const [details,setDetails]=useState<{key:string;value:TokenUsage;}|null>(null);
  const [loading,setLoading]=useState(false),[error,setError]=useState(''),[retry,setRetry]=useState(0);
  const scope=JSON.stringify([preferences.activeSiteId,d.user?.id,d.query || d.range,d.days]);
  const accountKey=JSON.stringify([preferences.activeSiteId,d.user?.id]);
  useEffect(()=>{
    if(!d.user || d.detailed){setLoading(false);setError('');return;}
    let active=true;setLoading(true);setError('');
    // Request timestamps and cache metadata share the complete-log cache.
    // Hourly aggregates cannot produce accurate sub-hour samples.
    void bridge.tokenUsage(d.query || d.range || d.days).then(value=>{if(active)setDetails({key:scope,value});}).catch(e=>{if(active)setError(e.message);}).finally(()=>{if(active)setLoading(false);});
    return()=>{active=false;};
  },[scope,d.detailed,!!d.user,d.fetchedAt,retry]);
  const detailData=!d.detailed && details?.key===scope ? details.value : null;
  const points=d.detailed ? d.series : detailData?.points || [];
  const now=new Date(d.fetchedAt),range=isRollingRange(d.query || d.range || d.days) ? '24h' : d.range;
  const selection=grouping==='model' ? model : token;
  const all=useMemo(()=>groupedTrend(points,d.days,d.status,range,now,grouping,metric),[points,d.days,d.status,range,now.getTime(),grouping,metric]);
  const selected=all.options.some(option=>option.key===selection) ? selection : '';
  const chart=selected ? groupedTrend(points,d.days,d.status,range,now,grouping,metric,selected) : all;
  const window=resolveRange(range || d.days,now);
  const windowPoints=points.filter(p=>p.created_at>=window.start_timestamp && p.created_at<=window.end_timestamp);
  const selectedPoints=selected && grouping!=='total' ? windowPoints.filter(p=>pointGroup(p,grouping).key===selected) : windowPoints;
  const totals=selectedPoints.reduce((a,p)=>({cost:a.cost+currency(d.status).value(p.quota),tokens:a.tokens+p.token_used,requests:a.requests+p.count,input:a.input+(p.cacheInputTokens || 0),read:a.read+(p.cacheReadTokens || 0)}),{cost:0,tokens:0,requests:0,input:0,read:0});
  const names={cost:'消费',tokens:'Tokens',requests:'请求',cacheHitRate:'缓存命中率'};
  const ready=d.detailed || !!detailData;
  const value=!ready || metric==='cacheHitRate' && totals.input<=0 ? '—' : metric==='cacheHitRate' ? (totals.read/totals.input*100).toFixed(1)+'%' : metric==='cost' ? currency(d.status).symbol+totals.cost.toFixed(2) : compact(totals[metric]);
  const label=grouping==='model' ? '模型' : '令牌';
  const grain=usageGranularity(window.durationDays);
  return <>
    <div className="trend-heading">
      <div className="trend-heading-copy"><h3>{title}</h3><p>{rangeLabel(d.range,now)}</p><DataRefreshMotion className="trend-summary" resetKey={accountKey} identity={JSON.stringify([metric,grouping,selected,value])} animation={preferences.dataRefreshAnimation}><strong>{value}</strong><span>{names[metric]}{selected ? ' · '+all.options.find(o=>o.key===selected)?.name : ' · 当前筛选范围'}</span></DataRefreshMotion></div>
      <div className="trend-controls" aria-label="趋势曲线选项">
        <Select label="趋势指标" value={metric} onChange={v=>setMetric(v as TrendMetric)} decorated={false}>{(['cost','tokens','requests','cacheHitRate'] as const).map(m=><option value={m} key={m}>{names[m]}</option>)}</Select>
        <Select label="曲线分组" value={grouping} onChange={v=>setGrouping(v as TrendGrouping)} decorated={false}><option value="total">合计</option><option value="model">按模型</option><option value="token">按令牌</option></Select>
        {grouping!=='total' && <Select label={'曲线'+label} value={selected} onChange={grouping==='model' ? setModel : setToken} decorated={false}><option value="">全部{label}</option>{all.options.map(option=><option key={option.key} value={option.key}>{option.name}</option>)}</Select>}
      </div>
    </div>
    <DataRefreshMotion identity={JSON.stringify([scope,metric,grouping,selected,chart.lines,chart.rows.map(row=>[row[metric],row.values])])} resetKey={accountKey} animation={preferences.dataRefreshAnimation || 'slide-up'} className="trend-data">
      {!ready && error ? <div className="trend-error" role="status"><span>{error}</span><button type="button" onClick={()=>setRetry(v=>v+1)}><RefreshCw size={13}/>重试</button></div> : !ready && loading ? <div className="trend-placeholder"><Loader2 size={22} className="spin"/><span>正在汇总所选时间段的完整消费记录</span></div> : points.length ? <TrendChart data={chart.rows} metric={metric} symbol={currency(d.status).symbol} series={chart.lines}/> : <Empty title="暂无用量曲线" description="所选时间段没有消费记录。"/>}
      {points.length>0 && chart.lines.length>0 && <div className="trend-legend">{chart.lines.map(line=><span key={line.id} title={line.name}><i style={{background:line.color}}/>{line.name}</span>)}</div>}
    </DataRefreshMotion>
    <div className="chart-note"><span>{grain.label} · 时长 ÷ 30 · 完整消费日志{metric==='cacheHitRate' ? ' · 有效缓存读取 ÷ 对应输入 Tokens，无数据留空' : ' · 输入 + 输出 Tokens'}</span>{loading && <span className="trend-loading"><Loader2 size={12} className="spin"/>同步中</span>}{error && ready && <span className="trend-loading" role="status" title={error}>同步失败，保留上次结果<button type="button" onClick={()=>setRetry(v=>v+1)}>重试</button></span>}{chart.combined>0 && <span>{metric==='cacheHitRate' ? '有效输入量' : names[metric]}最高的 8 项单列，其余合并；可单独选择任意{label}</span>}</div>
  </>;
}
