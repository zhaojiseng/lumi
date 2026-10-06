import test from 'node:test';
import assert from 'node:assert/strict';
import {glassDisplacement} from '../src/host/glass-refraction';

test('glass vectors preserve a neutral center and curve inward only along the bevel',()=>{
  const map=glassDisplacement(240,120,20);
  const rg=(x:number,y:number)=>[...map.data.slice((y*map.width+x)*4,(y*map.width+x)*4+2)];
  assert.deepEqual(rg(120,60),[128,128]);
  assert.deepEqual(rg(70,50),[128,128]);
  assert.ok(rg(1,60)[0]>128 && rg(238,60)[0]<128);
  assert.ok(rg(120,1)[1]>128 && rg(120,118)[1]<128);
  assert.deepEqual(rg(0,0),[128,128]); // outside the rounded corner
  assert.equal(map.data[3],255);
});
test('large glass maps bound texture allocation and preserve non-square geometry',()=>{
  const map=glassDisplacement(2000,1000,2000);
  assert.equal(map.width,384);assert.equal(map.height,192);
  assert.equal(map.data.length,384*192*4);
  const center=(96*384+192)*4;
  assert.deepEqual([...map.data.slice(center,center+2)],[128,128]);
});

test('selection lens magnifies the interior around a neutral anchor without displacing outside corners',()=>{
  const flat=glassDisplacement(101,27,7),lens=glassDisplacement(101,27,7,384,true);
  const rg=(map:typeof lens,x:number,y:number)=>[...map.data.slice((y*map.width+x)*4,(y*map.width+x)*4+2)];
  assert.deepEqual(rg(lens,50,13),[128,128]);
  assert.deepEqual(rg(lens,0,0),[128,128]);
  assert.deepEqual(rg(flat,30,13),[128,128]);
  assert.ok(rg(lens,30,13)[0]>128 && rg(lens,70,13)[0]<128);
  assert.ok(rg(lens,50,9)[1]>128 && rg(lens,50,17)[1]<128);
});

test('workspace and model surfaces bend a wider background band while keeping the center neutral',()=>{
  const flat=glassDisplacement(400,240,20),surface=glassDisplacement(400,240,20,384,false,true);
  const rg=(map:typeof surface,x:number,y:number)=>[...map.data.slice((y*map.width+x)*4,(y*map.width+x)*4+2)];
  assert.deepEqual(rg(flat,30,100),[128,128]);
  assert.ok(rg(surface,30,100)[0]>128);
  assert.deepEqual(rg(surface,192,115),[128,128]);
});
