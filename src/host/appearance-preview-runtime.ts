import {installGlassRefraction} from './glass-refraction';

// This is the only script allowed by the preview's CSP. It accepts no plugin
// messages or external code and runs inside an opaque, unprivileged document.
const shell=document.querySelector<HTMLElement>('.desktop-shell');
if(shell){
  let dispose=installGlassRefraction(shell);
  addEventListener('pagehide',()=>dispose());
  addEventListener('pageshow',()=>{dispose=installGlassRefraction(shell);});
}
