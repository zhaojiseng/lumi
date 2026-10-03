import test from 'node:test';
import assert from 'node:assert/strict';
import {surfaceBackdrop} from '../electron/services/surface-backdrop';

test('Windows acrylic uses a native rounded window instead of a layered rectangle',()=>{
  for(const version of ['10.0.22621','10.0.28000','11.0.1']){
    const options=surfaceBackdrop('win32',version);
    assert.equal(options.backgroundMaterial,'acrylic');
    assert.equal(options.transparent,false);
    assert.equal(options.thickFrame,true);
    assert.equal(options.roundedCorners,true);
    assert.equal(options.backgroundColor,'#00000000');
  }
});

test('unsupported systems retain the transparent window without unsupported material calls',()=>{
  for(const [platform,version] of [['win32','10.0.19045'],['win32','10.0.22000'],['darwin','24.0.0'],['linux','6.8.0']] as const){
    const options=surfaceBackdrop(platform,version);
    assert.equal(options.transparent,true);
    assert.equal(options.thickFrame,false);
    assert.equal(options.backgroundMaterial,undefined);
  }
});
