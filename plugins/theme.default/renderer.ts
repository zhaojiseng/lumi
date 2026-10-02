import {useEffect,useLayoutEffect,useState} from 'react';
import type {Theme} from '../../shared/types';
/** Existing semantic CSS and cascade order stay intact. */
export function useDefaultTheme(theme:Theme){
  const [systemDark,setSystemDark]=useState(()=>matchMedia('(prefers-color-scheme: dark)').matches);
  const resolved=theme==='system' ? systemDark ? 'dark' : 'light' : theme;
  useEffect(()=>{
    const query=matchMedia('(prefers-color-scheme: dark)');
    const update=()=>setSystemDark(query.matches);
    update();query.addEventListener('change',update);return()=>query.removeEventListener('change',update);
  },[]);
  useLayoutEffect(()=>{document.documentElement.dataset.theme=resolved;},[resolved]);
  return resolved;
}
