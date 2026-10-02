import {Loader2} from 'lucide-react';
import type {LocalUsageProgress as ScanProgress} from '../../shared/types';

const count=(value:number)=>Number.isFinite(value) && value>=0 ? Math.floor(value) : 0;
export function localUsageBytes(value:number) {
  if(value<1024)return value.toLocaleString()+' B';
  if(value<1024*1024)return (value/1024).toLocaleString('zh-CN',{maximumFractionDigits:1})+' KB';
  if(value<1024*1024*1024)return (value/1024/1024).toLocaleString('zh-CN',{maximumFractionDigits:1})+' MB';
  return (value/1024/1024/1024).toLocaleString('zh-CN',{maximumFractionDigits:1})+' GB';
}
export function LocalUsageProgress({progress}:{progress:ScanProgress|null}) {
  if(!progress || progress.phase==='complete')return null;
  const discovering=progress.phase==='discover',done=count(progress.filesDone),total=count(progress.filesTotal);
  const read=count(progress.bytesRead),size=count(progress.bytesTotal),known=size>0;
  const percent=known ? Math.min(100,read/size*100) : 0;
  // Keep a real fraction below 100% until all announced bytes have been read.
  const label=read>=size ? 100 : Math.floor(percent*10)/10;
  return <div className="local-usage-progress surface" role="status" aria-live="polite">
    <div className="local-usage-progress-heading"><Loader2 size={16} className="spin"/><strong>{discovering ? '正在查找本机会话' : '正在读取本机会话'}</strong>{!discovering && known && <span>{label.toLocaleString('zh-CN',{maximumFractionDigits:1})}%</span>}</div>
    {discovering ? <p>已发现 {total.toLocaleString()} 个会话文件</p> : <>
      <div className="local-usage-progress-track" role="progressbar" aria-label="本机会话读取进度" aria-valuemin={known ? 0 : undefined} aria-valuemax={known ? 100 : undefined} aria-valuenow={known ? percent : undefined} aria-valuetext={known ? `${localUsageBytes(read)} / ${localUsageBytes(size)}` : `已读取 ${localUsageBytes(read)}`}>{known && <i style={{width:`${percent}%`}}/>}</div>
      <p><span>已读取 {localUsageBytes(read)}{known ? ` / ${localUsageBytes(size)}` : ''}</span><span>文件 {done.toLocaleString()} / {total.toLocaleString()}</span></p>
    </>}
  </div>;
}
