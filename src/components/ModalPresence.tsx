import {createContext,useCallback,useContext,useLayoutEffect,useRef,useState,type ReactNode} from 'react';

const ScopeContext=createContext('');
const ExitContext=createContext<{exiting:boolean;complete():void}|null>(null);
export function ModalScope({scope,children}:{scope:string;children:ReactNode}){
  return <ScopeContext.Provider value={scope}>{children}</ScopeContext.Provider>;
}
export function useModalExit(){return useContext(ExitContext);}

/** Retain the exiting dialog, but never retain content across account/page/plugin revocation. */
export function ModalPresence({children}:{children:ReactNode}){
  const scope=useContext(ScopeContext),present=children!==null && children!==undefined && children!==false;
  const [visible,setVisible]=useState(present),saved=useRef({scope,children});
  if(present)saved.current={scope,children};
  const revoked=saved.current.scope!==scope,exiting=!present && visible && !revoked;
  const complete=useCallback(()=>setVisible(false),[]);
  useLayoutEffect(()=>{
    if(present){setVisible(true);return;}
    if(revoked || matchMedia('(prefers-reduced-motion: reduce)').matches){setVisible(false);return;}
    if(!exiting)return;
    const timer=setTimeout(complete,240);
    return()=>clearTimeout(timer);
  },[present,revoked,exiting,complete]);
  return <ExitContext.Provider value={{exiting,complete}}>{present ? children : exiting ? saved.current.children : null}</ExitContext.Provider>;
}
