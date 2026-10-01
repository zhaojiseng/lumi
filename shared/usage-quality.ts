import {logMetrics,requestStatus} from './logs';
import type {UsageLog,UsageQuality} from './types';

export function summarizeQuality(logs:UsageLog[],window:{start_timestamp:number;end_timestamp:number},fetchedAt=Date.now()):UsageQuality {
  let requestCount=0,cacheSamples=0,speedSamples=0,inputTokens=0,cacheReadTokens=0,outputTokens=0,durationSeconds=0;
  for(const log of logs){
    if(log.type!==2 || !Number.isFinite(log.created_at) || log.created_at<window.start_timestamp || log.created_at>window.end_timestamp || requestStatus(log).isError)continue;
    requestCount++;
    const metrics=logMetrics(log);
    if(Number.isFinite(log.prompt_tokens) && log.prompt_tokens>0 && metrics.cacheRead!==null && metrics.cacheRead<=log.prompt_tokens){
      cacheSamples++;inputTokens+=log.prompt_tokens;cacheReadTokens+=metrics.cacheRead;
    }
    if(metrics.speed!==null){speedSamples++;outputTokens+=log.completion_tokens;durationSeconds+=log.use_time;}
  }
  return {requestCount,cacheSamples,speedSamples,inputTokens,cacheReadTokens,outputTokens,durationSeconds,cacheHitRate:inputTokens>0 ? cacheReadTokens/inputTokens : null,averageTokenSpeed:durationSeconds>0 ? outputTokens/durationSeconds : null,fetchedAt};
}
