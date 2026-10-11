/** Optional, permission-isolated gateway management API. Extension API remains v1. */
export const GATEWAY_PROTOCOL_VERSION=1 as const;
export const GATEWAY_MAX_IPC_BYTES=256*1024;
export const GATEWAY_METHODS=[
  'gateway.status','gateway.pair','gateway.connect','gateway.disconnect',
  'gateway.local.status','gateway.local.setup','gateway.local.configure',
  'gateway.listener.start','gateway.listener.stop',
  'gateway.events.subscribe','gateway.events.unsubscribe',
  'gateway.routes.config.get','gateway.routes.config.set',
  'gateway.routes.save','gateway.routes.delete',
  'gateway.routes.models.detect','gateway.routes.models.preview',
  'gateway.agents.get','gateway.agents.replace',
  'gateway.rectifiers.list','gateway.rectifiers.replace','gateway.rectifiers.preview',
  'gateway.chain.snapshot',
  'gateway.rules.list','gateway.rules.preview','gateway.rules.replace',
  'gateway.recording.config.get','gateway.recording.config.set',
  'gateway.records.list','gateway.records.get','gateway.records.delete','gateway.records.export',
  'gateway.cliConfig.preview','gateway.cliConfig.apply','gateway.cliConfig.restore',
] as const;
export type GatewayMethod=typeof GATEWAY_METHODS[number];
export type GatewayPermission='gateway.control'|'gateway.config'|'gateway.records.read'|'gateway.records.manage'|'gateway.cli-config';
export const GATEWAY_METHOD_PERMISSIONS:Record<GatewayMethod,GatewayPermission>={
  'gateway.status':'gateway.control','gateway.pair':'gateway.control','gateway.connect':'gateway.control','gateway.disconnect':'gateway.control',
  'gateway.local.status':'gateway.control','gateway.local.setup':'gateway.config','gateway.local.configure':'gateway.config',
  'gateway.listener.start':'gateway.control','gateway.listener.stop':'gateway.control',
  'gateway.events.subscribe':'gateway.control','gateway.events.unsubscribe':'gateway.control',
  'gateway.routes.config.get':'gateway.config','gateway.routes.config.set':'gateway.config',
  'gateway.routes.save':'gateway.config','gateway.routes.delete':'gateway.config',
  'gateway.routes.models.detect':'gateway.config','gateway.routes.models.preview':'gateway.config',
  'gateway.agents.get':'gateway.config','gateway.agents.replace':'gateway.config',
  'gateway.rectifiers.list':'gateway.config','gateway.rectifiers.replace':'gateway.config','gateway.rectifiers.preview':'gateway.config',
  'gateway.chain.snapshot':'gateway.records.read',
  'gateway.rules.list':'gateway.config','gateway.rules.preview':'gateway.config','gateway.rules.replace':'gateway.config',
  'gateway.recording.config.get':'gateway.config','gateway.recording.config.set':'gateway.config',
  'gateway.records.list':'gateway.records.read','gateway.records.get':'gateway.records.read',
  'gateway.records.delete':'gateway.records.manage','gateway.records.export':'gateway.records.manage',
  'gateway.cliConfig.preview':'gateway.cli-config','gateway.cliConfig.apply':'gateway.cli-config','gateway.cliConfig.restore':'gateway.cli-config',
};
export function isGatewayMethod(method:string):method is GatewayMethod {
  return (GATEWAY_METHODS as readonly string[]).includes(method);
}
export type TierFieldDto={state:'missing'|'null'|'invalid'|'unavailable'}|{state:'string';value:string};
export type TierActionDto={type:'preserve'|'remove'}|{type:'set-if-missing'|'override';value:string};
export type GatewayEndpoint='/v1/responses'|'/v1/chat/completions'|'/v1/messages';
export interface TierRuleDto {
  id:string;enabled:boolean;priority:number;
  match:{routeId?:string;clientAlias?:string;endpoint?:GatewayEndpoint;model?:string};
  action:TierActionDto;
}
/** Read DTOs contain references only. Typed write-only inputs never return credentials. */
export interface GatewayModelDto {id:string;upstreamModel:string;enabled:boolean;}
export interface GatewayAgentDto {id:string;name:string;credentialRef:string;providerIds:string[];enabled:boolean;}
export type GatewayRectifierAction={type:'preserve'|'remove'}|{type:'set-if-missing'|'override';value:unknown}
 |{type:'map';values:Record<string,unknown>}|{type:'clamp';min:number;max:number}|{type:'reject';code:string};
export interface GatewayRectifierDto {
 id:string;enabled:boolean;priority:number;stage:'entry'|'model';field:string;match:TierRuleDto['match'];action:GatewayRectifierAction;
}
export interface GatewayFieldChangeDto {stage:'entry'|'model';field:string;ruleId:string;action:string;changed:boolean;}
export interface GatewayRequestChainDto {
 providerId:string;providerName:string;requestedModel:string|null;upstreamModel:string|null;entryEndpoint:GatewayEndpoint;upstreamEndpoint:GatewayEndpoint;
 entryTier:TierFieldDto;configVersion:number;changes:GatewayFieldChangeDto[];changesTruncated:boolean;routeReason:'explicit-provider'|'model-match'|'preview';
}
export interface GatewayTraceEventDto {phase:'received'|'prepared'|'upstream'|'streaming'|'finished';elapsedMs:number;errorCode:string|null;}
export interface GatewayOutputRateWindowDto {
 windowMs:5000;coveredMs:number;outputChars:number|null;charsPerSecond:number|null;source:'content-delta'|'json-content'|'unavailable';
}
export interface GatewayTraceDto {
 id:string;startedAtMs:number;providerId:string;agentId:string;entryEndpoint:GatewayEndpoint;requestedModel:string|null;
 phase:GatewayTraceEventDto['phase'];elapsedMs:number;httpStatus:number|null;errorCode:string|null;clientFirstResponseMs?:number;
 chain?:GatewayRequestChainDto;record?:GatewayRecordSummaryDto;rateWindow?:GatewayOutputRateWindowDto;events:GatewayTraceEventDto[];
}
export interface GatewayChainSnapshotDto {
 snapshotId:string;revision:number;traces:GatewayTraceDto[];truncated:boolean;
 totals:{requests:number;upstreamAttempts:number;rectified:number;rerouted:number;errors:number};
}
export interface GatewayRectifierPreviewDto {originalBody:string;entryBody:string;sentBody:string;chain:GatewayRequestChainDto|null;modified:boolean;}
export interface GatewayRouteDto {
  id:string;clientAlias:string;protocol:'openai'|'anthropic';upstreamBase:string;
  credentialRef:string;credentialPresent?:boolean;capabilities:{serviceTier:boolean};enabled:boolean;
  name?:string;models?:GatewayModelDto[];entryEndpoints?:GatewayEndpoint[];upstreamEndpoint?:GatewayEndpoint;
}
export interface GatewayRecordingDto {
  bodies:boolean;retentionDays:number;maxBytes:number;maxRecords:number;captureBytes:number;policyVersion:number;
}
export interface GatewayPairingStatusDto {
  pairingId:string;alias:string;instanceId:string;protocolVersion:1;connected:boolean;
  /** Last observed listener state; null means this host has no observation. */
  listening:boolean|null;activeRequests:number|null;errorCode?:string;pendingRevocation?:boolean;
}
export interface GatewayStatusDto {pairings:GatewayPairingStatusDto[];}
export type GatewayRouteInputDto=Omit<GatewayRouteDto,'credentialRef'|'credentialPresent'>;
export interface GatewayCredentialsInputDto {upstreamApiKey?:string;clientApiKey?:string;}
/** A provider catalog is not proof of inference permission, price or tier support. */
export interface GatewayModelCatalogDto {
 routeId:string;configVersion:number;checkedAtMs:number;source:'catalog';
 models:{id:string}[];truncated:boolean;
}
export interface GatewayLocalStatusDto {
 configured:boolean;running:boolean;pairingId:string|null;alias:string|null;
 listenPort:number|null;managementPort:number|null;configVersion:number|null;errorCode?:string;
 maxRequestBytes?:number|null;maxConcurrency?:number|null;
}
export interface GatewaySessionDto {sessionId:string;instanceId:string;protocolVersion:1;}
export interface GatewayListenerDto {
  state:'listening'|'stopped'|'draining'|'failed';address:string|null;owned:boolean;activeRequests:number;errorCode?:string;
}
export interface GatewayRecordFilterDto {
  routeId?:string;clientAlias?:string;model?:string;endpoint?:GatewayEndpoint;
  status?:GatewayRecordStatus;fromMs?:number;toMs?:number;tier?:string;
}
export type GatewayRecordStatus='forwarding'|'completed'|'upstream-error'|'gateway-rejected'|'client-aborted'|'interrupted'|'execution-unknown';
export interface GatewayRecordSummaryDto {
  id:string;startedAtMs:number;routeId:string;clientAlias:string;endpoint:GatewayEndpoint;model:string|null;
  status:GatewayRecordStatus;httpStatus:number|null;
  original:TierFieldDto;effective:TierFieldDto;reported:TierFieldDto;ruleId:string|null;
  requestBytes:number;responseBytes:number;durationMs:number;firstResponseMs:number|null;firstContentMs:number|null;
  inputTokens:number|null;outputTokens:number|null;cacheReadTokens:number|null;cacheWriteTokens:number|null;
  recordingPartial:boolean;errorCode:string|null;chain?:GatewayRequestChainDto;
}
export interface GatewayRecordBodyPageDto {
  text:string;nextCursor:string|null;redacted:true;encrypted:boolean;truncated:boolean;complete:boolean;
}
export interface GatewayRecordDetailDto {record:GatewayRecordSummaryDto;body:GatewayRecordBodyPageDto|null;}
export type GatewaySelectionDto={recordIds:string[]}|{filter:GatewayRecordFilterDto;throughMs:number};
export interface GatewayRulePreviewDto {
  original:TierFieldDto;effective:TierFieldDto;ruleId:string|null;modified:boolean;compatible:boolean;warningCode?:string;
}
export interface GatewayCliDifferenceDto {label:string;before:string;after:string;}
export interface GatewayCliPreviewDto {
  transactionId:string;fingerprint:string;expiresAtMs:number;tool:'codex'|'claude-code';
  differences:GatewayCliDifferenceDto[];conflicts:string[];recoverable:boolean;
}
export interface GatewayCliResultDto {transactionId:string;fingerprint:string;state:'applied'|'restored';recoverable:boolean;}
export interface GatewayInputMap {
  'gateway.status':Record<string,never>;
  'gateway.pair':Record<string,never>;
  'gateway.local.status':Record<string,never>;
  'gateway.local.setup':{alias:string;listenPort:number;managementPort:number;maxRequestBytes?:number;maxConcurrency?:number;route:GatewayRouteInputDto;credentials:{upstreamApiKey:string;clientApiKey:string}};
  'gateway.local.configure':{expectedVersion:number;alias:string;listenPort:number;managementPort:number;maxRequestBytes?:number;maxConcurrency?:number};
  'gateway.connect':{pairingId?:string};
  'gateway.disconnect':{sessionId:string};
  'gateway.listener.start':{sessionId:string};
  'gateway.listener.stop':{sessionId:string;mode:'drain'|'cancel'};
  'gateway.events.subscribe':{sessionId:string};
  'gateway.events.unsubscribe':{subscriptionId:string};
  'gateway.routes.config.get':{sessionId:string};
  'gateway.routes.config.set':{sessionId:string;expectedVersion:number;routes:GatewayRouteDto[]};
  'gateway.routes.save':{sessionId:string;expectedVersion:number;route:GatewayRouteInputDto;credentials?:GatewayCredentialsInputDto};
  'gateway.routes.delete':{sessionId:string;expectedVersion:number;routeId:string};
  'gateway.routes.models.detect':{sessionId:string;expectedVersion:number;routeId:string};
  'gateway.routes.models.preview':{sessionId:string;expectedVersion:number;routeId:string;protocol:'openai'|'anthropic';upstreamBase:string;upstreamApiKey:string};
  'gateway.agents.get':{sessionId:string};
  'gateway.agents.replace':{sessionId:string;expectedVersion:number;agents:GatewayAgentDto[]};
  'gateway.rectifiers.list':{sessionId:string};
  'gateway.rectifiers.replace':{sessionId:string;expectedVersion:number;rectifiers:GatewayRectifierDto[]};
  'gateway.rectifiers.preview':{sessionId:string;routeId:string;endpoint:GatewayEndpoint;body:string;clientAlias?:string};
  'gateway.chain.snapshot':{sessionId:string};
  'gateway.rules.list':{sessionId:string};
  'gateway.rules.preview':{sessionId:string;routeId:string;endpoint:GatewayEndpoint;model?:string;originalTier:TierFieldDto};
  'gateway.rules.replace':{sessionId:string;expectedVersion:number;rules:TierRuleDto[]};
  'gateway.recording.config.get':{sessionId:string};
  'gateway.recording.config.set':{sessionId:string;expectedVersion:number;recording:GatewayRecordingDto};
  'gateway.records.list':{sessionId:string;filter?:GatewayRecordFilterDto;cursor?:string;limit:number};
  'gateway.records.get':{sessionId:string;recordId:string;includeBody?:boolean;bodyCursor?:string};
  'gateway.records.delete':{sessionId:string;selection:GatewaySelectionDto};
  'gateway.records.export':{sessionId:string;selection:GatewaySelectionDto;format:'json'|'jsonl';includeBody:false};
  'gateway.cliConfig.preview':{sessionId:string;tool:'codex'|'claude-code';routeId:string};
  'gateway.cliConfig.apply':{transactionId:string;expectedFingerprint:string};
  'gateway.cliConfig.restore':{transactionId:string;expectedFingerprint:string};
}
export interface GatewayOutputMap {
  'gateway.status':GatewayStatusDto;
  'gateway.pair':{pairingId:string}|null;
  'gateway.local.status':GatewayLocalStatusDto;
  'gateway.local.setup':{pairingId:string;configVersion:number};
  'gateway.local.configure':{configVersion:number};
  'gateway.connect':GatewaySessionDto;
  'gateway.disconnect':{disconnected:true};
  'gateway.listener.start':GatewayListenerDto;
  'gateway.listener.stop':GatewayListenerDto;
  'gateway.events.subscribe':{subscriptionId:string};
  'gateway.events.unsubscribe':{unsubscribed:true};
  'gateway.routes.config.get':{configVersion:number;routes:GatewayRouteDto[]};
  'gateway.routes.config.set':{configVersion:number};
  'gateway.routes.save':{configVersion:number};
  'gateway.routes.delete':{configVersion:number};
  'gateway.routes.models.detect':GatewayModelCatalogDto;
  'gateway.routes.models.preview':GatewayModelCatalogDto;
  'gateway.agents.get':{configVersion:number;agents:GatewayAgentDto[]};
  'gateway.agents.replace':{configVersion:number};
  'gateway.rectifiers.list':{configVersion:number;rectifiers:GatewayRectifierDto[]};
  'gateway.rectifiers.replace':{configVersion:number};
  'gateway.rectifiers.preview':GatewayRectifierPreviewDto;
  'gateway.chain.snapshot':GatewayChainSnapshotDto;
  'gateway.rules.list':{policyVersion:number;rules:TierRuleDto[]};
  'gateway.rules.preview':GatewayRulePreviewDto;
  'gateway.rules.replace':{policyVersion:number};
  'gateway.recording.config.get':{configVersion:number;recording:GatewayRecordingDto;encryptionAvailable:boolean};
  'gateway.recording.config.set':{configVersion:number;encryptionAvailable:boolean};
  'gateway.records.list':{records:GatewayRecordSummaryDto[];nextCursor:string|null};
  'gateway.records.get':GatewayRecordDetailDto;
  'gateway.records.delete':{deleted:number;taskId?:string};
  'gateway.records.export':{exported:number;cancelled:boolean;taskId?:string};
  'gateway.cliConfig.preview':GatewayCliPreviewDto;
  'gateway.cliConfig.apply':GatewayCliResultDto;
  'gateway.cliConfig.restore':GatewayCliResultDto;
}
/** Events are summaries only; body data is available solely by an authorized get. */
export type GatewayEventDto={
  subscriptionId:string;sessionId:string;
}&({type:'status';status:GatewayListenerDto}|{type:'record-summary';record:GatewayRecordSummaryDto}|{type:'warning';code:string});
export interface GatewayOwner {id:string;generation:number;view:string;signal:AbortSignal;}
export type GatewayRevocationReason='disabled'|'generation'|'view'|'shutdown';
export interface GatewayBridge {
  request(method:GatewayMethod,input:unknown,owner:GatewayOwner):Promise<unknown>;
  revoke(owner:{id:string;generation?:number;view?:string},reason:GatewayRevocationReason):void|Promise<void>;
}
