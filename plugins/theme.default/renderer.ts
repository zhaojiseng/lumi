import {useEffect} from 'react';
import type {Theme} from '../../shared/types';
/** Existing semantic CSS and cascade order stay intact. */
export function useDefaultTheme(theme:Theme){
  useEffect(()=>{
    const query=matchMedia('(prefers-color-scheme: dark)');
    const update=()=>{document.documentElement.dataset.theme=theme==='system' ? query.matches ? 'dark' : 'light' : theme;};
    update();query.addEventListener('change',update);return()=>query.removeEventListener('change',update);
  },[theme]);
}
