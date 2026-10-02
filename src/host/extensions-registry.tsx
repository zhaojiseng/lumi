import {lazy} from 'react';
import {Puzzle} from 'lucide-react';
import type {ExtensionDescriptor,ExtensionView} from '../../shared/contracts/extensions';
import {extensionPluginManifest} from '../../shared/contracts/extensions';
import type {RendererContribution} from './renderer-registry';
import type {PluginPageId} from '../../shared/types';
let inventoryKey='';let contributions:readonly RendererContribution[]=[];
export function externalRendererContributions(){return contributions;}
export function registerExternalRenderers(packages:readonly ExtensionDescriptor[]){
  const key=JSON.stringify(packages.map(p=>[p.manifest.id,p.digest]));if(key===inventoryKey)return;
  inventoryKey=key;
  contributions=packages.map(({manifest})=>{
    const renderer:RendererContribution={manifest:extensionPluginManifest(manifest),settings:{title:manifest.name,description:manifest.description}};
    for(const view of manifest.contributions){
      const id=`plugin:${manifest.id}:${view.id}`,component=lazy(async()=>{const {ExtensionFrame}=await import('./extension-frame');return {default:(props:{refreshEpoch?:number})=><ExtensionFrame {...props} pluginId={manifest.id} view={view}/>};});
      const content={id,label:view.title,title:view.title,order:view.order,scope:view.scope,view:view.switch,component};
      if(view.slot==='workbench')renderer.workbench=[...renderer.workbench || [],content];
      else if(view.slot==='usage')renderer.usage=[...renderer.usage || [],content];
      else if(view.slot==='models' || view.slot==='tokens')renderer[view.slot]=[...renderer[view.slot] || [],content];
      else if(view.slot==='connection')renderer.connections=[...renderer.connections || [],content];
      else if(view.slot==='settingsTab')renderer.settingsTabs=[...renderer.settingsTabs || [],content];
      else if(view.slot==='sidebar')renderer.sidebar=[...renderer.sidebar || [],{view:view.switch,page:{id:id as PluginPageId,scope:view.scope,component},navigation:{id:id as PluginPageId,label:view.title,hint:manifest.description,icon:Puzzle,section:view.section || 'workspace'}}];
    }
    return renderer;
  });
}
