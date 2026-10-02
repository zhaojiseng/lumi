import {Component,Suspense,type ReactNode} from 'react';
import {useWorkbench} from '../../../src/host/workbench';
import {Empty,Skeleton,Button} from '../../../src/components/ui';
class CardBoundary extends Component<{children:ReactNode},{failed:boolean}> {
  state={failed:false};
  static getDerivedStateFromError(){return {failed:true};}
  render(){return this.state.failed ? <Empty title="此来源暂时无法显示" description="其它来源仍可正常使用。" action={<Button onClick={()=>this.setState({failed:false})}>重试</Button>}/> : this.props.children;}
}
export default function Workbench(){
  const {cards,siteScope,refreshInterval,refreshEpoch}=useWorkbench();
  return <div className="page overview-page"><div className="page-intro"><div><div className="eyebrow"><span className="tiny-dot"/>YOUR AI, IN ONE PLACE</div><h1>我的工作台<span className="greeting-orb">✳</span></h1><p>在一个地方查看各账户的限额、余额与使用情况。</p></div></div>
    {cards.map(card=>{const Card=card.component;return <CardBoundary key={card.id+(card.scope==='site' ? siteScope : '')}><Suspense fallback={<Skeleton/>}><Card refreshInterval={refreshInterval} refreshEpoch={refreshEpoch}/></Suspense></CardBoundary>;})}
    {!cards.length && <Empty title="暂无用量来源" description="在设置中启用需要的接入插件。"/>}
  </div>;
}
