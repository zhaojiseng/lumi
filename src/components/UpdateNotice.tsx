import {Check,Loader2,RefreshCw,X,Sparkles,RotateCw} from 'lucide-react';
import {bridge} from '../bridge';
import {useApp} from '../context';
import {Button,SectionHeading} from './ui';
import {useUpdates} from './UpdateDialog';

const size=(bytes:number)=>(bytes/1024/1024).toFixed(1)+' MB';
export function UpdateNotice({placement='sidebar'}:{placement?:'sidebar'|'settings'}){
  const {preferences,updatePreferences,toast}=useApp();
  const {state,review}=useUpdates();
  if(!state || state.phase==='unsupported')return null;
  const dismissed=!!preferences.dismissedUpdateVersion && (!state.version || state.version===preferences.dismissedUpdateVersion);
  const skipped=!!state.version && state.version===preferences.skippedUpdateVersion;
  if(placement==='sidebar' && (dismissed || skipped))return null;
  const setDismissed=async(version:string)=>{try{await updatePreferences({dismissedUpdateVersion:version});}catch(e){toast(e instanceof Error ? e.message : '设置保存失败，请重试。','error');}};
  const busy=['checking','downloading','verifying','installing'].includes(state.phase);
  const manual=state.installMode==='replace';
  const progress=state.total ? Math.min(100,state.received/state.total*100) : 0;
  const highlighted=['available','downloading','verifying','ready','installing'].includes(state.phase);
  const label=state.phase==='checking' ? '正在检查更新' : state.phase==='available' ? skipped ? '已跳过 · 查看更新' : '查看更新' : state.phase==='downloading' ? '下载中 '+Math.floor(progress)+'%' : state.phase==='verifying' ? '正在校验' : state.phase==='ready' ? '查看更新 · 安装' : state.phase==='installing' ? manual ? '正在打开 Finder' : '正在重启更新' : state.phase==='current' ? '已是最新版本' : state.phase==='error' ? '更新失败 · 点击重试' : '检查更新';
  const notice=<div className={'sidebar-update '+state.phase+(highlighted ? ' highlighted' : '')} aria-live="polite">
    {highlighted && <div className="update-heading"><Sparkles size={14}/><strong>{state.phase==='ready' ? '更新就绪' : '新版本'}</strong><span>v{state.version}</span>{placement==='sidebar' && state.phase!=='installing' && <button type="button" className="update-dismiss" aria-label="隐藏更新提示" title="隐藏本次更新提示，设置中仍可查看" onClick={()=>void setDismissed(state.version!)}><X size={13}/></button>}</div>}
    <div className="update-line"><button className="update-action" type="button" onClick={()=>void review()} disabled={busy} title={state.error || '先查看更新说明，再选择立即更新或跳过该版本'}>
      {busy ? <Loader2 size={14} className="spin"/> : state.phase==='ready' ? <RotateCw size={14}/> : state.phase==='available' ? <Sparkles size={14}/> : state.phase==='current' ? <Check size={13}/> : <RefreshCw size={13}/>}
      <span>{label}</span>
    </button>{state.phase==='downloading' && <button className="update-cancel" type="button" aria-label="取消更新下载" title="取消下载" onClick={()=>void bridge.cancelUpdate()}><X size={12}/></button>}</div>
    {state.phase==='downloading' || state.phase==='verifying' ? <><div className="update-progress" role="progressbar" aria-label="更新下载进度" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.floor(progress)}><i style={{width:progress+'%'}}/></div><span className="update-detail">{size(state.received)} / {size(state.total)}</span></> : state.phase==='ready' ? <span className="update-detail">{manual ? '已校验 · 自动退出并打开 Finder' : '已校验 · 重启后自动完成'}</span> : state.phase==='available' ? <span className="update-detail">{skipped ? '设置中仍可安装此版本' : manual ? '自动退出并打开 DMG 安装窗口' : '下载后自动重启更新'}</span> : state.phase==='error' && state.error ? <span className="update-detail" title={state.error}>{state.error}</span> : null}
  </div>;
  return placement==='settings' ? <section className="surface panel update-settings"><SectionHeading title="软件更新" sub={'当前版本 v'+state.currentVersion+' · 隐藏只影响当前版本的左栏提示'}/>{notice}{dismissed && <Button onClick={()=>void setDismissed('')}>恢复左栏提示</Button>}</section> : notice;
}
