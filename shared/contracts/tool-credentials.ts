import type {ConfigRequest,ModelInfo} from '../types';

/** Internal provisioning result: never exposed through renderer IPC. */
export interface ResolvedToolToken {key:string;tokenName:string;tokenId:number;group:string;created:boolean;siteId:string;siteUrl:string;models?:ModelInfo[];}
export interface ToolCredentialCapability {provision(input:ConfigRequest):Promise<ResolvedToolToken>;}
