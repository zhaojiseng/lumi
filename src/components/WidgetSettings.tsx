import {useState} from 'react';
import {PanelsTopLeft,Check,Move,Clock3,Database} from 'lucide-react';
import {useApp} from '../context';
import {Button,SectionHeading,Select} from './ui';
export default function WidgetSettings(){
  const {preferences,bootstrap,updatePreferences,toast}=useApp(),[busy,setBusy]=useState(false);
  async function toggle(){if(busy)return;setBusy(true);try{await updatePreferences({widgetEnabled:!preferences.widgetEnabled});}catch(e:any){toast(e.message || '浮窗暂不可用','error');}finally{setBusy(false);}}
  async function source(value:string){if(busy)return;setBusy(true);try{await updatePreferences({widgetDataSource:value==='local' ? 'local' : 'api'});}catch(e:any){toast(e.message || '浮窗数据源设置失败','error');}finally{setBusy(false);}}
  const local=preferences.widgetDataSource==='local';
  return <section className="surface panel"><SectionHeading title="浮窗挂件" sub="把余额和最近消费放在手边"/><div className="setting-control"><div><strong><PanelsTopLeft size={16}/> 桌面用量挂件</strong><p>始终置顶的紧凑横条：左侧最近消费，右上最近模型的输入、输出和缓存，右下账户余额。</p></div><Button busy={busy} disabled={!bootstrap.desktop} variant={preferences.widgetEnabled ? 'default' : 'primary'} onClick={toggle}>{preferences.widgetEnabled ? <Check size={15}/> : <PanelsTopLeft size={15}/>} {preferences.widgetEnabled ? '隐藏挂件' : '显示挂件'}</Button></div><div className="setting-control"><div><strong><Database size={16}/> 数据源</strong><p>{local ? '只读扫描本机 Codex / Claude 会话文件；每秒最多检查一次新增内容。' : '读取当前站点 API，用量与余额来自账户接口。'}</p></div><Select label="浮窗数据源" disabled={busy || !bootstrap.desktop} value={preferences.widgetDataSource} onChange={source}><option value="api">站点 API</option><option value="local">本地会话文件</option></Select></div><div className="info-note"><Clock3 size={16}/><span>{local ? '本地模式每秒最多读取一次追加内容，并保存每个会话文件的只读读取位置；不会写入、锁定或修改其它程序正在使用的文件。' : 'API 模式按完整分钟同步上一分钟；该分钟没有额度消耗时，显示最近有消耗的一分钟。'} 悬停查看消费时间和完整详情，刷新动效跟随设置中的数据刷新动画。关闭挂件后停止同步。</span></div><div className="info-note"><Move size={16}/><span>拖动挂件边缘可调整位置，下次启动会恢复。双击内容或聚焦后按 Enter 打开工作台，悬停或聚焦时可使用右上角关闭按钮。</span></div>{!bootstrap.desktop && <p className="muted small-text">浮窗挂件需要 Electron 桌面应用。</p>}</section>;
}
