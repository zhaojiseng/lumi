import {useState,useEffect,useRef} from 'react';
import {RefreshCw,TerminalSquare} from 'lucide-react';
import {useApp} from '../../../src/context';
import {bridge} from '../../../src/bridge';
import {Button,SectionHeading} from '../../../src/components/ui';
import type {ToolRuntimeState} from '../../../shared/types';
export default function CodexConnection(){
  const {bootstrap,setPage}=useApp(),[runtime,setRuntime]=useState<ToolRuntimeState>(),[busy,setBusy]=useState(false),[error,setError]=useState('');
  const request=useRef(0);
  useEffect(()=>{const version=++request.current;if(bootstrap.desktop)void bridge.toolRuntimes().then(states=>{if(version===request.current)setRuntime(states.find(s=>s.tool==='codex'));}).catch(()=>{});return()=>{++request.current;};},[bootstrap.desktop]);
  async function detect(){const version=++request.current;setBusy(true);setError('');try{const states=await bridge.toolRuntimes(true);if(version===request.current)setRuntime(states.find(s=>s.tool==='codex'));}catch(e){if(version===request.current)setError(e instanceof Error ? e.message : '检测失败，请重试。');}finally{if(version===request.current)setBusy(false);}}
  return <section className="surface panel"><SectionHeading title="Codex" sub="使用本机 Codex CLI 的 ChatGPT 登录连接" action={<Button disabled={!bootstrap.desktop} busy={busy} onClick={()=>void detect()}><RefreshCw size={15}/>检测连接</Button>}/>
    <div className="setting-control"><div><strong>{runtime?.installed ? '已发现 Codex CLI'+(runtime.version ? ' · '+runtime.version : '') : '安装 CLI 并登录后读取订阅限额'}</strong><p>在终端执行 codex login 登录 ChatGPT；Lumi 通过 CLI 读取限额和积分，不保存登录密钥。</p>{runtime?.path && <code>{runtime.path}</code>}</div><Button onClick={()=>setPage('tools')}><TerminalSquare size={15}/>工具配置</Button></div>
    {error && <p role="alert" className="error-text">{error}</p>}{!bootstrap.desktop && <p className="muted">本机连接检测需要桌面应用。</p>}
  </section>;
}
