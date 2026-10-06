/** Host-owned, local displacement maps. Interface CSS opts in with a bounded
 * --lumi-glass-distortion (logical pixels) and consumes --lumi-glass-filter.
 * No page capture, network resource, plugin script or arbitrary filter URL. */
const NS='http://www.w3.org/2000/svg';
const PROPERTY='--lumi-glass-filter';
const CONTAINERS='.content-scroll, .surface.panel:not(.modal), .stat-card, .tool-config-card, .model-card, .token-overview-card, .model-toolbar, .statistics-filter, .welcome-hero';
const POPUPS='.modal, .toast, [data-popup-kind="popover"], .multi-popover, .recharts-default-tooltip, .donut-tooltip';
const TARGETS='[data-lumi-glass], .sidebar, .segmented-thumb, .vendor-tabs > button.active, .favorite-filter.active, '+POPUPS+', .select-wrap select, '+CONTAINERS;
const installed=new WeakMap<HTMLElement,()=>void>();
let sequence=0;

export function glassDisplacement(width:number,height:number,radius:number,maxSize=384,lens=false,surface=false){
  const scale=Math.min(1,maxSize/Math.max(width,height));
  const w=Math.max(2,Math.round(width*scale)),h=Math.max(2,Math.round(height*scale));
  const data=new Uint8ClampedArray(w*h*4),r=Math.min(Math.max(0,radius),width/2,height/2);
  const bevel=Math.min(surface ? 64 : 18,width/4,height/4);
  const distance=(x:number,y:number)=>{
    const qx=Math.abs(x-width/2)-(width/2-r),qy=Math.abs(y-height/2)-(height/2-r);
    return Math.hypot(Math.max(qx,0),Math.max(qy,0))+Math.min(Math.max(qx,qy),0)-r;
  };
  for(let y=0;y<h;y++)for(let x=0;x<w;x++){
    const px=(x+.5)*width/w,py=(y+.5)*height/h,d=distance(px,py);
    // Flat center; curved bevel. Direction is the local inward surface normal.
    const amount=d<=0 ? Math.max(0,1+d/bevel)**2 : 0;
    const nx=distance(px+.5,py)-distance(px-.5,py),ny=distance(px,py+.5)-distance(px,py-.5),len=Math.hypot(nx,ny)||1,i=(y*w+x)*4;
    // A selection lens also samples slightly toward its center, magnifying the
    // labels painted beneath it. Other surfaces retain their flat center.
    const focalRadius=Math.min(width,height)/2;
    const lx=lens && d<=0 ? Math.max(-.65,Math.min(.65,.16*(px-width/2)/focalRadius))*(1-amount) : 0;
    const ly=lens && d<=0 ? Math.max(-.65,Math.min(.65,.16*(py-height/2)/focalRadius))*(1-amount) : 0;
    data[i]=128-127*(nx/len*amount+lx);data[i+1]=128-127*(ny/len*amount+ly);data[i+2]=0;data[i+3]=255;
  }
  return {width:w,height:h,data};
}

/** Returns a disposer. Style and appearance changes are observed without a
 * permanent animation loop; geometry maps are reused until size/radius changes. */
export function installGlassRefraction(shell:HTMLElement){
  const existing=installed.get(shell);if(existing)return existing;
  const document=shell.ownerDocument,view=document.defaultView!;
  const rootId='lumi-glass-root-'+(++sequence),originalRoot=shell.getAttribute('data-lumi-glass-root');
  shell.setAttribute('data-lumi-glass-root',rootId);
  // Each element owns its filter. Its pseudo-elements still inherit it, while
  // descendants cannot accidentally sample using an ancestor's geometry map.
  const baseline=document.createElement('style');
  baseline.textContent=`@scope ([data-lumi-glass-root="${rootId}"]) { :where(*) { ${PROPERTY}: blur(0px); } }`;
  shell.append(baseline);
  const svg=document.createElementNS(NS,'svg'),defs=document.createElementNS(NS,'defs');
  svg.setAttribute('aria-hidden','true');svg.setAttribute('data-lumi-glass-defs','');
  svg.style.cssText='position:absolute;width:0;height:0;overflow:hidden;pointer-events:none';svg.append(defs);shell.append(svg);
  type Entry={filter:SVGFilterElement;image:SVGFEImageElement;displace:SVGFEDisplacementMapElement;key:string;id:string;original:string;priority:string};
  const entries=new Map<HTMLElement,Entry>();let frame=0,disposed=false;
  const textures=new Map<string,{url:string;width:number;height:number}>();
  const reduced=view.matchMedia('(prefers-reduced-transparency: reduce)'),forced=view.matchMedia('(forced-colors: active)');
  const schedule=()=>{if(!disposed && !frame)frame=view.requestAnimationFrame(update);};
  const resize=new ResizeObserver(schedule);
  const remove=(element:HTMLElement)=>{const entry=entries.get(element);if(!entry)return;entries.delete(element);resize.unobserve(element);if(entry.original)element.style.setProperty(PROPERTY,entry.original,entry.priority);else element.style.removeProperty(PROPERTY);entry.filter.remove();};
  function update(){
    frame=0;
    const rootStyle=view.getComputedStyle(shell),raw=Number(rootStyle.getPropertyValue('--lumi-glass-distortion').trim()),strength=!reduced.matches && !forced.matches && shell.getAttribute('data-appearance-transparency')!=='solid' && Number.isFinite(raw) ? Math.max(0,Math.min(12,raw)) : 0;
    if(!strength){for(const element of [...entries.keys()])remove(element);textures.clear();return;}
    // A layout box can exist far outside the scroll viewport. Clip candidates
    // against the viewport and scrolling ancestors before allocating filters.
    const clips=new Map<Element,{rect:DOMRect;x:boolean;y:boolean}>(),styles=new Map<Element,CSSStyleDeclaration>();
    const styleOf=(element:Element)=>{let style=styles.get(element);if(!style){style=view.getComputedStyle(element);styles.set(element,style);}return style;};
    const visible=(element:HTMLElement)=>{
      if(!element.getClientRects().length || element instanceof HTMLSelectElement && !element.matches(':open'))return false;
      if(styleOf(element).visibility!=='visible')return false;
      const rect=element.getBoundingClientRect();let left=Math.max(0,rect.left),top=Math.max(0,rect.top),right=Math.min(view.innerWidth,rect.right),bottom=Math.min(view.innerHeight,rect.bottom);
      for(let parent:HTMLElement|null=element;parent;parent=parent.parentElement){
        if(Number(styleOf(parent).opacity)===0)return false;
        if(parent===shell)break;
        if(parent===element)continue;
        let clip=clips.get(parent);
        if(!clip){const style=styleOf(parent);clip={rect:parent.getBoundingClientRect(),x:['hidden','clip','auto','scroll'].includes(style.overflowX),y:['hidden','clip','auto','scroll'].includes(style.overflowY)};clips.set(parent,clip);}
        if(clip.x){left=Math.max(left,clip.rect.left);right=Math.min(right,clip.rect.right);}
        if(clip.y){top=Math.max(top,clip.rect.top);bottom=Math.min(bottom,clip.rect.bottom);}
      }
      return right>left && bottom>top;
    };
    const targets=[...shell.querySelectorAll<HTMLElement>(TARGETS)]
      .filter(visible)
      .filter(element=>element.hasAttribute('data-lumi-glass') || element.matches(POPUPS) || !element.matches(CONTAINERS) || styleOf(element).getPropertyValue('--lumi-glass-surface').trim()==='1')
      .filter(element=>element.hasAttribute('data-lumi-glass') || styleOf(element).backdropFilter!=='none' || view.getComputedStyle(element,'::before').backdropFilter!=='none' || element instanceof HTMLSelectElement)
      .sort((a,b)=>priority(b)-priority(a))
      .slice(0,96),live=new Set(targets);
    for(const element of [...entries.keys()])if(!live.has(element))remove(element);
    for(const element of targets){
      const style=styleOf(element),picker=element instanceof HTMLSelectElement;
      let width=element.offsetWidth,height=element.offsetHeight,radius=parseFloat(style.borderTopLeftRadius)||0;
      // The workspace background is anchored to main-area, not the scrolling
      // content box. Its map must use that painted box and rounded corners.
      if(element.matches('.content-scroll') || element.dataset.lumiGlass==='background'){
        const background=view.getComputedStyle(element,'::before');
        width=parseFloat(background.width)||width;height=parseFloat(background.height)||height;
        radius=parseFloat(background.borderTopLeftRadius)||radius;
      }
      if(picker){
        if(!element.matches(':open')){remove(element);continue;}
        const rects=[...element.options].map(option=>option.getBoundingClientRect()).filter(rect=>rect.width && rect.height);
        if(!rects.length)continue;
        const p=view.getComputedStyle(element,'::picker(select)');
        width=Math.max(...rects.map(r=>r.right))-Math.min(...rects.map(r=>r.left))+2*(parseFloat(p.paddingLeft)||0)+2*(parseFloat(p.borderLeftWidth)||0);
        height=Math.max(...rects.map(r=>r.bottom))-Math.min(...rects.map(r=>r.top))+2*(parseFloat(p.paddingTop)||0)+2*(parseFloat(p.borderTopWidth)||0);
        height=Math.min(height,parseFloat(p.maxHeight)||height);
        radius=parseFloat(p.borderTopLeftRadius)||0;
      }
      if(width<2 || height<2){remove(element);continue;}
      let entry=entries.get(element);
      if(!entry){
        const filter=document.createElementNS(NS,'filter'),image=document.createElementNS(NS,'feImage'),transfer=document.createElementNS(NS,'feComponentTransfer'),displace=document.createElementNS(NS,'feDisplacementMap');
        const id='lumi-glass-'+(++sequence);filter.id=id;filter.setAttribute('x','0');filter.setAttribute('y','0');filter.setAttribute('width','1');filter.setAttribute('height','1');filter.setAttribute('color-interpolation-filters','sRGB');
        image.setAttribute('result','map');image.setAttribute('preserveAspectRatio','none');transfer.setAttribute('in','map');transfer.setAttribute('result','vectors');
        for(const channel of ['R','G']){const fn=document.createElementNS(NS,'feFunc'+channel);fn.setAttribute('type','linear');fn.setAttribute('slope','1');fn.setAttribute('intercept',String(-.5/255));transfer.append(fn);}
        displace.setAttribute('in','SourceGraphic');displace.setAttribute('in2','vectors');displace.setAttribute('xChannelSelector','R');displace.setAttribute('yChannelSelector','G');
        filter.append(image,transfer,displace);defs.append(filter);entry={filter,image,displace,key:'',id,original:element.style.getPropertyValue(PROPERTY),priority:element.style.getPropertyPriority(PROPERTY)};entries.set(element,entry);resize.observe(element);
      }
      const lens=element.matches('.segmented-thumb') || element.dataset.lumiGlass==='lens';
      const surface=element.matches('.content-scroll, .model-card') || element.dataset.lumiGlass==='surface';
      const key=[Math.round(width),Math.round(height),radius,lens,surface].join(':');
      if(entry.key!==key){
        let texture=textures.get(key);
        if(!texture){const map=glassDisplacement(width,height,radius,384,lens,surface),canvas=document.createElement('canvas');canvas.width=map.width;canvas.height=map.height;
          canvas.getContext('2d')!.putImageData(new ImageData(map.data,map.width,map.height),0,0);texture={url:canvas.toDataURL('image/png'),width,height};
          if(textures.size>=32)textures.delete(textures.keys().next().value!);textures.set(key,texture);
        }
        else {textures.delete(key);textures.set(key,texture);}
        entry.image.setAttribute('href',texture.url);entry.image.setAttribute('width',String(texture.width));entry.image.setAttribute('height',String(texture.height));entry.key=key;
      }
      const value=String((surface ? 4 : 2)*strength);if(entry.displace.getAttribute('scale')!==value)entry.displace.setAttribute('scale',value);
      const reference='url("#'+entry.id+'")';if(element.style.getPropertyValue(PROPERTY)!==reference)element.style.setProperty(PROPERTY,reference);
    }
  }
  const priority=(element:HTMLElement)=>element.matches(POPUPS) ? 4 : element.matches('.segmented-thumb, select') || element.dataset.lumiGlass==='lens' ? 3 : element.matches('.sidebar, .content-scroll') ? 2 : 1;
  const withoutReference=(style:string|null)=>(style || '').replace(/--lumi-glass-filter\s*:[^;]*(?:;|$)/g,'').trim();
  const observer=new MutationObserver(records=>{if(records.some(record=>!svg.contains(record.target) && record.target!==baseline && !(record.type==='attributes' && record.attributeName==='style' && withoutReference(record.oldValue)===withoutReference((record.target as HTMLElement).getAttribute('style')))))schedule();});
  observer.observe(shell,{subtree:true,childList:true,attributes:true,attributeOldValue:true,attributeFilter:['class','style','hidden','open','data-lumi-glass','data-interface','data-theme','data-interface-appearance','data-appearance-distortion','data-appearance-blur','data-appearance-transparency']});
  if(document.head)observer.observe(document.head,{subtree:true,childList:true,characterData:true,attributes:true,attributeFilter:['href','media','disabled']});
  const events=['click','keydown','input','change','toggle','scroll','transitionrun','transitionend','animationstart','animationend'];
  for(const event of events)shell.addEventListener(event,schedule,true);
  document.head?.addEventListener('load',schedule,true);
  view.addEventListener('resize',schedule);reduced.addEventListener('change',schedule);forced.addEventListener('change',schedule);schedule();
  const dispose=()=>{if(disposed)return;disposed=true;if(frame)view.cancelAnimationFrame(frame);observer.disconnect();resize.disconnect();for(const event of events)shell.removeEventListener(event,schedule,true);document.head?.removeEventListener('load',schedule,true);view.removeEventListener('resize',schedule);reduced.removeEventListener('change',schedule);forced.removeEventListener('change',schedule);for(const element of [...entries.keys()])remove(element);textures.clear();svg.remove();baseline.remove();if(originalRoot===null)shell.removeAttribute('data-lumi-glass-root');else shell.setAttribute('data-lumi-glass-root',originalRoot);installed.delete(shell);};
  installed.set(shell,dispose);return dispose;
}
