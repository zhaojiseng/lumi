import {useEffect,useState,useSyncExternalStore} from 'react';
import {RefreshCw,Clock3,Wallet} from 'lucide-react';
import {bridge} from '../../../src/bridge';
import {SubscriptionResource} from '../../../src/host/subscription-resource';
import type {WorkbenchCardProps} from '../../../src/host/workbench';
import type {SubscriptionWindow} from '../../../shared/contracts/subscription-usage';
import {Button,Empty,Pill} from '../../../src/components/ui';
function Window({value}:{value:SubscriptionWindow}){
  const label=value.durationMinutes===10080 ? '周限额' : value.durationMinutes===300 ? '5 小时限额' : value.durationMinutes ? `${value.durationMinutes} 分钟限额` : '用量限额';
  return <div className="stat-card surface"><div className="stat-top"><span><Clock3 size={15}/>{label}</span></div><div className="stat-number">{value.remainingPercent===null ? '未知' : `${value.remainingPercent.toLocaleString('zh-CN',{maximumFractionDigits:1})}%`}</div><div className="quota-progress" role="progressbar" aria-label={label+'剩余'} aria-valuenow={value.remainingPercent ?? undefined} aria-valuemin={0} aria-valuemax={100}><i style={{width:`${value.remainingPercent ?? 0}%`}}/></div><p className="muted small-text">剩余额度 · {value.resetsAt ? new Date(value.resetsAt).toLocaleString('zh-CN')+' 重置' : '重置时间未知'}</p></div>;
}
export default function CodexUsageCard({refreshInterval,refreshEpoch}:WorkbenchCardProps){
  const [resource]=useState(()=>new SubscriptionResource(input=>bridge.readCodexUsage(input)));
  const {snapshot,loading,error}=useSyncExternalStore(resource.subscribe,resource.getState);
  useEffect(()=>{resource.configure(!!window.lumi);void resource.refresh();return()=>resource.configure(false);},[resource]);
  useEffect(()=>{if(refreshEpoch)void resource.refresh(true);},[resource,refreshEpoch]);
  useEffect(()=>{if(!refreshInterval || !window.lumi)return;const timer=setInterval(()=>{if(document.visibilityState==='visible')void resource.refresh();},Math.max(60,refreshInterval)*1000);return()=>clearInterval(timer);},[resource,refreshInterval]);
  return <section className="provider-usage-section" aria-label="Codex 订阅用量"><div className="section-heading"><div><h2>Codex <Pill tone="muted">{snapshot?.account?.plan || 'ChatGPT 订阅'}</Pill></h2><p>{snapshot?.account?.label || '独立读取本机 Codex 登录账户，与 New API 站点无关。'}</p></div><Button busy={loading} onClick={()=>void resource.refresh(true)} disabled={!window.lumi}><RefreshCw size={15}/>刷新用量</Button></div>
    {!window.lumi ? <Empty title="请在桌面应用中读取 Codex 用量" description="需要安装 Codex CLI，并使用 ChatGPT 账户登录。"/> : error ? <div role="alert" className="warning-banner error-banner">{error}</div> : snapshot?.state==='signed-out' ? <Empty title="Codex 尚未登录" description="在终端运行 codex login，使用 ChatGPT 账户登录后刷新。"/> : snapshot?.state==='unsupported' ? <Empty title="当前 Codex 使用 API Key 或其它认证" description="订阅限额需要 ChatGPT 账户登录；API 账单不属于订阅限额。"/> : !snapshot ? <p role="status">正在读取 Codex 用量…</p> : <>
      {snapshot.windows.map(bucket=><div key={bucket.id} className="subscription-bucket"><h3>{bucket.label}</h3><div className="stats-grid codex-quota-grid">{[bucket.primary,bucket.secondary].filter((value):value is SubscriptionWindow=>value!==null).map((value,index)=><Window key={index} value={value}/>)}<div className="stat-card surface"><div className="stat-top"><span><Wallet size={15}/>剩余积分</span></div><div className="stat-number">{bucket.credits?.unlimited===true ? '不限量' : bucket.credits?.remaining?.toLocaleString('zh-CN',{maximumFractionDigits:2}) ?? '未知'}</div><p className="muted small-text">服务返回的积分余额 · 非本地 Tokens</p></div></div></div>)}
      {!snapshot.windows.length && <Empty title="暂未返回限额数据" description="该账户的服务未提供可用窗口或积分；不会根据本地 Tokens 推算。"/>}
      <p className="muted small-text">更新于 {new Date(snapshot.fetchedAt).toLocaleString('zh-CN')} · 来源：Codex CLI account/rateLimits/read</p>
    </>}
  </section>;
}
