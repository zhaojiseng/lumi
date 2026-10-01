import type {ModelHealth} from '../../shared/types';
import {healthSlots} from '../../shared/health';
export function healthTone(rate:number) { return !Number.isFinite(rate) || rate < 0 || rate > 100 ? 'unknown' : rate >= 90 ? 'good' : rate >= 70 ? 'warning' : 'critical'; }
export function latency(ms:number) {return Number.isFinite(ms) && ms > 0 ? ms >= 1000 ? (ms/1000).toFixed(2)+'s' : Math.round(ms)+'ms' : '—';}
export function throughput(tps:number) {return Number.isFinite(tps) && tps > 0 ? tps.toFixed(1)+' t/s' : '—';}
export function HealthPlaceholder({label='暂无健康数据'}:{label?:string}) {return <span className="health-placeholder" role="img" aria-label={label} title={label}/>;}
export function HealthHistory({health,windowEnd,error}:{health?:ModelHealth;windowEnd?:number;error?:string}) {
  return <div className="health-status"><div className="health-status-heading"><span title="成功率排除业务拒绝，统计包含当前尚未结束的小时。">状态</span><span>{health && healthTone(health.success_rate)!=='unknown' ? health.success_rate.toFixed(1)+'%' : '—'}</span></div><div className="health-history" role="img" aria-label="近期成功率采样；灰色条表示暂无数据。" title={error || '最近 24 小时，每格一小时；灰色条表示暂无数据。'}>{healthSlots(health?.recent_success_series,windowEnd).map(p=><i aria-hidden="true" key={p.ts} className={p.success_rate===null ? 'unknown' : healthTone(p.success_rate)} title={new Date(p.ts*1000).toLocaleString('zh-CN',{month:'2-digit',day:'2-digit',hour:'2-digit'})+' · '+(p.success_rate===null ? '暂无数据' : p.success_rate.toFixed(1)+'%')}/>)}</div></div>;
}
export function Health({health,error,windowEnd}:{health?:ModelHealth;error?:string;windowEnd?:number}) {
  const tone=health ? healthTone(health.success_rate) : 'unknown';
  return <div className="model-health"><HealthHistory health={health} error={error} windowEnd={windowEnd}/>{health && tone!=='unknown' && <div className="health-metrics"><span title="平均请求耗时">{latency(health.avg_latency_ms)}</span><span title="平均生成速度">{throughput(health.avg_tps)}</span></div>}</div>;
}
