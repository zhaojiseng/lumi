import type {Page,PreferencePatch,Preferences} from '../types';
/** Trusted main-process platform services; display policy and resources belong to plugins. */
export interface DesktopSurfaceEnvironment {
  root:string;preloadDirectory:string;devUrl?:string;platform:NodeJS.Platform;packaged:boolean;resourcesPath:string;smoke:boolean;
  preferences():Preferences;
  identity():string;
  theme():'light'|'dark';
  onThemeChanged(listener:()=>void):()=>void;
  patch(input:PreferencePatch):Promise<Preferences>;
  setEnabled(id:string,enabled:boolean):Promise<unknown>;
  navigate(page:Page):void;showMain():void;quit():void;isQuitting():boolean;
  log(source:string,message:string):void;
}
/** Lifecycle-owned desktop extension; no direct provider or React-page access. */
export interface DesktopSurfaceControl {
  changed():Promise<void>;
  refresh(force?:boolean):Promise<void>;
  smoke():Promise<Record<string,unknown>>;
}
