import {useState} from 'react';
import {PanelsTopLeft,Check,Move,Clock3} from 'lucide-react';
import {useApp} from '../context';
import {Button,SectionHeading} from './ui';
export default function WidgetSettings(){
  const {preferences,bootstrap,updatePreferences,toast}=useApp(),[busy,setBusy]=useState(false);
  async function toggle(){if(busy)return;setBusy(true);try{await updatePreferences({widgetEnabled:!preferences.widgetEnabled});}catch(e:any){toast(e.message || '浮窗暂不可用','error');}finally{setBusy(false);}}
  return <section className="surface panel"><SectionHeading title="浮窗挂件" sub="把余额和最近一分钟的用量放在手边"/><div className="setting-control"><div><strong><PanelsTopLeft size={16}/> 桌面用量挂件</strong><p>始终置顶，显示当前站点余额、分钟消费，以及每个模型的输入、输出、缓存读取与写入。</p></div><Button busy={busy} disabled={!bootstrap.desktop} variant={preferences.widgetEnabled ? 'default' : 'primary'} onClick={toggle}>{preferences.widgetEnabled ? <Check size={15}/> : <PanelsTopLeft size={15}/>} {preferences.widgetEnabled ? '隐藏挂件' : '显示挂件'}</Button></div><div className="info-note"><Clock3 size={16}/><span>每分钟自动同步上一完整分钟；该分钟没有额度消耗时，显示最近有消耗的一分钟并注明时间。关闭挂件后停止同步。</span></div><div className="info-note"><Move size={16}/><span>拖动挂件顶栏可调整位置，下次启动会恢复。挂件右上角可打开工作台或关闭，底部可手动刷新。</span></div>{!bootstrap.desktop && <p className="muted small-text">浮窗挂件需要 Electron 桌面应用。</p>}</section>;
}
