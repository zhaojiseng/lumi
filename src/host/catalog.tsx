import {createContext,useContext,useEffect,useLayoutEffect,useMemo,useState,useSyncExternalStore,type ReactNode} from 'react';
import type {CatalogSnapshot} from '../../shared/contracts/catalog';
import {bridge} from '../bridge';
import {refreshSeconds} from '../../shared/refresh';
import {observeCatalogChanges} from '../../shared/catalog-changes';
import {CatalogResource,catalogScopeKey,type CatalogScope} from './catalog-resource';

export interface CatalogContextValue {snapshot:CatalogSnapshot|null;loading:boolean;error:string;refresh(force?:boolean):Promise<void>}
export const CatalogContext=createContext<CatalogContextValue|null>(null);
export function useCatalog(){const value=useContext(CatalogContext);if(!value)throw new Error('模型目录宿主未提供。');return value;}
export function useCatalogHost({scope,refreshInterval}:{scope:CatalogScope|null;refreshInterval:number}):CatalogContextValue {
  const [resource]=useState(()=>new CatalogResource(input=>bridge.readCatalog(input)));
  const key=scope ? catalogScopeKey(scope) : '';
  const state=useSyncExternalStore(resource.subscribe,resource.getState);
  useLayoutEffect(()=>{resource.configure(scope);return()=>resource.configure(null);},[resource,key]);
  useEffect(()=>{if(scope)void resource.refresh();},[resource,key]);
  useEffect(()=>{
    if(!scope)return;
    const unsubscribe=bridge.onRefresh(()=>{void resource.refresh(true);});
    const seconds=refreshSeconds(refreshInterval);
    const interval=seconds ? setInterval(()=>{if(document.visibilityState==='visible')void resource.refresh();},Math.max(15,seconds)*1000) : undefined;
    return()=>{unsubscribe();clearInterval(interval);};
  },[resource,key,refreshInterval]);
  const snapshot=state.scopeKey===key ? state.snapshot : null;
  useEffect(()=>{
    if(!scope || !snapshot?.loggedIn || state.loading || state.error)return;
    observeCatalogChanges({id:scope.siteId,url:scope.siteUrl},snapshot.catalog,snapshot.status,{warnings:snapshot.warnings,detectedAt:snapshot.fetchedAt});
  },[key,snapshot,state.loading,state.error]);
  return useMemo(()=>({snapshot,loading:!!scope && (state.scopeKey!==key || state.loading),error:state.scopeKey===key ? state.error : '',refresh:resource.refresh}),[snapshot,state,key,resource]);
}
export function CatalogProvider({value,children}:{value:CatalogContextValue;children:ReactNode}){return <CatalogContext.Provider value={value}>{children}</CatalogContext.Provider>;}
