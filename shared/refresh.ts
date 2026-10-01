/** A disabled interval stays disabled; small values never create tight polling loops. */
export function refreshSeconds(value:unknown,fallback=60):number {
  return typeof value==='number' && Number.isInteger(value) && value>=0 && value<=3600 ? value===0 ? 0 : Math.max(15,value) : fallback;
}
export function refreshLabel(seconds:number) {
  const value=refreshSeconds(seconds);
  return value===0 ? '自动刷新已关闭' : value<60 ? `每 ${value} 秒自动刷新` : value%60===0 ? `每 ${value/60} 分钟自动刷新` : `每 ${value} 秒自动刷新`;
}
