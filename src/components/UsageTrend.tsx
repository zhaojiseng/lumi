import {useEffect,useMemo,useState} from 'react';
import {Loader2,RefreshCw} from 'lucide-react';
import {bridge} from '../bridge';
import {useApp} from '../context';
import {useSavedSelection} from '../selections';
import {groupedTrend} from '../../shared/trends';
import {currency,usageGranularity} from '../../shared/utils';
import type {Dashboard,TokenUsage,TrendGrouping,TrendMetric} from '../../shared/types';
import {Empty,Select} from './ui';
import {TrendChart} from './charts';

export function UsageTrend({dashboard:d,metric,preferenceKey}:{dashboard:Dashboard;metric:TrendMetric;preferenceKey:string;}){
  const {preferences}=useApp();
  const [grouping,setGrouping]=useSavedSelection<TrendGrouping>(preferenceKey+'.group','total',v=>['total','model','token'].includes(v));
  const [model,setModel]=useSavedSelection<string>(preferenceKey+'.model','');
  const [token,setToken]=useSavedSelection<string>(preferenceKey+'.token','');
  const [tokens,setTokens]=useState<{key:string;value:TokenUsage;}|null>(null);
  const [loading,setLoading]=useState(false),[error,setError]=useState(''),[retry,setRetry]=useState(0);
  const scope=JSON.stringify([preferences.activeSiteId,d.user?.id,d.range,d.days,d.fetchedAt]);
  useEffect(()=>{
    if(grouping!=='token' || !d.user){setLoading(false);return;}
    let active=true;setLoading(true);setError('');
    void bridge.tokenUsage(d.range || d.days).then(value=>{if(active)setTokens({key:scope,value});}).catch(e=>{if(active)setError(e.message);}).finally(()=>{if(active)setLoading(false);});
    return ()=>{active=false;};
  },[grouping,scope,retry]);
  const tokenData=tokens?.key===scope ? tokens.value : null;
  const points=grouping==='token' ? tokenData?.points || [] : d.series;
  const now=grouping==='token' && tokenData ? new Date(tokenData.fetchedAt) : new Date(d.fetchedAt);
  const selection=grouping==='model' ? model : token;
  const all=useMemo(()=>groupedTrend(points,d.days,d.status,d.range,now,grouping,metric),[points,d.days,d.status,d.range,now.getTime(),grouping,metric]);
  const selected=all.options.some(option=>option.key===selection) ? selection : '';
  const chart=selected ? groupedTrend(points,d.days,d.status,d.range,now,grouping,metric,selected) : all;
  const label=grouping==='model' ? '模型' : '令牌';
  return <>
    <div className="trend-controls"><div className="segmented" aria-label="曲线分组">{(['total','model','token'] as const).map((mode,i)=><button type="button" key={mode} className={grouping===mode ? 'active' : ''} aria-pressed={grouping===mode} onClick={()=>setGrouping(mode)}>{['合计','按模型','按令牌'][i]}</button>)}</div>
      {grouping!=='total' && <Select label={'曲线'+label} value={selected} onChange={grouping==='model' ? setModel : setToken}><option value="">全部{label}</option>{all.options.map(option=><option key={option.key} value={option.key}>{option.name}</option>)}</Select>}
      {loading && <span className="trend-loading"><Loader2 size={13} className="spin"/>读取令牌用量</span>}
    </div>
    {error && grouping==='token' ? <div className="trend-error" role="status"><span>{error}</span><button type="button" onClick={()=>setRetry(v=>v+1)}><RefreshCw size={13}/>重试</button></div> : loading && !tokenData && grouping==='token' ? <div className="trend-placeholder"><Loader2 size={22} className="spin"/><span>正在汇总所选时间段的令牌消费</span></div> : points.length ? <>
      <TrendChart data={chart.rows} metric={metric} symbol={currency(d.status).symbol} series={chart.lines}/>
    </> : <Empty title="暂无用量曲线" description="所选时间段没有消费记录。"/>}
    {points.length>0 && !loading && !error && chart.lines.length>0 && <div className="trend-legend">{chart.lines.map(line=><span key={line.id} title={line.name}><i style={{background:line.color}}/>{line.name}</span>)}</div>}
    <div className="chart-note"><span>{usageGranularity(d.days).label}汇总 · {grouping==='token' ? '来源：完整消费日志 · 输入 + 输出 Tokens' : '来源：站点用量统计'}</span>{chart.combined>0 && <span>{metric==='cost' ? '消费金额' : metric==='tokens' ? 'Tokens' : '请求次数'}最高的 8 项单列，其余合并；可选择任意{label}单独查看</span>}</div>
  </>;
}
