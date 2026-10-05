import test from 'node:test';
import assert from 'node:assert/strict';
import {lazy} from 'react';
import {rendererRegistry,validateRendererRegistry,type RendererContribution} from '../src/host/renderer-registry';
import {registerExternalRenderers,externalRendererContributions} from '../src/host/extensions-registry';
import type {ExtensionDescriptor} from '../shared/contracts/extensions';

const component=()=>null;
const fixture:RendererContribution={manifest:{id:'provider.fixture',version:'1.0.0',hostApiVersion:1,configurable:true,requires:[],optional:[],provides:[],settings:{title:'Fixture',description:'',order:10,views:[{id:'details',title:'Details'}]}},settings:{title:'Fixture',description:'',component,sections:[{id:'options',title:'Owned options',view:'details',component:lazy(async()=>({default:component}))}]}};

test('plugin-owned sections validate locally and preserve the existing component interface',()=>{
  assert.doesNotThrow(()=>validateRendererRegistry([fixture]));
  assert.equal(fixture.settings.component,component);
  for(const id of ['','../settings','UPPER'])assert.throws(()=>validateRendererRegistry([{...fixture,settings:{...fixture.settings,sections:[{id,title:'Settings',component}]}}]),/插件自身设置项/);
  assert.throws(()=>validateRendererRegistry([{...fixture,settings:{...fixture.settings,sections:[...fixture.settings.sections!,...fixture.settings.sections!]}}]),/重复/);
  assert.throws(()=>validateRendererRegistry([{...fixture,settings:{...fixture.settings,sections:[{id:'other',title:'Settings',view:'undeclared',component}]}}]),/开关必须/);
  assert.throws(()=>validateRendererRegistry([{...fixture,settings:{...fixture.settings,sections:[{id:'other',title:' ',component}]}}]),/插件自身设置项/);
  assert.ok(rendererRegistry.filter(item=>item.manifest.configurable).every(item=>item.settings.sections?.length),'Each configurable builtin supplies its own settings');
});

test('external settings contributions also appear in their owning plugin detail page',()=>{
  const descriptor:ExtensionDescriptor={manifest:{schemaVersion:1,hostApiVersion:1,id:'extension.fixture.settings',name:'Fixture',version:'1.0.0',description:'Fixture settings',author:'Fixture',license:'MIT',permissions:[],networkOrigins:[],switches:[{id:'settings',title:'Settings',defaultEnabled:true}],contributions:[{id:'options',slot:'settingsTab',title:'Own settings',order:10,scope:'site',entry:'index.html',switch:'settings'}]},digest:'fixture-owned-settings'};
  registerExternalRenderers([descriptor]);
  const renderer=externalRendererContributions()[0];
  assert.equal(renderer.settings.sections?.[0].id,'options');assert.equal(renderer.settings.sections?.[0].view,'settings');
  assert.equal(renderer.settings.sections?.[0].component,renderer.settingsTabs?.[0].component);
  registerExternalRenderers([]);
});
