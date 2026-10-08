export const FONT_FAMILIES = {
  system: {label:'系统默认',css:'-apple-system, BlinkMacSystemFont, "Segoe UI Variable", "Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif'},
  sans: {label:'无衬线',css:'"Microsoft YaHei", "PingFang SC", "Noto Sans CJK SC", sans-serif'},
  serif: {label:'衬线',css:'"Noto Serif CJK SC", "Songti SC", SimSun, Georgia, serif'},
  mono: {label:'等宽',css:'"Cascadia Code", "SFMono-Regular", Consolas, "Noto Sans Mono CJK SC", monospace'},
} as const;
export type FontFamily = keyof typeof FONT_FAMILIES;
export interface Typography {fontSize:number;fontFamily:FontFamily;}
export const MIN_FONT_SIZE=11,MAX_FONT_SIZE=24;
export const DEFAULT_TYPOGRAPHY:Typography={fontSize:13,fontFamily:'system'};
export function validFontSize(value:unknown):value is number{return typeof value==='number' && Number.isInteger(value) && value>=MIN_FONT_SIZE && value<=MAX_FONT_SIZE;}
export function validFontFamily(value:unknown):value is FontFamily{return typeof value==='string' && Object.hasOwn(FONT_FAMILIES,value);}
export function normalizeTypography(value:unknown):Typography{
  const input=value && typeof value==='object' ? value as Partial<Typography> : {};
  return {fontSize:validFontSize(input.fontSize) ? input.fontSize : 13,fontFamily:validFontFamily(input.fontFamily) ? input.fontFamily : 'system'};
}
