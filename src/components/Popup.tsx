import {createContext,useCallback,useContext,useEffect,useLayoutEffect,useRef,useState,type AnimationEvent,type CSSProperties,type ReactNode,type Ref,type RefObject} from 'react';
import {createPortal} from 'react-dom';
import {PopupVisibilityContext,usePopupExit,usePopupScope} from './PopupPresence';

export type PopupCloseReason='escape'|'outside'|'parent'|'scope'|'resize'|'scroll';
export interface PopupLayerProps {
  kind?:'dialog'|'popover';label:string;children:ReactNode;onClose(reason?:PopupCloseReason):void;
  /** Keeping this layer mounted retains React drafts; PopupPresence instead unmounts after exit. */
  open?:boolean;className?:string;style?:CSSProperties;portal?:boolean;trapFocus?:boolean;
  panelRef?:Ref<HTMLDivElement>;initialFocus?:RefObject<HTMLElement|null>;returnFocus?:HTMLElement|null;
  anchorRef?:RefObject<HTMLElement|null>;dismissOutside?:boolean;closeOnResize?:boolean;closeOnScroll?:boolean;
  /** Override only when the caller has a narrower, explicitly managed account/page scope. */
  scope?:string;exitMs?:number;
}
const PopupContext=createContext<{active:boolean;depth:number;target:HTMLElement|null;root:object|null}>({active:true,depth:0,target:null,root:null});
const activeLayers=new Map<HTMLDivElement,{root:object;depth:number;layer:HTMLElement}>(),roots:object[]=[];
const handledEvents=new WeakSet<Event>();
function popupStack(){
  return [...activeLayers].filter(([panel])=>!panel.closest('[inert],[hidden]') && panel.getClientRects().length>0)
    .sort(([,a],[,b])=>roots.indexOf(a.root)-roots.indexOf(b.root) || a.depth-b.depth).map(([panel])=>panel);
}
function syncLayers(){popupStack().forEach((panel,index)=>{const entry=activeLayers.get(panel);if(entry)entry.layer.style.zIndex=String(100+index);});}
function visibleElement(element:HTMLElement){return element.isConnected && !element.closest('[inert],[hidden]') && element.getClientRects().length>0 && getComputedStyle(element).visibility!=='hidden';}

/** Shared portal, layer, dismissal, focus and retained-content lifecycle for dialogs and popovers. */
export function PopupLayer({kind='dialog',label,children,onClose,open=true,className='',style,portal=true,trapFocus=true,panelRef,initialFocus,returnFocus,anchorRef,dismissOutside=true,closeOnResize=kind==='popover',closeOnScroll=kind==='popover',scope:explicitScope,exitMs=240}:PopupLayerProps){
  const parent=useContext(PopupContext),inheritedScope=usePopupScope(),scope=explicitScope ?? inheritedScope;
  const openedScope=useRef(scope),wasOpen=useRef(open),withdrawn=useRef<PopupCloseReason|null>(null);
  if(open && !wasOpen.current){openedScope.current=scope;withdrawn.current=null;}
  wasOpen.current=open;
  if(openedScope.current!==scope)withdrawn.current='scope';
  else if(open && !parent.active && !withdrawn.current)withdrawn.current='parent';
  const revoked=withdrawn.current!==null,exit=usePopupExit(),externalExit=exit?.exiting ?? false;
  const [portalTarget,setPortalTarget]=useState<HTMLElement|null>(null);
  useLayoutEffect(()=>{
    if(portal && !parent.target && !portalTarget && typeof document!=='undefined')setPortalTarget(document.querySelector<HTMLElement>('.desktop-shell') || document.body);
  },[portal,parent.target,portalTarget]);
  const target=parent.target || (portal ? portalTarget : null),awaitingTarget=portal && !parent.target && !target && typeof document!=='undefined';
  const [drawn,setDrawn]=useState(open),controlledExit=!open && drawn && parent.active && !revoked;
  const exiting=externalExit || controlledExit,active=open && parent.active && !exiting && !revoked && !awaitingTarget;
  const displayed=parent.active && !revoked && !awaitingTarget && (open || controlledExit);
  const ownRoot=useRef({}),owner=parent.root || ownRoot.current;
  const panel=useRef<HTMLDivElement>(null),layer=useRef<HTMLDivElement>(null),closeRef=useRef(onClose);closeRef.current=onClose;
  const attach=useCallback((node:HTMLDivElement|null)=>{panel.current=node;if(kind==='popover')layer.current=node;if(typeof panelRef==='function')panelRef(node);else if(panelRef)panelRef.current=node;},[kind,panelRef]);
  const complete=useCallback(()=>{if(externalExit)exit?.complete();else setDrawn(false);},[externalExit,exit?.complete]);
  useLayoutEffect(()=>{
    if(revoked){setDrawn(false);if(open)closeRef.current(withdrawn.current!);return;}
    if(!parent.active){setDrawn(false);if(open)closeRef.current('parent');return;}
    if(open){setDrawn(true);return;}
    if(!controlledExit)return;
    if(matchMedia('(prefers-reduced-motion: reduce)').matches){setDrawn(false);return;}
    const timer=setTimeout(complete,exitMs);return()=>clearTimeout(timer);
  },[open,parent.active,revoked,controlledExit,complete,exitMs]);
  useLayoutEffect(()=>{
    if(displayed && exiting && !layer.current?.getAnimations().length)complete();
  },[displayed,exiting,complete]);
  useLayoutEffect(()=>{
    if(!active || !panel.current || !layer.current)return;
    const node=panel.current;
    if(!roots.includes(owner))roots.push(owner);
    activeLayers.set(node,{root:owner,depth:parent.depth,layer:layer.current});syncLayers();
    return()=>{activeLayers.delete(node);if(![...activeLayers.values()].some(entry=>entry.root===owner)){const index=roots.indexOf(owner);if(index>=0)roots.splice(index,1);}syncLayers();};
  },[active,owner,parent.depth,target]);
  useEffect(()=>{
    if(!active)return;
    const previous=returnFocus || document.activeElement as HTMLElement;
    const controls=()=>[...(panel.current?.querySelectorAll<HTMLElement>('button:not(:disabled), input:not(:disabled):not([type="hidden"]), select:not(:disabled), textarea:not(:disabled), a[href], [tabindex="0"]') || [])].filter(visibleElement);
    const top=()=>popupStack().at(-1)===panel.current;
    const timer=setTimeout(()=>{if(top()){const focus=initialFocus?.current;(focus && visibleElement(focus) ? focus : controls()[0] || panel.current)?.focus({preventScroll:true});}},0);
    function key(event:KeyboardEvent){
      if(event.defaultPrevented || handledEvents.has(event) || !top())return;
      if(event.key==='Escape'){handledEvents.add(event);event.preventDefault();event.stopPropagation();closeRef.current('escape');return;}
      if(event.key!=='Tab' || !trapFocus)return;
      const elements=controls();
      if(!elements.length){event.preventDefault();panel.current?.focus({preventScroll:true});return;}
      if(event.shiftKey && (document.activeElement===elements[0] || !panel.current?.contains(document.activeElement))){event.preventDefault();elements.at(-1)?.focus();}
      else if(!event.shiftKey && (document.activeElement===elements.at(-1) || !panel.current?.contains(document.activeElement))){event.preventDefault();elements[0].focus();}
    }
    function outside(event:PointerEvent){
      if(kind!=='popover' || !dismissOutside || handledEvents.has(event) || !top() || panel.current?.contains(event.target as Node) || anchorRef?.current?.contains(event.target as Node))return;
      handledEvents.add(event);
      if(event.target instanceof HTMLElement && event.target.matches('[data-popup-kind="dialog"]'))event.preventDefault();
      closeRef.current('outside');
    }
    const resize=()=>{if(closeOnResize && top())closeRef.current('resize');};
    const scroll=(event:Event)=>{if(closeOnScroll && top() && !panel.current?.contains(event.target as Node))closeRef.current('scroll');};
    document.addEventListener('keydown',key);document.addEventListener('pointerdown',outside);window.addEventListener('resize',resize);document.addEventListener('scroll',scroll,true);
    return()=>{
      clearTimeout(timer);document.removeEventListener('keydown',key);document.removeEventListener('pointerdown',outside);window.removeEventListener('resize',resize);document.removeEventListener('scroll',scroll,true);
      const topLayer=popupStack().at(-1);
      if(previous && visibleElement(previous) && (!topLayer || topLayer.contains(previous)))previous.focus({preventScroll:true});
    };
  },[active,kind,trapFocus,dismissOutside,closeOnResize,closeOnScroll,anchorRef,initialFocus,target]);
  if(revoked || awaitingTarget)return null;
  const phase=exiting ? 'exiting' : 'open',phaseClass=kind==='popover' ? exiting ? ' closing' : ' open' : '';
  const finish=(event:AnimationEvent<HTMLDivElement>)=>{if(exiting && event.target===event.currentTarget)complete();};
  const surface=<div ref={attach} className={(kind==='dialog' ? 'modal surface ' : '')+className+phaseClass} style={kind==='popover' ? {...style,display:displayed ? style?.display : 'none'} : style} role="dialog" aria-modal={kind==='dialog'} aria-hidden={!active || undefined} aria-label={label} tabIndex={-1} data-modal-depth={parent.depth} data-popup-kind={kind==='popover' ? kind : undefined} data-popup-phase={kind==='popover' ? phase : undefined} hidden={kind==='popover' && !displayed} inert={!active} onAnimationEnd={kind==='popover' ? finish : undefined}>{children}</div>;
  const content=<PopupContext.Provider value={{active,depth:parent.depth+1,target,root:owner}}><PopupVisibilityContext.Provider value={active}>{kind==='dialog' ? <div ref={layer} className="modal-overlay" hidden={!displayed} style={{display:displayed ? undefined : 'none'}} data-popup-kind={kind} data-popup-phase={phase} data-modal-phase={phase} inert={!active} onAnimationEnd={finish} onPointerDown={event=>{if(active && dismissOutside && event.target===event.currentTarget && popupStack().at(-1)===panel.current && !handledEvents.has(event.nativeEvent)){handledEvents.add(event.nativeEvent);event.preventDefault();closeRef.current('outside');}}}>{surface}</div> : surface}</PopupVisibilityContext.Provider></PopupContext.Provider>;
  return target ? createPortal(content,target) : content;
}
