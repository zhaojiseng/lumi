import {queryRange,resolveRange} from './range';
import {usageSeries} from './utils';
import type {DashboardQuery,LocalUsagePoint,Tool} from './types';

/** Local rows remain daily; only timestamped points belong in the elapsed-time chart. */
export function localUsageSeries(points:LocalUsagePoint[],query:DashboardQuery,now=new Date(),tool:Tool|'all'='all') {
  const selected=tool==='all' ? points : points.filter(point=>point.tool===tool);
  const window=resolveRange(query,now);
  return usageSeries(selected.map(point=>({
    created_at:point.created_at,model_name:point.model,quota:0,count:point.requests,
    token_used:point.inputTokens+point.outputTokens+point.cacheReadTokens+point.cacheWriteTokens,
  })),window.days,{system_name:'本地会话',quota_per_unit:1},queryRange(query),now);
}
