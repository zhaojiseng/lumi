import test from 'node:test';
import assert from 'node:assert/strict';
import {build} from 'esbuild';
import {createRequire} from 'node:module';
import {runInNewContext} from 'node:vm';
import * as React from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import {parseTrayAction,trayPanelBounds,trayPanelBoundsAt,trayPanelContentHeight,trustedTrayUrl,TRAY_CLOSE_DURATION,TRAY_RESIZE_DURATION,type TrayPanelState} from '../shared/tray';
import {nativeMenuBarState} from '../shared/menu-bar';
test('tray panel stays inside the correct work area for bottom/top/left/right taskbars and negative displays',()=>{
  for(const [anchor,area] of [
    [{x:1780,y:1040,width:24,height:24},{x:0,y:0,width:1920,height:1040}],
    [{x:1780,y:12,width:24,height:24},{x:0,y:40,width:1920,height:1040}],
    [{x:10,y:950,width:24,height:24},{x:48,y:0,width:1872,height:1080}],
    [{x:1890,y:950,width:24,height:24},{x:0,y:0,width:1872,height:1080}],
    [{x:-60,y:760,width:24,height:24},{x:-1280,y:0,width:1280,height:760}],
    [{x:290,y:420,width:24,height:24},{x:0,y:0,width:320,height:420}],
  ]){const bounds=trayPanelBounds(anchor,area);assert.ok(bounds.x>=area.x && bounds.y>=area.y);assert.ok(bounds.x+bounds.width<=area.x+area.width);assert.ok(bounds.y+bounds.height<=area.y+area.height);}
  assert.ok(trayPanelBounds({x:1800,y:1040,width:24,height:24},{x:0,y:0,width:1920,height:1040}).y<1040);
  assert.equal(trayPanelBounds({x:1800,y:10,width:24,height:24},{x:0,y:40,width:1920,height:1040}).y,50);
  for(const height of [160,260,500,648])for(const y of [1028,1040,1054]){
    const bounds=trayPanelBounds({x:1800,y,width:24,height:24},{x:0,y:0,width:1920,height:1040},{width:396,height});
    assert.equal(bounds.y+bounds.height,1040,'bottom edge meets the taskbar, regardless of icon inset');
  }
});
test('tray IPC accepts only its document and strictly limited navigation/selection actions',()=>{
  const url='file:///fixture/dist/tray.html';assert.ok(trustedTrayUrl(url+'#chart',url));
  for(const other of [undefined,'file:///fixture/dist/index.html',url+'?other',url+'/other','https://evil.invalid/tray.html'])assert.ok(!trustedTrayUrl(other,url));
  for(const action of [{type:'close'},{type:'refresh'},{type:'quit'},{type:'navigate',page:'usage'},{type:'select',selection:{days:30,tool:'codex'}},{type:'layout',height:160,reducedMotion:false},{type:'layout',height:648,reducedMotion:true},{type:'closeComplete',id:7}])assert.deepEqual(parseTrayAction(action),action);
  for(const action of [null,[],{type:'opened'},{type:'navigate',page:'tokens'},{type:'refresh',command:'anything'},{type:'select',selection:{days:7,tool:'codex',type:'quit'}},{type:'select',selection:{days:90,tool:'codex'}},{type:'select',selection:{days:7,tool:'shell'}},{type:'layout',height:159,reducedMotion:false},{type:'layout',height:649,reducedMotion:false},{type:'layout',height:300.5,reducedMotion:false},{type:'layout',height:NaN,reducedMotion:false},{type:'layout',height:300,reducedMotion:'false'},{type:'layout',height:300,reducedMotion:false,width:2000},{type:'closeComplete',id:0},{type:'closeComplete',id:Infinity},{type:'closeComplete',id:7,command:'hide'}])assert.equal(parseTrayAction(action),null);
});

test('intrinsic height is independent of the current viewport, capped, and compact with no sections',()=>{
  assert.equal(trayPanelContentHeight(224),232);
  assert.equal(trayPanelContentHeight(224,360),592);
  assert.equal(trayPanelContentHeight(232,40),280);
  assert.equal(trayPanelContentHeight(232,1000),648);
  assert.equal(trayPanelContentHeight(100),160);
  assert.equal(trayPanelContentHeight(232,360,0),592,'native material replaces the transparent top inset');
});

test('height interpolation has intermediate frames and keeps the bottom edge fixed in both directions',()=>{
  const area={x:-1280,y:0,width:1280,height:760},anchor={x:-60,y:770,width:24,height:24};
  const short=trayPanelBounds(anchor,area,{width:396,height:260}),tall=trayPanelBounds(anchor,area,{width:396,height:620});
  for(const [from,to] of [[short,tall],[tall,short]]){
    let previous=from.height;
    for(let frame=0;frame<=15;frame++){
      const bounds=trayPanelBoundsAt(from,to,frame/15);
      assert.equal(bounds.y+bounds.height,760);assert.ok(bounds.y>=area.y);
      assert.ok(to.height>from.height ? bounds.height>=previous : bounds.height<=previous);previous=bounds.height;
    }
    assert.deepEqual(trayPanelBoundsAt(from,to,0),from);assert.deepEqual(trayPanelBoundsAt(from,to,1),to);
    const middle=trayPanelBoundsAt(from,to,.3);assert.ok(middle.height>short.height && middle.height<tall.height);
  }
});

// Compile in memory and substitute only Electron and the clock: no app, config, or dist writes.
const panelBundle=build({entryPoints:['electron/services/tray-panel.ts'],bundle:true,platform:'node',format:'cjs',write:false,external:['electron'],logLevel:'silent'});
const bottomAnchor={x:1780,y:1054,width:24,height:24},workArea={x:0,y:0,width:1920,height:1040};
async function panelFixture(options:{deferLoad?:boolean;platform?:NodeJS.Platform;version?:string}={}){
  let now=1000,sequence=0,releaseLoad=()=>{};
  const timers=new Map<number,{at:number;run:()=>void}>(),handlers=new Map<string,(event:any,payload?:unknown)=>any>();
  const events:string[]=[],windows:FakeWindow[]=[];
  let state:TrayPanelState={usage:{...nativeMenuBarState({phase:'ready'},{days:1,tool:'all'}),viewKey:'fixture'},theme:'light'};
  class FakeWindow {
    visible=false;destroyed=false;shows=0;hides=0;focuses=0;bounds={x:0,y:0,width:396,height:648};history:typeof this.bounds[]=[];
    messages:TrayPanelState[]=[];listeners=new Map<string,(()=>void)[]>();
    webContents={mainFrame:{url:''},send:(_channel:string,value:TrayPanelState)=>this.messages.push(value),on:()=>{},setWindowOpenHandler:()=>{},session:{setPermissionRequestHandler:()=>{},setPermissionCheckHandler:()=>{}}};
    constructor(public options:any){windows.push(this);}
    on(name:string,listener:()=>void){this.listeners.set(name,[...(this.listeners.get(name) || []),listener]);}
    emit(name:string){for(const listener of this.listeners.get(name) || [])listener();}
    loadURL(url:string){this.webContents.mainFrame.url=url;return options.deferLoad ? new Promise<void>(resolve=>{releaseLoad=resolve;}) : Promise.resolve();}
    isDestroyed(){return this.destroyed;}
    isVisible(){return this.visible;}
    getBounds(){return {...this.bounds};}
    setBounds(bounds:typeof this.bounds){this.bounds={...bounds};this.history.push({...bounds});}
    show(){this.visible=true;this.shows++;}
    focus(){this.focuses++;}
    hide(){this.visible=false;this.hides++;this.emit('blur');}
    destroy(){this.destroyed=true;this.visible=false;this.emit('closed');}
  }
  const electron={BrowserWindow:FakeWindow,ipcMain:{handle:(channel:string,handler:any)=>handlers.set(channel,handler),removeHandler:(channel:string)=>handlers.delete(channel)},screen:{getDisplayNearestPoint:()=>({workArea}),getCursorScreenPoint:()=>({x:1780,y:1054})}};
  const module={exports:{} as {TrayPanel:typeof import('../electron/services/tray-panel').TrayPanel}},require=createRequire(import.meta.url);
  runInNewContext((await panelBundle).outputFiles[0].text,{module,exports:module.exports,URL,process:{platform:options.platform || 'win32'},Date:{now:()=>now},setTimeout:(run:()=>void,delay:number)=>{const id=++sequence;timers.set(id,{run,at:now+delay});return id;},clearTimeout:(id:number)=>timers.delete(id),require:(name:string)=>name==='electron' ? electron : name==='node:os' ? {release:()=>options.version || '10.0.19045'} : require(name)});
  const panel=new module.exports.TrayPanel({root:process.cwd(),preload:'fixture-preload.cjs',state:()=>state,event:event=>{events.push(event.type);}});
  const invoke=(payload:unknown,event?:any)=>handlers.get('lumi:trayAction')!(event || {sender:windows[0].webContents,senderFrame:windows[0].webContents.mainFrame},payload);
  const measure=(height:number,reducedMotion=false)=>invoke({type:'layout',height,reducedMotion});
  const advance=(duration:number)=>{
    const end=now+duration;
    for(;;){const next=[...timers.entries()].filter(([,timer])=>timer.at<=end).sort((a,b)=>a[1].at-b[1].at)[0];if(!next)break;now=next[1].at;timers.delete(next[0]);next[1].run();}
    now=end;
  };
  const open=async(height=400,reducedMotion=false)=>{const job=panel.toggle(bottomAnchor);await measure(height,reducedMotion);releaseLoad();await job;};
  return {panel,windows,events,handlers,timers,invoke,measure,advance,open,releaseLoad:()=>releaseLoad(),setState:(next:TrayPanelState)=>{state=next;panel.update();},get state(){return state;},get win(){return windows[0];},get motion(){return windows[0].messages.at(-1)!.motion!;}};
}

test('concurrent first opens and repeated state updates produce one entry lifecycle',async t=>{
  const f=await panelFixture({deferLoad:true});t.after(()=>f.panel.close());
  const first=f.panel.toggle(bottomAnchor),second=f.panel.toggle(bottomAnchor);
  assert.equal(f.windows.length,1);await f.measure(340);f.releaseLoad();await Promise.all([first,second]);
  assert.equal(f.win.shows,1);assert.equal(f.win.bounds.height,340);assert.equal(f.win.bounds.y+f.win.bounds.height,1040);
  assert.deepEqual(f.events,['opened']);const id=f.motion.id;
  for(let i=0;i<5;i++)f.panel.update();assert.equal(f.motion.id,id);assert.equal(f.motion.phase,'visible');assert.equal(f.win.shows,1);
  assert.equal(f.win.options.thickFrame,false);assert.equal(f.win.options.hasShadow,false);
  assert.equal(f.win.options.webPreferences.contextIsolation,true);assert.equal(f.win.options.webPreferences.sandbox,true);assert.equal(f.win.options.webPreferences.nodeIntegration,false);
});

test('native acrylic material reaches tray snapshots and updates without losing isolation',async t=>{
  const f=await panelFixture({version:'10.0.28000'});t.after(()=>f.panel.close());await f.open(320);
  assert.equal(f.win.options.backgroundMaterial,'acrylic');assert.equal(f.win.options.transparent,false);
  assert.equal(f.win.options.thickFrame,true);assert.equal(f.win.options.roundedCorners,true);assert.equal(f.win.options.hasShadow,false);
  assert.equal(f.win.messages.at(-1)?.material,'acrylic');
  const snapshot=f.handlers.get('lumi:traySnapshot')!({sender:f.win.webContents,senderFrame:f.win.webContents.mainFrame},undefined);
  assert.equal(snapshot.data.material,'acrylic');
  f.setState({...f.state,theme:'dark'});assert.equal(f.win.messages.at(-1)?.material,'acrylic');
  await f.measure(480);f.advance(TRAY_RESIZE_DURATION+16);assert.equal(f.win.bounds.height,480);
});

test('native resize animates up/down, survives repeated updates, and retargets from the current frame',async t=>{
  const f=await panelFixture();t.after(()=>f.panel.close());await f.open(320);
  await f.measure(600);assert.equal(f.win.bounds.height,320);f.advance(64);
  const middle=f.win.bounds.height;assert.ok(middle>320 && middle<600);
  f.panel.update();f.advance(TRAY_RESIZE_DURATION);assert.equal(f.win.bounds.height,600);
  await f.measure(220);f.advance(64);const shrinking=f.win.bounds.height;assert.ok(shrinking>220 && shrinking<600);
  await f.measure(480);assert.equal(f.win.bounds.height,shrinking);f.advance(TRAY_RESIZE_DURATION+16);assert.equal(f.win.bounds.height,480);
  assert.ok(f.win.history.length>12);for(const bounds of f.win.history)assert.equal(bounds.y+bounds.height,1040);
});

test('close action waits for exit completion and repeated blur cannot restart it',async t=>{
  const f=await panelFixture();t.after(()=>f.panel.close());await f.open();
  assert.equal((await f.invoke({type:'close'})).ok,true);const id=f.motion.id;
  assert.equal(f.motion.phase,'closing');assert.equal(f.win.hides,0);f.win.emit('blur');f.panel.hide();assert.equal(f.motion.id,id);
  f.advance(TRAY_CLOSE_DURATION-1);assert.equal(f.win.isVisible(),true);
  await f.invoke({type:'closeComplete',id});assert.equal(f.win.isVisible(),false);assert.equal(f.motion.phase,'hidden');
  f.advance(1000);assert.equal(f.win.hides,1);assert.deepEqual(f.events,['opened','closed']);
});

test('reopening cancels the closing timer and ignores old completion messages, including during another close',async t=>{
  const f=await panelFixture();t.after(()=>f.panel.close());await f.open();f.panel.hide();const oldId=f.motion.id;
  f.advance(30);await f.panel.toggle(bottomAnchor);assert.equal(f.motion.phase,'visible');assert.ok(f.motion.id>oldId);
  await f.invoke({type:'closeComplete',id:oldId});f.advance(1000);assert.equal(f.win.isVisible(),true);assert.equal(f.win.hides,0);assert.equal(f.win.shows,1);
  f.panel.hide();const id=f.motion.id;await f.invoke({type:'closeComplete',id:oldId});assert.equal(f.win.isVisible(),true);
  await f.invoke({type:'closeComplete',id});assert.equal(f.win.hides,1);
});

test('outside blur animates out, suppresses the same tray click, and has a renderer-failure fallback',async t=>{
  const f=await panelFixture();t.after(()=>f.panel.close());await f.open();f.win.emit('blur');const id=f.motion.id;
  await f.panel.toggle(bottomAnchor);assert.equal(f.motion.id,id);assert.equal(f.motion.phase,'closing');assert.equal(f.win.hides,0);
  f.advance(TRAY_CLOSE_DURATION+149);assert.equal(f.win.isVisible(),true);f.advance(1);assert.equal(f.win.hides,1);
  await f.panel.toggle(bottomAnchor);assert.equal(f.motion.phase,'visible');assert.equal(f.win.shows,2);
});

test('reduced motion applies resize and close immediately and cancels an in-flight animation',async t=>{
  const f=await panelFixture();t.after(()=>f.panel.close());await f.open(320,true);
  await f.measure(500,true);assert.equal(f.win.bounds.height,500);assert.equal(f.timers.size,0);
  await f.measure(250,false);f.advance(32);assert.ok(f.win.bounds.height>250 && f.win.bounds.height<500);
  await f.measure(250,true);assert.equal(f.win.bounds.height,250);assert.equal(f.timers.size,0);
  f.panel.hide();assert.equal(f.win.isVisible(),false);assert.equal(f.win.hides,1);assert.equal(f.timers.size,0);
  await f.panel.toggle(bottomAnchor);await f.measure(250,false);f.win.emit('blur');assert.equal(f.motion.phase,'closing');
  await f.measure(250,true);assert.equal(f.motion.phase,'hidden');assert.equal(f.win.hides,2);
});

test('presentation IPC rejects foreign contents, child frames, URL changes and malformed payloads',async t=>{
  const f=await panelFixture();t.after(()=>f.panel.close());await f.open();
  const sender=f.win.webContents,main=sender.mainFrame,layout={type:'layout',height:220,reducedMotion:true};
  for(const event of [{sender:{mainFrame:main},senderFrame:main},{sender,senderFrame:{url:main.url}}]){
    assert.equal((await f.invoke(layout,event)).ok,false);assert.equal((await f.invoke({type:'closeComplete',id:f.motion.id},event)).ok,false);
    assert.equal(f.handlers.get('lumi:traySnapshot')!(event).ok,false);
  }
  const original=main.url;main.url=original+'?foreign';assert.equal((await f.invoke(layout)).ok,false);main.url=original;
  assert.equal((await f.invoke({...layout,height:10000})).ok,false);assert.equal((await f.invoke({type:'closeComplete',id:-1})).ok,false);
  assert.equal(f.win.bounds.height,400);assert.deepEqual(f.events,['opened']);
  assert.equal(f.handlers.get('lumi:traySnapshot')!({sender,senderFrame:main},{}).ok,false);
  await f.measure(400);assert.deepEqual(f.events,['opened'],'layout events never reach the main navigation handler');
});

test('hiding or destroying during initial load cannot resurrect the popup',async()=>{
  for(const destroy of [false,true]){
    const f=await panelFixture({deferLoad:true});const job=f.panel.toggle(bottomAnchor);
    await f.measure(320);if(destroy)f.panel.close();else f.panel.hide();f.releaseLoad();await job;
    assert.equal(f.win.shows,0);assert.deepEqual(f.events,[]);f.panel.close();f.advance(1000);assert.equal(f.timers.size,0);
  }
});

test('an explicit reopen during a cancelled initial load reuses that load and opens once',async t=>{
  const f=await panelFixture({deferLoad:true});t.after(()=>f.panel.close());
  const first=f.panel.toggle(bottomAnchor);f.panel.hide();const reopened=f.panel.toggle(bottomAnchor);
  await f.measure(320);f.releaseLoad();await Promise.all([first,reopened]);
  assert.equal(f.windows.length,1);assert.equal(f.win.shows,1);assert.deepEqual(f.events,['opened']);
});

test('destroying before a layout report leaves no delayed readiness timer behind',async()=>{
  const f=await panelFixture({deferLoad:true});const job=f.panel.toggle(bottomAnchor);f.panel.close();f.releaseLoad();await job;
  assert.equal(f.win.shows,0);assert.equal(f.timers.size,0);assert.equal(f.handlers.size,0);
});

test('renderer uses the totals caption independently of the chart caption and retains a full label title',async()=>{
  const result=await build({entryPoints:['src/tray.tsx'],bundle:true,platform:'node',format:'cjs',write:false,external:['react','react/jsx-runtime','react-dom/client'],loader:{'.css':'empty','.svg':'text'},logLevel:'silent'});
  for(const totalsCaption of [undefined,'今日','最近24小时','最近7天']){
    const state:TrayPanelState={usage:{...nativeMenuBarState({phase:'ready'},{days:1,tool:'all'}),totalsCaption,chartCaption:'最近30天 · 按天'},theme:'light'};
    const module={exports:{}},require=createRequire(import.meta.url);let tree:React.ReactNode;
    const react={...React,useState:(initial:any)=>React.useState(initial?.usage ? state : initial)};
    runInNewContext(result.outputFiles[0].text,{module,exports:module.exports,document:{getElementById:()=>({})},matchMedia:()=>({matches:false}),require:(name:string)=>name==='react' ? react : name==='react-dom/client' ? {createRoot:()=>({render:(value:React.ReactNode)=>{tree=value;}})} : require(name)});
    const html=renderToStaticMarkup(tree),label=(totalsCaption || '本期')+'消费';
    assert.ok(html.includes('<dt title="'+label+'">'+label+'</dt>'));assert.ok(html.includes('最近30天 · 按天'));
    assert.ok(!html.includes('最近30天 · 按天消费'));
  }
});
