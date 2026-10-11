import type {GatewayModelCatalogDto} from '../../../shared/contracts/gateway';
import type {CoreRoute} from './types.mjs';
export interface ModelCatalog {
 detect(input:{route:CoreRoute;upstreamKey:string;configVersion:number;signal?:AbortSignal;assertFresh:()=>unknown|Promise<unknown>;privateValues?:string[]}):Promise<GatewayModelCatalogDto>;
}
/** Constructor-only hooks are for fixed isolated tests; SDK input has no network options. */
export function createModelCatalog(options?:{lookup?:unknown;request?:unknown;now?:()=>number;timeoutMs?:number}):ModelCatalog;
