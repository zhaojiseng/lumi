import {useMemo,useState} from 'react';
import {compact} from '../../shared/utils';
import type {LocalSessionMetadata,LocalSessionSummary,Tool} from '../../shared/types';
import {Button,Empty,SectionHeading,ToolIcon} from './ui';

export function localSessionTime(timestamp:number) {
  const date=new Date(timestamp*1000);
  return Number.isFinite(timestamp) && Number.isFinite(date.getTime()) ? date.toLocaleString('zh-CN',{year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',second:'2-digit',hour12:false}) : '时间未知';
}
export function localSessionDateTime(timestamp:number) {
  const date=new Date(timestamp*1000);
  return Number.isFinite(timestamp) && Number.isFinite(date.getTime()) ? date.toISOString() : undefined;
}
export function localSessionTitle(metadata?:LocalSessionMetadata) {
  return metadata?.title?.trim() || metadata?.firstPrompt?.trim().split(/\r?\n/)[0].slice(0,160) || '未命名会话';
}
export function localSessionProject(metadata?:LocalSessionMetadata) {
  return metadata?.project || metadata?.cwd || '未提供项目';
}
export function LocalSessions({sessions,tool,scope,busy,stale,onOpen}:{sessions?:LocalSessionSummary[];tool:Tool|'all';scope:string;busy:boolean;stale:boolean;onOpen(session:LocalSessionSummary):void}) {
  const key=JSON.stringify([scope,tool]);
  const [window,setWindow]=useState({key,count:20});
  const count=window.key===key ? window.count : 20;
  const sorted=useMemo(()=>(sessions || []).filter(session=>tool==='all' || session.tool===tool).slice().sort((a,b)=>b.updatedAt-a.updatedAt),[sessions,tool]);
  const visible=sorted.slice(0,count);
  return <section className="surface panel local-sessions"><SectionHeading title="本机会话" sub={busy ? '正在更新会话列表…' : `共 ${sorted.length.toLocaleString()} 个匹配会话 · 每次显示 20 条`}/>
    {visible.length ? <><div className="table-scroll"><table className="data-table"><thead><tr><th>会话 / 项目</th><th>最近调用</th><th>工具 / 模型</th><th>Tokens</th><th>用量事件</th><th>详情</th></tr></thead><tbody>{visible.map(session=><tr key={session.id}>
      <td><div className="local-session-summary"><strong title={localSessionTitle(session.metadata)}>{localSessionTitle(session.metadata)}</strong><span title={localSessionProject(session.metadata)}>{localSessionProject(session.metadata)}</span><span className="local-session-summary-key" title={session.metadata?.sessionKey || session.id}>会话：{session.metadata?.sessionKey || session.id}</span></div></td>
      <td className="muted nowrap"><time dateTime={localSessionDateTime(session.updatedAt)}>{localSessionTime(session.updatedAt)}</time></td>
      <td><div className="model-cell"><ToolIcon tool={session.tool} size={28}/><strong>{session.model}</strong></div></td>
      <td>{compact(session.inputTokens+session.outputTokens+session.cacheReadTokens+session.cacheWriteTokens)}</td><td>{session.requests.toLocaleString()}</td>
      <td><button type="button" className="text-link" disabled={stale} onClick={()=>{if(!stale)onOpen(session);}} aria-label={`查看 ${localSessionTitle(session.metadata)} · ${session.metadata?.sessionKey || session.id} 的会话详情`}>查看详情</button></td>
    </tr>)}</tbody></table></div><div className="local-sessions-footer"><span>已显示 {visible.length.toLocaleString()} / {sorted.length.toLocaleString()} 个会话</span>{visible.length<sorted.length && <Button onClick={()=>setWindow({key,count:count+20})}>再显示 20 条</Button>}</div></>
      : <Empty title={busy ? '正在读取会话汇总' : '没有匹配的会话'} description="会话列表按当前时间、模型和工具筛选显示。"/>}
  </section>;
}
