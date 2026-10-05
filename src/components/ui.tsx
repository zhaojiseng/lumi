import { type ReactNode, type ButtonHTMLAttributes } from 'react';
import { X, Loader2, ArrowUpRight, AlertCircle } from 'lucide-react';
import {BrandGlyph} from './BrandIcon';
import {PopupLayer,type PopupLayerProps} from './Popup';
import {usePopupVisible} from './PopupPresence';
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
