import {useState,useCallback} from 'react';
import {ProviderIcon} from './BrandIcon';
import type {UsageLog,SiteStatus,ModelCatalog} from '../../shared/types';
import {logMetrics,requestTiming,requestStatus} from '../../shared/logs';
import {formatMoney} from '../../shared/utils';
import {RequestDetail} from './RequestLogs';
const number=(n:number|null)=>n===null ? '—' : n.toLocaleString('en-US');
const time=(ms:number|null)=>ms===null ? '—' : (ms/1000).toLocaleString('en-US',{maximumFractionDigits:3})+'s';
export function RecentActivity({logs,status,catalog}:{logs:UsageLog[];status:SiteStatus;catalog:ModelCatalog}) {
  const [detail,setDetail]=useState<UsageLog|null>(null);const close=useCallback(()=>setDetail(null),[]);
  return <><div className="table-scroll"><table className="data-table recent-activity-table"><thead><tr><th>模型</th><th>输入 / 缓存命中</th><th>输出</th><th>费用</th><th title="输出 Tokens ÷ 总耗时（含首字等待）">速率</th><th title="首字等待 / 首字之后到请求结束的耗时；非流式或缺少数据时不推算">首字 / 后续</th><th>状态码</th></tr></thead><tbody>{logs.slice(0,5).map(log=>{
    const metrics=logMetrics(log),timing=requestTiming(log),state=requestStatus(log);
    const vendor=catalog.models.find(m=>m.model_name===log.model_name)?.vendor;
    const label=(state.httpStatus===null ? '—' : String(state.httpStatus))+' · '+(state.isError ? '错误' : log.type===2 ? '成功' : '其他');
    return <tr key={log.id}><td><div className="model-cell"><ProviderIcon vendor={vendor} modelName={log.model_name} className="model-mark" size={20}/><div><strong title={log.model_name}>{log.model_name}</strong><span title={log.token_name || '未提供令牌名称'}>{new Date(log.created_at*1000).toLocaleTimeString('zh-CN',{hour:'2-digit',minute:'2-digit',second:'2-digit'})}</span></div></div></td><td><div className="recent-tokens"><strong>{number(log.prompt_tokens)}</strong><small title="站点返回的缓存读取 Tokens，与输入账单值不额外相加">缓存命中 {number(metrics.cacheRead)}</small></div></td><td>{number(log.completion_tokens)}</td><td className="money-cell">{formatMoney(log.quota,status,4)}</td><td className="nowrap">{metrics.speed===null ? '—' : metrics.speed.toLocaleString('en-US',{maximumFractionDigits:1})+' t/s'}</td><td className="nowrap recent-timing"><span>{time(timing.firstMs)}</span><span className="muted"> / {time(timing.subsequentMs)}</span></td><td>{state.isError ? <button type="button" className="recent-status error" aria-label={'查看请求 '+log.id+' 错误详情'} onClick={()=>setDetail(log)}>{label}</button> : <span className={'recent-status '+(log.type===2 ? 'success' : '')} title={state.httpStatus===null ? '站点未返回 HTTP 状态码' : '站点返回的 HTTP 状态码'}>{label}</span>}</td></tr>;
  })}</tbody></table></div>{detail && <RequestDetail log={detail} status={status} onClose={close}/>}</>;
}
