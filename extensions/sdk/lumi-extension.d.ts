/** Portable author types for the sandboxed Lumi extension SDK v1. No host imports required. */
export type Json = null | boolean | number | string | Json[] | {[key:string]:Json};
export interface Context {theme:'light'|'dark';locale:'zh-CN';site:{id:string;name:string;url:string};refreshEpoch?:number;}
export type ExtensionSlot='workbench'|'usage'|'models'|'tokens'|'connection'|'settingsTab'|'sidebar';
export type ExtensionPermission='workbench.read'|'usage.read'|'codex.usage.read'|'codex.bridge'|'storage'|'network.read'|'secrets'|'gateway.control'|'gateway.config'|'gateway.records.read'|'gateway.records.manage'|'gateway.cli-config';
export interface ExtensionManifest {
  schemaVersion:1;hostApiVersion:1;minHostVersion?:string;id:string;kind?:'feature'|'interface';
  name:string;version:string;description:string;author:string;license:string;
  permissions?:ExtensionPermission[];networkOrigins?:string[];
  switches?:{id:string;title:string;defaultEnabled?:boolean}[];
  contributions?:{id:string;slot:ExtensionSlot;title:string;entry:string;order?:number;scope?:'site'|'independent';switch?:string;section?:'workspace'|'tools'|'settings'}[];
  interface?:{stylesheet:string;preview?:string;appearanceGroups?:{id:string;title:string;defaultOption:string;options:{id:string;title:string}[]}[]};
}
/** Formatted presentation data, not an account/consumption-log API. */
export interface NativeMenuBarState {
  type:'state';schemaVersion:1;phase:string;siteName:string;accountLabel:string;days:number;tool:string;
  contents:('balance'|'totals'|'tokenDetail'|'efficiency'|'chart'|'models')[];
  totalsCaption?:string;viewKey?:string;
  balance:string;cost:string;tokens:string;requests:string;tokenDetail:string;cacheDetail:string;
  cacheHitRate:string;tokenSpeed:string;message:string;updatedLabel:string;canRefresh:boolean;chartCaption:string;
  chart:{label:string;value:number;cost:string;tokens:string;requests:string}[]|null;
  models:{name:string;cost:string;share:number}[];modelsMessage:string;
}
export interface WidgetModel {name:string;cost:string;requests:string;input:string;output:string;cacheRead:string;cacheWrite:string;}
export interface WidgetState {
  phase:'idle'|'loading'|'ready'|'error';enabled:boolean;siteName:string;balance:string;cost:string;minuteLabel:string;historical:boolean;
  models:WidgetModel[];latestModel?:WidgetModel;message:string;updatedAt:number;viewKey:string;dataKey:string;theme:'light'|'dark';
  animation?:'slide-up'|'slide-down'|'blur'|'fade'|'scale'|'none';source?:'api'|'local';
}
export interface SubscriptionWindow {usedPercent:number|null;remainingPercent:number|null;durationMinutes:number|null;resetsAt:number|null;}
export interface CodexBridgeStatus {installed:boolean;state:'starting'|'ready'|'exited';detail?:string;}
export interface CodexBridgeMessage {id?:number|string;method?:string;params?:unknown;result?:unknown;error?:{code?:number;message?:string;data?:unknown};}
export interface CodexBridgeSdk {
  status():Promise<CodexBridgeStatus>;
  send(input:{method:string;params?:unknown;notify?:boolean}):Promise<{result?:unknown;error?:unknown}>;
  respond(input:{id:number|string;result?:unknown;error?:unknown}):Promise<void>;
  chooseDirectory():Promise<{path:string}|null>;
  subscribe(listener:(message:CodexBridgeMessage)=>void):()=>void;
}
export interface SubscriptionCredits {remaining:number|null;unlimited:boolean|null;hasCredits:boolean|null;}
export interface SubscriptionUsageSnapshot {
  sourceId:'provider.codex';account:{id:string;label:string;plan:string|null}|null;
  state:'ready'|'signed-out'|'unsupported';
  windows:{id:string;label:string;primary:SubscriptionWindow|null;secondary:SubscriptionWindow|null;credits:SubscriptionCredits|null}[];
  fetchedAt:number;
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
export interface GatewaySdk {
  status():Promise<GatewayOutputMap['gateway.status']>;
  pair():Promise<GatewayOutputMap['gateway.pair']>;
  local:{
    status():Promise<GatewayOutputMap['gateway.local.status']>;
    setup(input:GatewayInputMap['gateway.local.setup']):Promise<GatewayOutputMap['gateway.local.setup']>;
    configure(input:GatewayInputMap['gateway.local.configure']):Promise<GatewayOutputMap['gateway.local.configure']>;
  };
  connect(input?:GatewayInputMap['gateway.connect']):Promise<GatewayOutputMap['gateway.connect']>;
  disconnect(input:GatewayInputMap['gateway.disconnect']):Promise<GatewayOutputMap['gateway.disconnect']>;
  listener:{
    start(input:GatewayInputMap['gateway.listener.start']):Promise<GatewayOutputMap['gateway.listener.start']>;
    stop(input:GatewayInputMap['gateway.listener.stop']):Promise<GatewayOutputMap['gateway.listener.stop']>;
  };
  events:{
    subscribe(input:GatewayInputMap['gateway.events.subscribe'],listener:(event:GatewayEventDto)=>void):Promise<()=>void>;
    unsubscribe(input:GatewayInputMap['gateway.events.unsubscribe']):Promise<GatewayOutputMap['gateway.events.unsubscribe']>;
  };
  routes:{
    save(input:GatewayInputMap['gateway.routes.save']):Promise<GatewayOutputMap['gateway.routes.save']>;
    delete(input:GatewayInputMap['gateway.routes.delete']):Promise<GatewayOutputMap['gateway.routes.delete']>;
    models:{detect(input:GatewayInputMap['gateway.routes.models.detect']):Promise<GatewayOutputMap['gateway.routes.models.detect']>;preview(input:GatewayInputMap['gateway.routes.models.preview']):Promise<GatewayOutputMap['gateway.routes.models.preview']>;};
    config:{
    get(input:GatewayInputMap['gateway.routes.config.get']):Promise<GatewayOutputMap['gateway.routes.config.get']>;
    set(input:GatewayInputMap['gateway.routes.config.set']):Promise<GatewayOutputMap['gateway.routes.config.set']>;
  }};
  agents:{get(input:GatewayInputMap['gateway.agents.get']):Promise<GatewayOutputMap['gateway.agents.get']>;replace(input:GatewayInputMap['gateway.agents.replace']):Promise<GatewayOutputMap['gateway.agents.replace']>;};
  rectifiers:{list(input:GatewayInputMap['gateway.rectifiers.list']):Promise<GatewayOutputMap['gateway.rectifiers.list']>;replace(input:GatewayInputMap['gateway.rectifiers.replace']):Promise<GatewayOutputMap['gateway.rectifiers.replace']>;preview(input:GatewayInputMap['gateway.rectifiers.preview']):Promise<GatewayOutputMap['gateway.rectifiers.preview']>;};
  chain:{snapshot(input:GatewayInputMap['gateway.chain.snapshot']):Promise<GatewayOutputMap['gateway.chain.snapshot']>;};
  rules:{
    list(input:GatewayInputMap['gateway.rules.list']):Promise<GatewayOutputMap['gateway.rules.list']>;
    preview(input:GatewayInputMap['gateway.rules.preview']):Promise<GatewayOutputMap['gateway.rules.preview']>;
    replace(input:GatewayInputMap['gateway.rules.replace']):Promise<GatewayOutputMap['gateway.rules.replace']>;
  };
  recording:{config:{
    get(input:GatewayInputMap['gateway.recording.config.get']):Promise<GatewayOutputMap['gateway.recording.config.get']>;
    set(input:GatewayInputMap['gateway.recording.config.set']):Promise<GatewayOutputMap['gateway.recording.config.set']>;
  }};
  records:{
    list(input:GatewayInputMap['gateway.records.list']):Promise<GatewayOutputMap['gateway.records.list']>;
    get(input:GatewayInputMap['gateway.records.get']):Promise<GatewayOutputMap['gateway.records.get']>;
    delete(input:GatewayInputMap['gateway.records.delete']):Promise<GatewayOutputMap['gateway.records.delete']>;
    export(input:GatewayInputMap['gateway.records.export']):Promise<GatewayOutputMap['gateway.records.export']>;
  };
  cliConfig:{
    preview(input:GatewayInputMap['gateway.cliConfig.preview']):Promise<GatewayOutputMap['gateway.cliConfig.preview']>;
    apply(input:GatewayInputMap['gateway.cliConfig.apply']):Promise<GatewayOutputMap['gateway.cliConfig.apply']>;
    restore(input:GatewayInputMap['gateway.cliConfig.restore']):Promise<GatewayOutputMap['gateway.cliConfig.restore']>;
  };
}
export interface LumiExtensionSdk {
  readonly apiVersion:1;
  readonly gateway:GatewaySdk;
  readonly context:Context|undefined;
  readonly view:{id:string;slot:ExtensionSlot}|undefined;
  readonly ready:Promise<{context:Context;view:NonNullable<LumiExtensionSdk['view']>}>;
  onContext(listener:(context:Context)=>void):()=>void;
  onEvent(topic:string,listener:(payload:unknown)=>void):()=>void;
  workbench:{read<T=NativeMenuBarState>(input?:{force?:boolean}):Promise<T>};
  usage:{read<T=WidgetState>(input?:{force?:boolean}):Promise<T>};
  codex:{readUsage<T=SubscriptionUsageSnapshot>(input?:{force?:boolean}):Promise<T>;bridge:CodexBridgeSdk};
  storage:{read<T extends Json=Json>(key:string):Promise<T|null>;write(key:string,value:Json):Promise<void>};
  secrets:{has(key:string):Promise<boolean>;set(key:string,value:string|null):Promise<void>};
  network:{read(input:{url:string;headers?:Record<string,string>;secret?:{key:string;header:'Authorization'|'X-Api-Key';prefix?:'Bearer '|''}}):Promise<{status:number;body:string}>};
}
declare global {interface Window {readonly lumiExtension:LumiExtensionSdk;}}
