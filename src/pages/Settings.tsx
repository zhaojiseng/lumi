import {useState,useEffect,useRef,Suspense} from 'react';
import {PageIntro,Skeleton,SegmentedSwitch} from '../components/ui';
import {MotionSwap} from '../components/MotionSwap';
import {useSettingsContributions} from '../host/settings';
export default function Settings(){
  const {tabs}=useSettingsContributions();
  const [chosen,setChosen]=useState('general');
  const view=tabs.some(tab=>tab.id===chosen) ? chosen : 'general',active=tabs.find(tab=>tab.id===view)!;
  const root=useRef<HTMLDivElement>(null);
  useEffect(()=>{if(chosen!==view)setChosen(view);},[chosen,view]);
  useEffect(()=>{root.current?.closest('.content-scroll')?.scrollTo({top:0});},[view]);
  const Page=active.component;
  return <div className="page settings-page" ref={root}><PageIntro title="属于你的工作台" description="管理连接、插件和显示偏好。"/>
    <SegmentedSwitch label="设置二级菜单" size="regular" className="settings-subnav">{tabs.map(tab=><button key={tab.id} aria-pressed={view===tab.id} className={view===tab.id ? 'active' : ''} aria-current={view===tab.id ? 'page' : undefined} onClick={()=>setChosen(tab.id)}>{tab.label}</button>)}</SegmentedSwitch>
    <MotionSwap identity={view} canRetain={id=>tabs.some(tab=>tab.id===id)}><Suspense fallback={<Skeleton/>}><Page/></Suspense></MotionSwap>
  </div>;
}
