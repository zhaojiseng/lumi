import {useEffect,useRef,useState} from 'react';
import {Loader2} from 'lucide-react';
import {bridge} from '../bridge';
import {compact} from '../../shared/utils';
import type {DashboardQuery,LocalSessionContentPage,LocalSessionEvent,LocalSessionProgress,LocalSessionRawPage,LocalSessionRecord,LocalSessionRecordsPage,LocalSessionSnapshot,LocalSessionSummary} from '../../shared/types';
import {Button,Empty,Modal,SegmentedSwitch} from './ui';
import {localUsageBytes} from './LocalUsageProgress';
import {localSessionDateTime,localSessionProject,localSessionTime,localSessionTitle} from './LocalSessions';

const RECORD_PAGE_SIZE=50,CONTENT_PAGE_SIZE=20;
interface RecordsState extends LocalSessionRecordsPage {pending:boolean;error:string;}
interface ContentState extends LocalSessionContentPage {pending:boolean;error:string;}
interface RawState {eventId:string;offset:number;previousOffset?:number;chunk:LocalSessionRawPage|null;pending:boolean;error:string;}
interface DetailState {
  scope:string;snapshot:LocalSessionSnapshot|null;progress:LocalSessionProgress|null;pending:boolean;error:string;canceled:boolean;
  tab:'records'|'content';record:LocalSessionRecord|null;records:RecordsState;content:ContentState;raw:RawState|null;
}
interface Owner {
  scope:string;requestId:string;active:boolean;snapshotId?:string;unsubscribe?:()=>void;
  recordsToken?:object;contentToken?:object;rawToken?:object;
}
const initial=(scope:string):DetailState=>({
  scope,snapshot:null,progress:null,pending:true,error:'',canceled:false,tab:'records',record:null,raw:null,
  records:{items:[],total:0,page:1,pageSize:RECORD_PAGE_SIZE,pending:false,error:''},
  content:{items:[],total:0,page:1,pageSize:CONTENT_PAGE_SIZE,association:'session',pending:false,error:''},
});
const errorText=(error:unknown)=>error && typeof error==='object' && 'message' in error && typeof error.message==='string' ? error.message : String(error);
function release(input:{requestId?:string;snapshotId?:string}) {
  // Cleanup must remain safe even if the desktop bridge has already disconnected.
  try{void bridge.releaseLocalSession(input).catch(()=>{});}catch{}
}
function unsubscribe(owner:Owner) {owner.unsubscribe?.();owner.unsubscribe=undefined;}
function stop(owner:Owner) {
  if(!owner.active)return;
  owner.active=false;unsubscribe(owner);
  release({requestId:owner.requestId,...owner.snapshotId ? {snapshotId:owner.snapshotId} : {}});
}

export function useLocalSessionDetails(sessionId:string,query:DashboardQuery,accountKey:string) {
  const scope=JSON.stringify([accountKey,query,sessionId]);
  const latest=useRef(scope);latest.current=scope;
  const mounted=useRef(false);
  const ownerRef=useRef<Owner|null>(null);
  const [state,setState]=useState<DetailState>(()=>initial(scope));
  const view=state.scope===scope ? state : initial(scope);
  const current=(owner:Owner)=>mounted.current && owner.active && latest.current===owner.scope && ownerRef.current===owner;
  const owned=()=>ownerRef.current?.scope===scope && current(ownerRef.current) ? ownerRef.current : null;

  async function readRecords(owner:Owner,page:number) {
    if(!current(owner) || !owner.snapshotId)return;
    const token={};owner.recordsToken=token;
    setState(previous=>({...previous,records:{...previous.records,items:[],page,pending:true,error:''}}));
    try{
      const result=await bridge.localSessionRecords({snapshotId:owner.snapshotId,page,pageSize:RECORD_PAGE_SIZE});
      if(current(owner) && owner.recordsToken===token)setState(previous=>({...previous,records:{...result,pending:false,error:''}}));
    }catch(error){
      if(current(owner) && owner.recordsToken===token)setState(previous=>({...previous,records:{...previous.records,pending:false,error:errorText(error)}}));
    }
  }
  async function readContent(owner:Owner,record:LocalSessionRecord|null,page:number) {
    if(!current(owner) || !owner.snapshotId)return;
    const token={};owner.contentToken=token;owner.rawToken=undefined;
    setState(previous=>({...previous,tab:'content',record,raw:null,content:{...previous.content,items:[],total:page===1 ? 0 : previous.content.total,page,association:record ? 'unavailable' : 'session',pending:true,error:''}}));
    try{
      const result=await bridge.localSessionContent({snapshotId:owner.snapshotId,...record ? {recordId:record.id} : {},page,pageSize:CONTENT_PAGE_SIZE});
      if(current(owner) && owner.contentToken===token)setState(previous=>({...previous,content:{...result,pending:false,error:''}}));
    }catch(error){
      if(current(owner) && owner.contentToken===token)setState(previous=>({...previous,content:{...previous.content,pending:false,error:errorText(error)}}));
    }
  }
  async function readRaw(owner:Owner,eventId:string,offset:number,previousOffset?:number) {
    if(!current(owner) || !owner.snapshotId)return;
    const token={};owner.rawToken=token;
    setState(state=>({...state,raw:{eventId,offset,previousOffset,chunk:null,pending:true,error:''}}));
    try{
      const chunk=await bridge.localSessionRaw({snapshotId:owner.snapshotId,eventId,offset});
      if(current(owner) && owner.rawToken===token)setState(state=>({...state,raw:{eventId,offset,previousOffset,chunk,pending:false,error:''}}));
    }catch(error){
      if(current(owner) && owner.rawToken===token)setState(state=>({...state,raw:{eventId,offset,previousOffset,chunk:null,pending:false,error:errorText(error)}}));
    }
  }
  function load() {
    if(!mounted.current || latest.current!==scope)return;
    if(ownerRef.current)stop(ownerRef.current);
    const owner:Owner={scope,requestId:crypto.randomUUID(),active:true};ownerRef.current=owner;
    setState(initial(scope));
    // Subscribe before invoking: small files can report all their progress synchronously.
    try{
      owner.unsubscribe=bridge.onLocalSessionProgress(progress=>{
        if(current(owner) && !owner.snapshotId && progress.requestId===owner.requestId)setState(previous=>({...previous,progress}));
      });
      void bridge.loadLocalSession({sessionId,query,requestId:owner.requestId}).then(snapshot=>{
        if(!current(owner)){release({snapshotId:snapshot.snapshotId});return;}
        owner.snapshotId=snapshot.snapshotId;unsubscribe(owner);
        setState(previous=>({...previous,snapshot,pending:false,progress:{requestId:owner.requestId,phase:'complete',bytesRead:snapshot.totalBytes,totalBytes:snapshot.totalBytes,calls:snapshot.total},records:{...previous.records,total:snapshot.total}}));
        void readRecords(owner,1);
      }).catch(error=>{
        if(current(owner)){setState(previous=>({...previous,pending:false,error:errorText(error)}));stop(owner);}
      });
    }catch(error){
      if(current(owner)){setState(previous=>({...previous,pending:false,error:errorText(error)}));stop(owner);}
    }
  }
  useEffect(()=>{
    mounted.current=true;
    load();
    return()=>{mounted.current=false;if(ownerRef.current?.scope===scope)stop(ownerRef.current);};
  },[scope]);

  function cancel() {
    const owner=owned();if(!owner)return;
    stop(owner);setState({...initial(scope),pending:false,canceled:true});
  }
  return {
    ...view,cancel,retryLoad:load,
    showRecords:()=>{const owner=owned();if(!owner?.snapshotId)return;owner.contentToken=undefined;owner.rawToken=undefined;setState(previous=>({...previous,tab:'records',record:null,raw:null,content:{...previous.content,pending:false}}));},
    showContent:()=>{const owner=owned();if(owner)void readContent(owner,null,1);},
    showRelated:(record:LocalSessionRecord)=>{const owner=owned();if(owner)void readContent(owner,record,1);},
    setRecordPage:(page:number)=>{const owner=owned();if(owner && page>=1 && page<=Math.max(1,Math.ceil(view.records.total/RECORD_PAGE_SIZE)))void readRecords(owner,page);},
    retryRecords:()=>{const owner=owned();if(owner)void readRecords(owner,view.records.page);},
    setContentPage:(page:number)=>{const owner=owned();if(owner && page>=1 && page<=Math.max(1,Math.ceil(view.content.total/CONTENT_PAGE_SIZE)))void readContent(owner,view.record,page);},
    retryContent:()=>{const owner=owned();if(owner)void readContent(owner,view.record,view.content.page);},
    openRaw:(eventId:string)=>{const owner=owned();if(owner)void readRaw(owner,eventId,0);},
    hideRaw:()=>{const owner=owned();if(owner){owner.rawToken=undefined;setState(previous=>({...previous,raw:null}));}},
    nextRaw:()=>{const owner=owned(),raw=view.raw;if(owner && raw?.chunk?.nextOffset!==undefined && !raw.pending)void readRaw(owner,raw.eventId,raw.chunk.nextOffset,raw.chunk.offset);},
    previousRaw:()=>{const owner=owned(),raw=view.raw;if(owner && raw?.previousOffset!==undefined && !raw.pending)void readRaw(owner,raw.eventId,raw.previousOffset);},
    firstRaw:()=>{const owner=owned(),raw=view.raw;if(owner && raw && !raw.pending)void readRaw(owner,raw.eventId,0);},
    retryRaw:()=>{const owner=owned(),raw=view.raw;if(owner && raw)void readRaw(owner,raw.eventId,raw.offset,raw.previousOffset);},
  };
}

function pagination({page,pageSize,total,pending,label,onPage}:{page:number;pageSize:number;total:number;pending:boolean;label:string;onPage(page:number):void}) {
  const pages=Math.max(1,Math.ceil(total/pageSize));
  return <nav className="local-session-pagination" aria-label={`${label}分页`}>
    <span>共 {total.toLocaleString()} 条 · 第 {page.toLocaleString()} / {pages.toLocaleString()} 页 · 每页 {pageSize} 条</span>
    <div><Button disabled={pending || page<=1} onClick={()=>onPage(1)}>首页</Button><Button disabled={pending || page<=1} onClick={()=>onPage(page-1)}>上一页</Button>
      <Button disabled={pending || page>=pages} onClick={()=>onPage(page+1)}>下一页</Button><Button disabled={pending || page>=pages} onClick={()=>onPage(pages)}>末页</Button></div>
    <form key={page} onSubmit={event=>{event.preventDefault();const value=Number(new FormData(event.currentTarget).get('page'));if(Number.isInteger(value) && value>=1 && value<=pages)onPage(value);}}>
      <label>{label}页码<input name="page" type="number" min={1} max={pages} defaultValue={page} disabled={pending} required aria-label={`${label}页码`}/></label><Button type="submit" disabled={pending}>跳转</Button>
    </form>
  </nav>;
}
function failure(error:string,onRetry:()=>void) {return <div className="local-session-error" role="alert"><span>{error}</span><Button onClick={onRetry}>重试</Button></div>;}
const roles:Record<LocalSessionEvent['role'],string>={user:'用户消息',assistant:'助手回复',tool:'工具',system:'系统',event:'会话事件'};
const associationNotes:Record<LocalSessionContentPage['association'],string>={
  session:'完整会话内容包含用户消息、助手回复、工具和其他事件；不受调用记录的时间或模型筛选限制。',
  turn:'同轮上下文：这些内容属于同一轮会话，无法精确对应这一次模型请求。',
  message:'消息关联：展示与这条调用记录关联的消息和工具信息。',
  unavailable:'无法关联这条调用的内容。可切换到完整会话内容查看。',
};

export function LocalSessionDetails({session,query,accountKey,onClose}:{session:LocalSessionSummary;query:DashboardQuery;accountKey:string;onClose():void}) {
  const detail=useLocalSessionDetails(session.id,query,accountKey);
  const metadata={...session.metadata,...detail.snapshot?.metadata};
  const read=detail.progress?.bytesRead || 0,total=detail.progress?.totalBytes || 0,percent=total>0 ? Math.min(100,read/total*100) : undefined;
  const records=detail.records,content=detail.content,raw=detail.raw;
  const reasoning=records.items.some(item=>item.reasoning);
  const close=()=>{detail.cancel();onClose();};
  return <Modal title="本机会话详情" subtitle={`${session.tool==='codex' ? 'Codex' : 'Claude Code'} · ${session.model}`} wide className="local-session-details" onClose={close}>
    <div className="local-session-identity"><h3>{localSessionTitle(metadata)}</h3><dl>
      <div><dt>项目</dt><dd>{localSessionProject(metadata)}</dd></div><div><dt>工作目录</dt><dd>{metadata.cwd || '未提供'}</dd></div>
      <div className="local-session-key"><dt>会话标识</dt><dd>{metadata.sessionKey || session.id}</dd></div>
      {metadata.gitBranch && <div><dt>分支</dt><dd>{metadata.gitBranch}</dd></div>}{metadata.version && <div><dt>版本</dt><dd>{metadata.version}</dd></div>}{metadata.source && <div><dt>来源</dt><dd>{metadata.source}</dd></div>}
    </dl>{metadata.firstPrompt && <details className="local-session-first-prompt"><summary>首条用户消息</summary><pre>{metadata.firstPrompt}</pre></details>}</div>
    <p className="local-session-range">开始 {localSessionTime(session.startedAt)} · 最近调用 {localSessionTime(session.updatedAt)}</p>
    <div className="local-session-scan" role="status" aria-live="polite"><span>{detail.pending && <Loader2 size={14} className="spin"/>}
      {detail.pending ? '正在完整载入会话…' : detail.canceled ? '已取消会话载入' : detail.snapshot ? `会话已完整载入 · ${detail.snapshot.total.toLocaleString()} 条调用 · ${detail.snapshot.eventTotal.toLocaleString()} 条内容` : '会话载入失败'}</span>
      {detail.progress && <span>已读取 {localUsageBytes(read)} / {localUsageBytes(total)}{percent!==undefined ? ` · ${(Math.floor(percent*10)/10).toLocaleString('zh-CN')}%` : ''}{detail.pending ? ` · ${detail.progress.calls.toLocaleString()} 条调用` : ''}</span>}
    </div>
    {detail.pending && <p className="field-help">完整扫描结束后自动显示分页，分页浏览无需重新扫描。</p>}
    {detail.progress && <div className="local-usage-progress-track" role="progressbar" aria-label="会话载入进度" aria-valuemin={percent!==undefined ? 0 : undefined} aria-valuemax={percent!==undefined ? 100 : undefined} aria-valuenow={percent} aria-valuetext={`${localUsageBytes(read)} / ${localUsageBytes(total)}`}>{percent!==undefined && <i style={{width:`${percent}%`}}/>}</div>}
    {detail.error && failure(detail.error,detail.retryLoad)}
    {detail.canceled && <Button onClick={detail.retryLoad}>重新载入</Button>}
    {detail.snapshot && <>
      {!!detail.snapshot.warnings.length && <ul className="local-session-warnings" aria-label="会话载入提示">{detail.snapshot.warnings.map((warning,i)=><li key={i}>{warning}</li>)}</ul>}
      <SegmentedSwitch label="会话详情视图" size="regular" className="local-session-tabs"><button type="button" aria-pressed={detail.tab==='records'} onClick={detail.showRecords}>调用记录</button><button type="button" aria-pressed={detail.tab==='content'} onClick={detail.showContent}>完整会话内容</button></SegmentedSwitch>
      {detail.tab==='records' ? <section aria-label="调用记录">
        <p className="field-help">调用记录按当前时间与模型筛选显示。可查看每条调用的相关内容。</p>
        {records.pending && <p className="local-session-loading" role="status"><Loader2 size={14} className="spin"/>正在读取调用分页…</p>}
        {!!records.items.length && <div className="table-scroll local-session-records"><table className="data-table"><thead><tr><th>调用时间</th><th>模型</th>{reasoning && <th>思考强度</th>}<th>普通输入</th><th>输出</th><th>缓存读取</th><th>缓存写入</th><th>上下文 Tokens</th><th>相关内容</th></tr></thead><tbody>{records.items.map(record=><tr key={record.id}>
          <td className="muted nowrap">{localSessionTime(record.created_at)}</td><td className="font-medium">{record.model}</td>{reasoning && <td>{record.reasoning || '—'}</td>}<td>{compact(record.inputTokens)}</td><td>{compact(record.outputTokens)}</td><td>{compact(record.cacheReadTokens)}</td><td>{compact(record.cacheWriteTokens)}</td><td>{compact(record.contextTokens)}</td>
          <td><button type="button" className="text-link" onClick={()=>detail.showRelated(record)} aria-label={`查看 ${record.model} ${localSessionTime(record.created_at)} 的相关内容`}>查看相关内容</button></td>
        </tr>)}</tbody></table></div>}
        {!records.pending && !records.error && !records.items.length && <Empty title="没有模型调用记录" description="当前时间与模型筛选没有匹配的用量记录。仍可查看完整会话内容。"/>}
        {records.error && failure(records.error,detail.retryRecords)}
        {pagination({...records,label:'调用记录',onPage:detail.setRecordPage})}
      </section> : <section className="local-session-content" aria-label={detail.record ? '调用相关内容' : '完整会话内容'}>
        {detail.record && <div className="local-session-related"><strong>调用相关内容</strong><span>{detail.record.model} · {localSessionTime(detail.record.created_at)}</span><Button onClick={detail.showContent}>查看完整会话</Button></div>}
        {!content.pending && !content.error && <p className="local-session-association" role="status">{associationNotes[content.association]}</p>}
        {content.pending && <p className="local-session-loading" role="status"><Loader2 size={14} className="spin"/>正在读取会话内容…</p>}
        <div className="local-session-events">{content.items.map(event=><article className="local-session-event" key={event.id} aria-label={roles[event.role]}>
          <header><strong>{roles[event.role]}{event.toolName ? ` · ${event.toolName}` : ''}</strong><span>{event.kind}</span>{event.createdAt!==undefined && <time dateTime={localSessionDateTime(event.createdAt)}>{localSessionTime(event.createdAt)}</time>}</header>
          {event.toolCallId && <p className="local-session-tool-id">工具调用标识：{event.toolCallId}</p>}
          {event.text && <pre className="local-session-event-text">{event.text}</pre>}
          {!!event.details.length && <dl>{event.details.map((entry,i)=><div key={i}><dt>{entry.label}</dt><dd>{entry.value}</dd></div>)}</dl>}
          {event.truncated && <p className="field-help">内容预览已截断，可分块查看原始记录。</p>}
          <button type="button" className="text-link" onClick={()=>detail.openRaw(event.id)} aria-label={`查看${roles[event.role]}原始记录 ${event.id}`}>查看原始记录{event.rawBytes!==undefined ? ` · ${localUsageBytes(event.rawBytes)}` : ''}</button>
          {raw?.eventId===event.id && <div className="local-session-raw" aria-label="原始记录">
            <div className="local-session-raw-heading"><strong>原始记录</strong><Button onClick={detail.hideRaw}>收起原始记录</Button></div>
            <p className="field-help">每块最多 64 KB，仅显示当前块。可返回上一块，更早内容可返回开头查看。{raw.chunk && `字节 ${raw.chunk.offset.toLocaleString()}–${(raw.chunk.nextOffset ?? raw.chunk.totalBytes).toLocaleString()} / ${raw.chunk.totalBytes.toLocaleString()}`}</p>
            {raw.pending && <p role="status">正在读取原始记录…</p>}{raw.chunk && <pre tabIndex={0}>{raw.chunk.text}</pre>}{raw.error && failure(raw.error,detail.retryRaw)}
            <div className="local-session-raw-actions"><Button disabled={raw.pending || raw.offset===0} onClick={detail.firstRaw}>返回开头</Button><Button disabled={raw.pending || raw.previousOffset===undefined} onClick={detail.previousRaw}>上一块</Button><Button disabled={raw.pending || raw.chunk?.nextOffset===undefined} onClick={detail.nextRaw}>下一块</Button></div>
          </div>}
        </article>)}</div>
        {!content.pending && !content.error && !content.items.length && <Empty title={content.association==='unavailable' ? '没有可关联的内容' : '没有会话内容'} description="此页没有可展示的消息或工具事件。"/>}
        {content.error && failure(content.error,detail.retryContent)}
        {pagination({...content,label:'会话内容',onPage:detail.setContentPage})}
      </section>}
    </>}
    <div className="modal-actions">{detail.pending && <Button onClick={detail.cancel}>取消载入</Button>}<Button onClick={close}>关闭</Button></div>
  </Modal>;
}
