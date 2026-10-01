import {useEffect,useState} from 'react';
import {ArrowDownToLine,Check,FolderOpen,Loader2,RefreshCw,X} from 'lucide-react';
import {bridge} from '../bridge';
import type {UpdateState} from '../../shared/types';

const size=(bytes:number)=>(bytes/1024/1024).toFixed(1)+' MB';
export function UpdateNotice(){
  const [state,setState]=useState<UpdateState|null>(null);
  useEffect(()=>{let active=true;const unsubscribe=bridge.onUpdate(next=>{if(active)setState(next);});void bridge.updateStatus().then(next=>{if(active)setState(next);}).catch(()=>{});return ()=>{active=false;unsubscribe();};},[]);
  if(!state || state.phase==='unsupported')return null;
  const busy=['checking','downloading','verifying'].includes(state.phase);
  const progress=state.total ? Math.min(100,state.received/state.total*100) : 0;
  const label=state.phase==='checking' ? '正在检查更新' : state.phase==='available' ? '新版本 v'+state.version : state.phase==='downloading' ? '下载更新 '+Math.floor(progress)+'%' : state.phase==='verifying' ? '正在校验更新' : state.phase==='ready' ? 'v'+state.version+' 下载完成' : state.phase==='current' ? '已是最新版本' : state.phase==='error' ? '更新失败 · 点击重试' : '检查更新';
  const run=async()=>{
    try{const next=state.phase==='ready' ? (await bridge.showUpdateFile(),state) : state.phase==='available' || state.phase==='error' && state.version && state.total ? await bridge.downloadUpdate() : await bridge.checkUpdate();setState(next);}
    catch(e){setState({...state,phase:'error',error:e instanceof Error ? e.message : '操作失败，请重试。'});}
  };
  return <div className={'sidebar-update '+state.phase} aria-live="polite">
    <div className="update-line"><button className="update-action" type="button" onClick={()=>void run()} disabled={busy} title={state.error || (state.phase==='ready' ? '打开更新文件夹，退出当前 Lumi 后运行新版便携文件。' : state.phase==='available' ? '下载 GitHub Release 最新正式版' : '检查 GitHub Release 最新版本')}>
      {busy ? <Loader2 size={13} className="spin"/> : state.phase==='ready' ? <FolderOpen size={13}/> : state.phase==='available' ? <ArrowDownToLine size={13}/> : state.phase==='current' ? <Check size={13}/> : <RefreshCw size={13}/>}
      <span>{label}</span>
    </button>{state.phase==='downloading' && <button className="update-cancel" type="button" aria-label="取消更新下载" title="取消下载" onClick={()=>void bridge.cancelUpdate()}><X size={12}/></button>}</div>
    {state.phase==='downloading' || state.phase==='verifying' ? <><div className="update-progress" role="progressbar" aria-label="更新下载进度" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.floor(progress)}><i style={{width:progress+'%'}}/></div><span className="update-detail">{size(state.received)} / {size(state.total)}</span></> : state.phase==='ready' ? <span className="update-detail">打开文件夹 · 退出后运行新版</span> : state.phase==='error' && state.error ? <span className="update-detail" title={state.error}>{state.error}</span> : null}
  </div>;
}
