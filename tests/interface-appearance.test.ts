import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdir,mkdtemp,rm,writeFile,cp} from 'node:fs/promises';
import path from 'node:path';
import {parseExtensionManifest} from '../shared/extension-manifest';
import {normalizeInterfaceSelections,resolveInterfaceAppearance} from '../shared/interface-appearance';
import {SettingsStore} from '../electron/services/store';
import {SurfaceThemeState,SURFACE_COLOR_KEYS,type SurfacePalette} from '../shared/surface-theme';
import {readExtensionPackage} from '../electron/extensions/packages';
import {ExtensionHost} from '../electron/extensions/host';

const group={id:'accent',title:'强调色',defaultOption:'blue',options:[{id:'blue',title:'蓝色'},{id:'rose',title:'玫红'}]};
test('appearance manifests reject invalid defaults, duplicate groups and unsafe preview paths',async()=>{
  const pkg=await readExtensionPackage('extensions/packages/extension.lumi.compact'),manifest=pkg.manifest;
  for(const definition of [
    {preview:'../private.html'},
    {appearanceGroups:[group,group]},
    {appearanceGroups:[{...group,defaultOption:'missing'}]},
    {appearanceGroups:[{...group,id:'constructor'}]},
    {appearanceGroups:[{...group,options:[group.options[0],group.options[0]]}]},
  ])assert.throws(()=>parseExtensionManifest({...manifest,interface:{...manifest.interface,...definition}}));
  assert.deepEqual(resolveInterfaceAppearance([group],{accent:'missing'}),{accent:'blue'});
  assert.deepEqual(resolveInterfaceAppearance([group],{accent:'rose',unknown:'blue'}),{accent:'rose'});
  assert.deepEqual(normalizeInterfaceSelections(JSON.parse('{"extension.lumi.compact":{"accent":"rose","constructor":"blue","bad":"<script>"},"../private":{"accent":"blue"}}')),{ 'extension.lumi.compact':{accent:'rose'}});
});
test('appearance choices merge per interface and survive restart and legacy settings',async t=>{
  await mkdir('.test-data',{recursive:true});const root=await mkdtemp(path.resolve('.test-data/appearance-'));t.after(()=>rm(root,{recursive:true,force:true,maxRetries:5,retryDelay:100}));
  const cipher={available:()=>true,encrypt:(value:string)=>value,decrypt:(value:string)=>value};
  const store=new SettingsStore(root,cipher);await store.load();assert.deepEqual(store.preferences.interfaceSelections,{});
  await Promise.all([
    store.update({interfaceSelection:{interfaceId:'extension.lumi.compact',values:{accent:'rose'}}}),
    store.update({interfaceSelection:{interfaceId:'extension.lumi.compact',values:{density:'compact'}}}),
    store.update({interfaceSelection:{interfaceId:'extension.author.other',values:{accent:'blue'}}}),
  ]);
  const reload=new SettingsStore(root,cipher);await reload.load();assert.deepEqual(reload.preferences.interfaceSelections,{'extension.lumi.compact':{accent:'rose',density:'compact'},'extension.author.other':{accent:'blue'}});
  await assert.rejects(reload.update({interfaceSelection:{interfaceId:'provider.newapi',values:{accent:'blue'}}}));
  await writeFile(path.join(root,'settings.json'),JSON.stringify({preferences:{theme:'dark'}}));await reload.load();assert.deepEqual(reload.preferences.interfaceSelections,{});
  await rm(root,{recursive:true,force:true});await writeFile(root,'blocked settings directory');
  await assert.rejects(reload.update({interfaceSelection:{interfaceId:'extension.lumi.compact',values:{accent:'rose'}}}));assert.deepEqual(reload.preferences.interfaceSelections,{});
});
test('active package validates appearance choices and pins bounded preview bytes',async t=>{
  await mkdir('.test-data',{recursive:true});const root=await mkdtemp(path.resolve('.test-data/appearance-host-'));t.after(()=>rm(root,{recursive:true,force:true,maxRetries:5,retryDelay:100}));
  const directory=path.join(root,'extensions'),id='extension.lumi.compact',folder=path.join(directory,id);await cp('extensions/packages/'+id,folder,{recursive:true});
  const original=await readExtensionPackage(folder),manifest={...original.manifest,interface:{...original.manifest.interface!,preview:'preview.html'}};
  await writeFile(path.join(folder,'plugin.json'),JSON.stringify(manifest));await assert.rejects(readExtensionPackage(folder),/预览模板/);
  await writeFile(path.join(folder,'preview.html'),'<section class="surface panel"><h2>Theme</h2></section>');
  const host=new ExtensionHost({directory,settingsDirectory:root,cipher:{available:()=>true,encrypt:value=>value,decrypt:value=>value},sdk:Buffer.from(''),scope:()=>'',context:()=>({theme:'light',locale:'zh-CN',site:{id:'fixture',name:'Fixture',url:'https://fixture.invalid'}}),read:async()=>null});await host.start();t.after(()=>host.dispose());
  assert.throws(()=>host.validateAppearanceSelection({interfaceId:id,values:{accent:'blue'}}));await host.setEnabled(id,true);
  host.validateAppearanceSelection({interfaceId:id,values:{accent:'rose'}});assert.throws(()=>host.validateAppearanceSelection({interfaceId:id,values:{accent:'unknown'}}));assert.throws(()=>host.validateAppearanceSelection({interfaceId:id,values:{other:'blue'}}));
  assert.equal(host.inventory().interfaceStyle?.preview,'<section class="surface panel"><h2>Theme</h2></section>');
  await writeFile(path.join(folder,'preview.html'),'updated');assert.match(host.inventory().interfaceStyle!.preview!,/Theme/);await host.reload();assert.equal(host.inventory().interfaceStyle,undefined);
  await writeFile(path.join(folder,'preview.html'),'x'.repeat(32769));await assert.rejects(readExtensionPackage(folder),/32 KiB/);
});
test('late appearance palettes cannot recolor current desktop surfaces',()=>{
  const palette=Object.fromEntries(SURFACE_COLOR_KEYS.map(key=>[key,[10,20,30,1]])) as SurfacePalette;
  let appearanceKey='{"accent":"blue"}';const state=new SurfaceThemeState(()=>({interfaceId:'extension.lumi.compact',mode:'light',appearanceKey}));
  const input={interfaceId:'extension.lumi.compact',mode:'light' as const,appearanceKey,palette};assert.equal(state.update(input),true);
  appearanceKey='{"accent":"rose"}';assert.equal(state.palette(),undefined);assert.equal(state.update(input),false);assert.equal(state.update({...input,appearanceKey}),true);
});
