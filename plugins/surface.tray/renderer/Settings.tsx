import {useRef,useState} from 'react';
import {Check,Monitor} from 'lucide-react';
import {useApp} from '../../../src/context';
import {Button,SectionHeading,Select} from '../../../src/components/ui';
import {normalizeMenuBarContents} from '../../../shared/menu-bar';
import {normalizeMenuBarRange} from '../../../shared/menu-bar-periods';
import {MENU_BAR_SECTION_IDS,type MenuBarSectionId,type PreferencePatch} from '../../../shared/types';

const sections:Record<MenuBarSectionId,{label:string;description:string}>={
  balance:{label:'账户余额',description:'当前站点账户的可用余额'},
  totals:{label:'本期用量',description:'所选时间范围的消费、Tokens 和请求数'},
  tokenDetail:{label:'Token 明细',description:'输入和输出 Tokens'},
  efficiency:{label:'使用效率',description:'缓存命中率和平均 Token 速率'},
  chart:{label:'消费趋势',description:'今日按小时，7 天和 30 天按天显示'},
  models:{label:'主要模型',description:'按消费排序的前三个模型'},
};

export default function BarSettings(){
  const {preferences,updatePreferences,toast}=useApp();
  const [busy,setBusy]=useState(false),saving=useRef(false);
  const contents=normalizeMenuBarContents(preferences.menuBarContents);
  async function save(patch:PreferencePatch){
    if(saving.current)return;
    saving.current=true;setBusy(true);
    try{await updatePreferences(patch);toast('菜单栏与托盘设置已更新','success');}
    catch(error){toast(error instanceof Error ? error.message : '设置保存失败，请重试。','error');}
    finally{saving.current=false;setBusy(false);}
  }
  return <div className="settings-general">
    <section className="surface panel" aria-label="菜单栏与托盘显示内容" aria-busy={busy}>
      <SectionHeading title="显示内容" sub="自定义 macOS 菜单栏与 Windows 托盘用量面板" action={<div style={{display:'flex',gap:8,flexWrap:'wrap'}}><Button disabled={busy || contents.length===MENU_BAR_SECTION_IDS.length} onClick={()=>void save({menuBarContents:[...MENU_BAR_SECTION_IDS]})}><Check size={14}/>全选</Button><Button disabled={busy || contents.length===0} onClick={()=>void save({menuBarContents:[]})}>全部隐藏</Button></div>}/>
      <div role="group" aria-label="用量面板内容区块">
        {MENU_BAR_SECTION_IDS.map(id=><div className="setting-control" key={id}>
          <div><strong id={'bar-section-'+id}>{sections[id].label}</strong><p id={'bar-section-'+id+'-description'}>{sections[id].description}</p></div>
          <input type="checkbox" aria-labelledby={'bar-section-'+id} aria-describedby={'bar-section-'+id+'-description'} checked={contents.includes(id)} disabled={busy} style={{width:16,height:16,flexShrink:0,accentColor:'var(--accent)',cursor:'pointer'}} onChange={event=>void save({menuBarContents:normalizeMenuBarContents(event.target.checked ? [...contents,id] : contents.filter(section=>section!==id))})}/>
        </div>)}
      </div>
      <div className="info-note"><Monitor size={15}/><span>面板始终保留站点信息、工具与时间选择、刷新和导航操作。隐藏全部区块后也可正常使用。</span></div>
    </section>
    <section className="surface panel" aria-label="菜单栏与托盘时间筛选">
      <SectionHeading title="时间筛选" sub="本期用量和消费趋势可以使用不同的统计范围"/>
      {(['totals','chart'] as const).map(section=>{
        const field=section==='totals' ? 'menuBarTotalsRange' : 'menuBarChartRange';
        return <div className="setting-control" key={section}><div><strong>{section==='totals' ? '本期用量' : '消费趋势'}</strong><p>{section==='totals' ? '消费、Tokens、请求数及用量明细使用此范围。' : '仅控制消费趋势的时间范围。'}</p></div><Select label={(section==='totals' ? '本期用量' : '消费趋势')+'统计时间'} disabled={busy} value={normalizeMenuBarRange(preferences[field])} onChange={value=>void save({[field]:value==='follow' || value==='24h' ? value : Number(value)})}><option value="follow">跟随面板</option><option value="1">今日 · 00:00 起</option><option value="24h">最近 24 小时</option><option value="7">最近 7 天</option><option value="30">最近 30 天</option></Select></div>;
      })}
      <div className="info-note"><Monitor size={15}/><span>工具筛选始终生效。选择“跟随面板”后，弹窗中的今日、7 天、30 天切换会同步更新该区块。</span></div>
    </section>
    <section className="surface panel" aria-label="菜单栏与托盘刷新设置">
      <SectionHeading title="自动刷新" sub="单独设置菜单栏与托盘用量面板的刷新频率"/>
      <div className="setting-control"><div><strong>刷新间隔</strong><p>与工作台页面的自动刷新设置独立；关闭后仍可手动刷新。</p></div><Select tone="blue" label="菜单栏与托盘自动刷新频率" disabled={busy} value={preferences.menuBarRefreshInterval} onChange={value=>void save({menuBarRefreshInterval:Number(value)})}><option value="0">关闭</option><option value="30">30 秒</option><option value="60">1 分钟</option><option value="120">2 分钟</option><option value="300">5 分钟</option><option value="600">10 分钟</option></Select></div>
    </section>
  </div>;
}
