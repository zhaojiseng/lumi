import {useState} from 'react';
import {useApp} from '../context';
import {Button,Select} from './ui';
import {DataRefreshMotion} from './DataRefreshMotion';
import {refreshAnimation,DATA_REFRESH_ANIMATIONS,type DataRefreshAnimation} from '../../shared/motion';
const labels:Record<DataRefreshAnimation,string>={'slide-up':'向上滚动','slide-down':'向下滚动',blur:'模糊后清晰',fade:'淡入',scale:'轻微缩放',none:'关闭动画'};
export function RefreshAnimationSettings(){
  const {preferences,updatePreferences,toast}=useApp(),[preview,setPreview]=useState(0);
  const animation=refreshAnimation(preferences.dataRefreshAnimation);
  async function choose(value:string){try{await updatePreferences({dataRefreshAnimation:refreshAnimation(value)});setPreview(v=>v+1);}catch(e:any){toast(e.message || '动画设置未能保存','error');}}
  return <div className="refresh-animation-setting"><div className="setting-control"><div><strong>数据刷新动画</strong><p>工作台统计、最近活动、趋势图与浮窗整体过渡；相同数据不重复播放，遵循系统减少动态效果设置。</p></div><Select label="数据刷新动画" decorated={false} value={animation} onChange={choose}>{DATA_REFRESH_ANIMATIONS.map(value=><option key={value} value={value}>{labels[value]}</option>)}</Select></div><div className="refresh-animation-preview"><DataRefreshMotion identity={String(preview)} animation={animation}><span className="muted">动画预览</span><strong>{preview%2 ? '¥ 24.80' : '¥ 25.00'}</strong></DataRefreshMotion><Button onClick={()=>setPreview(v=>v+1)}>预览动画</Button></div></div>;
}
