import {Suspense,useState} from 'react';
import type {ContentView} from './content-views';
import {Empty,Skeleton,SegmentedSwitch} from '../components/ui';
/** The provider contribution owns its data and inner UI; the system owns selection/lifetime. */
export function ContentSurface({views,siteScope,empty}:{views:readonly ContentView[];siteScope:string;empty:string}){
  const [selected,setSelected]=useState(''),view=views.find(item=>item.id===selected) || views.at(0),View=view?.component;
  return <div className="plugin-content">{views.length>1 && <SegmentedSwitch label="内容来源" size="regular" className="page-tabs">{views.map(item=><button key={item.id} aria-pressed={item.id===view?.id} className={item.id===view?.id ? 'active' : ''} onClick={()=>setSelected(item.id)}>{item.label}</button>)}</SegmentedSwitch>}
    {View && view ? <Suspense fallback={<Skeleton/>}><View key={view.id+(view.scope==='site' ? siteScope : '')}/></Suspense> : <Empty title={empty} description="请启用提供此内容的接入插件。"/>}
  </div>;
}
