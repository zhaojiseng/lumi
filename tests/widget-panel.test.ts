import test from 'node:test';
import assert from 'node:assert/strict';
import {build} from 'esbuild';
import {createRequire} from 'node:module';
import {runInNewContext} from 'node:vm';
import {EventEmitter} from 'node:events';
import type {WidgetState} from '../shared/widget';

const bundle=build({entryPoints:['electron/services/widget-panel.ts'],bundle:true,platform:'node',format:'cjs',write:false,external:['electron'],logLevel:'silent'});
async function fixture(options:{platform?:NodeJS.Platform;root?:string;supported?:boolean;missing?:boolean;deferLoad?:boolean}={}){
  const platform=options.platform || 'darwin',calls:unknown[][]=[],windows:FakeWindow[]=[];
  const handlers=new Map<string,(event:any,payload?:unknown)=>any>();
  const nativeTheme=Object.assign(new EventEmitter(),{prefersReducedTransparency:false});
  let state:WidgetState={phase:'idle',enabled:true,siteName:'fixture',balance:'-',cost:'-',minuteLabel:'-',historical:false,models:[],message:'-',updatedAt:0,viewKey:'fixture',dataKey:'fixture',theme:'light'};
  let releaseLoad=()=>{};
  class FakeWindow {
    destroyed=false;visible=false;messages:WidgetState[]=[];listeners=new Map<string,((...args:any[])=>void)[]>();
    handle=Buffer.alloc(8);bounds={x:0,y:0,width:244,height:64};
    webContents={mainFrame:{url:''},send:(_channel:string,state:WidgetState)=>this.messages.push(state),on:()=>{},setWindowOpenHandler:()=>{},session:{setPermissionRequestHandler:()=>{},setPermissionCheckHandler:()=>{}}};
    constructor(public options:any){windows.push(this);}
    on(name:string,listener:(...args:any[])=>void){this.listeners.set(name,[...(this.listeners.get(name) || []),listener]);}
    loadURL(url:string){this.webContents.mainFrame.url=url;return options.deferLoad ? new Promise<void>(resolve=>{releaseLoad=resolve;}) : Promise.resolve();}
    isDestroyed(){return this.destroyed;}
    isVisible(){return this.visible;}
    getNativeWindowHandle(){assert.equal(this.destroyed,false);return this.handle;}
    setVibrancy(value:unknown){assert.equal(this.destroyed,false);calls.push(['vibrancy',value]);}
    setAlwaysOnTop(){}
    setVisibleOnAllWorkspaces(){}
    getBounds(){return this.bounds;}
    setBounds(bounds:typeof this.bounds){this.bounds=bounds;}
    showInactive(){this.visible=true;}
    hide(){this.visible=false;}
    destroy(){this.destroyed=true;this.visible=false;calls.push(['destroy']);for(const listener of this.listeners.get('closed') || [])listener();}
  }
  const native={apply:(handle:Buffer,dark:boolean)=>{assert.ok(windows.some(win=>win.handle===handle && !win.destroyed));calls.push(['apply',dark]);return options.supported!==false;},remove:(handle:Buffer)=>{assert.ok(windows.some(win=>win.handle===handle && !win.destroyed));calls.push(['remove']);}};
  const require=createRequire(import.meta.url),module={exports:{} as {WidgetPanel:typeof import('../electron/services/widget-panel').WidgetPanel}};
  runInNewContext((await bundle).outputFiles[0].text,{module,exports:module.exports,process:{platform,resourcesPath:'/fixture/Resources'},URL,Buffer,setTimeout,clearTimeout,
    require:(name:string)=>name==='electron' ? {BrowserWindow:FakeWindow,nativeTheme,ipcMain:{handle:(channel:string,handler:any)=>handlers.set(channel,handler),removeHandler:(channel:string)=>handlers.delete(channel)},screen:{getPrimaryDisplay:()=>({workArea:{x:0,y:0,width:1920,height:1080}})}}
      : name==='node:os' ? {release:()=>platform==='win32' ? '10.0.28000' : '25.0.0'}
      : name==='node:module' ? {createRequire:()=>((file:string)=>{calls.push(['load',file]);if(options.missing)throw new Error('Missing native module');return native;})}
      : require(name)});
  const panel=new module.exports.WidgetPanel({root:options.root || process.cwd(),preload:'fixture-preload',state:()=>state,event:()=>{}});
  return {panel,calls,windows,nativeTheme,handlers,releaseLoad:()=>releaseLoad(),setTheme:(theme:WidgetState['theme'])=>{state={...state,theme};panel.update();},get win(){return windows.at(-1)!;}};
}

test('macOS widget activates glass after load, streams material changes, and disposes before destroy',async t=>{
  const f=await fixture({deferLoad:true});t.after(()=>f.panel.close());
  const job=f.panel.setVisible(true,null);assert.equal(f.win.options.vibrancy,'hud');assert.equal(f.win.options.transparent,true);
  assert.ok(!f.calls.some(call=>call[0]==='load'));f.releaseLoad();await job;
  assert.equal(f.win.messages.at(-1)?.material,'liquid-glass');assert.equal(f.win.visible,true);
  const win=f.win;f.setTheme('dark');assert.equal(f.win,win);assert.deepEqual(f.calls.at(-1),['apply',true]);
  f.nativeTheme.prefersReducedTransparency=true;f.nativeTheme.emit('updated');assert.equal(f.win.messages.at(-1)?.material,'opaque');
  f.nativeTheme.prefersReducedTransparency=false;f.nativeTheme.emit('updated');assert.equal(f.win.messages.at(-1)?.material,'liquid-glass');
  f.panel.suspend();assert.deepEqual(f.calls.slice(-2),[['remove'],['destroy']]);
  const count=f.calls.length;f.nativeTheme.emit('updated');assert.equal(f.calls.length,count);
  f.panel.close();assert.equal(f.nativeTheme.listenerCount('updated'),0);assert.equal(f.handlers.size,0);
});

test('macOS widget falls back on older systems and loads packaged native resources outside asar',async t=>{
  for(const missing of [false,true]){
    const f=await fixture({root:'/fixture/Resources/app.asar',supported:false,missing});t.after(()=>f.panel.close());
    await f.panel.setVisible(true,null);assert.equal(f.win.messages.at(-1)?.material,'vibrancy');
    const file=f.calls.find(call=>call[0]==='load')?.[1];assert.equal(file,createRequire(import.meta.url)('node:path').join('/fixture/Resources','native/lumi-widget-glass.node'));
    assert.deepEqual(f.calls.at(-1),['vibrancy','hud']);
  }
});

test('suspending a loading macOS widget cannot attach native material to a dead window',async t=>{
  const f=await fixture({deferLoad:true});t.after(()=>f.panel.close());
  const job=f.panel.setVisible(true,null);f.panel.suspend();f.releaseLoad();await job;
  assert.ok(!f.calls.some(call=>call[0]==='apply' || call[0]==='load'));
  const next=f.panel.setVisible(true,null);f.releaseLoad();await next;
  assert.equal(f.windows.length,2);assert.equal(f.win.messages.at(-1)?.material,'liquid-glass');
});

test('widget material does not widen IPC privileges or load macOS code on Windows',async t=>{
  for(const platform of ['win32','darwin'] as const){
    const f=await fixture({platform});t.after(()=>f.panel.close());await f.panel.setVisible(true,null);
    assert.equal(f.win.options.webPreferences.sandbox,true);assert.equal(f.win.options.webPreferences.nodeIntegration,false);assert.equal(f.win.options.webPreferences.contextIsolation,true);
    const event={sender:f.win.webContents,senderFrame:f.win.webContents.mainFrame};
    const read=f.handlers.get('lumi:widgetSnapshot')!,action=f.handlers.get('lumi:widgetAction')!;
    assert.equal(read(event).ok,true);assert.equal(read(event).data.material,platform==='darwin' ? 'liquid-glass' : 'acrylic');
    assert.equal(read({...event,sender:{}}).ok,false);assert.equal(read({...event,senderFrame:{url:event.senderFrame.url}}).ok,false);
    assert.equal((await action(event,{type:'material',handle:'arbitrary'})).ok,false);
    if(platform==='win32'){assert.equal(f.win.options.backgroundMaterial,'acrylic');assert.ok(!f.calls.some(call=>call[0]==='load'));}
  }
});
