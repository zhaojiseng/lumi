import type {Page} from '../types';
/** Host-owned state/actions, consumed by trusted interface renderers without service ownership. */
export interface InterfaceNavigation {id:Page;label:string;hint:string;section:'workspace'|'tools'|'settings';}
export const DEFAULT_INTERFACE_ID='interface.default';
export interface InterfaceAppearanceGroup {
  id:string;title:string;defaultOption:string;options:{id:string;title:string}[];
}
export interface InterfaceDefinition {stylesheet:string;preview?:string;appearanceGroups?:InterfaceAppearanceGroup[];}
export interface InterfaceSelection {interfaceId:string;values:Record<string,string>;}
export interface InterfaceStyle {id:string;css:string;preview?:string;appearanceGroups?:InterfaceAppearanceGroup[];}
