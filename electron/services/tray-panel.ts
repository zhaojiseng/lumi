import {BrowserWindow,ipcMain,screen} from 'electron';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import type {NativeMenuEvent} from './native-menu-bar';
import {parseTrayAction,trayPanelBounds,trayPanelBoundsAt,trustedTrayUrl,TRAY_CLOSE_DURATION,TRAY_PANEL_WIDTH,TRAY_RESIZE_DURATION,type TrayPanelState} from '../../shared/tray';
import {menuBarPanelHeight} from '../../shared/menu-bar';

/** Separate sandbox/preload: the tray can access formatted statistics and an action allowlist. */
export class TrayPanel {
  private win?:BrowserWindow;private loading?:Promise<void>;private opening?:Promise<void>;private closed=false;private lastHidden=0;private visibility=0;
  private phase:'hidden'|'visible'|'closing'='hidden';private hideReason='';private anchor?:Electron.Rectangle;
  private layout?:{height:number;reducedMotion:boolean};private layoutReady?:Promise<void>;private resolveLayout?:()=>void;
  private layoutTimer?:ReturnType<typeof setTimeout>;private closeTimer?:ReturnType<typeof setTimeout>;private resizeTimer?:ReturnType<typeof setTimeout>;private resizeTarget?:Electron.Rectangle;
  constructor(private options:{root:string;preload:string;devUrl?:string;state():TrayPanelState;event(e:NativeMenuEvent):void|Promise<void>;}){
    ipcMain.handle('lumi:traySnapshot',(event,payload)=>this.trusted(event) && payload===undefined ? {ok:true,data:this.snapshot()} : {ok:false,error:'请求来源不可信。'});
    ipcMain.handle('lumi:trayAction',async(event,payload)=>{
      if(!this.trusted(event))return {ok:false,error:'请求来源不可信。'};
      try{
        const action=parseTrayAction(payload);
        if(!action)throw new Error('用量面板操作无效。');
        if(action.type==='layout'){
          this.layout={height:action.height,reducedMotion:action.reducedMotion};this.resolveLayout?.();clearTimeout(this.layoutTimer);
          if(action.reducedMotion && this.phase==='closing')this.finishHide(this.visibility);
          else this.resize();
          return {ok:true};
        }
        if(action.type==='closeComplete'){this.finishHide(action.id);return {ok:true};}
        if(action.type==='close'){this.hide();return {ok:true};}
        if(action.type==='navigate' || action.type==='quit')this.hide();
        await this.options.event(action);return {ok:true};
      }catch{return {ok:false,error:'用量面板操作失败，请重试。'};}
    });
  }
  private url(){return this.options.devUrl ? new URL('tray.html',this.options.devUrl.endsWith('/') ? this.options.devUrl : this.options.devUrl+'/').href : pathToFileURL(path.join(this.options.root,'dist/tray.html')).href;}
  private snapshot():TrayPanelState{return {...this.options.state(),motion:{id:this.visibility,phase:this.phase}};}
  private trusted(event:Electron.IpcMainInvokeEvent){return !!this.win && !this.win.isDestroyed() && event.sender===this.win.webContents && event.senderFrame===event.sender.mainFrame && trustedTrayUrl(event.senderFrame?.url,this.url());}
  private async ensureWindow(){
    if(this.closed)throw new Error('Tray closed');if(this.loading)return this.loading;if(this.win && !this.win.isDestroyed())return;
    this.layout=undefined;this.layoutReady=new Promise(resolve=>{this.resolveLayout=resolve;});
    // WS_THICKFRAME adds a second Windows show animation and an invisible native frame.
    const win=new BrowserWindow({width:TRAY_PANEL_WIDTH,height:648,show:false,frame:false,thickFrame:false,hasShadow:false,transparent:true,backgroundColor:'#00000000',resizable:false,maximizable:false,minimizable:false,fullscreenable:false,skipTaskbar:true,alwaysOnTop:true,title:'Lumi · 用量',webPreferences:{preload:this.options.preload,nodeIntegration:false,contextIsolation:true,sandbox:true,webSecurity:true,devTools:false,backgroundThrottling:false}});this.win=win;
    win.webContents.setWindowOpenHandler(()=>({action:'deny'}));win.webContents.on('will-navigate',e=>e.preventDefault());
    win.webContents.session.setPermissionRequestHandler((_wc,_p,done)=>done(false));win.webContents.session.setPermissionCheckHandler(()=>false);
    win.on('blur',()=>this.hide('blur'));win.on('closed',()=>{if(this.win===win){this.cancelTimers();this.resolveLayout?.();this.win=undefined;this.phase='hidden';this.visibility++;}});
    const job=win.loadURL(this.url()).then(()=>{if(this.win===win && !this.closed && !this.layout)this.layoutTimer=setTimeout(()=>this.resolveLayout?.(),500);}).catch(e=>{if(!win.isDestroyed())win.destroy();throw e;}).finally(()=>{if(this.loading===job)this.loading=undefined;});this.loading=job;return job;
  }
  async toggle(anchor:Electron.Rectangle){
    if(this.closed)return;
    if(this.phase==='visible' && this.win?.isVisible()){this.hide('toggle');return;}
    // A click on the tray first blurs the popup; do not immediately open it again.
    if(this.hideReason==='blur' && Date.now()-this.lastHidden<200)return;
    // Concurrent first clicks share one load/show operation instead of replaying entry.
    if(this.opening)return this.opening;
    const request=++this.visibility;
    clearTimeout(this.closeTimer);
    const job=this.open(anchor,request).finally(()=>{if(this.opening===job)this.opening=undefined;});this.opening=job;return job;
  }
  private async open(anchor:Electron.Rectangle,request:number){
    await this.ensureWindow();await this.layoutReady;
    if(this.closed || request!==this.visibility || !this.win || this.win.isDestroyed())return;
    const target=anchor.width>0 && anchor.height>0 ? anchor : {...screen.getCursorScreenPoint(),width:1,height:1};
    const area=screen.getDisplayNearestPoint({x:Math.round(target.x+target.width/2),y:Math.round(target.y+target.height/2)}).workArea;
    this.anchor=target;
    this.cancelResize();this.win.setBounds(trayPanelBounds(target,area,{width:TRAY_PANEL_WIDTH,height:this.panelHeight()}));
    this.phase='visible';this.hideReason='';if(!this.win.isVisible())this.win.show();this.update();this.win.focus();this.options.event({type:'opened'});
  }
  private panelHeight(){const usage=this.options.state().usage;return this.layout?.height ?? menuBarPanelHeight(usage.contents,usage.models.length);}
  private cancelResize(){clearTimeout(this.resizeTimer);this.resizeTimer=undefined;this.resizeTarget=undefined;}
  private cancelTimers(){this.cancelResize();clearTimeout(this.closeTimer);clearTimeout(this.layoutTimer);}
  private resize(){
    const win=this.win;if(!win || win.isDestroyed() || !this.anchor || this.phase==='closing')return;
    const area=screen.getDisplayNearestPoint({x:Math.round(this.anchor.x+this.anchor.width/2),y:Math.round(this.anchor.y+this.anchor.height/2)}).workArea;
    const bounds=trayPanelBounds(this.anchor,area,{width:TRAY_PANEL_WIDTH,height:this.panelHeight()}),current=win.getBounds();
    const same=(a:Electron.Rectangle,b:Electron.Rectangle)=>a.x===b.x && a.y===b.y && a.width===b.width && a.height===b.height;
    const animated=this.phase==='visible' && !this.layout?.reducedMotion;
    if(animated && this.resizeTarget && same(this.resizeTarget,bounds))return;
    this.cancelResize();if(same(current,bounds))return;
    if(!animated){win.setBounds(bounds);return;}
    this.resizeTarget=bounds;const start=Date.now();
    const step=()=>{
      if(this.win!==win || win.isDestroyed() || this.phase!=='visible')return;
      const progress=Math.min(1,(Date.now()-start)/TRAY_RESIZE_DURATION);
      win.setBounds(trayPanelBoundsAt(current,bounds,progress));
      if(progress<1)this.resizeTimer=setTimeout(step,16);else {this.resizeTimer=undefined;this.resizeTarget=undefined;}
    };
    this.resizeTimer=setTimeout(step,16);
  }
  update(){
    if(!this.win || this.win.isDestroyed())return;
    this.resize();this.win.webContents.send('lumi:trayState',this.snapshot());
  }
  async smoke(){
    await this.ensureWindow();
    await this.layoutReady;this.win!.setSize(TRAY_PANEL_WIDTH,this.panelHeight());
    return this.win!.webContents.executeJavaScript(String.raw`(async()=>{
      await new Promise(r=>setTimeout(r,250));
      const state=await window.lumiTray.snapshot();let rejected=false;
      try{await window.lumiTray.action({type:'select',selection:{days:90,tool:'shell'}});}catch{rejected=true;}
      const switches=[...document.querySelectorAll('[role="radiogroup"]')];
      const sections=document.querySelector('.tray-sections');
      const element=document.querySelector('.tray-card'),card=element.getBoundingClientRect(),offset=new DOMMatrix(getComputedStyle(element).transform).m42;
      return {isolated:typeof require==='undefined' && typeof window.lumi==='undefined',state:!!state.usage.balance,rejected,equalHeight:switches.length===2 && switches[0].getBoundingClientRect().height===switches[1].getBoundingClientRect().height,layout:Math.abs(card.bottom-offset-innerHeight)<=1 && document.documentElement.scrollWidth<=innerWidth && (!sections || sections.scrollHeight<=sections.clientHeight+1)};
    })()`);
  }
  hide(reason='action'){
    if(this.phase==='closing')return;
    this.opening=undefined;const id=++this.visibility;this.cancelResize();if(!this.win?.isVisible())return;
    this.lastHidden=Date.now();this.hideReason=reason;this.phase='closing';this.update();
    if(this.layout?.reducedMotion)this.finishHide(id);
    else this.closeTimer=setTimeout(()=>this.finishHide(id),TRAY_CLOSE_DURATION+150);
  }
  private finishHide(id:number){
    if(this.phase!=='closing' || id!==this.visibility || !this.win || this.win.isDestroyed())return;
    clearTimeout(this.closeTimer);this.win.hide();this.phase='hidden';this.update();this.options.event({type:'closed'});
  }
  close(){this.closed=true;this.visibility++;this.cancelTimers();this.resolveLayout?.();ipcMain.removeHandler('lumi:traySnapshot');ipcMain.removeHandler('lumi:trayAction');this.win?.destroy();this.win=undefined;}
}
