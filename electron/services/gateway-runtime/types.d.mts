export interface CoreRoute {
 id:string;client:string;protocol:'openai'|'anthropic';upstream:string;serviceTier:boolean;enabled:boolean;
 name?:string;models?:Array<{id:string;upstreamModel:string;enabled:boolean}>;entryEndpoints?:Array<'/v1/responses'|'/v1/chat/completions'|'/v1/messages'>;upstreamEndpoint?:'/v1/responses'|'/v1/chat/completions'|'/v1/messages';
}
export interface CoreConfig {
 schemaVersion:1;configVersion:number;listen:string;routes:CoreRoute[];rules:unknown[];rectifiers?:unknown[];agents?:Array<{id:string;name:string;credentialRef:string;providerIds:string[];enabled:boolean}>;
 recording:{bodies:boolean;retentionDays:number;maxRecords:number;maxBytes:number;captureBytes:number};
 maxRequestBytes:number;maxConcurrency:number;
}
export interface ManagementIdentity {
 instanceId:string;alias:string;port:number;certificatePem:string;privateKeyPem:string;fingerprintSha256:string;token:string;
}
export interface RouteSecret {routeId:string;clientKey:string;upstreamKey:string;}
export interface Engine {
 bootstrap:{protocolVersion:1;config:CoreConfig;management:ManagementIdentity|null;routeSecrets:RouteSecret[]};
 request(method:string,input?:unknown):Promise<unknown>;
 close():Promise<void>;
}
export interface GatewayHostCommitStage {assertFresh():void;commit():void;rollback():Promise<void>;}
export interface ManagementGateway {
 port:number;
 configure(expectedVersion:number,update:{config:CoreConfig;credentials?:unknown;management?:{alias:string;port:number}},prepareHostCommit?:(management:{alias:string;port:number})=>Promise<GatewayHostCommitStage>):Promise<{configVersion:number;management:{alias:string;port:number}}>;
 metrics():{recordingFailures:number};
 prepareConfiguration(expectedVersion:number):Promise<{config:CoreConfig;configVersion:number}>;
 close():Promise<void>;
}

export interface DataGateway {
 address:string;metrics:{recordingFailures:number};activeRequests():number;
 liveMetrics?():Array<{id:string;elapsedMs:number;rateWindow:import('../../../shared/contracts/gateway').GatewayOutputRateWindowDto}>;
 prepareConfig(config:CoreConfig,secrets?:RouteSecret[]):Promise<{assertFresh():void;activate():void;cancel():Promise<void>}>;
 updateConfig(config:CoreConfig):void;stop(options?:{mode?:'drain'|'cancel'}):Promise<void>;
}
