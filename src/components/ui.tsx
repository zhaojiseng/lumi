import { useEffect, useLayoutEffect, useRef, type ReactNode, type ButtonHTMLAttributes } from 'react';
import { X, Loader2, ArrowUpRight, AlertCircle } from 'lucide-react';
import {BrandGlyph} from './BrandIcon';
import {useModalExit} from './ModalPresence';
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
export function Modal({ title, subtitle, children, onClose, wide = false, className = '' }: { className?: string; title: string; subtitle?: string; children: ReactNode; onClose(): void; wide?: boolean }) {
  const ref = useRef<HTMLDivElement>(null);
  const overlay=useRef<HTMLDivElement>(null),exit=useModalExit(),exiting=exit?.exiting ?? false,exitingRef=useRef(exiting);exitingRef.current=exiting;
  const closeRef = useRef(onClose);closeRef.current=onClose;
  useLayoutEffect(()=>{
    if(exiting && !overlay.current?.getAnimations().length)exit?.complete();
  },[exiting,exit?.complete]);
  useEffect(() => {
    const previous = document.activeElement as HTMLElement;
    const timer = window.setTimeout(() => {if(!exitingRef.current)ref.current?.querySelector<HTMLElement>('input,button,select')?.focus();}, 0);
    function key(e: KeyboardEvent) {
      const dialogs=[...document.querySelectorAll('[role="dialog"]')].filter(dialog=>!dialog.closest('[inert]'));if(exitingRef.current || dialogs[dialogs.length-1]!==ref.current)return;
      if (e.key === 'Escape') { e.stopPropagation(); closeRef.current(); }
      if (e.key === 'Tab') {
        const els = [...(ref.current?.querySelectorAll<HTMLElement>('button:not(:disabled), input:not(:disabled), select:not(:disabled), textarea:not(:disabled), [tabindex="0"]') || [])].filter(element=>!element.closest('[inert]'));
        if (!els.length) return;
        if (e.shiftKey && document.activeElement === els[0]) { e.preventDefault(); els.at(-1)?.focus(); }
        else if (!e.shiftKey && document.activeElement === els.at(-1)) { e.preventDefault(); els[0].focus(); }
      }
    }
    document.addEventListener('keydown', key); return () => {
      clearTimeout(timer);document.removeEventListener('keydown',key);
      const active=[...document.querySelectorAll('[role="dialog"]')].filter(dialog=>!dialog.closest('[inert]'));
      if(previous?.isConnected && !previous.closest('[inert]') && (!active.length || active.at(-1)?.contains(previous)))previous.focus({preventScroll:true});
    };
  }, []);
  return <div ref={overlay} className="modal-overlay" data-modal-phase={exiting ? 'exiting' : 'open'} inert={exiting} onAnimationEnd={event=>{if(exiting && event.target===event.currentTarget && event.animationName==='modal-backdrop-out')exit?.complete();}} onMouseDown={e => { if (!exiting && e.target === e.currentTarget) onClose(); }}><div className={`modal surface ${wide ? 'wide' : ''} ${className}`} role="dialog" aria-modal="true" aria-hidden={exiting || undefined} aria-label={title} ref={ref}><div className="modal-heading"><div><h2>{title}</h2>{subtitle && <p>{subtitle}</p>}</div><button type="button" className="icon-button" disabled={exiting} onClick={onClose} aria-label="关闭弹窗"><X size={19}/></button></div>{children}</div></div>;
}
export function Skeleton() { return <div className="page-skeleton" aria-label="加载中"><div className="skeleton intro-skeleton"/><div className="stats-grid">{[1, 2, 3, 4].map(i => <div key={i} className="skeleton stat-skeleton"/>)}</div><div className="skeleton chart-skeleton"/></div>; }
