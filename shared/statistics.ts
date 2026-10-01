import type {StatisticsQuery,UsageLog} from './types';
/** OR within each dimension; AND across dimensions. Token identity never uses display names. */
export function filterLogs(rows:UsageLog[],filters:Pick<StatisticsQuery,'models'|'tokenIds'>) {
  const models=new Set(filters.models || []),tokens=new Set(filters.tokenIds || []);
  if(tokens.size && rows.some(row=>(!models.size || models.has(row.model_name)) && row.token_id===undefined))throw new Error('站点日志缺少令牌 ID，无法准确筛选同名令牌。');
  return rows.filter(row=>(!models.size || models.has(row.model_name)) && (!tokens.size || row.token_id!==undefined && tokens.has(row.token_id)));
}
export function logStat(rows:UsageLog[],window:{start_timestamp:number;end_timestamp:number}) {
  const successful=rows.filter(r=>r.type===2),minutes=Math.max(1,(window.end_timestamp-window.start_timestamp+1)/60);
  return {quota:successful.reduce((s,r)=>s+(r.quota || 0),0),rpm:Math.round(successful.length/minutes*100)/100,tpm:Math.round(successful.reduce((s,r)=>s+(r.prompt_tokens || 0)+(r.completion_tokens || 0),0)/minutes)};
}
