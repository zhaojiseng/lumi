/** Only numeric color channels cross the surface IPC boundary, never plugin CSS or resource URLs. */
export const SURFACE_COLOR_KEYS=['panel','panel-strong','panel-soft','text','text-secondary','text-muted','accent','accent-hover','accent-soft','border','line','hover','hover-strong','blue','blue-soft','purple','purple-soft','orange','orange-soft','red','red-soft'] as const;
export type SurfaceColorKey=typeof SURFACE_COLOR_KEYS[number];
export type SurfaceColor=[number,number,number,number];
export type SurfacePalette=Record<SurfaceColorKey,SurfaceColor>;
export interface SurfaceTheme {interfaceId:string;mode:'light'|'dark';palette:SurfacePalette;}
export function parseSurfaceTheme(value:unknown):SurfaceTheme {
  if(!value || typeof value!=='object' || Array.isArray(value))throw new Error('界面配色无效。');
  const v=value as Record<string,unknown>,palette=v.palette as Record<string,unknown>|undefined;
  if(Object.keys(v).sort().join(',')!=='interfaceId,mode,palette' || typeof v.interfaceId!=='string' || !/^(?:interface\.default|extension\.[a-z][a-z0-9-]{0,39}\.[a-z][a-z0-9-]{0,39})$/.test(v.interfaceId) || (v.mode!=='light' && v.mode!=='dark') || !palette || typeof palette!=='object' || Array.isArray(palette) || Object.keys(palette).length!==SURFACE_COLOR_KEYS.length)throw new Error('界面配色无效。');
  const colors={} as SurfacePalette;
  for(const key of SURFACE_COLOR_KEYS){
    const color=palette[key];
    if(!Array.isArray(color) || color.length!==4 || !color.every((n,i)=>typeof n==='number' && Number.isFinite(n) && n>=0 && n<=(i===3 ? 1 : 255) && (i===3 || Number.isInteger(n))))throw new Error('界面颜色无效。');
    colors[key]=[...color] as SurfaceColor;
  }
  return {interfaceId:v.interfaceId,mode:v.mode as SurfaceTheme['mode'],palette:colors};
}
export function surfacePaletteStyle(palette?:SurfacePalette):Record<string,string>|undefined {
  return palette ? Object.fromEntries(SURFACE_COLOR_KEYS.map(key=>{const [r,g,b,a]=palette[key];return ['--'+key,`rgba(${r},${g},${b},${a})`];})) : undefined;
}
/** Outdated interface or system-theme snapshots cannot recolor another active interface. */
export class SurfaceThemeState {
  private value?:SurfaceTheme;
  constructor(private current:()=>Pick<SurfaceTheme,'interfaceId'|'mode'>){}
  clear(){this.value=undefined;}
  update(input:SurfaceTheme){
    const next=parseSurfaceTheme(input),scope=this.current();
    if(next.interfaceId!==scope.interfaceId || next.mode!==scope.mode)return false;
    const changed=JSON.stringify(next)!==JSON.stringify(this.value);this.value=next;return changed;
  }
  palette(){const scope=this.current();return this.value?.interfaceId===scope.interfaceId && this.value.mode===scope.mode ? this.value.palette : undefined;}
}
