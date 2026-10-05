import {useEffect,useLayoutEffect,useMemo,useState,useSyncExternalStore} from 'react';
import {bridge} from '../bridge';
import {DashboardResource,type DashboardScope} from './dashboard-resource';

export function useDashboardHost(scope:DashboardScope|null){
  const [resource]=useState(()=>new DashboardResource((query,force)=>bridge.dashboard(query,force)));
  const state=useSyncExternalStore(resource.subscribe,resource.getState);
  const key=scope?.accountKey || '',queryKey=scope ? JSON.stringify(scope.query) : '';
  useLayoutEffect(()=>{resource.configure(scope);},[resource,key,queryKey]);
  useLayoutEffect(()=>()=>resource.configure(null),[resource]);
  useEffect(()=>{if(scope)void resource.refresh();},[resource,key,queryKey]);
  const dashboard=key && state.scopeKey===key ? state.dashboard : null;
  const loading=!!scope && (state.scopeKey!==key || state.queryKey!==queryKey || state.loading);
  const error=state.scopeKey===key && state.queryKey===queryKey ? state.error : '';
  return useMemo(()=>({dashboard,loading,error,refresh:resource.refresh}),[dashboard,loading,error,resource]);
}
