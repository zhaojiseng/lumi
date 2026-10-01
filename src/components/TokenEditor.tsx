import {useState} from 'react';
import {Check,Info,Save} from 'lucide-react';
import {useApp} from '../context';
import {bridge} from '../bridge';
import {availableGroups,groupLabel} from '../../shared/catalog';
import {currency} from '../../shared/utils';
import type {ApiToken} from '../../shared/types';
import {Button,Modal,Select} from './ui';
import {RouteDetails} from './Pricing';
import {DateTimePicker} from './DateTimePicker';
function localExpiry(seconds:number) {
  if(seconds<=0)return '';
  const d=new Date(seconds*1000);
  return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')} ${String(d.getHours()).padStart(2,'0')}:${String(d.getMinutes()).padStart(2,'0')}`;
}
function expiryTimestamp(value:string):number {
  const m=value.trim().match(/^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})$/);
  if(!m)throw new Error('有效期格式为 YYYY-MM-DD HH:mm。');
  const [,year,month,day,hour,minute]=m.map(Number),d=new Date(year,month-1,day,hour,minute);
  if(d.getFullYear()!==year || d.getMonth()!==month-1 || d.getDate()!==day || d.getHours()!==hour || d.getMinutes()!==minute || d.getTime()<=Date.now())throw new Error('请输入有效的未来时间。');
  return Math.floor(d.getTime()/1000);
}
export function TokenEditor({token,onClose}:{token:ApiToken;onClose():void}) {
  const {dashboard:d,preferences,refresh,reloadBootstrap,toast}=useApp();
  const [name,setName]=useState(token.name),[group,setGroup]=useState(token.group),[unlimited,setUnlimited]=useState(token.unlimited_quota);
  const c=currency(d!.status),[quota,setQuota]=useState(String(c.value(token.remain_quota)));
  const [permanent,setPermanent]=useState(token.expired_time<=0),[expiry,setExpiry]=useState(localExpiry(token.expired_time));
  const [models,setModels]=useState(token.model_limits_enabled ? (token.model_limits || '').split(',').filter(Boolean) : []);
  const [allowIps,setAllowIps]=useState(token.allow_ips || ''),[retry,setRetry]=useState(!!token.cross_group_retry),[busy,setBusy]=useState(false),[error,setError]=useState('');
  const managed=preferences.managedTokens.some(t=>t.siteId===preferences.activeSiteId && t.id===token.id) || preferences.bindings.some(b=>b.siteId===preferences.activeSiteId && (b.tokenId===token.id || b.tokenName===token.name));
  async function save(e:React.FormEvent) {
    e.preventDefault();setError('');
    try{
      if(!unlimited && (!Number.isFinite(Number(quota)) || Number(quota)<0))throw new Error('请输入有效剩余额度。');
      const expiredTime=permanent ? -1 : expiryTimestamp(expiry);
      setBusy(true);
      await bridge.updateToken({id:token.id,name,group,unlimited,quota:unlimited ? token.remain_quota : Number(quota)/c.rate*c.unit,models:models.join(','),expiredTime,allowIps,crossGroupRetry:group==='auto' && retry});
      onClose();toast('令牌控制已保存。','success');await reloadBootstrap();await refresh();
    }catch(e:any){setError(e.message);}finally{setBusy(false);}
  }
  const available=d!.catalog.models.filter(m=>availableGroups(m,d!.catalog).includes(group)),unavailable=models.filter(name=>!available.some(m=>m.model_name===name));
  return <Modal title="API 令牌控制" subtitle={token.name+' · #'+token.id} className="token-editor-modal" onClose={()=>{if(!busy)onClose();}}>
    <form onSubmit={save}>
      <label className="field-label" htmlFor="token-control-name">令牌名称</label>
      <input id="token-control-name" className="text-input" value={name} onChange={e=>setName(e.target.value)} required maxLength={50} disabled={managed || busy}/>
      {managed && <p className="field-help">工具专用令牌保留名称，维持历史消费归属。</p>}
      <label className="field-label">渠道 / 倍率</label><Select label="控制令牌渠道" value={group} disabled={busy} onChange={v=>{setGroup(v);setModels([]);}}>{!(group in d!.catalog.usableGroups) && <option value={group}>{group} · 当前不可用</option>}{Object.keys(d!.catalog.usableGroups).map(g=><option key={g} value={g}>{groupLabel(d!.catalog,g)}</option>)}</Select>
      <RouteDetails catalog={d!.catalog} status={d!.status} group={group}/>
      <div className="form-two-columns"><div><label className="field-label" htmlFor="token-control-quota">剩余额度 ({c.symbol})</label><input id="token-control-quota" className="text-input" type="number" min="0" step="any" value={quota} onChange={e=>setQuota(e.target.value)} disabled={unlimited || busy}/><label className="checkbox-label"><input type="checkbox" checked={unlimited} disabled={busy} onChange={e=>setUnlimited(e.target.checked)}/>不限制令牌额度</label></div><div><label className="field-label">有效期 · 本地时间</label><DateTimePicker label="令牌到期时间" value={expiry} disabled={permanent || busy} onChange={setExpiry}/><label className="checkbox-label"><input type="checkbox" checked={permanent} disabled={busy} onChange={e=>setPermanent(e.target.checked)}/>长期有效</label></div></div>
      <p className="field-help">额度修改的是当前剩余值，不会充值账户或改变累计消费。过期 / 耗尽令牌修改后可另行启用。</p>
      <label className="field-label">模型限制<span>不选择时允许该渠道全部模型</span></label>
      <div className="token-model-choices">{[...available.map(m=>m.model_name),...unavailable].map(model=><button type="button" disabled={busy} className={'model-choice '+(models.includes(model) ? 'selected' : '')} key={model} onClick={()=>setModels(prev=>prev.includes(model) ? prev.filter(m=>m!==model) : [...prev,model])}>{models.includes(model) && <Check size={11}/>} {model}{unavailable.includes(model) && ' · 当前不可用'}</button>)}</div>
      <label className="field-label" htmlFor="token-control-ips">IP 白名单<span>留空允许所有 IP</span></label><textarea id="token-control-ips" className="text-input" rows={3} value={allowIps} onChange={e=>setAllowIps(e.target.value)} disabled={busy} placeholder={'每行一个 IPv4、IPv6 或 CIDR\n例如 192.0.2.0/24'}/>
      {group==='auto' && <label className="checkbox-label"><input type="checkbox" checked={retry} disabled={busy} onChange={e=>setRetry(e.target.checked)}/>允许自动路由跨组重试</label>}
      <div className="info-note"><Info size={14}/><span>保存后立即影响使用此令牌的请求。调整渠道或模型限制后，请在工具页重新预览配置；已打开的配置预览将失效。</span></div>
      {error && <p role="alert" className="error-text">{error}</p>}
      <div className="modal-actions"><Button type="button" disabled={busy} onClick={onClose}>取消</Button><Button type="submit" variant="primary" busy={busy} disabled={!d!.user || unavailable.length>0}><Save size={15}/>保存控制设置</Button></div>
    </form>
  </Modal>;
}
