import {isIP} from 'node:net';
import type {CreateTokenInput,ModelCatalog} from '../../shared/types';
import {availableGroups} from '../../shared/catalog';
export function tokenSettings(input:Omit<CreateTokenInput,'tool'>,catalog:ModelCatalog) {
  const name=input.name.trim();
  if(!name || name.length>50)throw new Error('令牌名称需为 1–50 个字符。');
  if(!(input.group in catalog.usableGroups))throw new Error('所选渠道不可用，请刷新后重试。');
  if(!Number.isFinite(input.quota) || input.quota<0 || input.quota>Number.MAX_SAFE_INTEGER)throw new Error('请输入有效剩余额度。');
  const expired=input.expiredTime ?? -1;
  if(expired!==-1 && (!Number.isSafeInteger(expired) || expired<=Date.now()/1000))throw new Error('有效期需为未来时间，或选择长期有效。');
  const models=[...new Set((input.models || '').split(',').map(s=>s.trim()).filter(Boolean))];
  if(models.some(name=>!catalog.models.some(m=>m.model_name===name && availableGroups(m,catalog).includes(input.group))))throw new Error('限制模型必须是当前渠道的可用模型。');
  const ips=(input.allowIps || '').split(/[,\n]/).map(s=>s.trim()).filter(Boolean);
  if(ips.length>100)throw new Error('IP 白名单最多 100 项。');
  for(const address of ips){
    const [ip,prefix,...extra]=address.split('/'),version=isIP(ip);
    if(!version || extra.length || (prefix!==undefined && (!/^\d+$/.test(prefix) || Number(prefix)>(version===4 ? 32 : 128))))throw new Error('IP 白名单需使用有效 IPv4、IPv6 或 CIDR，每行一项。');
  }
  return {name,remain_quota:Math.round(input.quota),unlimited_quota:input.unlimited,expired_time:expired,group:input.group,model_limits_enabled:models.length>0,model_limits:models.join(','),allow_ips:[...new Set(ips)].join('\n'),cross_group_retry:input.group==='auto' && !!input.crossGroupRetry};
}
