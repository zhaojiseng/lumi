import {createContext,useContext,type LazyExoticComponent,type ComponentType,type ReactNode} from 'react';
export interface UsageView {id:string;label:string;order:number;scope:'site'|'independent';view?:string;component:LazyExoticComponent<ComponentType>;}
interface UsageValue {views:readonly UsageView[];siteScope:string;}
const Context=createContext<UsageValue>({views:[],siteScope:''});
export function UsageProvider({value,children}:{value:UsageValue;children:ReactNode}){return <Context.Provider value={value}>{children}</Context.Provider>;}
export function useUsageViews(){return useContext(Context);}
