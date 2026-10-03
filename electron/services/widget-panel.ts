import {BrowserWindow,ipcMain,screen} from 'electron';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import {WIDGET_WIDTH,WIDGET_HEIGHT,parseWidgetAction,type WidgetAction,type WidgetState} from '../../shared/widget';
import {surfaceBackdrop} from './surface-backdrop';
export function widgetBounds(position:{x:number;y:number}|null,area:{x:number;y:number;width:number;height:number}){
  const width=Math.min(WIDGET_WIDTH,area.width),height=Math.min(WIDGET_HEIGHT,area.height),clamp=(n:number,min:number,max:number)=>Math.round(Math.min(Math.max(n,min),Math.max(min,max)));
  return {x:clamp(position?.x ?? area.x+area.width-width-20,area.x,area.x+area.width-width),y:clamp(position?.y ?? area.y+area.height-height-20,area.y,area.y+area.height-height),width,height};
}
/** The persistent floating window gets only formatted statistics and three validated actions. */
export class WidgetPanel {
  private backdrop=surfaceBackdrop();
  private win?:BrowserWindow;private loading?:Promise<void>;private wanted=false;private closed=false;private moveTimer?:ReturnType<typeof setTimeout>;
  constructor(private options:{root:string;preload:string;devUrl?:string;state():WidgetState;event(e:WidgetAction):void|Promise<void>;moved?(position:{x:number;y:number}):void;}){
    ipcMain.handle('lumi:widgetSnapshot',(event,payload)=>this.trusted(event) && payload===undefined ? {ok:true,data:this.snapshot()} : {ok:false,error:'请求来源不可信。'});
    ipcMain.handle('lumi:widgetAction',async(event,payload)=>{if(!this.trusted(event))return {ok:false,error:'请求来源不可信。'};const action=parseWidgetAction(payload);if(!action)return {ok:false,error:'浮窗操作无效。'};try{await this.options.event(action);return {ok:true};}catch{return {ok:false,error:'浮窗操作失败，请重试。'};}});
  }
  private url(){return this.options.devUrl ? new URL('widget.html',this.options.devUrl.endsWith('/') ? this.options.devUrl : this.options.devUrl+'/').href : pathToFileURL(path.join(this.options.root,'dist/widget.html')).href;}
  private snapshot():WidgetState{return {...this.options.state(),material:this.backdrop.backgroundMaterial==='acrylic' ? 'acrylic' : undefined};}
  private trusted(e:Electron.IpcMainInvokeEvent){return !!this.win && !this.win.isDestroyed() && e.sender===this.win.webContents && e.senderFrame===e.sender.mainFrame && e.senderFrame?.url.split('#')[0]===this.url();}
  private async ensure(){
    if(this.closed)throw new Error('Widget closed');if(this.loading)return this.loading;if(this.win && !this.win.isDestroyed())return;
    const win=new BrowserWindow({width:WIDGET_WIDTH,height:WIDGET_HEIGHT,show:false,frame:false,hasShadow:false,...this.backdrop,resizable:false,maximizable:false,minimizable:false,fullscreenable:false,skipTaskbar:true,alwaysOnTop:true,title:'Lumi · 浮窗挂件',webPreferences:{preload:this.options.preload,nodeIntegration:false,contextIsolation:true,sandbox:true,webSecurity:true,devTools:false,backgroundThrottling:false}});this.win=win;
    win.setAlwaysOnTop(true,'floating');if(process.platform==='darwin')win.setVisibleOnAllWorkspaces(true,{visibleOnFullScreen:true});
    win.webContents.setWindowOpenHandler(()=>({action:'deny'}));win.webContents.on('will-navigate',e=>e.preventDefault());win.webContents.session.setPermissionRequestHandler((_w,_p,done)=>done(false));win.webContents.session.setPermissionCheckHandler(()=>false);
    win.on('moved',()=>{clearTimeout(this.moveTimer);this.moveTimer=setTimeout(()=>{if(!win.isDestroyed() && this.wanted){const {x,y}=win.getBounds();this.options.moved?.({x,y});}},250);});
    win.on('close',event=>{if(this.closed)return;event.preventDefault();this.wanted=false;win.hide();void Promise.resolve(this.options.event({type:'close'})).catch(()=>{});});
    win.on('closed',()=>{if(this.win===win)this.win=undefined;});
    const job=win.loadURL(this.url()).catch(e=>{if(!win.isDestroyed())win.destroy();throw e;}).finally(()=>{if(this.loading===job)this.loading=undefined;});this.loading=job;return job;
  }
  async setVisible(enabled:boolean,position:{x:number;y:number}|null){
    this.wanted=enabled;if(!enabled){this.win?.hide();return;}await this.ensure();if(!this.wanted || this.closed || !this.win || this.win.isDestroyed())return;
    if(!this.win.isVisible()){const display=position ? screen.getDisplayNearestPoint(position) : screen.getPrimaryDisplay();this.win.setBounds(widgetBounds(position,display.workArea));this.update();this.win.showInactive();}
  }
  update(){if(this.win && !this.win.isDestroyed())this.win.webContents.send('lumi:widgetState',this.snapshot());}
  /** Release the renderer on plugin disable; the host's restricted handlers remain reusable. */
  suspend(){this.wanted=false;clearTimeout(this.moveTimer);this.win?.destroy();this.win=undefined;}
  async smoke(){
    await this.ensure();const win=this.win!;
    const result=await win.webContents.executeJavaScript(String.raw`(async()=>{await new Promise(r=>setTimeout(r,150));const s=await window.lumiWidget.snapshot();let rejected=false;try{await window.lumiWidget.action({type:'shell',command:'invalid'});}catch{rejected=true;}const drag=document.querySelector('.widget-header');return {isolated:typeof require==='undefined' && typeof window.lumi==='undefined' && typeof window.lumiTray==='undefined',state:typeof s.balance==='string',rejected,layout:document.documentElement.scrollWidth<=innerWidth && document.documentElement.scrollHeight<=innerHeight,drag:!!drag && getComputedStyle(drag).getPropertyValue('-webkit-app-region')==='drag'};})()`);
    win.close();return {...result,nativeCloseHidden:!win.isDestroyed() && !win.isVisible() && !this.wanted};
  }
  close(){this.closed=true;this.wanted=false;clearTimeout(this.moveTimer);ipcMain.removeHandler('lumi:widgetSnapshot');ipcMain.removeHandler('lumi:widgetAction');this.win?.destroy();this.win=undefined;}
}
