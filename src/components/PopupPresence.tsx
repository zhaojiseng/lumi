import {createContext,useCallback,useContext,useLayoutEffect,useRef,useState,type ReactNode} from 'react';

const ScopeContext=createContext(''),ActiveScopeContext=createContext('');
const ExitContext=createContext<{exiting:boolean;complete():void}|null>(null);
export const PopupVisibilityContext=createContext(true);
export function usePopupVisible(){return useContext(PopupVisibilityContext);}
export function usePopupScope(){return useContext(ActiveScopeContext);}
export function usePopupExit(){return useContext(ExitContext);}

/** Exit snapshots follow scope; activeScope identifies the page and public account identity. */
export function PopupScope({scope,activeScope=scope,children}:{scope:string;activeScope?:string;children:ReactNode}){
  return <ScopeContext.Provider value={scope}><ActiveScopeContext.Provider value={activeScope}>{children}</ActiveScopeContext.Provider></ScopeContext.Provider>;
}

/** Unmount after exit; revoked scopes and reduced motion never retain an outgoing snapshot. */
export function PopupPresence({children,exitMs=240}:{children:ReactNode;exitMs?:number}){
  const scope=useContext(ScopeContext),present=children!==null && children!==undefined && children!==false;
  const [visible,setVisible]=useState(present),saved=useRef({scope,children});
  if(present)saved.current={scope,children};
  const revoked=saved.current.scope!==scope,exiting=!present && visible && !revoked;
  const complete=useCallback(()=>setVisible(false),[]);
  useLayoutEffect(()=>{
    if(present){setVisible(true);return;}
    if(revoked || matchMedia('(prefers-reduced-motion: reduce)').matches){setVisible(false);return;}
    if(!exiting)return;
    const timer=setTimeout(complete,exitMs);
    return()=>clearTimeout(timer);
  },[present,revoked,exiting,complete,exitMs]);
  return <ExitContext.Provider value={{exiting,complete}}>{present ? children : exiting ? saved.current.children : null}</ExitContext.Provider>;
}
