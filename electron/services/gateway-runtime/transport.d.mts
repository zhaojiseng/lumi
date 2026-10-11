import type {CoreConfig,DataGateway,Engine,RouteSecret} from './types.mjs';
import type {ModelCatalog} from './catalog.mjs';
export function createGateway(input:{config:CoreConfig;routeSecrets:RouteSecret[];engine:Engine;drainTimeoutMs?:number;publicUpstreams?:boolean;modelCatalog?:ModelCatalog;catalogPrivateValues?:string[];allowBareModelsAlias?:boolean;onTrace?:(trace:Record<string,any>)=>void}):Promise<DataGateway>;
export function isPublicAddress(address:string):boolean;
export function resolvePublicAddresses(host:string,lookup?:unknown,signal?:AbortSignal):Promise<Array<{address:string;family:4|6}>>;
export function targetUrl(base:string,endpoint:string):URL;
