import {ModalPresence} from './ModalPresence';
import {useState,useCallback,type ReactNode} from 'react';
import {Columns3} from 'lucide-react';
import {ProviderIcon} from './BrandIcon';
import {Button,Modal} from './ui';
import {useApp} from '../context';
import type {UsageLog,SiteStatus,ModelCatalog} from '../../shared/types';
import {ACTIVITY_COLUMN_IDS,ACTIVITY_COLUMN_LABELS,DEFAULT_ACTIVITY_COLUMNS,normalizeActivityColumns,visibleActivityColumns,logMetrics,requestTiming,requestStatus,requestReasoningEffort,upstreamChannel,type ActivityColumnId} from '../../shared/logs';
import {formatMoney,toolForLog} from '../../shared/utils';
import {RequestDetail} from './RequestLogs';
import '../recent-activity.css';

const number=(n:number|null)=>n===null ? '—' : n.toLocaleString('en-US');
const time=(ms:number|null)=>ms===null ? '—' : (ms/1000).toLocaleString('en-US',{maximumFractionDigits:3})+'s';
const columnHelp:Partial<Record<ActivityColumnId,string>>={
  speed:'输出 Tokens ÷ 总耗时（含首字等待）',
  timing:'首字等待 / 首字之后到请求结束的耗时；非流式或缺少数据时不推算',
  reasoning:'本次请求日志报告的 reasoning effort；缺少元数据时显示 —',
};

export function RecentActivityColumnsControl({columns,onChange}:{columns:ActivityColumnId[];onChange(columns:ActivityColumnId[]):void}) {
  const [open,setOpen]=useState(false),[draft,setDraft]=useState<ActivityColumnId[]>([]);
  const close=useCallback(()=>setOpen(false),[]);
  function toggle(id:ActivityColumnId){setDraft(current=>current.includes(id) ? current.filter(c=>c!==id) : [...current,id]);}
  return <>
    <Button onClick={()=>{setDraft(normalizeActivityColumns(columns));setOpen(true);}} aria-label="自定义最近活动显示列"><Columns3 size={15}/>显示列 · {visibleActivityColumns(columns).length}</Button>
    <ModalPresence>{open && <Modal title="自定义最近活动" subtitle="选择会单独保存到当前站点" className="log-columns-modal activity-columns-modal" onClose={close}>
      <div className="log-column-presets">
        <Button onClick={()=>setDraft([...DEFAULT_ACTIVITY_COLUMNS])}>恢复默认</Button>
        <Button onClick={()=>setDraft(['model','reasoning','cost','status'])}>精简视图</Button>
        <Button onClick={()=>setDraft([...ACTIVITY_COLUMN_IDS])}>显示全部</Button>
      </div>
      <div className="log-columns-grid">{ACTIVITY_COLUMN_IDS.map(id=><label key={id} className={draft.includes(id) ? 'selected' : ''} title={columnHelp[id]}>
        <input type="checkbox" checked={draft.includes(id)} disabled={draft.length===1 && draft[0]===id} onChange={()=>toggle(id)}/><span>{ACTIVITY_COLUMN_LABELS[id]}</span>
      </label>)}</div>
      <p className="field-help">至少保留一列。输入与缓存读取同时勾选时合并显示；首字延迟已包含在“首字 / 后续”中。思考强度只读取本次请求日志，缺少数据时显示“—”。</p>
      <div className="modal-actions"><Button onClick={close}>取消</Button><Button variant="primary" onClick={()=>{onChange(normalizeActivityColumns(draft));close();}}>应用显示项目</Button></div>
    </Modal>}</ModalPresence>
  </>;
}

export function RecentActivity({logs,status,catalog,columns=DEFAULT_ACTIVITY_COLUMNS}:{logs:UsageLog[];status:SiteStatus;catalog:ModelCatalog;columns?:ActivityColumnId[]}) {
  const {preferences}=useApp();
  const [detail,setDetail]=useState<UsageLog|null>(null),close=useCallback(()=>setDetail(null),[]);
  const selected=normalizeActivityColumns(columns),visible=visibleActivityColumns(selected),showCacheRead=selected.includes('cacheRead');
  const bindings=preferences.bindings.filter(b=>b.siteId===preferences.activeSiteId),managed=preferences.managedTokens.filter(t=>t.siteId===preferences.activeSiteId);
  function cell(log:UsageLog,id:ActivityColumnId):ReactNode {
    const metrics=logMetrics(log);
    switch(id){
      case 'model':{
        const vendor=catalog.models.find(m=>m.model_name===log.model_name)?.vendor;
        return <div className="model-cell"><ProviderIcon vendor={vendor} modelName={log.model_name} className="model-mark" size={20}/><div><strong title={log.model_name}>{log.model_name}</strong>{!selected.includes('time') && <span title={log.token_name || '未提供令牌名称'}>{new Date(log.created_at*1000).toLocaleTimeString('zh-CN',{hour:'2-digit',minute:'2-digit',second:'2-digit'})}</span>}</div></div>;
      }
      case 'time':return <span className="nowrap muted">{new Date(log.created_at*1000).toLocaleString('zh-CN',{month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',second:'2-digit'})}</span>;
      case 'reasoning':{const effort=requestReasoningEffort(log);return <span className="activity-text-cell" title={effort || undefined}>{effort || '—'}</span>;}
      case 'token':return <span className="activity-text-cell muted" title={log.token_name}>{log.token_name || '—'}</span>;
      case 'input':return <div className="recent-tokens"><strong>{number(log.prompt_tokens)}</strong>{showCacheRead && <small title="站点返回的缓存读取 Tokens，与输入账单值不额外相加">缓存命中 {number(metrics.cacheRead)}</small>}</div>;
      case 'cacheRead':return number(metrics.cacheRead);
      case 'cacheWrite':return number(metrics.cacheWrite);
      case 'output':return number(log.completion_tokens);
      case 'cost':return <span className="money-cell">{formatMoney(log.quota,status,4)}</span>;
      case 'speed':return metrics.speed===null ? '—' : metrics.speed.toLocaleString('en-US',{maximumFractionDigits:1})+' t/s';
      case 'timing':{const timing=requestTiming(log);return <span className="recent-timing"><span>{time(timing.firstMs)}</span><span className="muted"> / {time(timing.subsequentMs)}</span></span>;}
      case 'duration':return Number.isFinite(log.use_time) && log.use_time>=0 ? log.use_time+'s' : '—';
      case 'firstToken':return time(metrics.firstTokenMs);
      case 'channel':{const channel=upstreamChannel(log);return <span className="activity-text-cell" title={channel || undefined}>{channel || '—'}</span>;}
      case 'group':{const label=catalog.usableGroups[log.group] || log.group;return <span className="activity-text-cell" title={log.group}>{label || '—'}</span>;}
      case 'requestId':return <span className="activity-text-cell muted" title={log.request_id}>{log.request_id || '—'}</span>;
      case 'stream':return log.is_stream ? '是' : '否';
      case 'tool':{const tool=toolForLog(log,bindings,managed);return tool==='codex' ? 'Codex' : tool==='claude' ? 'Claude Code' : '—';}
      case 'status':{
        const state=requestStatus(log),label=(state.httpStatus===null ? '—' : String(state.httpStatus))+' · '+(state.isError ? '错误' : log.type===2 ? '成功' : '其他');
        return state.isError ? <button type="button" className="recent-status error" aria-label={'查看请求 '+log.id+' 错误详情'} onClick={()=>setDetail(log)}>{label}</button> : <span className={'recent-status '+(log.type===2 ? 'success' : '')} title={state.httpStatus===null ? '站点未返回 HTTP 状态码' : '站点返回的 HTTP 状态码'}>{label}</span>;
      }
    }
  }
  return <>
    <div className="table-scroll"><table className="data-table recent-activity-table"><thead><tr>{visible.map(id=><th key={id} title={columnHelp[id]}>{id==='input' && showCacheRead ? '输入 / 缓存命中' : ACTIVITY_COLUMN_LABELS[id]}</th>)}</tr></thead><tbody>{logs.slice(0,5).map(log=><tr key={log.id}>{visible.map(id=><td key={id}>{cell(log,id)}</td>)}</tr>)}</tbody></table></div>
    <ModalPresence>{detail && <RequestDetail log={detail} status={status} onClose={close}/>}</ModalPresence>
  </>;
}
