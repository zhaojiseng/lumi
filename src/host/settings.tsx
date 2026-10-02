import {lazy,Suspense} from 'react';
import {SectionHeading,Skeleton} from '../components/ui';
import {usePluginStatuses} from './plugins';
import {connectionContributions,settingsTabContributions,type SettingsTabContribution} from './renderer-registry';
const hostTabs:readonly SettingsTabContribution[]=[
  {id:'general',label:'常规设置',order:0,component:lazy(()=>import('../pages/GeneralSettings'))},
  {id:'logs',label:'实时日志',order:1000,component:lazy(()=>import('../components/RuntimeLogs'))},
];
export function useSettingsContributions(){const statuses=usePluginStatuses();return {tabs:[...hostTabs,...settingsTabContributions(statuses)].sort((a,b)=>a.order-b.order),connections:connectionContributions(statuses)};}
export function ConnectionSettings(){
  const {connections}=useSettingsContributions();
  if(!connections.length)return null;
  return <div className="settings-connections settings-general" aria-label="连接"><SectionHeading title="连接" sub="管理插件提供的连接选项"/>{connections.map(option=>{const Connection=option.component;return <Suspense key={option.id} fallback={<Skeleton/>}><Connection/></Suspense>;})}</div>;
}
