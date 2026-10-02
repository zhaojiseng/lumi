import {createContext,useContext,type ComponentType,type LazyExoticComponent,type ReactNode} from 'react';
export interface WorkbenchCardProps {refreshInterval:number;refreshEpoch:number;}
export interface WorkbenchCard {id:string;title:string;order:number;scope:'site'|'independent';view?:string;component:LazyExoticComponent<ComponentType<WorkbenchCardProps>>;}
export interface WorkbenchValue extends WorkbenchCardProps {cards:readonly WorkbenchCard[];siteScope:string;}
const Context=createContext<WorkbenchValue>({cards:[],siteScope:'',refreshInterval:0,refreshEpoch:0});
export function WorkbenchProvider({value,children}:{value:WorkbenchValue;children:ReactNode}){return <Context.Provider value={value}>{children}</Context.Provider>;}
export function useWorkbench(){return useContext(Context);}
