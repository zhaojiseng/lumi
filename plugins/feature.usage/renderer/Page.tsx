import {Suspense} from 'react';
import {MotionSwap} from '../../../src/components/MotionSwap';
import {useUsageViews} from '../../../src/host/usage';
import {useSourceSelection} from '../../../src/host/source-preferences';
import {PageIntro,Empty,Skeleton,SegmentedSwitch} from '../../../src/components/ui';
export default function Usage(){
  const {views,siteScope}=useUsageViews();
  const [selected,setSelected]=useSourceSelection<string>('feature.usage','tab','billing',value=>typeof value==='string');
  const view=views.find(item=>item.id===selected) || views[0],View=view?.component;
  return <div className="page"><PageIntro title="每一份消耗，尽在掌握" description="选择数据来源，查看账单或分析本机会话。"/>
    <SegmentedSwitch label="用量来源" size="regular" className="page-tabs">{views.map(item=><button key={item.id} aria-pressed={item.id===view?.id} className={item.id===view?.id ? 'active' : ''} onClick={()=>setSelected(item.id)}>{item.label}</button>)}</SegmentedSwitch>
    {view && View ? <MotionSwap identity={view.id} canRetain={id=>id===view.id && views.some(item=>item.id===id)}><div className="plugin-content"><Suspense fallback={<Skeleton/>}><View key={view.id+(view.scope==='site' ? siteScope : '')}/></Suspense></div></MotionSwap> : <Empty title="暂无用量来源" description="请启用相应接入插件。"/>}
  </div>;
}
