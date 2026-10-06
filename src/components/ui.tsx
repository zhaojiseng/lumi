import { type ReactNode, type ButtonHTMLAttributes, type PointerEvent, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { X, Loader2, ArrowUpRight, AlertCircle } from 'lucide-react';
import {BrandGlyph} from './BrandIcon';
import {PopupLayer,type PopupLayerProps} from './Popup';
import {usePopupVisible} from './PopupPresence';
/** Multi-state slider switch: a raised knob slides along a continuous track to the pressed stop. */
export function SegmentedSwitch({label,className,role='group',children}:{label:string;className?:string;role?:'group'|'radiogroup';children:ReactNode}) {
  const ref=useRef<HTMLDivElement>(null),[thumb,setThumb]=useState<{x:number;y:number;w:number;h:number}|null>(null);
  const knob=useRef<HTMLSpanElement>(null),align=useRef(()=>{}),suppressClick=useRef(false),clickTimer=useRef<ReturnType<typeof setTimeout>|undefined>(undefined);
  const drag=useRef<{id:number;button:HTMLButtonElement;x:number;y:number;left:number;top:number;w:number;h:number;moved:boolean}|null>(null);
  useEffect(()=>()=>{clearTimeout(clickTimer.current);drag.current=null;},[]);
  useLayoutEffect(()=>{
    const node=ref.current;
    if(!node)return;
    const update=()=>{
      if(drag.current?.moved)return;
      const active=node.querySelector<HTMLElement>(':scope > button[aria-pressed="true"], :scope > button[aria-checked="true"]');
      if(!active){setThumb(null);return;}
      const next={x:active.offsetLeft,y:active.offsetTop,w:active.offsetWidth,h:active.offsetHeight};
      if(knob.current)knob.current.style.transform='translate('+next.x+'px,'+next.y+'px)';
      setThumb(current=>current && current.x===next.x && current.y===next.y && current.w===next.w && current.h===next.h ? current : next);
    };
    align.current=update;
    update();
    const observer=new ResizeObserver(update);
    observer.observe(node);
    node.querySelectorAll(':scope > button').forEach(button=>observer.observe(button));
    return()=>observer.disconnect();
  });
  function finish(event:Pick<PointerEvent<HTMLDivElement>,'pointerId'|'clientX'|'clientY'>,cancel=false){
    const current=drag.current,node=ref.current;
    if(!current || current.id!==event.pointerId || !node)return;
    drag.current=null;delete node.dataset.dragging;
    if(current.button.hasPointerCapture(current.id))current.button.releasePointerCapture(current.id);
    if(current.moved){
      if(!cancel){
        const buttons=Array.from(node.querySelectorAll<HTMLButtonElement>(':scope > button:not(:disabled)'));
        const distance=(button:HTMLButtonElement)=>{const rect=button.getBoundingClientRect();return Math.max(rect.left-event.clientX,0,event.clientX-rect.right)**2+Math.max(rect.top-event.clientY,0,event.clientY-rect.bottom)**2;};
        const target=buttons.reduce<HTMLButtonElement|null>((best,button)=>!best || distance(button)<distance(best) ? button : best,null);
        if(target && target!==current.button){target.focus({preventScroll:true});target.click();}
      }
      suppressClick.current=true;clearTimeout(clickTimer.current);clickTimer.current=setTimeout(()=>{suppressClick.current=false;},0);
    }
    align.current();
  }
  return <div ref={ref} role={role} aria-label={label} className={'model-mode-selector segmented-switch '+(className || '')}
    onKeyDown={event=>{
      if(event.key==='Escape' && drag.current){event.preventDefault();finish({pointerId:drag.current.id,clientX:0,clientY:0},true);return;}
      if(!['ArrowLeft','ArrowRight','ArrowUp','ArrowDown','Home','End'].includes(event.key))return;
      const buttons=[...event.currentTarget.querySelectorAll<HTMLButtonElement>(':scope > button:not(:disabled)')],index=buttons.indexOf(event.target as HTMLButtonElement);if(index<0)return;
      event.preventDefault();const target=event.key==='Home' ? 0 : event.key==='End' ? buttons.length-1 : (index+(['ArrowLeft','ArrowUp'].includes(event.key) ? -1 : 1)+buttons.length)%buttons.length;
      buttons[target].focus({preventScroll:true});buttons[target].click();
    }}
    onPointerDown={event=>{
      const button=(event.target as Element).closest<HTMLButtonElement>('button');
      if(event.button!==0 || !event.isPrimary || !button || button.parentElement!==event.currentTarget || button.disabled || !(button.getAttribute('aria-pressed')==='true' || button.getAttribute('aria-checked')==='true'))return;
      drag.current={id:event.pointerId,button,x:event.clientX,y:event.clientY,left:button.offsetLeft,top:button.offsetTop,w:button.offsetWidth,h:button.offsetHeight,moved:false};
      button.setPointerCapture(event.pointerId);
    }}
    onPointerMove={event=>{
      const current=drag.current,node=ref.current;
      if(!current || current.id!==event.pointerId || !node || !knob.current)return;
      const dx=event.clientX-current.x,dy=event.clientY-current.y;
      if(!current.moved && Math.hypot(dx,dy)<4)return;
      current.moved=true;node.dataset.dragging='true';event.preventDefault();
      const x=Math.max(3,Math.min(current.left+dx,node.clientWidth-current.w-3)),y=Math.max(3,Math.min(current.top+dy,node.clientHeight-current.h-3));
      knob.current.style.transform='translate('+x+'px,'+y+'px)';
    }}
    onPointerUp={event=>finish(event)} onPointerCancel={event=>finish(event,true)} onLostPointerCapture={event=>finish(event,true)}
    onClickCapture={event=>{if(suppressClick.current){event.preventDefault();event.stopPropagation();}}}>
    {thumb && <span ref={knob} className="segmented-thumb" aria-hidden="true" style={{width:thumb.w,height:thumb.h,transform:'translate('+thumb.x+'px,'+thumb.y+'px)'}}/>}
    {children}
  </div>;
}
export function Logo({ small = false }: { small?: boolean }) {
  return <svg className="lumi-logo" width={small ? 32 : 43} height={small ? 32 : 43} viewBox="0 0 64 64" aria-hidden="true"><path d="M23 17v23c0 3 2 5 5 5h18" fill="none" stroke="#fff" strokeWidth="6" strokeLinecap="round"/><circle cx="42" cy="22" r="6" fill="#fff"/></svg>;
}
export function ToolIcon({ tool, size = 38 }: { tool: 'codex' | 'claude'; size?: number }) {
  return <div className={'tool-icon '+(tool==='codex' ? 'codex-icon' : 'claude-icon')} role="img" aria-label={tool==='codex' ? 'Codex 图标' : 'Claude Code 图标'} style={{width:size,height:size}}><BrandGlyph brand={tool==='codex' ? 'codex' : 'anthropic'} size={size*.64}/></div>;
}
export function Button({ children, className = '', variant = 'default', busy, ...props }: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: 'default' | 'primary' | 'ghost' | 'danger'; busy?: boolean }) {
  return <button className={`button ${variant} ${className}`} disabled={busy || props.disabled} {...props}>{busy && <Loader2 size={15} className="spin"/>}{children}</button>;
}
export function Pill({ children, tone = 'green' }: { children: ReactNode; tone?: 'green' | 'blue' | 'orange' | 'muted' | 'purple' | 'red' }) { return <span className={`pill ${tone}`}>{children}</span>; }
export function SectionHeading({ title, sub, action }: { title: string; sub?: string; action?: ReactNode }) { return <div className="section-heading"><div><h3>{title}</h3>{sub && <p>{sub}</p>}</div>{action}</div>; }
export function Empty({ title, description, action }: { title: string; description: string; action?: ReactNode }) { return <div className="empty-state"><div className="empty-icon"><AlertCircle size={25}/></div><h3>{title}</h3><p>{description}</p>{action}</div>; }
export { Select } from './Select';
export function PageIntro({ title, description, action }: { title: string; description: string; action?: ReactNode }) { return <div className="page-intro"><div><h1>{title}</h1><p>{description}</p></div>{action}</div>; }
export function TextLink({ children, onClick }: { children: ReactNode; onClick(): void }) { return <button className="text-link" onClick={onClick}>{children}<ArrowUpRight size={14}/></button>; }
export type ModalProps=Omit<PopupLayerProps,'kind'|'label'> & {title:string;subtitle?:string;wide?:boolean};
function ModalHeading({title,subtitle,onClose}:Pick<ModalProps,'title'|'subtitle'|'onClose'>){
  const active=usePopupVisible();
  return <div className="modal-heading"><div><h2>{title}</h2>{subtitle && <p>{subtitle}</p>}</div><button type="button" className="icon-button" disabled={!active} onClick={()=>onClose()} aria-label="关闭弹窗"><X size={19}/></button></div>;
}
/** Visual dialog shell; PopupLayer owns its lifecycle and PopupPresence owns unmounting exits. */
export function Modal({title,subtitle,children,onClose,wide=false,className='',...popup}:ModalProps){
  return <PopupLayer {...popup} kind="dialog" label={title} className={(wide ? 'wide ' : '')+className} onClose={onClose}><ModalHeading title={title} subtitle={subtitle} onClose={onClose}/>{children}</PopupLayer>;
}
export function Skeleton() { return <div className="page-skeleton" aria-label="加载中"><div className="skeleton intro-skeleton"/><div className="stats-grid">{[1, 2, 3, 4].map(i => <div key={i} className="skeleton stat-skeleton"/>)}</div><div className="skeleton chart-skeleton"/></div>; }
