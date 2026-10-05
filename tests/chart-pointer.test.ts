import test from 'node:test';
import assert from 'node:assert/strict';
import {ChartPointer} from '../src/components/chart-pointer';

function fixture(){
  let id=0;const frames=new Map<number,FrameRequestCallback>(),notifications:ReturnType<ChartPointer['getState']>[]=[];
  const pointer=new ChartPointer({request:callback=>{frames.set(++id,callback);return id;},cancel:id=>{frames.delete(id);}});
  const stop=pointer.subscribe(()=>notifications.push(pointer.getState()));
  const paint=()=>{for(const [id,frame] of [...frames]){frames.delete(id);frame(0);}};
  return {pointer,frames,notifications,paint,stop};
}

test('high frequency chart movement publishes only the latest position on each frame',()=>{
  const {pointer,frames,notifications,paint}=fixture();
  for(let i=0;i<1000;i++)pointer.move({x:i,y:i+1});
  assert.equal(frames.size,1);assert.equal(notifications.length,0);paint();
  assert.deepEqual(notifications,[{pointer:{x:999,y:1000},keyboard:false}]);
  pointer.move({x:999,y:1000});paint();assert.equal(notifications.length,1,'unchanged coordinates do not broadcast');
  pointer.move({x:12,y:24});paint();assert.equal(notifications.length,2);
});

test('leaving the chart and keyboard focus clear queued pointer motion immediately',()=>{
  for(const keyboard of [false,true]){
    const {pointer,frames,notifications,paint}=fixture();pointer.move({x:10,y:20});paint();
    pointer.move({x:30,y:40});pointer.clear(keyboard);assert.equal(frames.size,0);
    assert.deepEqual(pointer.getState(),{pointer:null,keyboard});paint();assert.equal(notifications.length,2);
    pointer.move({x:50,y:60});paint();assert.deepEqual(pointer.getState(),{pointer:{x:50,y:60},keyboard:false});
  }
});

test('unmount cancels pending frames and releases tooltip subscriptions',()=>{
  const {pointer,frames,notifications,paint,stop}=fixture();pointer.move({x:10,y:20});pointer.cancel();stop();paint();
  assert.equal(frames.size,0);assert.equal(notifications.length,0);
  pointer.move({x:30,y:40});paint();assert.equal(notifications.length,0);
});
