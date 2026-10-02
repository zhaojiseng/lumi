import {createContext,useCallback,useContext,useEffect,useRef,useState,type ReactNode} from 'react';
import {ArrowDownToLine,ExternalLink,Loader2} from 'lucide-react';
import {bridge} from '../bridge';
import {useApp} from '../context';
import {Button,Logo,Modal} from './ui';
import {shouldPromptUpdate} from '../../shared/updates';
import {updateDownloadDisplay} from '../../shared/bytes';
import type {UpdateState} from '../../shared/types';
import {InterfaceOverlay} from '../host/overlay';

const UpdateContext=createContext<{state:UpdateState|null;review():Promise<void>}|null>(null);
export function useUpdates(){const value=useContext(UpdateContext);if(!value)throw new Error('Missing UpdateDialogProvider');return value;}
function ReleaseNotes({notes}:{notes:string}){
  if(!notes)return <p className="release-notes-empty">此版本暂未提供更新说明，可在 GitHub Release 中查看。</p>;
  return <div className="release-notes">{notes.split('\n').map((line,i)=>{
    const heading=/^#{1,6}\s+(.+)$/.exec(line),bullet=/^\s*[-*]\s+(.+)$/.exec(line);
    if(heading)return <h3 key={i}>{heading[1]}</h3>;
    if(bullet)return <p className="release-note-item" key={i}><span aria-hidden="true">•</span><span>{bullet[1]}</span></p>;
    return line.trim() ? <p key={i}>{line}</p> : <div className="release-note-gap" key={i}/>;
  })}</div>;
}
export function UpdateDialogProvider({children}:{children:ReactNode}){
  const {preferences,updatePreferences,toast}=useApp();
  const [state,setState]=useState<UpdateState|null>(null),[open,setOpen]=useState(false),[operating,setOperating]=useState(false),[error,setError]=useState('');
  const seen=useRef(''),running=useRef(false);
  useEffect(()=>{let active=true;const stop=bridge.onUpdate(next=>{if(active)setState(next);});void bridge.updateStatus().then(next=>{if(active)setState(current=>current || next);}).catch(()=>{});return()=>{active=false;stop();};},[]);
  useEffect(()=>{if(shouldPromptUpdate(state,preferences.skippedUpdateVersion,preferences.dismissedUpdateVersion,seen.current)){seen.current=state!.version!;setError('');setOpen(true);}},[state,preferences.skippedUpdateVersion,preferences.dismissedUpdateVersion]);
  const review=useCallback(async()=>{
    try{const next=state?.version && ['available','ready','error','downloading','verifying','installing'].includes(state.phase) ? state : await bridge.checkUpdate();setState(next);if(next.version){seen.current=next.version;setError('');setOpen(true);}else if(next.phase==='current')toast('已是最新版本。','success');}
    catch(e){toast(e instanceof Error ? e.message : '更新检查失败，请重试。','error');}
  },[state,toast]);
  useEffect(()=>bridge.onReviewUpdate(()=>{void review();}),[review]);
  const close=()=>{if(!running.current){setOpen(false);setError('');}};
  const skip=async()=>{
    if(!state?.version || running.current)return;
    try{await updatePreferences({skippedUpdateVersion:state.version,dismissedUpdateVersion:''});setOpen(false);}
    catch(e){setError(e instanceof Error ? e.message : '设置保存失败，请重试。');}
  };
  const install=async()=>{
    if(!state?.version || running.current)return;
    running.current=true;setOperating(true);setError('');
    try{
      if(preferences.skippedUpdateVersion===state.version || preferences.dismissedUpdateVersion===state.version)await updatePreferences({skippedUpdateVersion:'',dismissedUpdateVersion:''});
      const next=state.phase==='ready' ? state : await bridge.downloadUpdate();setState(next);
      if(next.phase==='error')throw new Error(next.error || '更新下载失败，请重试。');
      if(next.phase!=='ready')return;
      if(next.installMode==='replace')await bridge.openUpdateFile();else await bridge.restartUpdate();
    }catch(e){setError(e instanceof Error ? e.message : '更新失败，请重试。');}
    finally{running.current=false;setOperating(false);}
  };
  const busy=operating || !!state && ['downloading','verifying','installing'].includes(state.phase);
  const display=state ? updateDownloadDisplay(state) : null,progress=display?.percent ?? null;
  const progressLabel=state?.phase==='downloading' ? '正在下载'+(progress===null ? '' : ` ${Math.floor(progress)}%`) : state?.phase==='verifying' ? '正在校验安装包' : state?.phase==='installing' ? state.installMode==='replace' ? '正在打开 Finder…' : '正在重启更新…' : '准备更新…';
  return <UpdateContext.Provider value={{state,review}}>{children}{open && state?.version && <InterfaceOverlay><Modal title="Lumi 有新版本" subtitle={'v'+state.currentVersion+' → v'+state.version} onClose={close} className="update-release-modal">
    <div className="release-summary"><Logo small/><div><strong>Lumi {state.version}</strong><span>{state.installMode==='replace' ? '下载后自动退出，并打开 Finder 安装窗口' : '下载后自动重启，完成更新'}</span></div></div>
    <div className="release-notes-scroll" tabIndex={0} aria-label="更新内容"><ReleaseNotes notes={state.releaseNotes || ''}/></div>
    {state.releaseUrl && <button className="text-link release-github" onClick={()=>void bridge.openExternal(state.releaseUrl!).catch(e=>setError(e.message))}>在 GitHub 查看完整说明<ExternalLink size={13}/></button>}
    {(error || state.error) && <p className="release-error" role="alert">{error || state.error}</p>}
    {display && <div className="release-download" role={busy ? 'status' : undefined}>
      {busy && <span><Loader2 size={14} className="spin"/>{progressLabel}</span>}
      {state.phase==='ready' && !operating && <span>安装包已校验</span>}
      {state.phase==='downloading' && <div className={'update-progress'+(progress===null ? ' indeterminate' : '')} role="progressbar" aria-label="更新下载进度" aria-valuemin={0} aria-valuemax={100} aria-valuenow={progress===null ? undefined : Math.floor(progress)} aria-valuetext={display.downloadLabel}><i style={progress===null ? undefined : {width:progress+'%'}}/></div>}
      <div className="release-download-details">{display.showTransfer && <span>{display.downloadLabel}</span>}<span>{display.packageLabel}</span></div>
      {state.phase==='downloading' && <button className="text-link" onClick={()=>void bridge.cancelUpdate().catch(e=>setError(e.message))}>取消下载</button>}
    </div>}
    <div className="modal-actions"><Button disabled={busy} onClick={()=>void skip()}>跳过该版本</Button><Button variant="primary" disabled={busy} onClick={()=>void install()}><ArrowDownToLine size={15}/>立即更新</Button></div>
  </Modal></InterfaceOverlay>}</UpdateContext.Provider>;
}
