import {FONT_FAMILIES,normalizeTypography} from '../../shared/typography';

type Original={value:string;priority:string};
type Declaration={style:CSSStyleDeclaration;name:string;original:Original};
const documents=new WeakMap<Document,{update(value:unknown):void;dispose():void}>();
/** Scale text, including explicit pixel sizes in skins, without zooming geometry
 * or polling the DOM. Code keeps its local monospace family and relative size. */
export function applyDocumentTypography(document:Document,value:unknown){
  const existing=documents.get(document);if(existing){existing.update(value);return;}
  const root=document.documentElement,body=document.body;
  if(!root || !body)return;
  const original=(style:CSSStyleDeclaration,name:string):Original=>({value:style.getPropertyValue(name),priority:style.getPropertyPriority(name)});
  const restore=({style,name,original}:Declaration)=>original.value ? style.setProperty(name,original.value,original.priority) : style.removeProperty(name);
  const own=[{style:root.style,name:'--lumi-font-scale'},{style:root.style,name:'--lumi-font-size'},{style:root.style,name:'font-family'},{style:body.style,name:'font-family'}].map(entry=>({...entry,original:original(entry.style,entry.name)}));
  let declarations=new Map<CSSStyleDeclaration,Declaration[]>(),disposed=false,queued=false;
  const pendingSheets=new Map<HTMLLinkElement,{readable:HTMLLinkElement;loaded:()=>void;failed:()=>void}>();
  function refresh(){
    queued=false;if(disposed)return;
    // Anonymous CORS loads expose local CSSOM inside opaque SDK frames. Replacing
    // the link triggers a fresh load; changing crossorigin alone does not. Keep
    // the original applied until the readable copy loads, avoiding layout jumps.
    for(const link of document.querySelectorAll<HTMLLinkElement>('link[rel="stylesheet"][href]'))if(new URL(link.href).protocol==='lumi-extension:' && !link.hasAttribute('crossorigin') && !pendingSheets.has(link)){
      const readable=link.cloneNode() as HTMLLinkElement;readable.crossOrigin='anonymous';
      const loaded=()=>{if(disposed)return;refresh();link.remove();pendingSheets.delete(link);readable.removeEventListener('error',failed);};
      const failed=()=>{readable.removeEventListener('load',loaded);readable.remove();};
      pendingSheets.set(link,{readable,loaded,failed});readable.addEventListener('load',loaded,{once:true});readable.addEventListener('error',failed,{once:true});link.after(readable);
    }
    const live=new Map<CSSStyleDeclaration,Declaration[]>();
    const visit=(rules:CSSRuleList)=>{for(const rule of rules){
      if('style' in rule){const style=(rule as CSSStyleRule).style;if(style){
        const saved=declarations.get(style) || [];
        for(const name of ['font-size','line-height','--list-font-size','--list-secondary-size']){
          const raw=style.getPropertyValue(name),match=raw.match(/^(\d+(?:\.\d+)?)px$/);
          if(match && Number(match[1])>0){const entry={style,name,original:original(style,name)},index=saved.findIndex(entry=>entry.name===name);if(index<0)saved.push(entry);else saved[index]=entry;style.setProperty(name,`calc(${raw} * var(--lumi-font-scale, 1))`,style.getPropertyPriority(name));}
        }
        if(saved.length)live.set(style,saved);
      }}
      if('cssRules' in rule)visit((rule as CSSGroupingRule).cssRules);
    }};
    for(const sheet of [...document.styleSheets,...document.adoptedStyleSheets]){try{visit(sheet.cssRules);}catch{/* Inaccessible external styles keep their own typography. */}}
    for(const [style,entries] of declarations)if(!live.has(style))for(const entry of entries)restore(entry);
    declarations=live;
  }
  const schedule=()=>{if(!disposed && !queued){queued=true;queueMicrotask(refresh);}};
  const observer=new MutationObserver(schedule);
  if(document.head)observer.observe(document.head,{subtree:true,childList:true,characterData:true});
  document.head?.addEventListener('load',schedule,true);
  const update=(input:unknown)=>{
    const settings=normalizeTypography(input);
    root.style.setProperty('--lumi-font-scale',String(settings.fontSize/13));root.style.setProperty('--lumi-font-size',settings.fontSize+'px');
    if(settings.fontFamily==='system'){for(const entry of own.filter(entry=>entry.name==='font-family'))restore(entry);}
    else {root.style.setProperty('font-family',FONT_FAMILIES[settings.fontFamily].css,'important');body.style.setProperty('font-family',FONT_FAMILIES[settings.fontFamily].css,'important');}
    refresh();
  };
  const dispose=()=>{disposed=true;observer.disconnect();document.head?.removeEventListener('load',schedule,true);for(const {readable,loaded,failed} of pendingSheets.values()){readable.removeEventListener('load',loaded);readable.removeEventListener('error',failed);readable.remove();}pendingSheets.clear();for(const entries of declarations.values())for(const entry of entries)restore(entry);for(const entry of own)restore(entry);declarations.clear();documents.delete(document);};
  documents.set(document,{update,dispose});update(value);
}
export function disposeDocumentTypography(document:Document){documents.get(document)?.dispose();}
