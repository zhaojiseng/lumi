import {createContext,useContext,type ReactNode} from 'react';
import {validSelectionValue} from '../../shared/selections';
import type {Preferences,PreferencePatch,SelectionValue} from '../../shared/types';
export interface SourcePreferencesValue {selections:Preferences['sourceSelections'];desktop:boolean;update(patch:PreferencePatch):Promise<unknown>;onError(message:string):void;}
const Context=createContext<SourcePreferencesValue|null>(null);
export function SourcePreferencesProvider({value,children}:{value:SourcePreferencesValue;children:ReactNode}){return <Context.Provider value={value}>{children}</Context.Provider>;}
export function useSourcePreferences(){const value=useContext(Context);if(!value)throw new Error('来源设置宿主未提供。');return value;}
export function useSourceSelection<T extends SelectionValue>(sourceId:'source.local-sessions'|'feature.usage',key:string,fallback:T,validate:(value:T)=>boolean):[T,(value:T)=>void]{
  const context=useSourcePreferences(),saved=context.selections?.[sourceId]?.[key];
  const value=validSelectionValue(saved) && validate(saved as T) ? saved as T : fallback;
  return [value,next=>{void context.update({sourceSelection:{sourceId,values:{[key]:next}}}).catch(error=>context.onError(error instanceof Error ? error.message : '来源设置保存失败。'));}];
}
