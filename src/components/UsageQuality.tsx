import {useEffect,useState} from 'react';
import {Database,Zap,Loader2,RefreshCw} from 'lucide-react';
import {bridge} from '../bridge';
import {useApp} from '../context';
import {DataRefreshMotion} from './DataRefreshMotion';
import {compact} from '../../shared/utils';
import type {Dashboard,UsageQuality as Quality} from '../../shared/types';

export function UsageQuality({dashboard:d}:{dashboard:Dashboard}){
  const {preferences}=useApp();
  const [result,setResult]=useState<{scope:string;value:Quality}|null>(null),[error,setError]=useState(''),[loading,setLoading]=useState(false),[retry,setRetry]=useState(0);
  const scope=JSON.stringify([preferences.activeSiteId,d.user?.id,d.query || d.range,d.days]);
  useEffect(()=>{
    if(!d.user)return;
    if(d.quality){setResult({scope,value:d.quality});setLoading(false);setError('');return;}
    if(d.detailed){setError('当前筛选统计未完成，请缩小时间范围或重试。');setLoading(false);return;}
    let active=true;setLoading(true);setError('');
    void bridge.usageQuality(d.query || d.range || d.days).then(value=>{if(active)setResult({scope,value});}).catch(e=>{if(active)setError(e.message);}).finally(()=>{if(active)setLoading(false);});
    return ()=>{active=false;};
  },[scope,d.fetchedAt,retry]);
  const value=d.quality || (result?.scope===scope && !error ? result.value : null);
  const {fetchedAt,...metrics}=value || {};
  return <section aria-label="模型使用效率"><DataRefreshMotion className="surface usage-quality" resetKey={JSON.stringify([preferences.activeSiteId,d.user?.id])} identity={JSON.stringify(metrics)} animation={preferences.dataRefreshAnimation}>
    <div className="quality-metric"><span className="quality-icon"><Database size={18}/></span><div><span className="quality-label" title="有效消费记录的缓存读取 Tokens 合计 ÷ 对应输入 Tokens 合计；缺失或不一致的缓存元数据不当作零命中">模型缓存命中率</span><strong>{value?.cacheHitRate==null ? '—' : (value.cacheHitRate*100).toFixed(1)+'%'}</strong><small>{value ? value.cacheSamples ? `${compact(value.cacheReadTokens)} / ${compact(value.inputTokens)} Tokens · 有效 ${value.cacheSamples}/${value.requestCount} 条` : '暂无可用缓存元数据' : loading ? '正在统计所选时间段' : '暂无统计'}</small></div></div>
    <div className="quality-metric"><span className="quality-icon speed"><Zap size={18}/></span><div><span className="quality-label" title="有效消费记录的输出 Tokens 合计 ÷ 总耗时合计（含首字等待），按耗时加权">平均 Token 速率</span><strong>{value?.averageTokenSpeed==null ? '—' : value.averageTokenSpeed.toFixed(1)}{value?.averageTokenSpeed!=null && <em> t/s</em>}</strong><small>{value ? value.speedSamples ? `输出 ${compact(value.outputTokens)} Tokens · 有效 ${value.speedSamples}/${value.requestCount} 条` : '暂无可用速率数据' : loading ? '正在统计所选时间段' : '暂无统计'}</small></div></div>
    <div className="quality-status" role="status">{error ? <><span>{error}</span><button type="button" onClick={()=>setRetry(v=>v+1)}><RefreshCw size={12}/>重试</button></> : loading && !value ? <><Loader2 size={13} className="spin"/>后台统计</> : value ? <><span>当前范围完整消费日志 · 缓存 {d.detailed ? '1' : '5'} 分钟</span><span>更新于 {new Date(value.fetchedAt).toLocaleTimeString('zh-CN',{hour:'2-digit',minute:'2-digit'})}</span></> : '等待数据'}</div>
  </DataRefreshMotion></section>;
}
