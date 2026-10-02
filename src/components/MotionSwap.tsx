import {useLayoutEffect,useRef,useState,type ReactNode} from 'react';
/** Keep the outgoing panel until its exit ends, and preserve height during the handoff. */
export function MotionSwap({identity,children,className='',canRetain}:{identity:string;children:ReactNode;className?:string;canRetain?:(identity:string)=>boolean}) {
  const [shown,setShown]=useState(identity),[phase,setPhase]=useState(''),[height,setHeight]=useState<number>();
  const root=useRef<HTMLDivElement>(null),saved=useRef(children),latest=useRef(children);latest.current=children;
  if(shown===identity)saved.current=children;
  // A revoked page must unmount in this render, even while its exit animation is pending.
  const revoked=shown!==identity && canRetain?.(shown)===false;
  useLayoutEffect(()=>{
    if(shown===identity){if(phase==='leaving'){setPhase('');setHeight(undefined);}return;}
    if(revoked || matchMedia('(prefers-reduced-motion: reduce)').matches){saved.current=latest.current;setShown(identity);setPhase('');setHeight(undefined);return;}
    setHeight(root.current?.getBoundingClientRect().height);setPhase('leaving');
    const timer=setTimeout(()=>{saved.current=latest.current;setShown(identity);setPhase('entering');},110);
    return ()=>clearTimeout(timer);
  },[identity,shown,revoked]);
  useLayoutEffect(()=>{
    if(phase!=='entering')return;
    // Disabled or cancelled animations do not emit animationend; release the height anyway.
    const timer=setTimeout(()=>{setPhase('');setHeight(undefined);},250);
    return ()=>clearTimeout(timer);
  },[phase,shown]);
  return <div ref={root} className={'motion-frame '+className} style={height ? {minHeight:height} : undefined}><div className={'motion-panel '+phase} onAnimationEnd={event=>{if(event.target===event.currentTarget && phase==='entering'){setPhase('');setHeight(undefined);}}}>{shown===identity || revoked ? children : saved.current}</div></div>;
}
