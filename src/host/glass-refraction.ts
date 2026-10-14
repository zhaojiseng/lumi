/** Host-owned, local displacement maps. Interface CSS opts in with a bounded
 * --lumi-glass-distortion (logical pixels) and consumes --lumi-glass-filter.
 * No page capture, network resource, plugin script or arbitrary filter URL. */
const NS='http://www.w3.org/2000/svg';
const PROPERTY='--lumi-glass-filter';
const CONTAINERS='.content-scroll, .surface.panel:not(.modal), .stat-card, .tool-config-card, .model-card, .token-overview-card, .model-toolbar, .statistics-filter, .welcome-hero';
const POPUPS='.modal, .toast, [data-popup-kind="popover"], .multi-popover, .recharts-default-tooltip, .donut-tooltip';
const TARGETS='[data-lumi-glass], .sidebar, .segmented-thumb, .vendor-tabs > button.active, .favorite-filter.active, .model-choice.selected, '+POPUPS+', .select-wrap select, '+CONTAINERS;
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

/** Keep the displacement algorithm and rendered filter
 * graph unchanged; batch DOM reads before writes and pre-register finite
 * opacity entrances so an opacity-zero first frame cannot miss its filter. */
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
  type Geometry={width:number;height:number;radius:number;lens:boolean;surface:boolean;key:string;epoch:number};
  type Snapshot={element:HTMLElement;geometry:Geometry};
  const entries=new Map<HTMLElement,Entry>();
  const geometryCache=new WeakMap<HTMLElement,Geometry>();
  const observed=new Set<HTMLElement>();
  const watchedEntrances=new Map<Animation,()=>void>();
  let candidates:HTMLElement[]=[],candidatesDirty=true,geometryEpoch=0;
  let frame=0,disposed=false;
  const textures=new Map<string,{url:string;width:number;height:number}>();
  const reduced=view.matchMedia('(prefers-reduced-transparency: reduce)'),forced=view.matchMedia('(forced-colors: active)');
  const schedule=()=>{if(!disposed && !frame)frame=view.requestAnimationFrame(update);};
  const invalidate=()=>{geometryEpoch++;schedule();};
  const resize=new ResizeObserver(records=>{for(const record of records)geometryCache.delete(record.target as HTMLElement);schedule();});
  const remove=(element:HTMLElement)=>{const entry=entries.get(element);if(!entry)return;entries.delete(element);if(entry.original)element.style.setProperty(PROPERTY,entry.original,entry.priority);else element.style.removeProperty(PROPERTY);entry.filter.remove();};
  function syncObserved(next:readonly HTMLElement[]){
    const live=new Set(next);
    for(const element of observed)if(!live.has(element)){resize.unobserve(element);observed.delete(element);geometryCache.delete(element);}
    for(const element of next)if(!observed.has(element)){observed.add(element);resize.observe(element);}
  }
  function update(){
    frame=0;
    const rootStyle=view.getComputedStyle(shell),raw=Number(rootStyle.getPropertyValue('--lumi-glass-distortion').trim()),strength=!reduced.matches && !forced.matches && shell.getAttribute('data-appearance-transparency')!=='solid' && Number.isFinite(raw) ? Math.max(0,Math.min(12,raw)) : 0;
    if(!strength){for(const element of [...entries.keys()])remove(element);textures.clear();syncObserved([]);for(const stop of watchedEntrances.values())stop();watchedEntrances.clear();return;}
    if(candidatesDirty){candidates=[...shell.querySelectorAll<HTMLElement>(TARGETS)];candidatesDirty=false;}
    // READ PHASE. No attached SVG/style/observer writes may occur until every
    // candidate's visibility, consumer, size and radius have been measured.
    // A layout box can exist far outside the scroll viewport. Clip candidates
    // against the viewport and scrolling ancestors before allocating filters.
    const clips=new Map<Element,{rect:DOMRect;x:boolean;y:boolean}>(),styles=new Map<Element,CSSStyleDeclaration>();
    const backgrounds=new Map<Element,CSSStyleDeclaration>(),entrances=new Map<Element,boolean>();
    const pendingEntrances=new Set<Animation>();
    const opacities=new Map<Element,number>();
    const styleOf=(element:Element)=>{let style=styles.get(element);if(!style){style=view.getComputedStyle(element);styles.set(element,style);}return style;};
    const backgroundOf=(element:Element)=>{let style=backgrounds.get(element);if(!style){style=view.getComputedStyle(element,'::before');backgrounds.set(element,style);}return style;};
    const opacityOf=(element:Element)=>{let opacity=opacities.get(element);if(opacity===undefined){opacity=Number(styleOf(element).opacity);opacities.set(element,opacity);}return opacity;};
    const entering=(element:HTMLElement)=>{
      const cached=entrances.get(element);if(cached!==undefined)return cached;
      // A paused entrance is still eligible. Long delays need no polling:
      // allocate its existing geometry once, before opacity becomes visible.
      // Infinite animations, exits and permanent opacity-zero nodes remain
      // excluded, and offscreen/hidden/unused candidates are checked separately.
      const value=element.getAnimations().some(animation=>{
        if(animation.playState==='idle' || animation.playState==='finished' || !animation.effect)return false;
        const effect=animation.effect as KeyframeEffect;
        if(effect.target!==element || effect.pseudoElement)return false;
        const timing=effect.getComputedTiming();
        if(typeof timing.endTime!=='number' || !Number.isFinite(timing.endTime))return false;
        const keyframes=effect.getKeyframes?.();
        if(!keyframes)return false;
        const opacity=keyframes.filter(keyframe=>keyframe.opacity!==undefined);
        if(!opacity.length)return false;
        const options=effect.getTiming(),iterations=Number(options.iterations);
        const finalIteration=Math.max(0,Math.ceil(Number(options.iterationStart)+iterations)-1);
        const reverse=options.direction==='reverse' || options.direction==='alternate-reverse' && finalIteration%2===0 || options.direction==='alternate' && finalIteration%2===1;
        const towardStart=animation.playbackRate<0 ? !reverse : reverse;
        if(Number((towardStart ? opacity[0] : opacity.at(-1)!).opacity)<=0)return false;
        pendingEntrances.add(animation);return true;
      });
      entrances.set(element,value);return value;
    };
    const visible=(element:HTMLElement)=>{
      if(element instanceof HTMLSelectElement && !element.matches(':open'))return false;
      if(styleOf(element).visibility!=='visible')return false;
      const rect=element.getBoundingClientRect();let left=Math.max(0,rect.left),top=Math.max(0,rect.top),right=Math.min(view.innerWidth,rect.right),bottom=Math.min(view.innerHeight,rect.bottom);
      if(right<=left || bottom<=top)return false;
      for(let parent:HTMLElement|null=element;parent;parent=parent.parentElement){
        if(opacityOf(parent)===0 && !entering(parent))return false;
        if(parent===shell)break;
        if(parent===element)continue;
        let clip=clips.get(parent);
        if(!clip){
          const style=styleOf(parent),x=['hidden','clip','auto','scroll'].includes(style.overflowX),y=['hidden','clip','auto','scroll'].includes(style.overflowY);
          // An overflow-visible ancestor has no clip rectangle to measure.
          if(!x && !y){clip={rect:new DOMRect(),x,y};clips.set(parent,clip);continue;}
          clip={rect:parent.getBoundingClientRect(),x,y};clips.set(parent,clip);
        }
        if(clip.x){left=Math.max(left,clip.rect.left);right=Math.min(right,clip.rect.right);}
        if(clip.y){top=Math.max(top,clip.rect.top);bottom=Math.min(bottom,clip.rect.bottom);}
        if(right<=left || bottom<=top)return false;
      }
      return right>left && bottom>top;
    };
    const targets=candidates
      .filter(visible)
      .filter(element=>element.hasAttribute('data-lumi-glass') || element.matches(POPUPS) || !element.matches(CONTAINERS) || styleOf(element).getPropertyValue('--lumi-glass-surface').trim()==='1')
      // Chromium on macOS may expose the composited declaration only through
      // the WebKit alias while the standards property still reports `none`.
      // Keep both forms in the consumer probe so preview/runtime initialization
      // does not depend on the platform's computed-style alias.
      .filter(element=>{
        if(element.hasAttribute('data-lumi-glass') || element instanceof HTMLSelectElement)return true;
        const style=styleOf(element),background=backgroundOf(element) as CSSStyleDeclaration & {webkitBackdropFilter?: string};
        return style.backdropFilter!=='none' || style.webkitBackdropFilter!=='none' || background.backdropFilter!=='none' || background.webkitBackdropFilter!=='none';
      })
      .sort((a,b)=>priority(b)-priority(a))
      .slice(0,96);
    const snapshots:Snapshot[]=[];
    for(const element of targets){
      const style=styleOf(element),picker=element instanceof HTMLSelectElement,lens=element.matches('.segmented-thumb') || element.dataset.lumiGlass==='lens',surface=element.matches('.content-scroll, .model-card') || element.dataset.lumiGlass==='surface';
      const background=element.matches('.content-scroll') || element.dataset.lumiGlass==='background' ? backgroundOf(element) : undefined;
      const elementRadius=parseFloat(style.borderTopLeftRadius)||0;
      const radius=background ? parseFloat(background.borderTopLeftRadius)||elementRadius : elementRadius;
      let geometry=geometryCache.get(element);
      if(!picker && geometry && geometry.epoch===geometryEpoch && geometry.radius===radius && geometry.lens===lens && geometry.surface===surface){
        // Pseudo-element geometry can change with its containing block while
        // the element's own ResizeObserver box remains stable.
        const width=background ? parseFloat(background.width) : NaN,height=background ? parseFloat(background.height) : NaN;
        if((!Number.isFinite(width) || width===geometry.width) && (!Number.isFinite(height) || height===geometry.height)){
          snapshots.push({element,geometry});continue;
        }
      }
      let width=element.offsetWidth,height=element.offsetHeight,measuredRadius=radius;
      // The workspace background is anchored to main-area, not the scrolling
      // content box. Its map must use that painted box and rounded corners.
      if(background){
        width=parseFloat(background.width)||width;height=parseFloat(background.height)||height;
      }
      if(picker){
        const rects=[...element.options].map(option=>option.getBoundingClientRect()).filter(rect=>rect.width && rect.height);
        if(!rects.length)continue;
        const p=view.getComputedStyle(element,'::picker(select)');
        width=Math.max(...rects.map(r=>r.right))-Math.min(...rects.map(r=>r.left))+2*(parseFloat(p.paddingLeft)||0)+2*(parseFloat(p.borderLeftWidth)||0);
        height=Math.max(...rects.map(r=>r.bottom))-Math.min(...rects.map(r=>r.top))+2*(parseFloat(p.paddingTop)||0)+2*(parseFloat(p.borderTopWidth)||0);
        height=Math.min(height,parseFloat(p.maxHeight)||height);
        measuredRadius=parseFloat(p.borderTopLeftRadius)||0;
      }
      if(width<2 || height<2)continue;
      geometry={width,height,radius:measuredRadius,lens,surface,key:[Math.round(width),Math.round(height),measuredRadius,lens,surface].join(':'),epoch:geometryEpoch};
      geometryCache.set(element,geometry);snapshots.push({element,geometry});
    }
    // WRITE PHASE. Reading the next entry can no longer force style/layout
    // recalculation after the preceding entry's SVG or custom-property update.
    const live=new Set(snapshots.map(snapshot=>snapshot.element));
    for(const element of [...entries.keys()])if(!live.has(element))remove(element);
    syncObserved(candidates);
    for(const [animation,stop] of watchedEntrances){const target=(animation.effect as KeyframeEffect|null)?.target;if(animation.playState==='idle' || animation.playState==='finished' || !target || !shell.contains(target)){stop();watchedEntrances.delete(animation);}}
    for(const animation of pendingEntrances)if(!watchedEntrances.has(animation)){
      const complete=()=>{watchedEntrances.get(animation)?.();watchedEntrances.delete(animation);invalidate();};
      animation.addEventListener('finish',complete);animation.addEventListener('cancel',complete);
      watchedEntrances.set(animation,()=>{animation.removeEventListener('finish',complete);animation.removeEventListener('cancel',complete);});
    }
    for(const {element,geometry} of snapshots){
      const {width,height,radius,lens,surface,key}=geometry;
      let entry=entries.get(element);
      if(!entry){
        const filter=document.createElementNS(NS,'filter'),image=document.createElementNS(NS,'feImage'),transfer=document.createElementNS(NS,'feComponentTransfer'),displace=document.createElementNS(NS,'feDisplacementMap');
        const id='lumi-glass-'+(++sequence);filter.id=id;filter.setAttribute('x','0');filter.setAttribute('y','0');filter.setAttribute('width','1');filter.setAttribute('height','1');filter.setAttribute('color-interpolation-filters','sRGB');
        image.setAttribute('result','map');image.setAttribute('preserveAspectRatio','none');transfer.setAttribute('in','map');transfer.setAttribute('result','vectors');
        for(const channel of ['R','G']){const fn=document.createElementNS(NS,'feFunc'+channel);fn.setAttribute('type','linear');fn.setAttribute('slope','1');fn.setAttribute('intercept',String(-.5/255));transfer.append(fn);}
        displace.setAttribute('in','SourceGraphic');displace.setAttribute('in2','vectors');displace.setAttribute('xChannelSelector','R');displace.setAttribute('yChannelSelector','G');
        filter.append(image,transfer,displace);defs.append(filter);entry={filter,image,displace,key:'',id,original:element.style.getPropertyValue(PROPERTY),priority:element.style.getPropertyPriority(PROPERTY)};entries.set(element,entry);
      }
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
  const observer=new MutationObserver(records=>{
    let changed=false;
    for(const record of records){
      if(svg.contains(record.target) || record.target===baseline || record.type==='attributes' && record.attributeName==='style' && withoutReference(record.oldValue)===withoutReference((record.target as HTMLElement).getAttribute('style')))continue;
      changed=true;
      if(shell.contains(record.target) && (record.type==='childList' || record.type==='attributes' && (record.attributeName==='class' || record.attributeName==='data-lumi-glass')))candidatesDirty=true;
    }
    if(changed)invalidate();
  });
  observer.observe(shell,{subtree:true,childList:true,attributes:true,attributeOldValue:true,attributeFilter:['class','style','hidden','open','data-lumi-glass','data-interface','data-theme','data-interface-appearance','data-appearance-distortion','data-appearance-blur','data-appearance-transparency']});
  if(document.head)observer.observe(document.head,{subtree:true,childList:true,characterData:true,attributes:true,attributeFilter:['href','media','disabled']});
  const events=['click','keydown','input','change','toggle','transitionrun','transitionend','transitioncancel','animationstart','animationend','animationcancel'];
  for(const event of events)shell.addEventListener(event,invalidate,true);
  shell.addEventListener('scroll',schedule,true);
  document.head?.addEventListener('load',invalidate,true);
  view.addEventListener('resize',invalidate);reduced.addEventListener('change',invalidate);forced.addEventListener('change',invalidate);schedule();
  const dispose=()=>{if(disposed)return;disposed=true;if(frame)view.cancelAnimationFrame(frame);observer.disconnect();resize.disconnect();observed.clear();candidates=[];for(const stop of watchedEntrances.values())stop();watchedEntrances.clear();for(const event of events)shell.removeEventListener(event,invalidate,true);shell.removeEventListener('scroll',schedule,true);document.head?.removeEventListener('load',invalidate,true);view.removeEventListener('resize',invalidate);reduced.removeEventListener('change',invalidate);forced.removeEventListener('change',invalidate);for(const element of [...entries.keys()])remove(element);textures.clear();svg.remove();baseline.remove();if(originalRoot===null)shell.removeAttribute('data-lumi-glass-root');else shell.setAttribute('data-lumi-glass-root',originalRoot);installed.delete(shell);};
  installed.set(shell,dispose);return dispose;
}
