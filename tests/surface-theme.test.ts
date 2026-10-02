import test from 'node:test';
import assert from 'node:assert/strict';
import {SURFACE_COLOR_KEYS,parseSurfaceTheme,SurfaceThemeState,surfacePaletteStyle,type SurfacePalette,type SurfaceTheme} from '../shared/surface-theme';

const palette=():SurfacePalette=>Object.fromEntries(SURFACE_COLOR_KEYS.map(key=>[key,[45,85,190,1]])) as SurfacePalette;
const theme=():SurfaceTheme=>({interfaceId:'extension.lumi.compact',mode:'light',palette:palette()});

test('surface IPC carries bounded numeric colors and rejects CSS, resources and malformed snapshots',()=>{
  const input=theme(),copy=parseSurfaceTheme(input);input.palette.accent[0]=0;
  assert.equal(copy.palette.accent[0],45);
  assert.equal(surfacePaletteStyle(copy.palette)?.['--accent'],'rgba(45,85,190,1)');
  for(const invalid of [null,[],{...theme(),mode:{toString:()=> 'light'}},{...theme(),mode:'system'},{...theme(),interfaceId:'../arbitrary'},{...theme(),css:'body{color:red}'},{...theme(),palette:{...palette(),extra:[0,0,0,1]}},{...theme(),palette:{...palette(),accent:'url(file:///private)'}},...[[256,0,0,1],[-1,0,0,1],[.5,0,0,1],[NaN,0,0,1],[0,0,0,1.1],[0,0,0,-.1],[0,0,0],[0,0,0,'1']].map(accent=>({...theme(),palette:{...palette(),accent}}))])assert.throws(()=>parseSurfaceTheme(invalid));
  const missing=theme();delete (missing.palette as Partial<SurfacePalette>).panel;assert.throws(()=>parseSurfaceTheme(missing));
});

test('disabled interfaces and outdated theme replies cannot recolor current desktop surfaces',()=>{
  let scope:Pick<SurfaceTheme,'interfaceId'|'mode'>={interfaceId:'extension.lumi.compact',mode:'light'};
  const state=new SurfaceThemeState(()=>scope);
  assert.equal(state.update(theme()),true);assert.equal(state.update(theme()),false);assert.ok(state.palette());
  scope={...scope,mode:'dark'};assert.equal(state.palette(),undefined);assert.equal(state.update(theme()),false);
  assert.equal(state.update({...theme(),mode:'dark'}),true);
  scope={interfaceId:'interface.default',mode:'dark'};assert.equal(state.palette(),undefined);assert.equal(state.update({...theme(),mode:'dark'}),false);
  state.clear();scope={interfaceId:'extension.lumi.compact',mode:'dark'};assert.equal(state.palette(),undefined);
});
