import {useLayoutEffect,useState,type ComponentType,type ReactNode,type RefObject} from 'react';
import type {Bootstrap,Preferences,Dashboard,Page,ModelInfo} from '../../shared/types';
import type {PluginManifest} from '../../shared/contracts/plugins';
import type {InterfaceStyle} from '../../shared/contracts/interface';
import {DEFAULT_INTERFACE_ID} from '../../shared/contracts/interface';
import type {NavigationItem} from './renderer-registry';
import {defaultInterfacePlugin} from '../../plugins/interface.default/renderer';
import {defaultInterfaceLayout} from '../../plugins/interface.default/layout';
import {usePluginSettings} from './plugins';
import {InterfaceErrorContext} from './interface-settings';
import {syncSurfaceTheme} from './surface-theme';
import {interfaceAppearanceKey,resolveInterfaceAppearance} from '../../shared/interface-appearance';
import {ModalScope} from '../components/ModalPresence';

export interface InterfaceShellProps {
  bootstrap:Bootstrap;preferences:Preferences;dashboard:Dashboard|null;nav:readonly NavigationItem[];visiblePage:Page;catalogPending:number;status:string;loading:boolean;error:string;refreshDisabled:boolean;
  loginOpen:boolean;notice:{text:string;kind:'success'|'error'|'info';id:number}|null;searchOpen:boolean;query:string;announcements:boolean;searchedModels:readonly ModelInfo[];filteredActions:readonly NavigationItem[];
  contentRef:RefObject<HTMLDivElement|null>;children:ReactNode;
  setPage(page:Page):void;refresh():void;retry():void;setQuery(query:string):void;setSearchOpen(open:boolean):void;setAnnouncements(open:boolean):void;setLoginOpen(open:boolean):void;clearNotice():void;
  selectSite(id:string):void;configureModel(model:string,tool:'codex'|'claude'):void;windowControl(action:'minimize'|'maximize'|'close'):void;
  interfaceId?:string;
}
export interface InterfacePlugin {manifest:PluginManifest;component:ComponentType<InterfaceShellProps>;}

function cssUnescape(value:string){return value.replace(/\\([0-9a-f]{1,6})(?:\r\n|[ \t\r\n\f])?|\\([^\r\n\f])/gi,(_,hex:string|undefined,char:string)=>hex ? String.fromCodePoint(Math.min(parseInt(hex,16),0x10ffff) || 0xfffd) : char);}
function rejectImports(css:string){
  // replaceSync silently drops @import; inspect at-keywords before CSSOM parsing.
  const tokens=/\/\*[\s\S]*?\*\/|"(?:\\[\s\S]|[^"\\])*"|'(?:\\[\s\S]|[^'\\])*'|@((?:[\w-]|\\(?:[0-9a-f]{1,6}(?:\r\n|[ \t\r\n\f])?|[^\r\n\f]))+)/gi;
  for(const match of css.matchAll(tokens))if(match[1] && cssUnescape(match[1]).toLowerCase()==='import')throw new Error('界面样式不能导入外部资源。');
}
/** CSSOM composes a bounded stylesheet inside a scope; raw text never enters a global style tag. */
export function scopedInterfaceSheet(style:InterfaceStyle){
  if(!/^extension\.[a-z][a-z0-9-]{0,39}\.[a-z][a-z0-9-]{0,39}$/.test(style.id) || style.css.length>65536)throw new Error('界面样式无效或超过大小限制。');
  rejectImports(style.css);
  const parsed=new CSSStyleSheet();parsed.replaceSync(style.css);let count=0;
  function inspect(rules:CSSRuleList){for(const rule of rules){
    if(++count>1000)throw new Error('界面样式规则过多。');
    if(rule instanceof CSSStyleRule){
      for(const name of rule.style){const value=cssUnescape(rule.style.getPropertyValue(name).replace(/\/\*[\s\S]*?\*\//g,''));if(/url\s*\(|image-set\s*\(/i.test(value) || name==='-webkit-app-region' || name==='app-region' || name==='z-index' && value!=='auto' && (!Number.isFinite(Number(value)) || Number(value)>1000))throw new Error('界面样式包含不支持的资源或窗口属性。');}
      if(rule.cssRules?.length)inspect(rule.cssRules);
    }else if(rule instanceof CSSMediaRule || rule instanceof CSSSupportsRule){inspect(rule.cssRules);}
    else throw new Error('界面只支持样式、media 和 supports 规则。');
  }}
  inspect(parsed.cssRules);if(!count)throw new Error('界面样式为空。');
  const sheet=new CSSStyleSheet();sheet.insertRule(`@scope (.desktop-shell[data-interface="${style.id}"]) {}`,0);
  const scope=sheet.cssRules[0] as CSSGroupingRule;for(const rule of parsed.cssRules)scope.insertRule(rule.cssText,scope.cssRules.length);
  return sheet;
}
export function InterfaceHost(props:InterfaceShellProps){
  const {extensions,statuses}=usePluginSettings(),[failure,setFailure]=useState('');
  const style=extensions?.interfaceStyle;
  useLayoutEffect(()=>{
    const base=new CSSStyleSheet();base.replaceSync(defaultInterfaceLayout);let extra:CSSStyleSheet|undefined;
    try{if(style)extra=scopedInterfaceSheet(style);setFailure('');}catch(error){setFailure(error instanceof Error ? error.message : '界面插件无法加载。');}
    const ours=[base,...extra ? [extra] : []];document.adoptedStyleSheets=[...document.adoptedStyleSheets,...ours];
    return()=>{document.adoptedStyleSheets=document.adoptedStyleSheets.filter(sheet=>!ours.includes(sheet));};
  },[style?.id,style?.css]);
  const Shell=defaultInterfacePlugin.component,active=style && !failure ? style.id : DEFAULT_INTERFACE_ID;
  useLayoutEffect(()=>{
    const shell=document.querySelector<HTMLElement>('.desktop-shell');if(!shell)return;
    for(const attribute of [...shell.attributes])if(attribute.name.startsWith('data-appearance-'))shell.removeAttribute(attribute.name);
    const groups=active===style?.id ? style.appearanceGroups : undefined,saved=props.preferences.interfaceSelections?.[active];
    for(const [id,value] of Object.entries(resolveInterfaceAppearance(groups,saved)))shell.setAttribute('data-appearance-'+id,value);
    const key=interfaceAppearanceKey(groups,saved);if(key)shell.dataset.interfaceAppearance=key;else delete shell.dataset.interfaceAppearance;
    const sync=()=>syncSurfaceTheme(shell);sync();
    const observer=new MutationObserver(sync);observer.observe(shell,{attributes:true,attributeFilter:['data-theme','data-interface']});
    return()=>observer.disconnect();
  },[style?.id,style?.css,active,props.preferences]);
  const dialogScope=JSON.stringify([props.visiblePage,props.preferences.sites.find(site=>site.id===props.preferences.activeSiteId),statuses?.map(status=>[status.manifest.id,status.state,status.generation,status.views])]);
  return <ModalScope scope={dialogScope}><InterfaceErrorContext.Provider value={failure}><Shell {...props} interfaceId={active}/></InterfaceErrorContext.Provider></ModalScope>;
}
