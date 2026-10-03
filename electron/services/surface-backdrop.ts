import {release} from 'node:os';
import type {BrowserWindowConstructorOptions} from 'electron';

/** Layered transparent windows disable Windows' native rounded corners. */
export function surfaceBackdrop(platform:NodeJS.Platform=process.platform,version=release()):Pick<BrowserWindowConstructorOptions,'transparent'|'thickFrame'|'roundedCorners'|'backgroundMaterial'|'backgroundColor'> {
  const [major,,build]=version.split('.').map(Number);
  const acrylic=platform==='win32' && (major>10 || major===10 && build>=22621);
  return acrylic
    ? {transparent:false,thickFrame:true,roundedCorners:true,backgroundMaterial:'acrylic',backgroundColor:'#00000000'}
    : {transparent:true,thickFrame:false,backgroundColor:'#00000000'};
}
