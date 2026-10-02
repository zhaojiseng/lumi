import {useEffect,useRef,useState} from 'react';
import {Loader2} from 'lucide-react';
import {bridge} from '../bridge';
import {compact} from '../../shared/utils';
import type {DashboardQuery,LocalSessionPage,LocalSessionRecord,LocalSessionSummary} from '../../shared/types';
import {Button,Empty,Modal} from './ui';
import {localUsageBytes} from './LocalUsageProgress';
import {localSessionTime} from './LocalSessions';

interface DetailState {scope:string;items:LocalSessionRecord[];page:LocalSessionPage|null;pending:boolean;error:string;retryCursor?:string;trimmed:boolean;}
const initial=(scope:string):DetailState=>({scope,items:[],page:null,pending:true,error:'',trimmed:false});
export function mergeSessionRecords(previous:LocalSessionRecord[],incoming:LocalSessionRecord[]) {
  const records=[...new Map([...previous,...incoming].map(record=>[record.id,record])).values()].sort((a,b)=>a.created_at-b.created_at);
  return {items:records.slice(-200),trimmed:records.length>200};
}
export function useLocalSessionDetails(sessionId:string,query:DashboardQuery,accountKey:string) {
  const scope=JSON.stringify([accountKey,query,sessionId]);
  const latest=useRef(scope);latest.current=scope;
  const mounted=useRef(false),request=useRef<{scope:string;token:object}|null>(null);
  const [state,setState]=useState<DetailState>(()=>initial(scope));
  const view=state.scope===scope ? state : initial(scope);
  function read(cursor?:string) {
    if(!mounted.current || latest.current!==scope || request.current?.scope===scope)return;
    const token={};request.current={scope,token};
    const current=()=>mounted.current && latest.current===scope && request.current?.token===token;
    setState(previous=>({...(previous.scope===scope ? previous : initial(scope)),pending:true,error:'',retryCursor:cursor}));
    // The cursor keeps the first page's resolved time window in the backend.
    void bridge.localSessionDetails({sessionId,query,cursor}).then(page=>{
      if(!current())return;
      setState(previous=>{const merged=mergeSessionRecords(previous.items,page.items);return {...previous,items:merged.items,trimmed:previous.trimmed || merged.trimmed,page,pending:false};});
    }).catch(error=>{
      if(current())setState(previous=>({...previous,pending:false,error:typeof error?.message==='string' ? error.message : String(error)}));
    }).finally(()=>{if(current())request.current=null;});
  }
  useEffect(()=>{
    mounted.current=true;request.current=null;read();
    return()=>{mounted.current=false;request.current=null;};
  },[scope]);
  return {...view,loadMore:()=>{if(view.page?.nextCursor)read(view.page.nextCursor);},retry:()=>read(view.retryCursor)};
}
export function LocalSessionDetails({session,query,accountKey,onClose}:{session:LocalSessionSummary;query:DashboardQuery;accountKey:string;onClose():void}) {
  const detail=useLocalSessionDetails(session.id,query,accountKey);
  const scanned=detail.page?.scannedBytes || 0,total=detail.page?.totalBytes || 0,percent=total>0 ? Math.min(100,scanned/total*100) : undefined;
  const reasoning=detail.items.some(item=>item.reasoning);
  return <Modal title="会话用量详情" subtitle={`${session.tool==='codex' ? 'Codex' : 'Claude Code'} · ${session.model}`} wide className="local-session-details" onClose={onClose}>
    <p className="local-session-range">开始 {localSessionTime(session.startedAt)} · 最近调用 {localSessionTime(session.updatedAt)}</p>
    <p className="field-help">按当前筛选逐页读取模型调用的用量记录。</p>
    <div className="local-session-scan" role="status" aria-live="polite"><span>{detail.pending && <Loader2 size={14} className="spin"/>}{detail.pending ? '正在读取会话用量…' : `已载入 ${detail.items.length.toLocaleString()} 条调用`}</span>{detail.page && <span>已扫描 {localUsageBytes(scanned)} / {localUsageBytes(total)}{percent!==undefined ? ` · ${(Math.floor(percent*10)/10).toLocaleString('zh-CN')}%` : ''}</span>}</div>
    {detail.page && <div className="local-usage-progress-track" role="progressbar" aria-label="会话用量扫描进度" aria-valuemin={percent!==undefined ? 0 : undefined} aria-valuemax={percent!==undefined ? 100 : undefined} aria-valuenow={percent} aria-valuetext={`${localUsageBytes(scanned)} / ${localUsageBytes(total)}`}>{percent!==undefined && <i style={{width:`${percent}%`}}/>}</div>}
    {detail.trimmed && <p className="local-session-window-note" role="status">仅显示最近 200 条调用，较早记录已移出显示窗口。</p>}
    {detail.items.length ? <div className="table-scroll local-session-records"><table className="data-table"><thead><tr><th>调用时间</th><th>模型</th>{reasoning && <th>思考强度</th>}<th>普通输入</th><th>输出</th><th>缓存读取</th><th>缓存写入</th><th>上下文 Tokens</th></tr></thead><tbody>{detail.items.map(record=><tr key={record.id}>
      <td className="muted nowrap">{localSessionTime(record.created_at)}</td><td className="font-medium">{record.model}</td>{reasoning && <td>{record.reasoning || '—'}</td>}<td>{compact(record.inputTokens)}</td><td>{compact(record.outputTokens)}</td><td>{compact(record.cacheReadTokens)}</td><td>{compact(record.cacheWriteTokens)}</td><td>{compact(record.contextTokens)}</td>
    </tr>)}</tbody></table></div> : !detail.pending && !detail.error && <Empty title={detail.page?.nextCursor ? '本页没有匹配的调用' : '没有模型调用记录'} description={detail.page?.nextCursor ? '会话中仍有未扫描的数据，继续读取下一页。' : '当前时间与模型筛选没有匹配的用量记录。'}/>}
    {detail.error && <div className="local-session-error" role="alert"><span>{detail.error}</span><Button onClick={detail.retry}>重试</Button></div>}
    <div className="modal-actions"><Button onClick={onClose}>关闭</Button>{detail.page?.nextCursor && !detail.error && <Button busy={detail.pending} onClick={detail.loadMore}>继续读取</Button>}</div>
  </Modal>;
}
