import {Logo,Button} from './ui';
export function StartupScreen({error,retry}:{error?:string;retry:()=>void}){
  return <div className="startup-screen" role="status" aria-live="polite"><div className="startup-brand"><Logo/><h1>Lumi</h1><p>你的 AI，尽在一处</p></div>{error ? <><p className="startup-error">{error}</p><Button onClick={retry}>重新加载</Button></> : <><div className="startup-dots" aria-hidden="true"><i/><i/><i/></div><p className="startup-message">正在读取本机设置…</p></>}</div>;
}
