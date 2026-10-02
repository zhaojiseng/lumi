import {useLayoutEffect,useRef,useState,type ReactNode} from 'react';
import {refreshKeyframes,refreshExitKeyframes,type DataRefreshAnimation} from '../../shared/motion';
export function DataRefreshMotion({identity,animation,children,className='',resetKey=''}:{identity:string;animation:DataRefreshAnimation;children:ReactNode;className?:string;resetKey?:string}){
  const ref=useRef<HTMLDivElement>(null),reset=useRef(resetKey),latest=useRef({identity,children}),enter=useRef(false),visible=useRef(children);
  const [display,setDisplay]=useState({identity,children});latest.current={identity,children};
  if(display.identity===identity)visible.current=children;
  useLayoutEffect(()=>{
    const node=ref.current,media=window.matchMedia('(prefers-reduced-motion: reduce)');
    const resetChanged=reset.current!==resetKey;reset.current=resetKey;
    if(display.identity===identity)return;
    if(!node || typeof node.animate!=='function' || animation==='none' || media.matches || resetChanged){enter.current=false;setDisplay(latest.current);return;}
    let active=true;
    const motion=node.animate(refreshExitKeyframes(animation),{duration:120,easing:'ease-in',fill:'forwards'});
    const finish=()=>{if(active){enter.current=true;setDisplay(latest.current);}};
    void motion.finished.then(finish,()=>{});
    const reduce=()=>{if(media.matches){active=false;motion.cancel();enter.current=false;setDisplay(latest.current);}};media.addEventListener('change',reduce);
    return()=>{active=false;motion.cancel();media.removeEventListener('change',reduce);};
  },[identity,animation,resetKey,display.identity]);
  useLayoutEffect(()=>{
    const media=window.matchMedia('(prefers-reduced-motion: reduce)'),node=ref.current;
    const pending=enter.current;enter.current=false;
    if(!pending || !node || media.matches || animation==='none')return;
    const motion=node.animate(refreshKeyframes(animation),{duration:animation==='blur' ? 300 : 220,easing:'cubic-bezier(.22,.61,.36,1)'});
    const reduce=()=>{if(media.matches)motion.cancel();};media.addEventListener('change',reduce);
    return()=>{motion.cancel();media.removeEventListener('change',reduce);};
  },[display.identity,identity,resetKey,animation]);
  return <div ref={ref} className={className}>{display.identity===identity ? children : visible.current}</div>;
}
