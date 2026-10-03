import test from 'node:test';
import assert from 'node:assert/strict';
import {MacWidgetMaterial,type NativeWidgetGlass} from '../electron/services/mac-widget-material';

function fixture(options:{supported?:boolean;missing?:boolean;fail?:boolean}={}){
  const handle=Buffer.alloc(8),calls:unknown[]=[];
  let loaded=0;
  const native:NativeWidgetGlass={apply:(received,dark)=>{assert.equal(received,handle);calls.push(['apply',dark]);if(options.fail)throw new Error('Native failure');return options.supported!==false;},remove:received=>{assert.equal(received,handle);calls.push(['remove']);}};
  const win={getNativeWindowHandle:()=>handle,setVibrancy:(value:unknown)=>calls.push(['vibrancy',value])};
  const material=new MacWidgetMaterial(win,()=>{loaded++;if(options.missing)throw new Error('Missing addon');return native;});
  return {material,calls,get loaded(){return loaded;}};
}

test('Liquid Glass follows the theme without allocating another view on data updates',()=>{
  const f=fixture();assert.equal(f.material.sync('light',false),'liquid-glass');
  const count=f.calls.length;
  for(let i=0;i<20;i++)assert.equal(f.material.sync('light',false),'liquid-glass');
  assert.equal(f.calls.length,count);assert.equal(f.loaded,1);
  assert.equal(f.material.sync('dark',false),'liquid-glass');
  assert.deepEqual(f.calls,[['vibrancy',null],['apply',false],['vibrancy',null],['apply',true]]);
  f.material.dispose();f.material.dispose();assert.deepEqual(f.calls.at(-1),['remove']);
  assert.equal(f.calls.filter(call=>Array.isArray(call) && call[0]==='remove').length,1);
});

test('reduced transparency removes glass, renders an opaque theme, and can restore glass',()=>{
  const f=fixture();assert.equal(f.material.sync('light',true),'opaque');assert.equal(f.loaded,0);
  assert.equal(f.material.sync('dark',false),'liquid-glass');
  assert.equal(f.material.sync('dark',true),'opaque');
  assert.deepEqual(f.calls.slice(-2),[['remove'],['vibrancy',null]]);
  assert.equal(f.material.sync('light',false),'liquid-glass');assert.equal(f.loaded,1);
  f.material.dispose();assert.deepEqual(f.calls.at(-1),['remove']);
});

test('older macOS, a missing addon, or a native failure fall back to vibrancy',()=>{
  for(const options of [{supported:false},{missing:true},{fail:true}]){
    const f=fixture(options);assert.equal(f.material.sync('light',false),'vibrancy');assert.deepEqual(f.calls.at(-1),['vibrancy','hud']);
    assert.equal(f.material.sync('dark',false),'vibrancy');assert.equal(f.loaded,1);
    assert.equal(f.material.sync('dark',true),'opaque');assert.deepEqual(f.calls.at(-1),['vibrancy',null]);
    f.material.dispose();assert.ok(!f.calls.some(call=>Array.isArray(call) && call[0]==='remove'));
  }
});
