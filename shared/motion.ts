export const DATA_REFRESH_ANIMATIONS=['slide-up','slide-down','blur','fade','scale','none'] as const;
export type DataRefreshAnimation=typeof DATA_REFRESH_ANIMATIONS[number];
export function refreshAnimation(value:unknown):DataRefreshAnimation {return DATA_REFRESH_ANIMATIONS.includes(value as DataRefreshAnimation) ? value as DataRefreshAnimation : 'slide-up';}
export function refreshKeyframes(animation:DataRefreshAnimation):Keyframe[] {
  if(animation==='slide-up')return [{opacity:0,transform:'translateY(10px)'},{opacity:1,transform:'translateY(0)'}];
  if(animation==='slide-down')return [{opacity:0,transform:'translateY(-10px)'},{opacity:1,transform:'translateY(0)'}];
  if(animation==='blur')return [{opacity:.45,filter:'blur(5px)'},{opacity:1,filter:'blur(0)'}];
  if(animation==='scale')return [{opacity:0,transform:'scale(.96)'},{opacity:1,transform:'scale(1)'}];
  return [{opacity:0},{opacity:1}];
}
export function refreshExitKeyframes(animation:DataRefreshAnimation):Keyframe[] {
  if(animation==='slide-up')return [{opacity:1,transform:'translateY(0)'},{opacity:0,transform:'translateY(-8px)'}];
  if(animation==='slide-down')return [{opacity:1,transform:'translateY(0)'},{opacity:0,transform:'translateY(8px)'}];
  if(animation==='blur')return [{opacity:1,filter:'blur(0)'},{opacity:.2,filter:'blur(5px)'}];
  if(animation==='scale')return [{opacity:1,transform:'scale(1)'},{opacity:0,transform:'scale(.96)'}];
  return [{opacity:1},{opacity:0}];
}
