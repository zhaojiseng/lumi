import {createRequire} from 'node:module';
import path from 'node:path';
import type {BrowserWindow} from 'electron';
import type {WidgetState} from '../../shared/widget';

export interface NativeWidgetGlass {
  apply(handle:Buffer,dark:boolean):boolean;
  remove(handle:Buffer):void;
}

export function loadWidgetGlass(root:string,resources=process.resourcesPath):NativeWidgetGlass {
  const require=createRequire(path.join(root,'package.json'));
  const file=root.endsWith('.asar') ? path.join(resources,'native/lumi-widget-glass.node') : path.join(root,'dist-native/lumi-widget-glass.node');
  return require(file) as NativeWidgetGlass;
}

/** This native handle stays in main; the widget receives only a material name. */
export class MacWidgetMaterial {
  private native?:NativeWidgetGlass;
  private attempted=false;
  private attached=false;
  private key='';
  private material?:WidgetState['material'];
  constructor(private win:Pick<BrowserWindow,'getNativeWindowHandle'|'setVibrancy'>,private load:()=>NativeWidgetGlass){}
  sync(theme:WidgetState['theme'],reducedTransparency:boolean):WidgetState['material'] {
    const key=theme+':'+reducedTransparency;
    if(this.key===key)return this.material;
    this.key=key;
    if(reducedTransparency){
      this.remove();this.win.setVibrancy(null);return this.material='opaque';
    }
    if(!this.attempted){this.attempted=true;try{this.native=this.load();}catch{}}
    this.win.setVibrancy(null);
    try{
      if(this.native?.apply(this.win.getNativeWindowHandle(),theme==='dark')){
        this.attached=true;return this.material='liquid-glass';
      }
    }catch{this.remove();this.native=undefined;}
    this.win.setVibrancy('hud');return this.material='vibrancy';
  }
  private remove(){
    if(this.attached){try{this.native?.remove(this.win.getNativeWindowHandle());}catch{}this.attached=false;}
  }
  dispose(){this.remove();this.native=undefined;this.key='';this.material=undefined;}
}
