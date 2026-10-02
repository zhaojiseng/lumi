import {createHash} from 'node:crypto';
import type {SubscriptionUsageSnapshot,SubscriptionWindow,SubscriptionCredits} from '../../../shared/contracts/subscription-usage';
const record=(value:unknown):Record<string,unknown>=>value && typeof value==='object' && !Array.isArray(value) ? value as Record<string,unknown> : {};
const number=(value:unknown)=>typeof value==='number' && Number.isFinite(value) ? value : null;
const text=(value:unknown)=>typeof value==='string' && value.length<=300 ? value : null;
function window(value:unknown):SubscriptionWindow|null {
  if(!value || typeof value!=='object')return null;
  const row=record(value),percent=number(row.usedPercent),duration=number(row.windowDurationMins),reset=number(row.resetsAt);
  const used=percent!==null && percent>=0 ? percent : null;
  return {usedPercent:used,remainingPercent:used===null ? null : Math.max(0,100-used),durationMinutes:duration!==null && duration>0 ? duration : null,resetsAt:reset!==null && reset>0 && reset<8640000000000 ? reset*1000 : null};
}
function credits(value:unknown):SubscriptionCredits|null {
  if(!value || typeof value!=='object')return null;
  const row=record(value),raw=row.balance;
  const parsed=typeof raw==='string' && /^\d+(?:\.\d+)?$/.test(raw.trim()) ? Number(raw) : number(raw);
  return {remaining:parsed!==null && Number.isFinite(parsed) && parsed>=0 ? parsed : null,unlimited:typeof row.unlimited==='boolean' ? row.unlimited : null,hasCredits:typeof row.hasCredits==='boolean' ? row.hasCredits : null};
}
export function normalizeCodexUsage(accountResponse:unknown,limitsResponse:unknown,scope:string,now=Date.now()):SubscriptionUsageSnapshot {
  const auth=record(record(accountResponse).account),type=text(auth.type);
  const snapshot:SubscriptionUsageSnapshot={sourceId:'provider.codex',account:null,state:'signed-out',windows:[],fetchedAt:now};
  if(!type)return snapshot;
  if(type!=='chatgpt'){snapshot.state='unsupported';return snapshot;}
  const email=text(auth.email),plan=text(auth.planType);
  snapshot.account={id:createHash('sha256').update(JSON.stringify([scope,email,plan])).digest('hex'),label:email || 'Codex 账户',plan};
  snapshot.state='ready';
  const response=record(limitsResponse),buckets=record(response.rateLimitsByLimitId);
  const entries=Object.entries(buckets);
  const legacy=record(response.rateLimits),legacyId=text(legacy.limitId) || 'codex';
  if(response.rateLimits && !entries.some(([id])=>id===legacyId))entries.unshift([legacyId,response.rateLimits]);
  snapshot.windows=entries.slice(0,30).map(([id,value])=>{
    const row=record(value);
    return {id:id.slice(0,200),label:text(row.limitName) || (id==='codex' ? 'Codex' : id.slice(0,200)),primary:window(row.primary),secondary:window(row.secondary),credits:credits(row.credits===undefined && id===legacyId ? legacy.credits : row.credits)};
  });
  return snapshot;
}
