import type {Page} from '../types';
/** Host-owned state/actions, consumed by trusted interface renderers without service ownership. */
export interface InterfaceNavigation {id:Page;label:string;hint:string;section:'workspace'|'tools'|'settings';}
export const DEFAULT_INTERFACE_ID='interface.default';
export interface InterfaceStyle {id:string;css:string;}
