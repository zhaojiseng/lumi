import {USAGE_HISTORY_TTL} from '../../../electron/services/usage-log-cache';

/** Live account data keeps its existing freshness; completed dates can share the history TTL. */
export function newApiReadTtl(endpoint:string,query:Record<string,unknown>={},now=Date.now()):number{
  if(endpoint==='/api/pricing')return 300000;
  if(endpoint==='/api/data/self'){
    const start=query.start_timestamp,end=query.end_timestamp,today=new Date(now);today.setHours(0,0,0,0);
    if(typeof start==='number' && Number.isSafeInteger(start) && start>=0 && typeof end==='number' && Number.isSafeInteger(end) && end>=start && end<today.getTime()/1000)return USAGE_HISTORY_TTL;
    return 60000;
  }
  // The stat response may also contain live RPM/TPM, even for historical selections.
  if(endpoint==='/api/log/self/stat' || endpoint.startsWith('/api/perf-metrics'))return 60000;
  if(endpoint==='/api/token/' || endpoint==='/api/user/self')return 30000;
  if(endpoint==='/api/log/self')return 15000;
  return 0;
}

export function newApiWriteEffect(endpoint:string,method:string,hasBody:boolean):'none'|'tokens'|'all'{
  if(method==='GET')return 'none';
  // This POST reveals an existing key; it neither rotates nor updates the token.
  if(method==='POST' && !hasBody && /^\/api\/token\/[1-9]\d*\/key$/.test(endpoint))return 'none';
  if(['POST','PUT','DELETE'].includes(method) && /^\/api\/token\/(?:[1-9]\d*)?$/.test(endpoint))return 'tokens';
  return 'all';
}
