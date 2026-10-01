import test from 'node:test';
import assert from 'node:assert/strict';
import {parseTrayAction,trayPanelBounds,trustedTrayUrl} from '../shared/tray';
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
});
test('tray IPC accepts only its document and strictly limited navigation/selection actions',()=>{
  const url='file:///fixture/dist/tray.html';assert.ok(trustedTrayUrl(url+'#chart',url));
  for(const other of [undefined,'file:///fixture/dist/index.html',url+'?other',url+'/other','https://evil.invalid/tray.html'])assert.ok(!trustedTrayUrl(other,url));
  for(const action of [{type:'close'},{type:'refresh'},{type:'quit'},{type:'navigate',page:'usage'},{type:'select',selection:{days:30,tool:'codex'}}])assert.deepEqual(parseTrayAction(action),action);
  for(const action of [null,[],{type:'opened'},{type:'navigate',page:'tokens'},{type:'refresh',command:'anything'},{type:'select',selection:{days:7,tool:'codex',type:'quit'}},{type:'select',selection:{days:90,tool:'codex'}},{type:'select',selection:{days:7,tool:'shell'}}])assert.equal(parseTrayAction(action),null);
});
