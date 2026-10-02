import {useState} from 'react';
import {Check,Sun,Moon,Laptop,ArrowUpRight} from 'lucide-react';
import {useApp} from '../context';
import {bridge} from '../bridge';
import {Button,SectionHeading,Select,Pill,Logo} from '../components/ui';
import {UpdateNotice} from '../components/UpdateNotice';
import {AppCacheSettings} from '../components/AppCacheSettings';
import {RefreshAnimationSettings} from '../components/RefreshAnimationSettings';
import {PluginSettingsSection} from '../host/plugins';
import {ConnectionSettings} from '../host/settings';
import {InterfaceSettings} from '../host/interface-settings';
export default function GeneralSettings(){
  const {preferences,bootstrap,updatePreferences,toast}=useApp();
  const [threshold,setThreshold]=useState(String(preferences.lowBalanceThreshold));
  async function preference(patch:Parameters<typeof updatePreferences>[0]){try{await updatePreferences(patch);toast('设置已更新','success');}catch(e:any){toast(e.message,'error');}}
  return <div className="settings-general"><ConnectionSettings/>
    <div className="settings-two-columns"><section className="surface panel"><SectionHeading title="外观" sub="简洁、清晰，专注你的工作"/><div className="theme-options">{([['light', Sun, '浅色'], ['dark', Moon, '深色'], ['system', Laptop, '跟随系统']] as const).map(([theme, Icon, label]) => <button key={theme} className={preferences.theme === theme ? 'active' : ''} onClick={() => preference({ theme })}><div className={`theme-preview ${theme}`}><i/><span/><span/></div><span><Icon size={14}/>{label}{preferences.theme === theme && <Check size={13}/>}</span></button>)}</div></section><section className="surface panel"><SectionHeading title="同步与提醒" sub="按你的节奏更新数据"/><div className="setting-control"><div><strong>自动刷新</strong><p>所有页面按此频率刷新，仅在窗口可见时执行；接口缓存与请求合并继续生效</p></div><Select tone="blue" label="自动刷新频率" value={preferences.refreshInterval} onChange={v => preference({ refreshInterval: Number(v) })}><option value="0">关闭</option><option value="30">30 秒</option><option value="60">1 分钟</option><option value="120">2 分钟</option><option value="300">5 分钟</option><option value="600">10 分钟</option><option value="1800">30 分钟</option><option value="3600">1 小时</option></Select></div><RefreshAnimationSettings/><div className="setting-control balance-threshold"><div><strong>余额提醒阈值</strong><p>低于此额度时显示桌面通知</p></div><div><input aria-label="余额提醒阈值" type="number" min="0" step="0.1" value={threshold} onChange={e => setThreshold(e.target.value)} className="text-input"/><button className="icon-button" aria-label="保存提醒阈值" onClick={() => Number.isFinite(Number(threshold)) && Number(threshold) >= 0 ? preference({ lowBalanceThreshold: Number(threshold) }) : toast('请输入有效提醒阈值。', 'error')}><Check size={17}/></button></div></div></section></div>
    <InterfaceSettings/>
    <PluginSettingsSection/>
    <UpdateNotice placement="settings"/>
    <AppCacheSettings desktop={bootstrap.desktop}/>
    <section className="surface panel about-panel"><Logo/><div><h3>Lumi <Pill tone="muted">v{bootstrap.version}</Pill></h3><p>你的 AI，尽在一处。基于 Electron 的 New API 专属工作台。</p><span>{bootstrap.desktop ? 'Electron 桌面运行中' : '浏览器预览'} · {bootstrap.secureStorage ? '系统加密存储可用' : bootstrap.desktop ? '系统加密存储不可用' : '密钥配置仅支持桌面应用'}</span></div><div><Button onClick={() => bridge.openExternal('https://docs.newapi.ai/zh/docs/api').catch(e => toast(e.message, 'error'))}>New API 文档<ArrowUpRight size={13}/></Button><Button onClick={() => bridge.openExternal('https://github.com/farion1231/cc-switch').catch(e => toast(e.message, 'error'))}>CC Switch<ArrowUpRight size={13}/></Button></div></section>
  </div>;
}
