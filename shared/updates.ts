import type {UpdateState} from './types';

/** GitHub bodies and electron-updater's Atom notes are rendered as bounded plain text. */
export function releaseNotesText(value:unknown,version?:string):string {
  const raw=typeof value==='string' ? value : Array.isArray(value) ? value.filter(item=>item && typeof item==='object' && (!version || item.version===version)).map(item=>item.note).filter(note=>typeof note==='string').join('\n\n') : '';
  return raw.slice(0,64_000)
    .replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1>/gi,'')
    .replace(/<li\b[^>]*>/gi,'\n- ').replace(/<br\s*\/?\s*>|<\/(?:p|div|h[1-6]|ul|ol)>/gi,'\n')
    .replace(/<[^>]*>/g,'').replace(/&#(x[0-9a-f]+|\d+);/gi,(_,code:string)=>{const n=code[0].toLowerCase()==='x' ? parseInt(code.slice(1),16) : Number(code);return n>0 && n<=0x10ffff ? String.fromCodePoint(n) : '';})
    .replace(/&(amp|lt|gt|quot|apos|nbsp);/g,(_,name:string)=>({amp:'&',lt:'<',gt:'>',quot:'"',apos:"'",nbsp:' '}[name]!))
    .replace(/\r\n?/g,'\n').replace(/[\u0000-\u0008\u000b-\u001f\u007f\u202a-\u202e\u2066-\u2069]/g,'').replace(/\n{3,}/g,'\n\n').trim().slice(0,32_000);
}
export function shouldPromptUpdate(state:UpdateState|null,skipped:string,dismissed:string,seen:string):boolean {
  return !!state && state.phase==='available' && !!state.version && ![skipped,dismissed,seen].includes(state.version);
}
