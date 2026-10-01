import {BrowserWindow,ipcMain,screen} from 'electron';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import type {NativeMenuEvent} from './native-menu-bar';
import {parseTrayAction,trayPanelBounds,trustedTrayUrl,type TrayPanelState} from '../../shared/tray';
import {menuBarPanelHeight,type NativeMenuBarState} from '../../shared/menu-bar';

/** Separate sandbox/preload: the tray can access formatted statistics and an action allowlist. */
export class TrayPanel {
  private win?:BrowserWindow;private loading?:Promise<void>;private closed=false;private lastHidden=0;private visibility=0;
  private anchor?:Electron.Rectangle;private previousUsage?:NativeMenuBarState;
  constructor(private options:{root:string;preload:string;devUrl?:string;state():TrayPanelState;event(e:NativeMenuEvent):void|Promise<void>;}){
    ipcMain.handle('lumi:traySnapshot',(event,payload)=>this.trusted(event) && payload===undefined ? {ok:true,data:this.options.state()} : {ok:false,error:'请求来源不可信。'});
    ipcMain.handle('lumi:trayAction',async(event,payload)=>{
      if(!this.trusted(event))return {ok:false,error:'请求来源不可信。'};
      try{
        const action=parseTrayAction(payload);
        if(!action)throw new Error('用量面板操作无效。');
        if(action.type==='close'){this.hide();return {ok:true};}
        if(action.type==='navigate' || action.type==='quit')this.hide();
        await this.options.event(action);return {ok:true};
      }catch{return {ok:false,error:'用量面板操作失败，请重试。'};}
    });
  }
  private url(){return this.options.devUrl ? new URL('tray.html',this.options.devUrl.endsWith('/') ? this.options.devUrl : this.options.devUrl+'/').href : pathToFileURL(path.join(this.options.root,'dist/tray.html')).href;}
  private trusted(event:Electron.IpcMainInvokeEvent){return !!this.win && !this.win.isDestroyed() && event.sender===this.win.webContents && event.senderFrame===event.sender.mainFrame && trustedTrayUrl(event.senderFrame?.url,this.url());}
  private async ensureWindow(){
    if(this.closed)throw new Error('Tray closed');if(this.loading)return this.loading;if(this.win && !this.win.isDestroyed())return;
    const win=new BrowserWindow({width:396,height:648,show:false,frame:false,transparent:true,backgroundColor:'#00000000',resizable:false,maximizable:false,minimizable:false,fullscreenable:false,skipTaskbar:true,alwaysOnTop:true,title:'Lumi · 用量',webPreferences:{preload:this.options.preload,nodeIntegration:false,contextIsolation:true,sandbox:true,webSecurity:true,devTools:false}});this.win=win;
    win.webContents.setWindowOpenHandler(()=>({action:'deny'}));win.webContents.on('will-navigate',e=>e.preventDefault());
    win.webContents.session.setPermissionRequestHandler((_wc,_p,done)=>done(false));win.webContents.session.setPermissionCheckHandler(()=>false);
    win.on('blur',()=>this.hide());win.on('closed',()=>{if(this.win===win)this.win=undefined;});
    const job=win.loadURL(this.url()).then(()=>{}).catch(e=>{win.destroy();throw e;}).finally(()=>{if(this.loading===job)this.loading=undefined;});this.loading=job;return job;
  }
  async toggle(anchor:Electron.Rectangle){
    if(this.win?.isVisible()){this.hide();return;}
    // A click on the tray first blurs the popup; do not immediately open it again.
    if(Date.now()-this.lastHidden<200)return;
    const request=++this.visibility;
    await this.ensureWindow();if(this.closed || request!==this.visibility || !this.win || this.win.isDestroyed())return;
    const target=anchor.width>0 && anchor.height>0 ? anchor : {...screen.getCursorScreenPoint(),width:1,height:1};
    const area=screen.getDisplayNearestPoint({x:Math.round(target.x+target.width/2),y:Math.round(target.y+target.height/2)}).workArea;
    this.anchor=target;
    this.win.setBounds(trayPanelBounds(target,area,{width:396,height:this.panelHeight(this.options.state().usage)}));this.update();this.win.show();this.win.focus();this.options.event({type:'opened'});
  }
  private panelHeight(usage:NativeMenuBarState){
    const previous=this.previousUsage,retained=['idle','loading'].includes(usage.phase) && !!previous?.viewKey && previous.viewKey===usage.viewKey;
    const height=menuBarPanelHeight(usage.contents,retained ? previous.models.length : usage.models.length);
    if(!retained)this.previousUsage=usage;
    return height;
  }
  update(){
    if(!this.win || this.win.isDestroyed())return;
    const state=this.options.state(),height=this.panelHeight(state.usage);
    if(this.anchor){
      const area=screen.getDisplayNearestPoint({x:Math.round(this.anchor.x+this.anchor.width/2),y:Math.round(this.anchor.y+this.anchor.height/2)}).workArea;
      const bounds=trayPanelBounds(this.anchor,area,{width:396,height});
      const current=this.win.getBounds();
      if(['x','y','width','height'].some(key=>current[key as keyof Electron.Rectangle]!==bounds[key as keyof Electron.Rectangle]))this.win.setBounds(bounds);
    }
    this.win.webContents.send('lumi:trayState',state);
  }
  async smoke(){
    await this.ensureWindow();
    this.win!.setSize(396,this.panelHeight(this.options.state().usage));
    return this.win!.webContents.executeJavaScript(String.raw`(async()=>{
      await new Promise(r=>setTimeout(r,250));
      const state=await window.lumiTray.snapshot();let rejected=false;
      try{await window.lumiTray.action({type:'select',selection:{days:90,tool:'shell'}});}catch{rejected=true;}
      const switches=[...document.querySelectorAll('[role="radiogroup"]')];
      const sections=document.querySelector('.tray-sections');
      return {isolated:typeof require==='undefined' && typeof window.lumi==='undefined',state:!!state.usage.balance,rejected,equalHeight:switches.length===2 && switches[0].getBoundingClientRect().height===switches[1].getBoundingClientRect().height,layout:document.querySelector('.tray-card').getBoundingClientRect().bottom<=innerHeight && document.documentElement.scrollWidth<=innerWidth && (!sections || sections.scrollHeight<=sections.clientHeight+1)};
    })()`);
  }
  hide(){this.visibility++;if(!this.win?.isVisible())return;this.lastHidden=Date.now();this.win.hide();this.options.event({type:'closed'});}
  close(){this.closed=true;this.visibility++;ipcMain.removeHandler('lumi:traySnapshot');ipcMain.removeHandler('lumi:trayAction');this.win?.destroy();this.win=undefined;}
}
