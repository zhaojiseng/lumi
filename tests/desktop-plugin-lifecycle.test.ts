import test from 'node:test';
import assert from 'node:assert/strict';
import {build} from 'esbuild';
import {runInNewContext} from 'node:vm';
import {createRequire} from 'node:module';
import {readFile} from 'node:fs/promises';
import {DEFAULT_PREFERENCES,type MenuBarUsage} from '../shared/types';
import type {WidgetUsage} from '../shared/widget';
import type {DesktopSurfaceEnvironment,DesktopSurfaceControl} from '../shared/contracts/desktop-surface';
import type {UsagePresentationCapability,WorkbenchPresentationCapability} from '../shared/contracts/desktop-projection';

const bundles=Promise.all(['widget','tray'].map(async kind=>(await build({entryPoints:[`plugins/surface.${kind}/runtime.ts`],bundle:true,platform:'node',format:'cjs',write:false,external:['electron','../../electron/services/widget-panel','../../electron/services/tray-panel','../../electron/services/native-menu-bar'],logLevel:'silent'})).outputFiles[0].text));
function deferred<T>(){let resolve!:(value:T)=>void;const promise=new Promise<T>(r=>resolve=r);return {promise,resolve};}
const settle=()=>new Promise(resolve=>setImmediate(resolve));
async function harness(kind:'widget'|'tray',projection:UsagePresentationCapability|WorkbenchPresentationCapability,platform:NodeJS.Platform='win32'){
  const preferences=structuredClone(DEFAULT_PREFERENCES),themes=new Set<()=>void>(),timers=new Map<object,()=>void>(),panels:FakePanel[]=[],trays:FakeTray[]=[],native:FakeNative[]=[],changes:string[]=[],actions:{id:string;enabled:boolean}[]=[];
  let identity='account-a';
  class FakePanel{
    closed=false;updates=0;visible=false;
    constructor(readonly options:any){panels.push(this);}
    update(){this.updates++;}async setVisible(visible:boolean){this.visible=visible;}async toggle(){this.visible=!this.visible;}
    hide(){this.visible=false;}suspend(){this.visible=false;}close(){this.closed=true;this.visible=false;}
    async smoke(){return {isolated:true,layout:true};}
  }
  class FakeTray{
    destroyed=false;listeners=new Map<string,()=>void>();menu:any;
    constructor(_image:any){trays.push(this);}setToolTip(){}setIgnoreDoubleClickEvents(){}setContextMenu(menu:any){this.menu=menu;}
    on(event:string,fn:()=>void){this.listeners.set(event,fn);}getBounds(){return {x:1,y:1,width:20,height:20};}popUpContextMenu(){}destroy(){this.destroyed=true;}
  }
  const ready=deferred<boolean>();
  class FakeNative{
    closed=false;updates=0;constructor(readonly options:any){native.push(this);}start(){return ready.promise;}update(){this.updates++;}close(){this.closed=true;}
  }
  const schedule=(fn:()=>void)=>{const id={unref(){}};timers.set(id,fn);return id;},cancel=(id:object)=>timers.delete(id);
  const env:DesktopSurfaceEnvironment={root:process.cwd(),preloadDirectory:process.cwd(),platform,packaged:false,resourcesPath:'fixture',smoke:false,preferences:()=>preferences,identity:()=>identity,theme:()=> 'light',onThemeChanged:fn=>{themes.add(fn);return()=>{themes.delete(fn);};},patch:async patch=>Object.assign(preferences,patch),setEnabled:async(id,enabled)=>{actions.push({id,enabled});},navigate:page=>changes.push(page),showMain:()=>{},quit:()=>{},isQuitting:()=>false,log:()=>{}};
  const require=createRequire(import.meta.url),module={exports:{} as {WidgetRuntime:new(env:DesktopSurfaceEnvironment,projection:UsagePresentationCapability)=>DesktopSurfaceControl & {start():Promise<void>;close():void};TrayRuntime:new(env:DesktopSurfaceEnvironment,projection:WorkbenchPresentationCapability)=>DesktopSurfaceControl & {start():Promise<void>;close():void}}};
  runInNewContext((await bundles)[kind==='widget' ? 0 : 1],{module,exports:module.exports,Buffer,structuredClone,setTimeout:schedule,clearTimeout:cancel,setInterval:schedule,clearInterval:cancel,require:(name:string)=>name==='electron' ? {Tray:FakeTray,Menu:{buildFromTemplate:(items:Electron.MenuItemConstructorOptions[])=>({items,once(){},closePopup(){}})},nativeImage:{createFromPath:()=>({resize(){return this;}}),createFromBitmap:()=>({isEmpty:()=>false})}} : name.endsWith('/widget-panel') ? {WidgetPanel:FakePanel} : name.endsWith('/tray-panel') ? {TrayPanel:FakePanel} : name.endsWith('/native-menu-bar') ? {NativeMenuBar:FakeNative} : require(name)});
  const runtime=kind==='widget' ? new module.exports.WidgetRuntime(env,projection as UsagePresentationCapability) : new module.exports.TrayRuntime(env,projection as WorkbenchPresentationCapability);
  return {runtime,env,preferences,themes,timers,panels,trays,native,actions,ready,setIdentity:(value:string)=>{identity=value;},changes};
}
const usage=(siteId='a'):WidgetUsage=>({siteId,siteName:'Fixture',status:{system_name:'Fixture',quota_per_unit:1},loggedIn:false,balance:null,minute:null,historical:false,warnings:[],fetchedAt:Date.now()});
const menu=(siteId='a'):MenuBarUsage=>({siteId,siteName:'Fixture',status:{system_name:'Fixture',quota_per_unit:1},user:null,today:{quota:null,tokens:null,requests:null},tools:[],warnings:[],fetchedAt:Date.now()});

test('Widget plugin owns window/timer/theme cleanup and rejects late refresh effects',async()=>{
  const pending=deferred<any>();let calls=0;
  const h=await harness('widget',{loadWidget:()=>{calls++;return pending.promise;}});await h.runtime.start();await settle();
  assert.equal(h.panels[0].visible,true);assert.equal(h.timers.size,1);assert.equal(h.themes.size,1);assert.equal(calls,1);
  const updates=h.panels[0].updates;h.runtime.close();assert.equal(h.panels[0].closed,true);assert.equal(h.timers.size,0);assert.equal(h.themes.size,0);
  pending.resolve(usage());await settle();assert.equal(h.panels[0].updates,updates);await h.runtime.changed();assert.equal(h.timers.size,0);
  const restarted=await harness('widget',{loadWidget:async()=>usage()});await restarted.runtime.start();await settle();assert.equal(restarted.panels[0].visible,true);
  await restarted.panels[0].options.event({type:'close'});assert.deepEqual(restarted.actions,[{id:'surface.widget',enabled:false}]);restarted.runtime.close();
});

test('Tray plugin owns windows/icon/timer and surface changes stay independent',async()=>{
  const h=await harness('tray',{loadMenu:async()=>menu(),loadMenuDetails:async()=>assert.fail('closed panel must not request details')});await h.runtime.start();
  assert.equal(h.trays.length,1);assert.equal(h.panels.length,1);assert.equal(h.timers.size,1);assert.equal(h.themes.size,1);
  h.trays[0].listeners.get('click')!();await settle();assert.equal(h.panels[0].visible,true);
  const toggle=h.trays[0].menu.items.find((item:Electron.MenuItemConstructorOptions)=>item.label==='显示 / 隐藏浮窗挂件');toggle.click();await settle();assert.deepEqual(h.actions,[{id:'surface.widget',enabled:true}]);
  const updates=h.panels[0].updates;h.runtime.close();assert.equal(h.panels[0].closed,true);assert.equal(h.trays[0].destroyed,true);assert.equal(h.themes.size,0);assert.equal(h.timers.size,0);
  await h.panels[0].options.event({type:'navigate',page:'overview'});assert.equal(h.changes.length,0);await h.runtime.changed();assert.equal(h.panels[0].updates,updates);
});

test('late macOS helper failure cannot recreate a stopped Tray plugin',async()=>{
  const h=await harness('tray',{loadMenu:async()=>menu(),loadMenuDetails:async()=>assert.fail('unexpected details')},'darwin');await h.runtime.start();assert.equal(h.native.length,1);
  h.runtime.close();h.ready.resolve(false);h.native[0].options.failed();await settle();assert.equal(h.trays.length,0);assert.equal(h.native[0].closed,true);assert.equal(h.timers.size,0);
});

test('host main has no desktop panel constructors, cache policy or refresh schedulers',async()=>{
  const main=await readFile('electron/main.ts','utf8');assert.doesNotMatch(main,/new (?:WidgetPanel|TrayPanel|NativeMenuBar|WidgetService|MenuBarService|Tray)\b|syncWidget|syncTray|widgetTimer|menuInterval/);
  for(const file of ['plugins/surface.widget/runtime.ts','plugins/surface.tray/runtime.ts'])assert.doesNotMatch(await readFile(file,'utf8'),/provider\.newapi|SettingsStore|AppContext|store\.credentials/);
});
