import {ModalPresence} from './ModalPresence';
import {useState,useCallback,type ReactNode} from 'react';
import {Columns3,ChevronLeft,ChevronRight,Info} from 'lucide-react';
import {useApp} from '../context';
import {Button,Modal,Pill,Empty} from './ui';
import {DEFAULT_LOG_COLUMNS,LOG_COLUMN_IDS,type UsageLog,type LogPage,type LogColumnId,type SiteStatus,type ModelCatalog} from '../../shared/types';
import {LOG_COLUMN_LABELS,normalizeLogColumns,visibleLogColumns,logMetrics,upstreamChannel,requestStatus,requestTiming,requestReasoningEffort} from '../../shared/logs';
import {formatMoney,toolForLog} from '../../shared/utils';
import '../recent-activity.css';
function tokens(n:number|null) {return n===null ? '—' : n.toLocaleString();}
function speedText(n:number|null) {return n===null ? '—' : n.toLocaleString('en-US',{maximumFractionDigits:1})+' t/s';}
function firstToken(n:number|null) {return n===null ? '—' : (n/1000).toLocaleString('en-US',{maximumFractionDigits:3})+'s';}
const speedHelp='平均输出速度 = 输出 Tokens ÷ 总耗时（含首字等待）。';
export function LogColumnsControl() {
  const {preferences,updatePreferences,toast}=useApp();
  const [open,setOpen]=useState(false),[draft,setDraft]=useState<LogColumnId[]>([]),[busy,setBusy]=useState(false);
  const close=useCallback(() => setOpen(false),[]);
  async function apply(){setBusy(true);try{await updatePreferences({logColumns:[...draft]});close();}catch(e:any){toast(e.message,'error');}finally{setBusy(false);}}
  function toggle(id:LogColumnId){setDraft(d => d.includes(id) ? d.filter(c => c!==id) : LOG_COLUMN_IDS.filter(c => c===id || d.includes(c)));}
  return <><Button onClick={() => {setDraft(normalizeLogColumns(preferences.logColumns));setOpen(true);}}><Columns3 size={15}/>显示列 · {visibleLogColumns(preferences.logColumns).length}</Button><ModalPresence>{open && <Modal title="自定义请求明细" subtitle="勾选需要显示的项目，选择会保存到本机" className="log-columns-modal" onClose={close}><div className="log-column-presets"><Button onClick={() => setDraft([...DEFAULT_LOG_COLUMNS])}>恢复默认</Button><Button onClick={() => setDraft(['time','model','input','output','cost','status'])}>精简视图</Button><Button onClick={() => setDraft([...LOG_COLUMN_IDS])}>显示全部</Button></div><div className="log-columns-grid">{LOG_COLUMN_IDS.map(id => <label key={id} className={draft.includes(id) ? 'selected' : ''}><input type="checkbox" checked={draft.includes(id)} disabled={draft.length===1 && draft[0]===id} onChange={() => toggle(id)}/><span>{LOG_COLUMN_LABELS[id]}</span></label>)}</div><p className="field-help">输入与缓存读取同时勾选时合并为一栏；缓存写入默认隐藏，可自行勾选。至少保留一列，CSV 导出保持完整字段。</p><div className="modal-actions"><Button disabled={busy} onClick={close}>取消</Button><Button variant="primary" busy={busy} onClick={apply}>应用显示项目</Button></div></Modal>}</ModalPresence></>;
}
export function RequestLogTable({logs,busy,page,onPage,onDetail,status,catalog}:{logs:LogPage|null;busy:boolean;page:number;onPage(n:number):void;onDetail(log:UsageLog):void;status:SiteStatus;catalog:ModelCatalog}) {
  const {preferences}=useApp();const columns=visibleLogColumns(preferences.logColumns),showCacheRead=normalizeLogColumns(preferences.logColumns).includes('cacheRead');
  const bindings=preferences.bindings.filter(b => b.siteId===preferences.activeSiteId),managed=preferences.managedTokens.filter(t => t.siteId===preferences.activeSiteId);
  function cell(log:UsageLog,id:LogColumnId):ReactNode {
    const m=logMetrics(log);
    switch(id){
      case 'time':return <span className="nowrap muted">{new Date(log.created_at*1000).toLocaleString('zh-CN',{month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',second:'2-digit'})}</span>;
      case 'model':return <span className="log-text-cell font-medium" title={log.model_name}>{log.model_name}</span>;
      case 'reasoning':{const effort=requestReasoningEffort(log);return <span className="log-text-cell" title={effort || undefined}>{effort || '—'}</span>;}
      case 'token':return <span className="log-text-cell muted" title={log.token_name}>{log.token_name || '—'}</span>;
      case 'input':return <div className="log-input-cell"><strong>{tokens(log.prompt_tokens)}</strong>{showCacheRead && <small>缓存读取 {tokens(m.cacheRead)}</small>}</div>;
      case 'output':return tokens(log.completion_tokens);
      case 'cacheRead':return tokens(m.cacheRead);
      case 'cacheWrite':return tokens(m.cacheWrite);
      case 'cost':return <span className="money-cell">{formatMoney(log.quota,status,4)}</span>;
      case 'duration':return Number.isFinite(log.use_time) && log.use_time>=0 ? log.use_time+'s' : '—';
      case 'speed':return <span title={speedHelp} className="nowrap">{speedText(m.speed)}</span>;
      case 'firstToken':return firstToken(m.firstTokenMs);
      case 'group':return log.group || '—';
      case 'channel':{const upstream=upstreamChannel(log),label=catalog.usableGroups[log.group] || log.group;return <div className="log-channel-cell"><span title={label}>{label || '—'}</span>{upstream && <small title={upstream}>上游 {upstream}</small>}{label!==log.group && log.group && <small>{log.group}</small>}</div>;}
      case 'status':return <Pill tone={log.type===2 ? 'green' : log.type===5 ? 'red' : 'muted'}>{log.type===2 ? '成功' : log.type===5 ? '错误' : '其他'}</Pill>;
      case 'requestId':return <span className="log-text-cell muted" title={log.request_id}>{log.request_id || '—'}</span>;
      case 'stream':return log.is_stream ? '是' : '否';
      case 'tool':{const tool=toolForLog(log,bindings,managed);return tool==='codex' ? 'Codex' : tool==='claude' ? 'Claude Code' : '—';}
    }
  }
  return <>{logs?.items.length ? <div className={'table-scroll '+(busy ? 'table-loading' : '')}><table className="data-table request-log-table"><thead><tr>{columns.map(id => <th key={id} title={id==='speed' ? speedHelp : undefined}>{LOG_COLUMN_LABELS[id]}</th>)}<th><span className="muted">详情</span></th></tr></thead><tbody>{logs.items.map(log => <tr key={log.id}>{columns.map(id => <td key={id}>{cell(log,id)}</td>)}<td><button className="icon-button" aria-label={'查看请求 '+log.id} onClick={() => onDetail(log)}><ChevronRight size={16}/></button></td></tr>)}</tbody></table></div> : <Empty title={busy ? '正在查询记录' : '未找到匹配的请求'} description="调整日期、模型或令牌筛选后重试。"/>}<div className="pagination"><span>第 {page} 页 · 每页 15 条</span><div><button className="icon-button" disabled={page===1 || busy} aria-label="上一页" onClick={() => onPage(page-1)}><ChevronLeft size={17}/></button><span>{page} / {Math.max(1,Math.ceil((logs?.total || 0)/15))}</span><button className="icon-button" disabled={busy || page*15>=(logs?.total || 0)} aria-label="下一页" onClick={() => onPage(page+1)}><ChevronRight size={17}/></button></div></div><p className="request-log-note"><Info size={13}/>输入、输出保留账单原值；缓存读取合并在输入下方，不额外相加。缺少元数据时显示“—”。{speedHelp}</p></>;
}
export function RequestDetail({log,status,onClose}:{log:UsageLog;status:SiteStatus;onClose():void}) {
  const m=logMetrics(log),state=requestStatus(log),timing=requestTiming(log);
  const fields=[['模型',log.model_name],['思考强度',requestReasoningEffort(log) || '—'],['令牌',log.token_name],['时间',new Date(log.created_at*1000).toLocaleString()],['路由分组',log.group || '—'],['上游渠道',upstreamChannel(log) || '站点未提供'],['输入 Tokens',tokens(log.prompt_tokens)],['输出 Tokens',tokens(log.completion_tokens)],['缓存读取 Tokens',tokens(m.cacheRead)],['缓存写入 Tokens',tokens(m.cacheWrite)],['Token 速度',speedText(m.speed)],['首字延迟',firstToken(m.firstTokenMs)],['费用',formatMoney(log.quota,status,6)],['耗时',log.use_time+'s'],['请求 ID',log.request_id || '—'],['流式输出',log.is_stream ? '是' : '否']];
  fields.push(['HTTP 状态码',state.httpStatus===null ? '站点未提供' : String(state.httpStatus)],['后续耗时',timing.subsequentMs===null ? '—' : (timing.subsequentMs/1000).toLocaleString('en-US',{maximumFractionDigits:3})+'s']);
  if(state.isError)fields.push(['错误类型',state.errorType || '站点未提供'],['错误代码',state.errorCode || '站点未提供']);
  return <Modal title={state.isError ? '请求错误详情' : '请求详情'} subtitle={'记录 #'+log.id} onClose={onClose}><div className="detail-grid">{fields.map(([key,value]) => <div key={key}><span>{key}</span><strong className={key==='思考强度' ? 'request-reasoning-value' : undefined} title={key==='思考强度' ? value : undefined}>{value}</strong></div>)}</div><p className="field-help">{speedHelp}后续耗时为总耗时减去首字等待，仅在流式请求提供有效首字时间时显示。</p>{state.message && <div className="info-note request-error-message">{state.message}</div>}{log.other && <details className="raw-detail"><summary>计费与缓存元数据</summary><pre>{(() => {try{return JSON.stringify(JSON.parse(log.other!),null,2);}catch{return log.other;}})()}</pre></details>}<div className="modal-actions"><Button onClick={onClose}>关闭</Button></div></Modal>;
}
