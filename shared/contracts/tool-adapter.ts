import type {ConfigRequest} from '../types';
export interface ToolConfigBuild {request:ConfigRequest;config:string|null;auth:string|null;baseUrl:string;key:string;configDir:string;}
/** Pure formatting only; encrypted backups, idle checks and atomic writes stay host-owned. */
export interface ToolConfigAdapter {build(input:ToolConfigBuild):{config:string;auth?:string};}
