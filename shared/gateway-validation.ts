import {z} from 'zod';
import {GATEWAY_MAX_IPC_BYTES,type GatewayMethod,type GatewayInputMap,type GatewayOutputMap,type GatewayEventDto} from './contracts/gateway';

const identifier=z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/);
const opaque=z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/);
const safeCode=z.string().regex(/^[a-z][a-z0-9-]{0,63}$/);
const label=z.string().min(1).max(100).refine(value=>!/[\u0000-\u001f\u007f]/.test(value));
const model=z.string().min(1).max(256).refine(value=>!/[\u0000-\u001f\u007f]/.test(value));
const catalogModel=model.refine(value=>new TextEncoder().encode(value).length<=256 && value.trim().length>0 && !/[\ud800-\udfff]/u.test(value) && !/[\u007f-\u009f]/.test(value));
const integer=z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const version=z.number().int().nonnegative().max(2147483647);
const timestamp=integer;
const endpoint=z.enum(['/v1/responses','/v1/chat/completions','/v1/messages']);
const status=z.enum(['forwarding','completed','upstream-error','gateway-rejected','client-aborted','interrupted','execution-unknown']);
const session=z.object({sessionId:opaque}).strict();
const empty=z.object({}).strict();

/** Plugin-configurable upstreams remain public HTTPS. DNS/IP are rechecked by services. */
export function gatewayPublicUpstream(value:string):boolean {
  try {
    const url=new URL(value),host=url.hostname.toLowerCase().replace(/^\[|\]$/g,'');
    if(url.protocol!=='https:' || url.username || url.password || url.search || url.hash || !host || host.endsWith('.'))return false;
    if(host==='localhost' || host.endsWith('.localhost') || host.endsWith('.local') || host==='::' || host==='::1')return false;
    // Literal IPv6 is rejected at this boundary; fixed/public DNS hosts are resolved and pinned server-side.
    if(host.includes(':'))return false;
    if(/^\d+\.\d+\.\d+\.\d+$/.test(host)) {
      const [a,b]=host.split('.').map(Number);
      if(a===0 || a===10 || a===127 || a===169 && b===254 || a===172 && b>=16 && b<=31
        || a===192 && b===168 || a===100 && b>=64 && b<=127 || a>=224
        || a===198 && (b===18 || b===19))return false;
    }
    return true;
  }catch{return false;}
}
const upstream=z.string().min(1).max(2048).refine(gatewayPublicUpstream,'网关上游必须为无凭据的公共 HTTPS 地址。');
const listenerAddress=z.string().max(64).refine(value=>{
  const match=/^(?:\[(::1)\]|(127(?:\.\d{1,3}){3})):(\d{1,5})$/.exec(value);
  if(!match)return false;
  if(match[2] && match[2].split('.').some(part=>Number(part)>255))return false;
  const port=Number(match[3]);return port>=1 && port<=65535;
});
const unique=<T>(values:T[],select:(value:T)=>string)=>new Set(values.map(select)).size===values.length;
export const gatewayTierFieldSchema=z.discriminatedUnion('state',[
  z.object({state:z.literal('missing')}).strict(),z.object({state:z.literal('null')}).strict(),
  z.object({state:z.literal('invalid')}).strict(),z.object({state:z.literal('unavailable')}).strict(),
  z.object({state:z.literal('string'),value:z.string().max(64).refine(value=>!/[\u0000-\u001f\u007f]/.test(value))}).strict(),
]);
export const gatewayTierActionSchema=z.discriminatedUnion('type',[
  z.object({type:z.literal('preserve')}).strict(),z.object({type:z.literal('remove')}).strict(),
  z.object({type:z.literal('set-if-missing'),value:identifier}).strict(),
  z.object({type:z.literal('override'),value:identifier}).strict(),
]);
export const gatewayTierRuleSchema=z.object({
  id:identifier,enabled:z.boolean(),priority:z.number().int().min(-2147483648).max(2147483647),
  match:z.object({routeId:identifier.optional(),clientAlias:identifier.optional(),endpoint:endpoint.optional(),model:model.optional()}).strict(),
  action:gatewayTierActionSchema,
}).strict();
const rules=z.array(gatewayTierRuleSchema).max(128).refine(values=>unique(values,value=>value.id),'网关规则 ID 重复。');
export const gatewayModelSchema=z.object({id:catalogModel,upstreamModel:catalogModel,enabled:z.boolean()}).strict();
export const gatewayAgentSchema=z.object({id:identifier,name:label,credentialRef:identifier,providerIds:z.array(identifier).min(1).max(32).refine(v=>new Set(v).size===v.length),enabled:z.boolean()}).strict();
const agents=z.array(gatewayAgentSchema).max(32).refine(v=>unique(v,a=>a.id)&&unique(v,a=>a.credentialRef));
const jsonValue=z.json().refine(v=>new TextEncoder().encode(JSON.stringify(v)).length<=4096);
export const gatewayRectifierSchema=z.object({
 id:identifier,enabled:z.boolean(),priority:z.number().int().min(-2147483648).max(2147483647),stage:z.enum(['entry','model']),
 field:z.enum(['/service_tier','/reasoning','/reasoning/effort','/reasoning/summary','/reasoning_effort','/thinking','/thinking/type','/thinking/budget_tokens','/output_config','/output_config/effort','/output_config/format','/max_tokens','/max_output_tokens','/max_completion_tokens','/temperature','/top_p','/top_k','/stop','/stop_sequences','/tool_choice','/parallel_tool_calls','/response_format','/text','/text/format','/text/verbosity','/store','/metadata','/prompt_cache_key','/prompt_cache_retention','/cache_control','/system/*/cache_control','/messages/*/content/*/cache_control','/tools/*/cache_control','/input/*/content/*/cache_control','/stream_options','/stream_options/include_usage']),
 match:gatewayTierRuleSchema.shape.match,
 action:z.discriminatedUnion('type',[
  z.object({type:z.literal('preserve')}).strict(),z.object({type:z.literal('remove')}).strict(),
  z.object({type:z.literal('set-if-missing'),value:jsonValue}).strict(),z.object({type:z.literal('override'),value:jsonValue}).strict(),
  z.object({type:z.literal('map'),values:z.record(z.string().min(1).max(64),jsonValue).refine(v=>Object.keys(v).length>0&&Object.keys(v).length<=32)}).strict(),
  z.object({type:z.literal('clamp'),min:z.number().finite(),max:z.number().finite()}).strict().refine(v=>v.min<=v.max),
  z.object({type:z.literal('reject'),code:safeCode}).strict(),
 ]),
}).strict().refine(v=>new TextEncoder().encode(JSON.stringify(v.action)).length<=4096)
 .refine(v=>!v.field.includes('*')||['preserve','remove'].includes(v.action.type))
 .refine(v=>v.field!=='/service_tier'||(!['clamp'].includes(v.action.type)&&
  (v.action.type==='override'||v.action.type==='set-if-missing'?identifier.safeParse(v.action.value).success:
   v.action.type==='map'?Object.values(v.action.values).every(x=>identifier.safeParse(x).success):true)));
const rectifiers=z.array(gatewayRectifierSchema).max(128).refine(v=>unique(v,r=>r.id));
const fieldChange=z.object({stage:z.enum(['entry','model']),field:z.string().max(64),ruleId:identifier,action:z.string().max(32),changed:z.boolean()}).strict();
export const gatewayRequestChainSchema=z.object({
 providerId:identifier,providerName:label,requestedModel:model.nullable(),upstreamModel:model.nullable(),entryEndpoint:endpoint,upstreamEndpoint:endpoint,
 entryTier:gatewayTierFieldSchema,configVersion:version,changes:z.array(fieldChange).max(16),changesTruncated:z.boolean(),routeReason:z.enum(['explicit-provider','model-match','preview']),
}).strict();
export const gatewayRouteSchema=z.object({
  id:identifier,clientAlias:identifier,protocol:z.enum(['openai','anthropic']),upstreamBase:upstream,
  credentialRef:opaque,credentialPresent:z.boolean().optional(),capabilities:z.object({serviceTier:z.boolean()}).strict(),enabled:z.boolean(),
 name:label.optional(),models:z.array(gatewayModelSchema).max(128).refine(v=>unique(v,m=>m.id)).optional(),entryEndpoints:z.array(endpoint).max(3).refine(v=>new Set(v).size===v.length).optional(),upstreamEndpoint:endpoint.optional(),
}).strict().refine(value=>(value.protocol!=='anthropic'||!value.capabilities.serviceTier) && (value.upstreamEndpoint===undefined || (value.upstreamEndpoint==='/v1/messages')===(value.protocol==='anthropic')));
const {credentialRef:_credentialRef,credentialPresent:_credentialPresent,...routeShape}=gatewayRouteSchema.shape;
const routeInput=z.object(routeShape).strict().refine(value=>(value.protocol!=='anthropic'||!value.capabilities.serviceTier) && (value.upstreamEndpoint===undefined || (value.upstreamEndpoint==='/v1/messages')===(value.protocol==='anthropic')));
const secret=z.string().min(1).max(8192).regex(/^[\x21-\x7e]+$/);
const clientSecret=secret.min(16);
const credentials=z.object({upstreamApiKey:secret.optional(),clientApiKey:clientSecret.optional()}).strict()
 .refine(value=>value.upstreamApiKey!==undefined || value.clientApiKey!==undefined,'请填写要更新的密钥。');
const port=z.number().int().min(1024).max(65535);
const localPorts={alias:label,listenPort:port,managementPort:port,maxRequestBytes:z.number().int().min(1).max(4*1024*1024).optional(),maxConcurrency:z.number().int().min(1).max(128).optional()};
const portsDiffer=(value:{listenPort:number;managementPort:number})=>value.listenPort!==value.managementPort;
const routes=z.array(gatewayRouteSchema).min(1).max(32).refine(values=>unique(values,value=>value.id),'网关路由 ID 重复。');
export const gatewayRecordingSchema=z.object({
  bodies:z.boolean(),retentionDays:z.number().int().min(1).max(365),maxBytes:z.number().int().min(1048576).max(10*1024*1024*1024),
  maxRecords:z.number().int().min(1).max(100000),captureBytes:z.number().int().min(1).max(1048576),policyVersion:version,
}).strict();
export const gatewayRecordFilterSchema=z.object({
  routeId:identifier.optional(),clientAlias:identifier.optional(),model:model.optional(),endpoint:endpoint.optional(),status:status.optional(),
  fromMs:timestamp.optional(),toMs:timestamp.optional(),tier:identifier.optional(),
}).strict().refine(value=>value.fromMs===undefined || value.toMs===undefined || value.fromMs<=value.toMs,'记录时间范围无效。');
export const gatewaySelectionSchema=z.union([
  z.object({recordIds:z.array(opaque).min(1).max(100).refine(values=>new Set(values).size===values.length)}).strict(),
  z.object({filter:gatewayRecordFilterSchema,throughMs:timestamp}).strict(),
]);
export const gatewayListenerSchema=z.object({
  state:z.enum(['listening','stopped','draining','failed']),address:listenerAddress.nullable(),owned:z.boolean(),activeRequests:integer.max(128),errorCode:safeCode.optional(),
}).strict();
export const gatewayRecordSummarySchema=z.object({
  id:opaque,startedAtMs:timestamp,routeId:identifier,clientAlias:identifier,endpoint,model:model.nullable(),status,httpStatus:z.number().int().min(100).max(599).nullable(),
  original:gatewayTierFieldSchema,effective:gatewayTierFieldSchema,reported:gatewayTierFieldSchema,ruleId:identifier.nullable(),
  requestBytes:integer,responseBytes:integer,durationMs:integer,firstResponseMs:integer.nullable(),firstContentMs:integer.nullable(),
  inputTokens:integer.nullable(),outputTokens:integer.nullable(),cacheReadTokens:integer.nullable(),cacheWriteTokens:integer.nullable(),
  recordingPartial:z.boolean(),errorCode:safeCode.nullable(),chain:gatewayRequestChainSchema.optional(),
}).strict();
const rateWindow=z.object({windowMs:z.literal(5000),coveredMs:integer.max(5000),outputChars:integer.nullable(),charsPerSecond:z.number().finite().nonnegative().nullable(),source:z.enum(['content-delta','json-content','unavailable'])}).strict().refine(value=>value.source==='unavailable'?value.outputChars===null&&value.charsPerSecond===null:value.coveredMs>0&&value.outputChars!==null&&value.charsPerSecond!==null&&Math.abs(value.charsPerSecond-value.outputChars*1000/value.coveredMs)<1e-6);
const traceEvent=z.object({phase:z.enum(['received','prepared','upstream','streaming','finished']),elapsedMs:integer,errorCode:safeCode.nullable()}).strict();
const trace=z.object({id:opaque,startedAtMs:timestamp,providerId:identifier,agentId:identifier,entryEndpoint:endpoint,requestedModel:model.nullable(),phase:traceEvent.shape.phase,
 elapsedMs:integer,httpStatus:z.number().int().min(100).max(599).nullable(),errorCode:safeCode.nullable(),clientFirstResponseMs:integer.optional(),chain:gatewayRequestChainSchema.optional(),record:gatewayRecordSummarySchema.optional(),rateWindow:rateWindow.optional(),events:z.array(traceEvent).max(8)}).strict();
const chainSnapshot=z.object({snapshotId:opaque,revision:integer,traces:z.array(trace).max(192),truncated:z.boolean(),totals:z.object({requests:integer,upstreamAttempts:integer,rectified:integer,rerouted:integer,errors:integer}).strict()}).strict();
const previewBody=z.string().refine(v=>new TextEncoder().encode(v).length<=65536);
const bodyPage=z.object({
  text:z.string().refine(value=>new TextEncoder().encode(value).byteLength<=65536),nextCursor:opaque.nullable(),redacted:z.literal(true),encrypted:z.boolean(),truncated:z.boolean(),complete:z.boolean(),
}).strict();
const cliPreview=z.object({
  transactionId:opaque,fingerprint:opaque,expiresAtMs:timestamp,tool:z.enum(['codex','claude-code']),
  differences:z.array(z.object({label:label,before:z.string().max(2048),after:z.string().max(2048)}).strict()).max(32),
  conflicts:z.array(label).max(32),recoverable:z.boolean(),
}).strict();
const cliResult=z.object({transactionId:opaque,fingerprint:opaque,state:z.enum(['applied','restored']),recoverable:z.boolean()}).strict();
const recordDetail=z.object({record:gatewayRecordSummarySchema,body:bodyPage.nullable()}).strict();
export const gatewayInputSchemas={
  'gateway.status':empty,'gateway.pair':empty,
  'gateway.local.status':empty,
  'gateway.local.setup':z.object({...localPorts,route:routeInput,credentials:z.object({upstreamApiKey:secret,clientApiKey:clientSecret}).strict()}).strict().refine(portsDiffer,'两个端口不能相同。'),
  'gateway.local.configure':z.object({...localPorts,expectedVersion:version}).strict().refine(portsDiffer,'两个端口不能相同。'),
  'gateway.connect':z.object({pairingId:opaque.optional()}).strict(),
  'gateway.disconnect':session,
  'gateway.listener.start':session,
  'gateway.listener.stop':session.extend({mode:z.enum(['drain','cancel'])}).strict(),
  'gateway.events.subscribe':session,
  'gateway.events.unsubscribe':z.object({subscriptionId:opaque}).strict(),
  'gateway.routes.config.get':session,
  'gateway.routes.config.set':session.extend({expectedVersion:version,routes}).strict(),
  'gateway.routes.save':session.extend({expectedVersion:version,route:routeInput,credentials:credentials.optional()}).strict(),
  'gateway.routes.delete':session.extend({expectedVersion:version,routeId:identifier}).strict(),
  'gateway.routes.models.detect':session.extend({expectedVersion:version,routeId:identifier}).strict(),
  'gateway.routes.models.preview':session.extend({expectedVersion:version,routeId:identifier,protocol:z.enum(['openai','anthropic']),upstreamBase:upstream,upstreamApiKey:secret}).strict(),
  'gateway.agents.get':session,'gateway.agents.replace':session.extend({expectedVersion:version,agents}).strict(),
  'gateway.rectifiers.list':session,'gateway.rectifiers.replace':session.extend({expectedVersion:version,rectifiers}).strict(),
  'gateway.rectifiers.preview':session.extend({routeId:identifier,endpoint,body:previewBody,clientAlias:identifier.optional()}).strict(),
  'gateway.chain.snapshot':session,
  'gateway.rules.list':session,
  'gateway.rules.preview':session.extend({routeId:identifier,endpoint,model:model.optional(),originalTier:gatewayTierFieldSchema}).strict(),
  'gateway.rules.replace':session.extend({expectedVersion:version,rules}).strict(),
  'gateway.recording.config.get':session,
  'gateway.recording.config.set':session.extend({expectedVersion:version,recording:gatewayRecordingSchema}).strict(),
  'gateway.records.list':session.extend({filter:gatewayRecordFilterSchema.optional(),cursor:opaque.optional(),limit:z.number().int().min(1).max(100)}).strict(),
  'gateway.records.get':session.extend({recordId:opaque,includeBody:z.boolean().optional(),bodyCursor:opaque.optional()}).strict()
    .refine(value=>value.bodyCursor===undefined || value.includeBody===true,'正文游标需要显式读取正文。'),
  'gateway.records.delete':session.extend({selection:gatewaySelectionSchema}).strict(),
  'gateway.records.export':session.extend({selection:gatewaySelectionSchema,format:z.enum(['json','jsonl']),includeBody:z.literal(false)}).strict(),
  'gateway.cliConfig.preview':session.extend({tool:z.enum(['codex','claude-code']),routeId:identifier}).strict(),
  'gateway.cliConfig.apply':z.object({transactionId:opaque,expectedFingerprint:opaque}).strict(),
  'gateway.cliConfig.restore':z.object({transactionId:opaque,expectedFingerprint:opaque}).strict(),
} satisfies Record<GatewayMethod,z.ZodType>;
export const gatewayOutputSchemas={
  'gateway.status':z.object({pairings:z.array(z.object({pairingId:opaque,alias:label,instanceId:opaque,protocolVersion:z.literal(1),connected:z.boolean(),listening:z.boolean().nullable(),activeRequests:integer.max(128).nullable(),errorCode:safeCode.optional(),pendingRevocation:z.boolean().optional()}).strict()).max(32)}).strict(),
  'gateway.pair':z.object({pairingId:opaque}).strict().nullable(),
  'gateway.local.status':z.object({configured:z.boolean(),running:z.boolean(),pairingId:opaque.nullable(),alias:label.nullable(),listenPort:port.nullable(),managementPort:port.nullable(),configVersion:version.nullable(),maxRequestBytes:z.number().int().min(1).max(4*1024*1024).nullable().optional(),maxConcurrency:z.number().int().min(1).max(128).nullable().optional(),errorCode:safeCode.optional()}).strict(),
  'gateway.local.setup':z.object({pairingId:opaque,configVersion:version}).strict(),
  'gateway.local.configure':z.object({configVersion:version}).strict(),
  'gateway.connect':z.object({sessionId:opaque,instanceId:opaque,protocolVersion:z.literal(1)}).strict(),
  'gateway.disconnect':z.object({disconnected:z.literal(true)}).strict(),
  'gateway.listener.start':gatewayListenerSchema,'gateway.listener.stop':gatewayListenerSchema,
  'gateway.events.subscribe':z.object({subscriptionId:opaque}).strict(),
  'gateway.events.unsubscribe':z.object({unsubscribed:z.literal(true)}).strict(),
  'gateway.routes.config.get':z.object({configVersion:version,routes}).strict(),
  'gateway.routes.config.set':z.object({configVersion:version}).strict(),
  'gateway.routes.save':z.object({configVersion:version}).strict(),
  'gateway.routes.delete':z.object({configVersion:version}).strict(),
  'gateway.routes.models.detect':z.object({routeId:identifier,configVersion:version,checkedAtMs:timestamp,source:z.literal('catalog'),models:z.array(z.object({id:catalogModel}).strict()).max(500),truncated:z.boolean()}).strict().refine(value=>new Set(value.models.map(item=>item.id)).size===value.models.length),
  'gateway.routes.models.preview':z.object({routeId:identifier,configVersion:version,checkedAtMs:timestamp,source:z.literal('catalog'),models:z.array(z.object({id:catalogModel}).strict()).max(500),truncated:z.boolean()}).strict().refine(value=>new Set(value.models.map(item=>item.id)).size===value.models.length),
  'gateway.agents.get':z.object({configVersion:version,agents}).strict(),'gateway.agents.replace':z.object({configVersion:version}).strict(),
  'gateway.rectifiers.list':z.object({configVersion:version,rectifiers}).strict(),'gateway.rectifiers.replace':z.object({configVersion:version}).strict(),
  'gateway.rectifiers.preview':z.object({originalBody:previewBody,entryBody:previewBody,sentBody:previewBody,chain:gatewayRequestChainSchema.nullable(),modified:z.boolean()}).strict(),
  'gateway.chain.snapshot':chainSnapshot,
  'gateway.rules.list':z.object({policyVersion:version,rules}).strict(),
  'gateway.rules.preview':z.object({original:gatewayTierFieldSchema,effective:gatewayTierFieldSchema,ruleId:identifier.nullable(),modified:z.boolean(),compatible:z.boolean(),warningCode:safeCode.optional()}).strict(),
  'gateway.rules.replace':z.object({policyVersion:version}).strict(),
  'gateway.recording.config.get':z.object({configVersion:version,recording:gatewayRecordingSchema,encryptionAvailable:z.boolean()}).strict(),
  'gateway.recording.config.set':z.object({configVersion:version,encryptionAvailable:z.boolean()}).strict(),
  'gateway.records.list':z.object({records:z.array(gatewayRecordSummarySchema).max(100),nextCursor:opaque.nullable()}).strict(),
  'gateway.records.get':recordDetail,
  'gateway.records.delete':z.object({deleted:integer,taskId:opaque.optional()}).strict(),
  'gateway.records.export':z.object({exported:integer,cancelled:z.boolean(),taskId:opaque.optional()}).strict(),
  'gateway.cliConfig.preview':cliPreview,'gateway.cliConfig.apply':cliResult,'gateway.cliConfig.restore':cliResult,
} satisfies Record<GatewayMethod,z.ZodType>;
export const gatewayEventSchema=z.discriminatedUnion('type',[
  z.object({subscriptionId:opaque,sessionId:opaque,type:z.literal('status'),status:gatewayListenerSchema}).strict(),
  z.object({subscriptionId:opaque,sessionId:opaque,type:z.literal('record-summary'),record:gatewayRecordSummarySchema}).strict(),
  z.object({subscriptionId:opaque,sessionId:opaque,type:z.literal('warning'),code:safeCode}).strict(),
]);
function sizeBound(value:unknown) {
  try {
    const encoded=JSON.stringify(value ?? null);
    if(new TextEncoder().encode(encoded).byteLength>GATEWAY_MAX_IPC_BYTES)throw new Error();
  }catch{throw new Error('网关请求或返回数据超过大小限制。');}
}
export function parseGatewayInput<M extends GatewayMethod>(method:M,input:unknown):GatewayInputMap[M] {
  sizeBound(input);
  return gatewayInputSchemas[method].parse(input ?? {}) as GatewayInputMap[M];
}
export function parseGatewayOutput<M extends GatewayMethod>(method:M,result:unknown):GatewayOutputMap[M] {
  sizeBound(result);
  return gatewayOutputSchemas[method].parse(result) as GatewayOutputMap[M];
}
export function parseGatewayEvent(value:unknown):GatewayEventDto {
  sizeBound(value);return gatewayEventSchema.parse(value) as GatewayEventDto;
}
