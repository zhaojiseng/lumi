import {createContext,useContext,type LazyExoticComponent,type ComponentType,type ReactNode} from 'react';
export interface ContentView {id:string;label:string;order:number;scope:'site'|'independent';view?:string;component:LazyExoticComponent<ComponentType>;}
export interface ContentViewsValue {models:readonly ContentView[];tokens:readonly ContentView[];siteScope:string;}
const Context=createContext<ContentViewsValue>({models:[],tokens:[],siteScope:''});
export function ContentViewsProvider({value,children}:{value:ContentViewsValue;children:ReactNode}){return <Context.Provider value={value}>{children}</Context.Provider>;}
export function useContentViews(){return useContext(Context);}
