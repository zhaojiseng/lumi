import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdir,mkdtemp,rm,writeFile} from 'node:fs/promises';
import path from 'node:path';
import {SettingsStore} from '../electron/services/store';
import {preferredInterface,normalizeBackground,normalizeInterfacePriorities} from '../shared/interface-styles';

test('style priorities resolve deterministically and fall back across independent switches',()=>{
  const styles=[{id:'interface.default',priority:0,enabled:true},{id:'interface.background',priority:200,enabled:true},{id:'extension.lumi.compact',priority:100,enabled:true}];
  assert.equal(preferredInterface(styles),'interface.background');
  assert.equal(preferredInterface(styles,{'extension.lumi.compact':300}),'extension.lumi.compact');
  assert.equal(preferredInterface(styles.map(style=>({...style,enabled:false}))),'interface.default');
  assert.equal(preferredInterface([...styles].reverse(),{'interface.background':100}),'extension.lumi.compact');
  assert.deepEqual(normalizeInterfacePriorities({'../bad':1,'interface.default':1001,'interface.background':1.5,'extension.lumi.compact':-10}),{'extension.lumi.compact':-10});
  assert.equal(normalizeBackground({image:'https://fixture.invalid/image',fit:'invalid'}).image,'');
});
test('background, priorities and default switch survive restart, migration and failed writes',async t=>{
  await mkdir('.test-data',{recursive:true});const root=await mkdtemp(path.resolve('.test-data/style-preferences-'));t.after(()=>rm(root,{recursive:true,force:true,maxRetries:5,retryDelay:100}));
  const cipher={available:()=>true,encrypt:(value:string)=>value,decrypt:(value:string)=>value};
  const store=new SettingsStore(root,cipher);await store.load();
  const background={image:'data:image/webp;base64,UklGRg==',name:'fixture.webp',fit:'contain' as const};
  await store.update({background,defaultInterfaceEnabled:false,interfacePriority:{id:'interface.background',priority:500}});
  await store.update({interfacePriority:{id:'extension.lumi.compact',priority:600}});
  const reload=new SettingsStore(root,cipher);await reload.load();assert.deepEqual(reload.preferences.background,background);assert.equal(reload.preferences.defaultInterfaceEnabled,false);assert.deepEqual(reload.preferences.interfacePriorities,{'interface.background':500,'extension.lumi.compact':600});
  await assert.rejects(reload.update({background:{...background,image:'file:///private'}}));
  await writeFile(path.join(root,'settings.json'),JSON.stringify({preferences:{theme:'dark'}}));await reload.load();assert.equal(reload.preferences.defaultInterfaceEnabled,true);assert.deepEqual(reload.preferences.interfacePriorities,{});assert.equal(reload.preferences.background.image,'');
  await rm(root,{recursive:true});await writeFile(root,'blocked');
  await assert.rejects(reload.update({background,defaultInterfaceEnabled:false,interfacePriority:{id:'interface.background',priority:500}}));
  assert.equal(reload.preferences.defaultInterfaceEnabled,true);assert.deepEqual(reload.preferences.interfacePriorities,{});assert.equal(reload.preferences.background.image,'');
});
