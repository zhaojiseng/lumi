import { Children, cloneElement, isValidElement, type ReactNode } from 'react';
import { ChevronDown } from 'lucide-react';
import {usePopupVisible} from './PopupPresence';
export type SelectTone = 'sage' | 'blue' | 'lavender' | 'peach' | 'red' | 'neutral';
interface OptionProps { value?: string | number; children?: ReactNode; 'data-tone'?: SelectTone; 'aria-label'?: string; }
function optionText(node: ReactNode): string {
  return Children.toArray(node).map(child => isValidElement<{ children?: ReactNode }>(child) ? optionText(child.props.children) : String(child)).join('');
}
function optionTone(value: string, text: string, fallback: SelectTone): SelectTone {
  const name = (value + ' ' + text).toLowerCase();
  if (/错误|失败|error|failed/.test(name)) return 'red';
  if (/claude|anthropic|sonnet|opus|haiku/.test(name)) return 'peach';
  if (/codex|openai|gpt|response|deepseek/.test(name)) return 'blue';
  if (/gemini|google|auto|自动路由|premium|高质量/.test(name)) return 'lavender';
  if (!value || /^(all|0)$/.test(value) || /全部|关闭|不绑定/.test(text)) return 'neutral';
  return fallback;
}
/** Native customizable select: one picker style, with platform keyboard and form semantics. */
export function Select({ value, onChange, children, label, className = '', tone = 'sage', disabled = false, displayValue, decorated=true }: {
  value: string | number; onChange: (v: string) => void; children: ReactNode;
  label: string; className?: string; tone?: SelectTone; disabled?: boolean; displayValue?: ReactNode; decorated?:boolean;
}) {
  // Hidden dialogs retain drafts; replacing only this native control closes Chromium's picker.
  const modalVisible=usePopupVisible();
  let selectedTone: SelectTone = tone;
  let selectedText = '';
  const options = Children.map(children, child => {
    if (!isValidElement<OptionProps>(child) || child.type !== 'option') return child;
    const text = child.props['aria-label'] || optionText(child.props.children);
    const optionValue = String(child.props.value ?? text);
    const color = child.props['data-tone'] || optionTone(optionValue, text, tone);
    if (optionValue === String(value)) { selectedTone = color; selectedText = text; }
    return cloneElement(child, { 'data-tone': color }, <span className="select-option-label">{child.props.children}</span>);
  });
  return <div className={`select-wrap ${displayValue ? 'rich-select' : ''} ${className}`} data-tone={selectedTone} data-decorated={decorated} data-disabled={disabled || undefined}>
    <select key={modalVisible ? 'visible' : 'hidden'} aria-label={label} title={selectedText || undefined} value={value} onChange={e => onChange(e.target.value)} disabled={disabled} onKeyDown={e => { if (e.key === 'Escape' && (e.currentTarget.matches(':open') || (e.target as HTMLElement).tagName === 'OPTION')) e.stopPropagation(); }}>{options}</select>
    <ChevronDown size={15} aria-hidden="true"/>
    {displayValue && <span className="select-display-value" aria-hidden="true">{displayValue}</span>}
  </div>;
}
