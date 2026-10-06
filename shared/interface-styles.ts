export const BACKGROUND_INTERFACE_ID='interface.background';
export const BACKGROUND_FITS=['stretch','contain','cover','natural'] as const;
export type BackgroundFit=typeof BACKGROUND_FITS[number];
export interface UserBackground {image:string;name:string;fit:BackgroundFit;}
export const DEFAULT_BACKGROUND:UserBackground={image:'',name:'',fit:'cover'};
export const MAX_BACKGROUND_LENGTH=3*1024*1024;
export const styleId=/^(?:interface\.(?:default|background)|extension\.[a-z][a-z0-9-]{0,39}\.[a-z][a-z0-9-]{0,39})$/;
export function validBackgroundImage(image:string){return image==='' || image.length<=MAX_BACKGROUND_LENGTH && /^data:image\/webp;base64,[A-Za-z0-9+/]+={0,2}$/.test(image);}
export function normalizeBackground(input:unknown):UserBackground{
  const value=input && typeof input==='object' ? input as Partial<UserBackground> : {};
  return {image:typeof value.image==='string' && validBackgroundImage(value.image) ? value.image : '',name:typeof value.name==='string' ? value.name.slice(0,120) : '',fit:BACKGROUND_FITS.includes(value.fit as BackgroundFit) ? value.fit! : 'cover'};
}
export function normalizeInterfacePriorities(input:unknown):Record<string,number>{
  if(!input || typeof input!=='object' || Array.isArray(input))return {};
  return Object.fromEntries(Object.entries(input).filter(([id,value])=>styleId.test(id) && Number.isSafeInteger(value) && Math.abs(value as number)<=1000).slice(0,66)) as Record<string,number>;
}
export interface StyleCandidate {id:string;enabled:boolean;priority:number;}
export function validInterfaceOrder(value:unknown):value is string[]{return Array.isArray(value) && value.length>=2 && value.length<=66 && new Set(value).size===value.length && value.every(id=>typeof id==='string' && styleId.test(id));}
/** A deterministic winner preserves enabled alternatives for automatic fallback. */
export function preferredInterface(candidates:readonly StyleCandidate[],priorities:Record<string,number>={}){
  return candidates.filter(style=>style.enabled).sort((a,b)=>(priorities[b.id] ?? b.priority)-(priorities[a.id] ?? a.priority) || a.id.localeCompare(b.id))[0]?.id || 'interface.default';
}
