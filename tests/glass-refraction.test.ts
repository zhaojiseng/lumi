import test from 'node:test';
import {createHash} from 'node:crypto';
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

// Captured from the previous implementation; protects bevel, lens, tiny maps,
// clamped radii and fractional geometry while optimizing neutral pixels.
test('optimized displacement maps retain the original RGBA bytes',()=>{
  const fixtures=[[[2,2,2000,32,false,false],"a6fc1a50a33d6b7dfe8c81dc97ada8ddc3e268894e5dd89d830a6a6828228af1"],[[13,47,7,384,true,false],"416987f631fad04ba77fff91c7e92e96fcb55de5dafae8f157d5920045779fe6"],[[101,27,7,384,true,false],"0a19ee5ef196a36c63af31b091376b5403f326f1373dbf28d4eed241960afc38"],[[240,120,20,384,false,false],"2136aed1f6c34241ec25c5d583eac1f6b7de042374194f695fdffa06744069c1"],[[400,240,20,384,false,true],"f9ccb2ae7378531c0ad185180e376f6774e318d98006401d93fad7f6282af3a5"],[[1200,800,24,384,false,true],"a37d9698d253f6effdd39d60f538f9b25f12b651ed391d47e930f6c15beb9ef9"],[[2000,1000,2000,384,false,false],"247ff13918a40c63114c3b258fc9530a9c80f2bef3197fce4d6ee3588ab13e01"],[[139.5,51.25,20,32,true,true],"7fb757dcb0cc35034ac6a24db175c8181332dcfd351d83fca82618a8c67da862"]] as const;
  for(const [args,expected] of fixtures){
    const [width,height,radius,maxSize,lens,surface]=args;
    assert.equal(createHash('sha256').update(glassDisplacement(width,height,radius,maxSize,lens,surface).data).digest('hex'),expected,JSON.stringify(args));
  }
});
