import type {ToolRuntimeState} from '../../../shared/types';
export function RuntimeVersions({state,desktop}:{state?:ToolRuntimeState;desktop:boolean}){
  const current=!desktop ? '桌面端检测' : state?.phase==='installing' ? '正在安装' : state?.version ? 'v'+state.version : state?.phase==='error' || state?.installed ? '检测异常' : state ? '未安装' : '检测中…';
  const latest=!desktop ? '桌面端检测' : state?.latestVersion ? 'v'+state.latestVersion : state?.latestCheckedAt ? '暂不可查' : '查询中…';
  return <span className="runtime-versions"><span>当前 <strong>{current}</strong></span><span>最新 <strong>{latest}</strong></span></span>;
}
