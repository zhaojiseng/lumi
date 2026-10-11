import type {Engine,ManagementIdentity,ManagementGateway,RouteSecret} from './types.mjs';
import type {ModelCatalog} from './catalog.mjs';
export function validatePublicUpstream(value:string):Promise<string>;
export function createManagementGateway(input:{dataDir:string;engine:Engine;identity:ManagementIdentity;routeSecrets:RouteSecret[];allowFixtureUpstream?:boolean;startData?:boolean;modelCatalog?:ModelCatalog}):Promise<ManagementGateway>;
