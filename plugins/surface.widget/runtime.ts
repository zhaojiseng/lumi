import path from 'node:path';
import {createHash} from 'node:crypto';
import {WidgetPanel} from '../../electron/services/widget-panel';
import {WidgetService} from '../../electron/services/widget';
import {formattedWidget} from '../../shared/widget';
import {normalizeTypography} from '../../shared/typography';
import type {UsagePresentationCapability} from '../../shared/contracts/desktop-projection';
import type {DesktopSurfaceEnvironment,DesktopSurfaceControl} from '../../shared/contracts/desktop-surface';

/** This plugin owns the window, restricted IPC, refresh scheduler and cache lifetime. */
export class WidgetRuntime implements DesktopSurfaceControl {
  private panel:WidgetPanel;private usage:WidgetService;private timer?:ReturnType<typeof setTimeout>;private schedule=0;private closed=false;private probing=false;private stopTheme:()=>void;
  constructor(private env:DesktopSurfaceEnvironment,projection:UsagePresentationCapability){
    this.usage=new WidgetService({identity:()=>this.identity(),load:()=>projection.loadWidget(),minInterval:()=>this.env.preferences().widgetDataSource==='local' ? 1000 : 0,ttl:()=>this.env.preferences().widgetDataSource==='local' ? 1000 : 60000,changed:()=>{if(!this.closed)this.panel.update();}});
    this.panel=new WidgetPanel({root:env.root,preload:path.join(env.preloadDirectory,'widget-preload.cjs'),devUrl:env.devUrl,state:()=>{const prefs=env.preferences(),s=this.usage.snapshot();return {...formattedWidget(s.phase,s.usage,{enabled:!this.closed,viewKey:this.identity(),theme:env.theme(),animation:prefs.dataRefreshAnimation,inputMode:prefs.widgetInputMode,error:s.error}),typography:normalizeTypography(prefs),palette:env.palette?.()};},event:async event=>{
      if(this.closed)return;
      if(event.type==='close'){if(!this.probing)await env.setEnabled('surface.widget',false);}
      else if(event.type==='open')env.navigate('overview');else await this.refresh();
    },moved:position=>{void env.patch({widgetPosition:position}).catch(()=>env.log('浮窗','浮窗位置暂未能保存。'));}});
    this.stopTheme=env.onThemeChanged(()=>this.panel.update());
  }
  private identity(){const prefs=this.env.preferences();return createHash('sha256').update(JSON.stringify([this.env.identity(),prefs.widgetDataSource,prefs.widgetPeriod,prefs.bindings,prefs.managedTokens])).digest('hex');}
  async start(){await this.changed();}
  async changed(){
    const generation=++this.schedule;clearTimeout(this.timer);if(this.closed || this.env.isQuitting())return;
    this.panel.update();if(this.env.smoke)return;
    await this.panel.setVisible(true,this.env.preferences().widgetPosition);
    if(this.closed || generation!==this.schedule)return;void this.refresh();
    const delay=()=>this.env.preferences().widgetDataSource==='local' ? 1000 : 60000-Date.now()%60000+2000;
    const tick=async()=>{if(this.closed || this.env.isQuitting() || generation!==this.schedule)return;await this.refresh();if(!this.closed && generation===this.schedule){this.timer=setTimeout(tick,delay());this.timer.unref();}};
    this.timer=setTimeout(tick,delay());this.timer.unref();
  }
  async refresh(){if(!this.closed)await this.usage.refresh();}
  async smoke(){this.probing=true;try{const result=await this.panel.smoke();this.panel.suspend();return result;}finally{this.probing=false;}}
  close(){this.closed=true;++this.schedule;clearTimeout(this.timer);this.stopTheme();this.panel.close();}
}
