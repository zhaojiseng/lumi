import {SURFACE_COLOR_KEYS,type SurfacePalette,type SurfaceTheme} from '../../shared/surface-theme';
import {bridge} from '../bridge';

/** Resolve semantic tokens through Chromium so light-dark(), color-mix() and plugin colors all agree. */
export function syncSurfaceTheme(shell:HTMLElement){
  if(!bridge.syncSurfaceTheme)return;
  const canvas=document.createElement('canvas');canvas.width=canvas.height=1;
  const context=canvas.getContext('2d',{willReadFrequently:true});if(!context)return;
  const probe=document.createElement('span');probe.hidden=true;shell.append(probe);
  const palette={} as SurfacePalette;
  try{for(const key of SURFACE_COLOR_KEYS){
    probe.style.color=`var(--${key})`;
    context.clearRect(0,0,1,1);context.fillStyle=getComputedStyle(probe).color;context.fillRect(0,0,1,1);
    const [r,g,b,a]=context.getImageData(0,0,1,1).data;palette[key]=[r,g,b,a/255];
  }}finally{probe.remove();}
  const mode=shell.dataset.theme==='dark' ? 'dark' : 'light';
  const input:SurfaceTheme={interfaceId:shell.dataset.interface || 'interface.default',mode,palette};
  void bridge.syncSurfaceTheme(input).catch(()=>{});
}
