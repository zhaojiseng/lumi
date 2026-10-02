import {useLayoutEffect,useState,type ReactNode} from 'react';
import {createPortal} from 'react-dom';

/** Host overlays inherit the selected interface's scoped palette without remounting the shell. */
export function useInterfaceOverlayTarget(){
  const [target,setTarget]=useState<HTMLElement|null>(null);
  useLayoutEffect(()=>{setTarget(document.querySelector<HTMLElement>('.desktop-shell'));},[]);
  return target;
}
export function InterfaceOverlay({children}:{children:ReactNode}){
  const target=useInterfaceOverlayTarget();
  return target ? createPortal(children,target) : children;
}
