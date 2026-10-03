import type {BrowserWindow} from 'electron';

type CloseWindow=Pick<BrowserWindow,'isDestroyed'|'isVisible'|'getOpacity'|'setOpacity'>;
export class WindowCloseAnimation {
  private timer:ReturnType<typeof setInterval>|undefined;
  private opacity=1;
  private running=false;
  constructor(private window:CloseWindow,private reducedMotion:()=>boolean,private platform:NodeJS.Platform=process.platform){}
  run(action:()=>void){
    if(this.running)return;
    if(this.window.isDestroyed() || !this.window.isVisible() || !['win32','darwin'].includes(this.platform)){action();return;}
    try{if(this.reducedMotion()){action();return;}this.opacity=this.window.getOpacity();}catch{action();return;}
    this.running=true;
    const start=Date.now();
    const finish=()=>{
      this.dispose();
      action();
      if(!this.window.isDestroyed())try{this.window.setOpacity(this.opacity);}catch{}
    };
    this.timer=setInterval(()=>{
      if(this.window.isDestroyed()){this.dispose();return;}
      const progress=Math.min(1,(Date.now()-start)/160);
      if(progress>=1){finish();return;}
      try{this.window.setOpacity(this.opacity*(1-progress*progress));}catch{finish();}
    },16);
  }
  dispose(){clearInterval(this.timer);this.timer=undefined;this.running=false;}
}
