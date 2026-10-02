import path from 'node:path';
import {createHash} from 'node:crypto';
import {Tray,Menu,nativeImage} from 'electron';
import {MenuBarService,menuBarTemplate} from '../../electron/services/menu-bar';
import {NativeMenuBar,type NativeMenuEvent} from '../../electron/services/native-menu-bar';
import {TrayPanel} from '../../electron/services/tray-panel';
import {menuBarSelection,nativeMenuBarState,menuBarNeedsDetails} from '../../shared/menu-bar';
import {refreshSeconds} from '../../shared/refresh';
import type {WorkbenchPresentationCapability} from '../../shared/contracts/desktop-projection';
import type {DesktopSurfaceEnvironment,DesktopSurfaceControl} from '../../shared/contracts/desktop-surface';

export function trayImage(platform:NodeJS.Platform,root:string){
  if(platform!=='darwin')return nativeImage.createFromPath(path.join(root,'public/icon.png')).resize({width:20,height:20});
  const width=36,bitmap=Buffer.alloc(width*width*4);
  for(let y=0;y<width;y++)for(let x=0;x<width;x++){
    const vertical=Math.hypot(x-11,y-Math.max(8,Math.min(25,y)))<=2.5,horizontal=Math.hypot(x-Math.max(11,Math.min(27,x)),y-25)<=2.5,dot=Math.hypot(x-26,y-10)<=4;
    if(vertical || horizontal || dot)bitmap.fill(255,(y*width+x)*4,(y*width+x)*4+4);
  }
  return nativeImage.createFromBitmap(bitmap,{width,height:width,scaleFactor:2});
}
/** Owns platform presentation, native-helper fallback and on-demand refresh. */
export class TrayRuntime implements DesktopSurfaceControl {
  private tray?:Tray;private panel?:TrayPanel;private native?:NativeMenuBar;private menu?:Electron.Menu;private open=false;private closed=false;private timer?:ReturnType<typeof setInterval>;private usage:MenuBarService;private stopTheme:()=>void;
  constructor(private env:DesktopSurfaceEnvironment,projection:WorkbenchPresentationCapability){
    this.usage=new MenuBarService({summaryTtl:()=>refreshSeconds(env.preferences().menuBarRefreshInterval)*1000 || 60000,identity:()=>this.identity(),load:force=>projection.loadMenu(force),loadDetails:()=>projection.loadMenuDetails(),changed:()=>this.update()});
    this.stopTheme=env.onThemeChanged(()=>this.update());
  }
  private selected(){const p=this.env.preferences();return menuBarSelection(p.viewSelections[p.activeSiteId]);}
  private identity(){const p=this.env.preferences();return createHash('sha256').update(JSON.stringify([this.env.identity(),this.selected(),p.menuBarTotalsRange,p.menuBarChartRange,p.menuBarContents.includes('chart'),new Date().toLocaleDateString('sv-SE'),p.managedTokens,p.bindings])).digest('hex');}
  private state=()=>({...nativeMenuBarState(this.usage.snapshot(),this.selected(),this.env.preferences().menuBarContents),theme:this.env.theme(),palette:this.env.palette?.(),viewKey:this.identity()});
  private actions={navigate:(page:Parameters<DesktopSurfaceEnvironment['navigate']>[0])=>this.env.navigate(page),refresh:()=>{void this.refresh(true);},quit:()=>this.env.quit()};
  private update(){if(this.closed)return;this.native?.update();this.panel?.update();if(this.menu){const next=menuBarTemplate(this.usage.snapshot(),this.actions,this.env.preferences().menuBarContents);if(this.menu.items.length===next.length)this.menu.items.forEach((item,index)=>{if(next[index]?.label!==undefined)item.label=next[index].label!;item.enabled=next[index]?.enabled!==false;});}}
  private event=async(event:NativeMenuEvent)=>{
    if(this.closed)return;
    if(event.type==='opened'){this.open=true;await this.refresh();}
    else if(event.type==='closed')this.open=false;
    else if(event.type==='refresh')await this.refresh(true);
    else if(event.type==='navigate')this.env.navigate(event.page);
    else if(event.type==='quit')this.env.quit();
    else if(event.type==='select'){const p=this.env.preferences();await this.env.patch({selection:{siteId:p.activeSiteId,values:{'menuBar.days':event.selection.days,'menuBar.tool':event.selection.tool}}});await this.changed();await this.refresh();}
  };
  async start(){
    if(this.env.platform==='darwin'){
      this.native=new NativeMenuBar({executable:this.env.packaged ? path.join(this.env.resourcesPath,'native/lumi-menu-bar') : path.join(this.env.root,'dist-native/lumi-menu-bar'),state:this.state,event:event=>{void this.event(event).catch(()=>this.env.log('菜单栏','用量菜单操作暂不可用。'));},failed:()=>{if(this.closed)return;this.open=false;this.env.log('菜单栏','原生用量面板不可用，启用系统文字菜单。');this.fallback();}});
      if(!this.env.smoke)void this.native.start().then(ok=>{if(!ok && !this.closed)this.fallback();});
    }else if(!this.env.smoke){
      this.tray=new Tray(trayImage(this.env.platform,this.env.root));this.tray.setToolTip('Lumi · 余额与用量');
      this.tray.setContextMenu(Menu.buildFromTemplate([{label:'打开 Lumi',click:()=>this.env.showMain()},{label:'用量分析',click:()=>this.env.navigate('usage')},{label:'显示 / 隐藏浮窗挂件',click:()=>{void this.env.setEnabled('surface.widget',!this.env.preferences().widgetEnabled).catch(()=>this.env.log('浮窗','浮窗暂未能打开。'));}},{label:'刷新用量',click:()=>void this.refresh(true)},{type:'separator'},{label:'退出 Lumi',click:()=>this.env.quit()}]));
      if(this.env.platform==='win32'){this.panel=this.createPanel();this.tray.on('click',()=>{const tray=this.tray;if(tray && !this.closed)void this.panel?.toggle(tray.getBounds()).catch(()=>this.env.log('托盘','用量面板暂不可用。'));});}
      this.tray.on('double-click',()=>{this.panel?.hide();this.env.showMain();});
    }
    await this.changed();
  }
  private createPanel(){return new TrayPanel({root:this.env.root,preload:path.join(this.env.preloadDirectory,'tray-preload.cjs'),devUrl:this.env.devUrl,state:()=>({usage:this.state(),theme:this.env.theme(),palette:this.env.palette?.()}),event:this.event});}
  private fallback(){
    if(this.tray || this.closed || this.env.isQuitting() || this.env.smoke)return;
    this.tray=new Tray(trayImage(this.env.platform,this.env.root));this.tray.setToolTip('Lumi · 余额与用量');this.tray.setIgnoreDoubleClickEvents(true);
    const open=()=>{if(this.menu || this.closed)return;this.open=true;this.menu=Menu.buildFromTemplate(menuBarTemplate(this.usage.snapshot(),this.actions,this.env.preferences().menuBarContents));this.menu.once('menu-will-close',()=>{this.menu=undefined;this.open=false;});void this.refresh();this.tray?.popUpContextMenu(this.menu);};
    this.tray.on('click',open);this.tray.on('right-click',open);
  }
  async changed(){clearInterval(this.timer);this.update();if(this.closed)return;const seconds=refreshSeconds(this.env.preferences().menuBarRefreshInterval);if(seconds && !this.env.smoke){this.timer=setInterval(()=>{if(this.open)void this.refresh();},seconds*1000);this.timer.unref();}if(this.open)void this.refresh();}
  async refresh(force=false){if(this.closed)return;await this.usage.refresh(force);if(!this.closed && this.open && menuBarNeedsDetails(this.env.preferences().menuBarContents,this.selected()))await this.usage.details(force);}
  async smoke(){
    if(this.env.platform==='darwin')return {nativeStatusMenu:!trayImage('darwin',this.env.root).isEmpty() && Menu.buildFromTemplate(menuBarTemplate({phase:'idle'},this.actions)).items.some(item=>item.label==='用量分析'),nativeStatusCard:!!this.native && await this.native.start(true),nativeWindowsTray:true};
    if(this.env.platform!=='win32')return {nativeStatusMenu:true,nativeStatusCard:true,nativeWindowsTray:true};
    const panel=this.createPanel();try{const windowsTray=await panel.smoke();return {windowsTray,nativeWindowsTray:Object.values(windowsTray).every(Boolean),nativeStatusMenu:true,nativeStatusCard:true};}finally{panel.close();}
  }
  close(){this.closed=true;clearInterval(this.timer);this.stopTheme();this.open=false;this.menu?.closePopup();this.menu=undefined;this.native?.close();this.panel?.close();this.tray?.destroy();this.tray=undefined;}
}
