import {useEffect,useRef,useState} from 'react';
import {ArrowRight,Check,FileCode2,History,Info,Eye,RotateCcw,KeyRound,CircleAlert,Download,RefreshCw,ChevronDown,Loader2} from 'lucide-react';
import {useApp} from '../context';
import {useSavedSelection} from '../selections';
import {bridge} from '../bridge';
import {Button,PageIntro,Pill,ToolIcon,Select,Modal} from '../components/ui';
import {ChannelSelect} from '../components/ChannelSelect';
import {availableGroups,defaultModelGroup,sortModels} from '../../shared/catalog';
import {RouteDetails} from '../components/Pricing';
import type {Tool,ConfigRequest,ConfigPreview,ConfigProgress,BackupInfo,ToolConfigState,ToolRuntimeState} from '../../shared/types';
import '../tools-progress.css';

type ConfigOperation = Pick<ConfigProgress,'tool'|'operation'> & {progress?:ConfigProgress};
type ConfigError = Pick<ConfigProgress,'tool'|'operation'> & {message:string};
const toolName = (tool:Tool) => tool==='codex' ? 'Codex' : 'Claude Code';
// Keep the lock until the bridge settles, even if its owning page has unmounted.
// Progress has no request ID, so overlapping requests of the same kind are unsafe.
let inFlight:ConfigOperation|null=null;
const operationListeners=new Set<()=>void>();
const notifyOperation=()=>{for(const listener of operationListeners)listener();};

export function ConfigFeedback({pending,error}:{pending?:ConfigOperation|null;error?:string}) {
  let message='';
  if(pending){
    const {operation,progress}=pending;
    const waiting={preview:'正在准备配置预览…',apply:'正在应用配置…',restore:'正在恢复配置…'};
    const phases:Record<ConfigProgress['phase'],string>={
      validating:operation==='preview' ? '正在校验配置…' : operation==='apply' ? '正在检查应用条件…' : '正在检查恢复条件…',
      key:'正在准备专用密钥…',
      history:operation==='restore' ? '正在准备恢复相关历史对话…' : '正在检查相关历史对话…',
      backup:'正在备份当前配置…',
      writing:operation==='preview' ? '正在生成配置预览…' : operation==='apply' ? '正在保存配置…' : '正在恢复配置…',
      done:operation==='preview' ? '预览已就绪，正在加载结果…' : '配置处理完成，正在确认结果…',
    };
    message=toolName(pending.tool)+' · '+(progress ? phases[progress.phase] : waiting[operation]);
  }
  const completed=pending?.progress?.completed,total=pending?.progress?.total;
  const hasCount=Number.isSafeInteger(completed) && completed!>=0;
  const hasTotal=Number.isSafeInteger(total) && total!>0 && total!>=completed!;
  return <>{pending && <div className="tool-config-progress" role="status" aria-live="polite" aria-atomic="true"><Loader2 size={17} className="spin" aria-hidden="true"/><div><strong>{message}</strong>{hasCount && <span>本阶段已处理 {completed}{hasTotal ? ` / ${total}` : ''} 项</span>}</div></div>}{error && <p className="tool-config-error error-text" role="alert">{error}</p>}</>;
}

function RuntimeVersions({state,desktop}:{state?:ToolRuntimeState;desktop:boolean}){
  const current=!desktop ? '桌面端检测' : state?.phase==='installing' ? '正在安装' : state?.version ? 'v'+state.version : state?.phase==='error' || state?.installed ? '检测异常' : state ? '未安装' : '检测中…';
  const latest=!desktop ? '桌面端检测' : state?.latestVersion ? 'v'+state.latestVersion : state?.latestCheckedAt ? '暂不可查' : '查询中…';
  return <span className="runtime-versions"><span>当前 <strong>{current}</strong></span><span>最新 <strong>{latest}</strong></span></span>;
}

function ToolForm({tool,onPreview,runtime,chatgpt,onInstall,onDetect,config,locked,pending,error}:{tool:Tool;onPreview(req:ConfigRequest):Promise<void>;runtime?:ToolRuntimeState;chatgpt?:ToolRuntimeState;onInstall(tool:Tool):void;onDetect():void;config?:ToolConfigState;locked:boolean;pending?:ConfigOperation;error?:string}) {
  const {bootstrap,preferences,dashboard:d,openLogin}=useApp();
  const b=preferences.bindings.find(x=>x.tool===tool && x.siteId===preferences.activeSiteId),state=config || bootstrap.configs.find(x=>x.tool===tool);
  const [model,setModel]=useSavedSelection(tool+'.model',b?.model || state?.model || ''),[group,setGroup]=useSavedSelection(tool+'.group',b?.group || '');
  const [contextWindow,setContextWindow]=useSavedSelection<number>(tool+'.context',(b?.contextWindow ?? state?.contextWindow)===1000000 ? 1000000 : 272000,n=>[272000,1000000].includes(n));
  const [keyInfo,setKeyInfo]=useState(false),[prices,setPrices]=useState(false);
  const site=preferences.sites.find(s=>s.id===preferences.activeSiteId)!,catalog=d?.catalog,models=sortModels(catalog?.models || [],preferences.favoriteModels),selected=models.find(m=>m.model_name===model),groups=selected && catalog ? availableGroups(selected,catalog) : [];
  useEffect(()=>{if(locked || !catalog || !models.length)return;if(model && !selected){setModel('');setGroup('');return;}if(selected && !groups.includes(group))setGroup(defaultModelGroup(selected,catalog));},[model,catalog,group,locked]);
  async function submit(e:React.FormEvent){e.preventDefault();if(locked)return;await onPreview({tool,model,group,...(tool==='codex' ? {contextWindow} : {})});}
  const prefix=preferences.tokenPrefix || 'Lumi-',expected=(prefix+(tool==='codex' ? 'Codex' : 'Claude')).slice(0,50);
  return <section className="surface tool-config-card">
    <div className="tool-config-heading"><ToolIcon tool={tool} size={36}/><div><h2>{tool==='codex' ? 'Codex' : 'Claude Code'}</h2></div><Pill tone={state?.baseUrl ? 'green' : 'muted'}>{state?.baseUrl ? '已配置' : '待配置'}</Pill><button type="button" className="icon-button key-info-button" aria-label={tool+' 专用密钥说明'} title="专用密钥说明" onClick={()=>setKeyInfo(true)}><CircleAlert size={18}/></button></div>
    <div className="tool-runtime" title={runtime?.path}><div><span className={'connection-dot '+(runtime?.version ? '' : 'inactive')}/><span className="runtime-name">{tool==='codex' ? 'Codex CLI' : 'Claude Code CLI'}</span><RuntimeVersions state={runtime} desktop={bootstrap.desktop}/></div><button type="button" className="icon-button" title="重新检测工具" aria-label={tool+' 重新检测'} disabled={locked || !bootstrap.desktop || runtime?.phase==='installing'} onClick={onDetect}><RefreshCw size={14}/></button><Button busy={runtime?.phase==='installing'} disabled={locked || runtime?.phase==='installing' || !bootstrap.desktop || !runtime} onClick={()=>onInstall(tool)}><Download size={14}/>{runtime?.installed ? '更新' : '自动安装'}</Button></div>
    {tool==='codex' && <div className="tool-runtime desktop-runtime" title={chatgpt?.path}><div><span className={'connection-dot '+(chatgpt?.version ? '' : 'inactive')}/><span className="runtime-name">ChatGPT 桌面</span><RuntimeVersions state={chatgpt} desktop={bootstrap.desktop}/></div><button type="button" className="icon-button" title="重新检测 ChatGPT 桌面应用" aria-label="ChatGPT 重新检测" disabled={locked || !bootstrap.desktop} onClick={onDetect}><RefreshCw size={14}/></button></div>}
    {runtime?.message && <p className={'runtime-message '+(runtime.phase==='error' ? 'error-text' : 'muted')} role="status">{runtime.message}</p>}
    <div className="current-config"><span><span className={'connection-dot '+(state?.exists ? '' : 'inactive')}/>{state?.exists ? '当前配置' : '尚未发现配置文件'}</span><strong>{state?.model || '—'}</strong><code>{state?.path || (tool==='codex' ? '~/.codex/config.toml' : '~/.claude/settings.json')}</code>{state?.error && <p className="error-text">{state.error}</p>}</div>
    {!d?.user ? <div className="empty-state"><KeyRound size={23}/><h3>登录后选择可用模型与渠道</h3><p>Lumi 会自动获取模型列表和专用密钥。</p><Button variant="primary" onClick={openLogin}>登录账号<ArrowRight size={14}/></Button></div> : <form onSubmit={submit} className="tool-model-select">
      <div className="form-step"><span>1</span>选择目标模型</div><Select disabled={locked} tone={tool==='codex' ? 'blue' : 'peach'} label={tool+' 目标模型'} value={model} onChange={setModel}><option value="">选择站点模型</option>{models.map(m=><option value={m.model_name} key={m.model_name}>{m.model_name}</option>)}</Select>
      <div className="form-step"><span>2</span>选择可用渠道</div>{catalog && <ChannelSelect disabled={locked || !selected} label={tool+' 模型渠道'} value={group} onChange={setGroup} catalog={catalog} model={selected} groups={groups}/>}
      {tool==='codex' && <div className="context-setting"><span>上下文窗口</span><Select disabled={locked} label="Codex 上下文窗口" tone="blue" value={contextWindow} onChange={v=>setContextWindow(Number(v))}><option value="272000">272K · 默认</option><option value="1000000">1M</option></Select></div>}
      {selected && catalog && group && <div className="tool-price-disclosure"><button type="button" aria-expanded={prices} onClick={()=>setPrices(!prices)}>默认定价<ChevronDown size={14} className={prices ? 'rotated' : ''}/></button><div className={'collapsible-grid '+(prices ? 'expanded' : '')} inert={!prices} aria-hidden={!prices}><div>{<RouteDetails model={selected} catalog={catalog} status={d.status} group={group} defaultOnly/>}</div></div></div>}
      <div className="endpoint-display"><span>接口地址</span><code>{site.url}{tool==='codex' ? '/v1' : ''}</code></div><Button type="submit" variant="primary" busy={!!pending} className="full-width" disabled={locked || !selected || !group || !bootstrap.desktop}><Eye size={16}/>自动配钥并预览<ArrowRight size={15}/></Button>
    </form>}
    <ConfigFeedback pending={pending} error={error}/>
    {keyInfo && <Modal title="自动使用专用密钥" subtitle={tool==='codex' ? 'Codex' : 'Claude Code'} onClose={()=>setKeyInfo(false)}><p className="key-info-copy">复用工具专用密钥，没有时自动创建。切换渠道时，预览操作会更新同一令牌的渠道，密钥保持不变；名称不包含渠道。额度随账户余额。</p><code className="key-info-token">{expected}</code><p className="muted">应用前可预览变更，原始配置会自动加密备份。</p><div className="modal-actions"><Button variant="primary" onClick={()=>setKeyInfo(false)}>知道了</Button></div></Modal>}
  </section>;
}
export default function Tools() {
  const {preferences}=useApp(),site=preferences.sites.find(s=>s.id===preferences.activeSiteId);
  // A changed site or account owns a fresh UI session, including pending previews.
  const scope=JSON.stringify([preferences.activeSiteId,site?.url,site?.userId,site?.username,site?.accessTokenConfigured,site?.apiKeyConfigured,site?.sessionAuth]);
  return <ToolsPage key={scope}/>;
}

function ToolsPage() {
  const {preferences,bootstrap,reloadBootstrap,toast}=useApp();
  const [preview,setPreview]=useState<ConfigPreview|null>(null);
  const [pending,setPending]=useState<ConfigOperation|null>(null);
  const [error,setError]=useState<ConfigError|null>(null);
  const [configs,setConfigs]=useState<ToolConfigState[]|null>(null);
  const [syncNote,setSyncNote]=useState('');
  const [waitingForPrevious,setWaitingForPrevious]=useState(!!inFlight);
  const [fileIndex,setFileIndex]=useState(0),[view,setView]=useState<'before'|'after'>('after');
  const [backups,setBackups]=useState<BackupInfo[]>([]),[history,setHistory]=useState(false);
  const [historyLoading,setHistoryLoading]=useState(false),[restore,setRestore]=useState<BackupInfo|null>(null);
  const [runtimes,setRuntimes]=useState<ToolRuntimeState[]>([]);
  const mounted=useRef(false),lifetime=useRef(0),runtimeRequest=useRef(0);
  const syncVersion=useRef(0);
  const operation=useRef<ConfigOperation|null>(null),historyRequest=useRef(false);
  const installs=useRef(new Set<Tool>());
  const busy=!!pending,locked=busy || waitingForPrevious || historyLoading || !!preview || !!restore || history;
  const currentFile=preview?.files[fileIndex];
  const alive=(session:number)=>mounted.current && lifetime.current===session;
  const current=(request:ConfigOperation)=>mounted.current && operation.current===request;
  const message=(e:unknown,fallback:string)=>e && typeof e==='object' && 'message' in e && typeof e.message==='string' && e.message ? e.message : fallback;

  async function detect(force=false) {
    const session=lifetime.current,request=++runtimeRequest.current;
    try{const states=await bridge.toolRuntimes(force);if(alive(session) && request===runtimeRequest.current)setRuntimes(states);}
    catch(e){if(alive(session) && request===runtimeRequest.current)toast(message(e,'工具检测失败。'),'error');}
  }
  useEffect(()=>{
    mounted.current=true;lifetime.current++;
    const updateLock=()=>{if(mounted.current)setWaitingForPrevious(!!inFlight && inFlight!==operation.current);};
    operationListeners.add(updateLock);updateLock();
    void detect();
    const stopRuntime=bridge.onToolRuntime(state=>{if(mounted.current)setRuntimes(states=>[...states.filter(r=>r.tool!==state.tool),state]);});
    const stopProgress=bridge.onConfigProgress?.(progress=>{
      const request=operation.current;
      if(!request || !current(request) || progress.tool!==request.tool || progress.operation!==request.operation)return;
      // Replace the whole event so counts from the previous phase never carry over.
      setPending({...request,progress});
    });
    const focus=()=>void detect();window.addEventListener('focus',focus);
    return()=>{mounted.current=false;lifetime.current++;operation.current=null;historyRequest.current=false;installs.current.clear();operationListeners.delete(updateLock);stopRuntime();stopProgress?.();window.removeEventListener('focus',focus);};
  },[]);

  async function install(tool:Tool) {
    if(!mounted.current || locked || inFlight || historyRequest.current || installs.current.has(tool))return;
    const session=lifetime.current;installs.current.add(tool);
    setRuntimes(states=>states.map(r=>r.tool===tool ? {...r,phase:'installing',message:'正在准备安装…'} : r));
    try{
      const state=await bridge.installTool(tool);if(!alive(session))return;
      setRuntimes(states=>[...states.filter(r=>r.tool!==tool),state]);
      if(state.phase==='error')toast(state.message || '安装失败','error');else toast(toolName(tool)+' 已就绪 · v'+state.version,'success');
    }catch(e){if(alive(session)){void detect(true);toast(message(e,'工具安装失败。'),'error');}}
    finally{if(alive(session))installs.current.delete(tool);}
  }
  function begin(tool:Tool,kind:ConfigProgress['operation']) {
    // The ref takes the lock synchronously, before React renders disabled buttons.
    if(!mounted.current || inFlight || operation.current || historyRequest.current)return null;
    const request:ConfigOperation={tool,operation:kind};operation.current=request;inFlight=request;notifyOperation();syncVersion.current++;setSyncNote('');setPending(request);setError(null);return request;
  }
  function finish(request:ConfigOperation) {
    if(current(request)){operation.current=null;setPending(null);}
    if(inFlight===request){inFlight=null;notifyOperation();}
  }
  function fail(request:ConfigOperation,e:unknown) {
    if(!current(request))return;
    const text=message(e,{preview:'配置预览失败，请重试。',apply:'应用配置失败，请检查后重试。',restore:'恢复配置失败，请检查后重试。'}[request.operation]);
    setError({...request,message:text});toast(text,'error');
  }
  function syncBootstrap(kind:'apply'|'restore') {
    // Configuration is already successful. Background refresh cannot turn it into a failure.
    const session=lifetime.current,version=++syncVersion.current;
    void reloadBootstrap().catch(()=>{
      if(alive(session) && version===syncVersion.current)setSyncNote(kind==='apply' ? '配置已生效，但同步设置失败。' : '配置已恢复，但同步设置失败。');
    });
  }
  async function previewConfig(req:ConfigRequest) {
    if(locked)return;
    const request=begin(req.tool,'preview');if(!request)return;
    try{const result=await bridge.previewConfig(req);if(!current(request))return;setPreview(result);setFileIndex(0);setView('after');}
    catch(e){fail(request,e);}finally{finish(request);}
  }
  async function apply() {
    if(!preview || !preview.files.length || !bootstrap.desktop)return;
    const request=begin(preview.tool,'apply');if(!request)return;
    try{
      const states=await bridge.applyConfig(preview.id);if(!current(request))return;
      setConfigs(states);setPreview(null);
      toast(preview.tool==='codex' ? '配置已应用，原文件已加密备份。配置与相关旧对话已同步。请重新打开 Codex。' : 'Claude Code CLI 配置已应用，原文件已加密备份。请重新启动 Claude Code。','success');
      syncBootstrap('apply');
    }catch(e){fail(request,e);}finally{finish(request);}
  }
  async function openHistory() {
    if(!mounted.current || locked || inFlight || operation.current || historyRequest.current)return;
    const session=lifetime.current;historyRequest.current=true;setHistoryLoading(true);
    try{const result=await bridge.backups();if(!alive(session))return;setBackups(result);setHistory(true);}
    catch(e){if(alive(session))toast(message(e,'读取配置备份失败。'),'error');}
    finally{if(alive(session)){historyRequest.current=false;setHistoryLoading(false);}}
  }
  async function doRestore() {
    if(!restore || !bootstrap.desktop)return;
    const request=begin(restore.tool,'restore');if(!request)return;
    try{
      const states=await bridge.restoreBackup(restore.id);if(!current(request))return;
      setConfigs(states);setRestore(null);setHistory(false);
      toast('已恢复配置。请重新启动对应工具。','success');syncBootstrap('restore');
    }catch(e){fail(request,e);}finally{finish(request);}
  }
  return <div className="page">
    <PageIntro title="让工具，顺手起来" description="检测安装与版本，选择模型和渠道，预览后应用。" action={<div className="modal-actions"><Button busy={historyLoading} disabled={locked} onClick={openHistory}><History size={16}/>配置备份</Button></div>}/>
    {waitingForPrevious && <p className="muted small-text" role="status">上一项工具配置操作仍在处理中，请稍候。</p>}
    <div className="tools-config-grid">{(['codex','claude'] as const).map(tool=><ToolForm key={`${tool}-${preferences.activeSiteId}`} tool={tool} config={configs?.find(s=>s.tool===tool)} locked={locked} pending={pending?.tool===tool && pending.operation==='preview' ? pending : undefined} error={error?.tool===tool && error.operation==='preview' ? error.message : undefined} onPreview={previewConfig} runtime={runtimes.find(r=>r.tool===tool)} chatgpt={runtimes.find(r=>r.tool==='chatgpt')} onInstall={tool=>void install(tool)} onDetect={()=>void detect(true)}/>)}</div>
    {syncNote && <p className="muted small-text" role="status">{syncNote}</p>}
    <div className="info-note"><Info size={15}/><span>设置中的环境变量只写入工具配置文件。系统或项目级环境变量可能覆盖这些设置；应用后请重启 Codex / Claude Code。与 CC Switch 同时切换配置时，请重新检查预览。</span></div>
    {preview && <Modal title="确认配置变更" subtitle={preview.tool==='codex' ? 'Codex · Responses API' : 'Claude Code · Anthropic API'} wide onClose={()=>{if(!operation.current)setPreview(null);}}>
      <div className="preview-token"><KeyRound size={16}/><span>{preview.token?.created ? '已创建' : '已复用'}专用令牌 <strong>{preview.token?.name}</strong> · {preview.token?.group}</span></div>
      <div className="preview-changes">{preview.changes.map((s,i)=><div key={i}><Check size={14}/><span>{s}</span></div>)}</div>
      {preview.tool==='codex' && <p className="muted small-text">相关历史对话会在应用时检查并同步。</p>}
      <div className="preview-file-tabs">{preview.files.map((f,i)=><button key={f.path} className={fileIndex===i ? 'active' : ''} onClick={()=>setFileIndex(i)}><FileCode2 size={14}/>{f.path.split(/[\\/]/).at(-1)}</button>)}<div className="segmented"><button className={view==='before' ? 'active' : ''} onClick={()=>setView('before')}>修改前</button><button className={view==='after' ? 'active' : ''} onClick={()=>setView('after')}>修改后</button></div></div>
      {currentFile && <><p className="preview-path">{currentFile.path}</p><pre className="code-preview">{currentFile[view]}</pre></>}
      <ConfigFeedback pending={pending?.operation==='apply' ? pending : null} error={error?.operation==='apply' ? error.message : undefined}/>
      <div className="modal-actions"><span className="muted small-text">原配置会在写入前自动加密备份</span><Button onClick={()=>{if(!operation.current)setPreview(null);}} disabled={busy}>取消</Button><Button variant="primary" busy={busy} onClick={apply} disabled={busy || !bootstrap.desktop || !preview.files.length}><Check size={16}/>备份并应用</Button></div>
    </Modal>}
    {history && <Modal title="配置备份" subtitle="备份包含原始配置与认证，保存在本机系统加密存储中。" onClose={()=>setHistory(false)}><div className="backup-list">{backups.length ? backups.map(b=><div key={b.id}><ToolIcon tool={b.tool} size={33}/><div><strong>{toolName(b.tool)}</strong><span>{new Date(b.createdAt).toLocaleString()}</span></div><Button disabled={busy || !bootstrap.desktop} onClick={()=>{if(operation.current)return;setHistory(false);setError(null);setRestore(b);}}><RotateCcw size={14}/>恢复</Button></div>) : <div className="empty-state"><History size={28}/><h3>暂无备份</h3><p>首次应用工具配置后，备份会显示在这里。</p></div>}</div></Modal>}
    {restore && <Modal title="恢复配置" subtitle={`恢复 ${new Date(restore.createdAt).toLocaleString()} 修改前的文件`} onClose={()=>{if(!operation.current)setRestore(null);}}>
      <div className="info-note"><Info size={16}/><span>恢复会修改 {toolName(restore.tool)} 的本机配置，并先备份当前文件。若文件被其他程序修改，本次恢复将停止。</span></div>
      <ConfigFeedback pending={pending?.operation==='restore' ? pending : null} error={error?.operation==='restore' ? error.message : undefined}/>
      <div className="modal-actions"><Button disabled={busy} onClick={()=>{if(!operation.current)setRestore(null);}}>取消</Button><Button busy={busy} disabled={busy || !bootstrap.desktop} variant="primary" onClick={doRestore}><RotateCcw size={15}/>备份并恢复</Button></div>
    </Modal>}
  </div>;
}
