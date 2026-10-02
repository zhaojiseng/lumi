import {useEffect,useRef,useState} from 'react';
import {bridge} from '../bridge';
import type {DashboardQuery,LocalUsage,LocalUsageProgress} from '../../shared/types';

export function useLocalUsage(enabled:boolean,query:DashboardQuery,accountKey:string,onError:(message:string)=>void) {
  const scope=JSON.stringify([accountKey,query]);
  const latest=useRef({enabled,scope,onError});latest.current={enabled,scope,onError};
  const [snapshot,setSnapshot]=useState<{scope:string;value:LocalUsage;query:DashboardQuery}|null>(null);
  const [scan,setScan]=useState<{scope:string;pending:boolean;progress:LocalUsageProgress|null}|null>(null);
  useEffect(()=>{
    if(!enabled)return;
    const requestId=crypto.randomUUID();
    let active=true,complete=false,reading=false;
    const current=()=>active && latest.current.enabled && latest.current.scope===scope;
    setScan({scope,pending:true,progress:{requestId,phase:'discover',filesDone:0,filesTotal:0,bytesRead:0,bytesTotal:0}});
    // A cached scan can emit completion synchronously during invoke.
    const unsubscribe=bridge.onLocalUsageProgress(progress=>{
      if(!current() || complete || progress.requestId!==requestId)return;
      if(reading && progress.phase==='discover')return;
      if(progress.phase==='read')reading=true;
      complete=progress.phase==='complete';
      setScan({scope,pending:true,progress:complete ? null : progress});
    });
    let subscribed=true;
    const stop=()=>{if(subscribed){subscribed=false;unsubscribe();}};
    void bridge.localUsage(query,requestId).then(value=>{
      if(current())setSnapshot({scope,value,query});
    }).catch(error=>{
      if(current())latest.current.onError(error instanceof Error ? error.message : String(error));
    }).finally(()=>{
      if(current())setScan({scope,pending:false,progress:null});
      active=false;stop();
    });
    return()=>{active=false;stop();};
  },[enabled,scope]);
  return {
    local:snapshot?.value || null,query:snapshot?.query || query,stale:snapshot?.scope!==scope,
    busy:enabled && (scan?.scope!==scope || scan.pending),
    progress:enabled && scan?.scope===scope ? scan.progress : null,
  };
}
