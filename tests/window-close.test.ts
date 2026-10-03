import test from 'node:test';
import assert from 'node:assert/strict';
import {WindowCloseAnimation} from '../electron/services/window-close';

function fixture(){
  const state={destroyed:false,visible:true,opacity:.8,values:[] as number[]};
  const window={isDestroyed:()=>state.destroyed,isVisible:()=>state.visible,getOpacity:()=>state.opacity,setOpacity:(value:number)=>{state.opacity=value;state.values.push(value);}};
  return {state,window};
}
test('window close fades once, then restores opacity for a hidden reusable macOS window',t=>{
  t.mock.timers.enable({apis:['Date','setInterval']});
  const {state,window}=fixture(),animation=new WindowCloseAnimation(window,()=>false,'darwin');let closes=0;
  const close=()=>{closes++;state.visible=false;};
  animation.run(close);animation.run(close);
  for(let frame=0;frame<5;frame++)t.mock.timers.tick(16);assert.equal(closes,0);assert.ok(state.opacity<.8 && state.opacity>0);
  for(let frame=0;frame<5;frame++)t.mock.timers.tick(16);assert.equal(closes,1);assert.equal(state.opacity,.8);
  assert.ok(state.values.slice(0,-1).every((value,index,array)=>index===0 || value<array[index-1]));
  t.mock.timers.tick(1000);assert.equal(closes,1);
});
test('reduced motion, hidden windows and unsupported platforms close immediately',()=>{
  for(const [platform,reduced,visible] of [['win32',true,true],['win32',false,false],['linux',false,true]] as const){
    const {state,window}=fixture();state.visible=visible;let closes=0;
    new WindowCloseAnimation(window,()=>reduced,platform).run(()=>closes++);
    assert.equal(closes,1);assert.deepEqual(state.values,[]);
  }
});
test('destroying a window mid-fade cancels the timer without calling its close action',t=>{
  t.mock.timers.enable({apis:['Date','setInterval']});
  const {state,window}=fixture(),animation=new WindowCloseAnimation(window,()=>false,'win32');let closes=0;
  animation.run(()=>closes++);t.mock.timers.tick(32);state.destroyed=true;const count=state.values.length;
  t.mock.timers.tick(1000);assert.equal(closes,0);assert.equal(state.values.length,count);
});
test('opacity failure completes the close action once',t=>{
  t.mock.timers.enable({apis:['Date','setInterval']});
  const {window}=fixture();window.setOpacity=()=>{throw new Error('fixture opacity unavailable');};let closes=0;
  new WindowCloseAnimation(window,()=>false,'win32').run(()=>closes++);
  t.mock.timers.tick(1000);assert.equal(closes,1);
});
test('unavailable animation settings or opacity reads never prevent closing',()=>{
  for(const fail of ['settings','opacity']){
    const {window}=fixture();let closes=0;
    if(fail==='opacity')window.getOpacity=()=>{throw new Error('fixture opacity unavailable');};
    new WindowCloseAnimation(window,()=>{if(fail==='settings')throw new Error('fixture settings unavailable');return false;},'win32').run(()=>closes++);
    assert.equal(closes,1);
  }
});
