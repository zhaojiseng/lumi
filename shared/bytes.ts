import type {UpdateState} from './types';

/** Binary units, with extra precision for small values and no trailing zeroes. */
export function formatBytes(bytes:number):string {
  if(!Number.isFinite(bytes) || bytes<=0)return '0 B';
  const units=['B','KB','MB','GB'];
  let value=bytes,unit=0;
  while(value>=1024 && unit<units.length-1){value/=1024;unit++;}
  const precision=unit===0 ? 0 : value<10 ? 2 : value<100 ? 1 : 0;
  let rounded=Number(value.toFixed(precision));
  if(rounded>=1024 && unit<units.length-1){rounded=1;unit++;}
  return rounded+' '+units[unit];
}

type DownloadState=Pick<UpdateState,'phase'|'received'|'total'> & {packageSize?:number};

/** received/total describe network transfer; packageSize describes the final installer. */
export function updateDownloadDisplay(state:DownloadState){
  const received=Number.isFinite(state.received) && state.received>0 ? state.received : 0;
  const total=Number.isFinite(state.total) && state.total>0 ? state.total : null;
  // Older states used total for the full installer and did not expose packageSize.
  const packageSize=state.packageSize===undefined ? total : Number.isFinite(state.packageSize) && state.packageSize>0 ? state.packageSize : null;
  const isDifferential=total!==null && packageSize!==null && total<packageSize;
  return {
    percent:total===null ? null : Math.min(100,received/total*100),
    isDifferential,
    // A reused local installer can reach verification without any transfer event.
    showTransfer:state.phase==='downloading' || received>0 || total!==null && ['verifying','ready','installing'].includes(state.phase),
    downloadLabel:'已下载 '+formatBytes(received)+' / '+(total===null ? '总量未知' : '需下载 '+formatBytes(total)),
    packageLabel:(isDifferential ? '增量下载 · ' : '')+'安装包 '+(packageSize===null ? '大小未知' : formatBytes(packageSize)),
  };
}
