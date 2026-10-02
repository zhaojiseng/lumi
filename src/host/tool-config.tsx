import {createContext,useContext,type ComponentType,type ReactNode} from 'react';
import type {ConfigRequest,ConfigProgress,Tool,ToolBinding,ToolConfigState,ToolRuntimeState} from '../../shared/types';

export type ConfigOperation=Pick<ConfigProgress,'tool'|'operation'> & {progress?:ConfigProgress};
export interface ToolConfigOptions {fields:ReactNode;request:Pick<ConfigRequest,'contextWindow'|'disableAttributionHeader'>;}
export interface ToolRuntimeExtrasProps {state?:ToolRuntimeState;desktop:boolean;locked:boolean;onDetect():void;}
/** Trusted tool adapters own defaults, validation and additional fields, not transactions. */
export interface ToolConfigView {
  view?:string;
  tool:Tool;label:string;runtimeLabel:string;defaultPath:string;endpointSuffix:string;tokenSuffix:string;tone:'blue'|'peach';
  useOptions(binding:ToolBinding|undefined,state:ToolConfigState|undefined,locked:boolean):ToolConfigOptions;
  RuntimeExtras?:ComponentType<ToolRuntimeExtrasProps>;
}
export const ToolConfigContext=createContext<readonly ToolConfigView[]>([]);
export const ToolConfigViewsProvider=ToolConfigContext.Provider;
export function useToolConfigViews(){return useContext(ToolConfigContext);}
