import {useMemo,useState} from 'react';
import {compact} from '../../shared/utils';
import type {LocalSessionSummary,Tool} from '../../shared/types';
import {Button,Empty,SectionHeading,ToolIcon} from './ui';

export function localSessionTime(timestamp:number) {
  return new Date(timestamp*1000).toLocaleString('zh-CN',{year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',second:'2-digit',hour12:false});
}
export function LocalSessions({sessions,tool,scope,busy,stale,onOpen}:{sessions?:LocalSessionSummary[];tool:Tool|'all';scope:string;busy:boolean;stale:boolean;onOpen(session:LocalSessionSummary):void}) {
  const key=JSON.stringify([scope,tool]);
  const [window,setWindow]=useState({key,count:20});
  const count=window.key===key ? window.count : 20;
  const sorted=useMemo(()=>(sessions || []).filter(session=>tool==='all' || session.tool===tool).slice().sort((a,b)=>b.updatedAt-a.updatedAt),[sessions,tool]);
  const visible=sorted.slice(0,count);
  return <section className="surface panel local-sessions"><SectionHeading title="会话用量" sub={busy ? '正在更新会话列表…' : `共 ${sorted.length.toLocaleString()} 个匹配会话 · 每次显示 20 条`}/>
    {visible.length ? <><div className="table-scroll"><table className="data-table"><thead><tr><th>最近调用</th><th>工具 / 模型</th><th>Tokens</th><th>用量事件</th><th>详情</th></tr></thead><tbody>{visible.map(session=><tr key={session.id}>
      <td className="muted nowrap"><time dateTime={new Date(session.updatedAt*1000).toISOString()}>{localSessionTime(session.updatedAt)}</time></td>
      <td><div className="model-cell"><ToolIcon tool={session.tool} size={28}/><strong>{session.model}</strong></div></td>
      <td>{compact(session.inputTokens+session.outputTokens+session.cacheReadTokens+session.cacheWriteTokens)}</td><td>{session.requests.toLocaleString()}</td>
      <td><button className="text-link" disabled={stale} onClick={()=>onOpen(session)} aria-label={`查看 ${session.tool==='codex' ? 'Codex' : 'Claude Code'} ${session.model} 会话用量详情`}>查看用量</button></td>
    </tr>)}</tbody></table></div><div className="local-sessions-footer"><span>已显示 {visible.length.toLocaleString()} / {sorted.length.toLocaleString()} 个会话</span>{visible.length<sorted.length && <Button onClick={()=>setWindow({key,count:count+20})}>再显示 20 条</Button>}</div></>
      : <Empty title={busy ? '正在读取会话汇总' : '没有匹配的会话'} description="会话列表按当前时间、模型和工具筛选显示。"/>}
  </section>;
}
