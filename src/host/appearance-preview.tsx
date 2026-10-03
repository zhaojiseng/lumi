import {useEffect,useLayoutEffect,useRef,useState} from 'react';
import type {InterfaceStyle} from '../../shared/contracts/interface';
import {DEFAULT_INTERFACE_ID} from '../../shared/contracts/interface';
import {defaultInterfaceLayout} from '../../plugins/interface.default/layout';
import {scopedInterfaceSheet} from './interface';

const defaultPreview=`<header class="titlebar"><div class="titlebar-brand"><strong>Lumi</strong></div><div class="breadcrumb">工作台</div></header>
<aside class="sidebar surface"><div class="sidebar-navigation"><div class="sidebar-caption">WORKSPACE</div><nav><div class="nav-item active">工作台</div><div class="nav-item">用量分析</div><div class="nav-item">模型广场</div></nav></div><div class="sidebar-footer"><div class="nav-item">设置</div></div></aside>
<main class="main-area"><div class="content-container"><div class="page-intro"><h1>工作台</h1><p>当前用量</p></div><div class="preview-stat-grid"><section class="surface panel"><div class="stat-top">余额</div><strong class="stat-number">$ 28.60</strong></section><section class="surface panel"><div class="stat-top">请求</div><strong class="stat-number">128</strong></section></div><section class="surface panel preview-chart"><div class="section-heading"><h2>用量趋势</h2></div><div class="preview-bars"><i></i><i></i><i></i><i></i><i></i><i></i></div></section></div></main>`;
const previewCss=`html,body{margin:0;height:100%;overflow:hidden!important}*{-webkit-app-region:no-drag!important}.desktop-shell{height:100vh!important;min-height:0!important}.preview-stat-grid{display:grid;grid-template-columns:1fr 1fr;gap:16px;margin-bottom:16px}.preview-chart{height:230px}.preview-bars{height:150px;display:flex;align-items:end;gap:20px;padding-top:16px}.preview-bars i{flex:1;background:var(--accent);border-radius:4px 4px 0 0;height:60%}.preview-bars i:nth-child(2n){height:90%}.preview-bars i:nth-child(3n){height:40%}`;
const tags=new Set(['DIV','SPAN','STRONG','B','EM','P','H1','H2','H3','HEADER','ASIDE','MAIN','NAV','SECTION','ARTICLE','UL','OL','LI','I','HR','BR']);
export function sanitizeInterfacePreview(html:string){
  if(html.length>32768)throw new Error('预览模板超过大小限制。');
  const template=document.createElement('template');template.innerHTML=html;
  const elements=template.content.querySelectorAll('*');if(!elements.length || elements.length>500)throw new Error('预览模板为空或节点过多。');
  for(const element of elements){
    if(!tags.has(element.tagName) || [...element.attributes].some(attribute=>!['class','aria-label','aria-hidden'].includes(attribute.name)))throw new Error('预览模板只支持静态布局标签和 class、aria-label、aria-hidden 属性。');
  }
  return template.innerHTML;
}
export function appearancePreviewDocument(style:InterfaceStyle|undefined,mode:'light'|'dark',values:Record<string,string>,platform:string){
  // The preview has its own CSSOM and CSP; alternate modes never touch the application's theme.
  const css=[...document.styleSheets].flatMap(sheet=>{try{return [...sheet.cssRules].map(rule=>rule.cssText);}catch{return [];}}).join('\n');
  let extra='',markup=defaultPreview,error='';
  try{if(style)extra=[...scopedInterfaceSheet(style).cssRules].map(rule=>rule.cssText).join('\n');}catch(e){error=e instanceof Error ? e.message : '界面样式无效。';style=undefined;}
  try{if(style?.preview)markup=sanitizeInterfacePreview(style.preview);}catch(e){error=e instanceof Error ? e.message : '预览模板无效。';}
  const escape=(value:string)=>value.replace(/[&"<>]/g,char=>({'&':'&amp;','"':'&quot;','<':'&lt;','>':'&gt;'}[char]!));
  const attrs=Object.entries(values).filter(([id])=>/^[a-z][a-z0-9-]{0,39}$/.test(id)).map(([id,value])=>`data-appearance-${id}="${escape(value)}"`).join(' ');
  const stylesheet=(css+'\n'+defaultInterfaceLayout+'\n'+extra+'\n'+previewCss).replace(/<\/style/gi,'<\\/style');
  return {error,html:`<!doctype html><html data-theme="${mode}"><head><meta charset="UTF-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'none'; img-src 'none'; font-src 'none'; base-uri 'none'; form-action 'none'"><style>${stylesheet}</style></head><body><div class="desktop-shell platform-${escape(platform)}" data-theme="${mode}" data-interface="${escape(style?.id || DEFAULT_INTERFACE_ID)}" ${attrs}>${markup}</div></body></html>`};
}
export function AppearancePreview({style,mode,values,platform}:{style?:InterfaceStyle;mode:'light'|'dark';values:Record<string,string>;platform:string}){
  const ref=useRef<HTMLDivElement>(null),[scale,setScale]=useState(0),[preview,setPreview]=useState<{html:string;error:string}>();
  const key=JSON.stringify(values);
  useEffect(()=>{setPreview(appearancePreviewDocument(style,mode,JSON.parse(key),platform));},[style,mode,key,platform]);
  useLayoutEffect(()=>{const node=ref.current;if(!node)return;setScale(node.clientWidth/1024);const observer=new ResizeObserver(([entry])=>setScale(entry.contentRect.width/1024));observer.observe(node);return()=>observer.disconnect();},[]);
  return <div ref={ref} className="theme-preview live" data-preview-mode={mode} title={preview?.error || undefined}>{preview && <iframe aria-hidden="true" title="外观缩略预览" tabIndex={-1} sandbox="" srcDoc={preview.html} style={{width:1024,height:640,transform:`scale(${scale})`,transformOrigin:'top left'}}/>}{preview?.error && <span className="preview-error">预览模板无效</span>}</div>;
}
