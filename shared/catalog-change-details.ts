import {compilePrice, isExpression, pricingChoices, type PricingChoice} from './pricing';
import {currency} from './utils';
import type {ModelCatalog, ModelInfo, SiteStatus, UsageField} from './types';

const MAX_TEXT = 120, MAX_EXPRESSION = 6000, MAX_ITEMS = 64, MAX_VARIANTS = 12, MAX_DETAILS = 96;
const numericKeys = ['quota_type','model_ratio','model_price','completion_ratio','cache_ratio','create_cache_ratio','image_ratio','audio_ratio','audio_completion_ratio'] as const;
type PriceNode = ReturnType<typeof compilePrice>['node'];
type Numbers = Record<typeof numericKeys[number], number | null>;
interface PublicExpression {state: 'none' | 'parsed' | 'unsupported' | 'limited'; source?: string;}
interface PublicUsage {key: string; type: string | null; unit: string | null; enum: string[];}
interface PublicVariant {key: string; mode: string | null; expression: PublicExpression; schema: PublicUsage[];}
export interface PublicModelPricing {
  numbers: Numbers; mode: string | null; expression: PublicExpression; schema: PublicUsage[];
  variants: PublicVariant[]; groups: string[]; groupRatios: [string, number][]; limited: boolean;
}
export interface PublicCatalogPricing {
  quotaPerUnit: number; currency: string; exchangeRate: number; symbol: string | null;
  groupRatios: [string, number][]; groups: string[]; autoGroups: string[]; limited: boolean;
}
export interface CatalogChangeDetail {
  label: string; before?: string; after?: string; note?: string;
  formula?: {before?: string; after?: string};
}
function record(value: unknown): value is Record<string, unknown> {return !!value && typeof value === 'object' && !Array.isArray(value);}
function number(value: unknown): number | null {return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null;}
const privateName = /authorization|cookie|password|secret|sensitive|access.?token|api.?key|account|user.?id/i;
function text(value: unknown): string | null {
  return typeof value === 'string' && value.length <= MAX_TEXT && !/[\u0000-\u001f]/.test(value) && !privateName.test(value) && !/^sk-|\bBearer\s/i.test(value) ? value : null;
}
function names(value: unknown): string[] {
  return Array.isArray(value) ? [...new Set(value.map(text).filter((v): v is string => v !== null))].sort().slice(0, MAX_ITEMS) : [];
}
function ratios(value: unknown): [string, number][] {
  return record(value) ? Object.entries(value).filter((v): v is [string, number] => text(v[0]) !== null && number(v[1]) !== null).sort(([a],[b]) => a.localeCompare(b)).slice(0, MAX_ITEMS) : [];
}
/** Remove comments without treating comment markers inside quoted rule strings as comments. */
function uncomment(source: string): string {
  return source.replace(/"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|\/\*[\s\S]*?\*\/|\/\/[^\r\n]*/g, part => part.startsWith('/*') || part.startsWith('//') ? ' ' : part);
}
function sourceOf(node: PriceNode): string {
  if (node.k === 'value') {
    if (typeof node.value === 'string' && text(node.value) === null) throw new Error('Non-public rule literal');
    if (typeof node.value === 'number' && !Number.isFinite(node.value)) throw new Error('Invalid coefficient');
    return JSON.stringify(node.value);
  }
  if (node.k === 'var') return node.name;
  if (node.k === 'call') return node.name + '(' + node.args.map(sourceOf).join(',') + ')';
  if (node.k === 'unary') return '(' + node.op + sourceOf(node.right) + ')';
  if (node.k === 'binary') return '(' + sourceOf(node.left) + ' ' + node.op + ' ' + sourceOf(node.right) + ')';
  return '(' + sourceOf(node.cond) + ' ? ' + sourceOf(node.yes) + ' : ' + sourceOf(node.no) + ')';
}
function expression(value: unknown): PublicExpression {
  if (typeof value !== 'string' || !value.trim()) return {state: 'none'};
  if (value.length > 30000) return {state: 'limited'};
  try {
    const source = sourceOf(compilePrice(uncomment(value)).node);
    if(source.length <= MAX_EXPRESSION) compilePrice(source);
    return source.length <= MAX_EXPRESSION ? {state: 'parsed', source} : {state: 'limited'};
  } catch {return {state: 'unsupported'};}
}
function schema(value: unknown): PublicUsage[] {
  return record(value) ? Object.entries(value).filter(([key]) => text(key) !== null).sort(([a],[b]) => a.localeCompare(b)).slice(0, MAX_ITEMS).map(([key, raw]) => {
    const field = record(raw) ? raw : {};
    return {key, type: text(field.type), unit: text(field.unit), enum: names(field.enum)};
  }) : [];
}
export function publicModelPricing(model: ModelInfo): PublicModelPricing {
  const variants = (Array.isArray(model.billing_plugin_variants) ? model.billing_plugin_variants : []).filter(record).filter(v => text(v.plugin_key) !== null);
  const usage = record(model.billing_usage_schema) ? model.billing_usage_schema : {};
  return {
    numbers: Object.fromEntries(numericKeys.map(key => [key, number(key === 'create_cache_ratio' ? model.create_cache_ratio ?? model.cache_creation_ratio : model[key])])) as Numbers,
    mode: text(model.billing_mode), expression: expression(model.billing_expr), schema: schema(usage),
    variants: variants.map(v => ({key: v.plugin_key as string, mode: text(v.billing_mode) || 'tiered_expr', expression: expression(v.billing_expr), schema: schema(v.billing_usage_schema)})).sort((a,b) => a.key.localeCompare(b.key) || JSON.stringify(a).localeCompare(JSON.stringify(b))).slice(0, MAX_VARIANTS),
    groups: names(model.enable_groups), groupRatios: ratios(model.group_ratio),
    limited: variants.length > MAX_VARIANTS || Object.keys(usage).length > MAX_ITEMS || model.enable_groups.length > MAX_ITEMS || (record(model.group_ratio) && Object.keys(model.group_ratio).length > MAX_ITEMS),
  };
}
export function publicCatalogPricing(catalog: ModelCatalog, status: SiteStatus): PublicCatalogPricing {
  const currency = text(status.quota_display_type) || 'USD';
  return {
    quotaPerUnit: number(status.quota_per_unit) || 500000, currency,
    exchangeRate: currency === 'CUSTOM' ? number(status.custom_currency_exchange_rate) ?? 1 : currency === 'CNY' ? number(status.usd_exchange_rate) ?? 1 : 1,
    symbol: currency === 'CUSTOM' ? text(status.custom_currency_symbol) || '¤' : null,
    groupRatios: ratios(catalog.groupRatio), groups: names(Object.keys(catalog.usableGroups)), autoGroups: names(catalog.autoGroups),
    limited: Object.keys(catalog.groupRatio).length > MAX_ITEMS || Object.keys(catalog.usableGroups).length > MAX_ITEMS || catalog.autoGroups.length > MAX_ITEMS,
  };
}
function readExpression(value: unknown): PublicExpression | null {
  if (!record(value) || !['none','parsed','unsupported','limited'].includes(value.state as string)) return null;
  if (value.state !== 'parsed') return {state: value.state as PublicExpression['state']};
  if (typeof value.source !== 'string' || value.source.length > MAX_EXPRESSION) return null;
  const parsed = expression(value.source);
  return parsed.state === 'parsed' && parsed.source === value.source ? parsed : null;
}
function readNames(value: unknown): string[] | null {
  return Array.isArray(value) && value.length <= MAX_ITEMS && value.every(v => text(v) !== null) ? names(value) : null;
}
function readRatios(value: unknown): [string, number][] | null {
  if (!Array.isArray(value) || value.length > MAX_ITEMS || !value.every(v => Array.isArray(v) && v.length === 2 && text(v[0]) !== null && number(v[1]) !== null)) return null;
  if (new Set(value.map(v => v[0])).size !== value.length) return null;
  return ratios(Object.fromEntries(value));
}
function readSchema(value: unknown): PublicUsage[] | null {
  if (!Array.isArray(value) || value.length > MAX_ITEMS) return null;
  const result: PublicUsage[] = [];
  for (const field of value) {
    if (!record(field) || text(field.key) === null || !(field.type === null || text(field.type) !== null) || !(field.unit === null || text(field.unit) !== null)) return null;
    const choices = readNames(field.enum);
    if (!choices) return null;
    result.push({key: field.key as string, type: field.type as string | null, unit: field.unit as string | null, enum: choices});
  }
  return new Set(result.map(f => f.key)).size === result.length ? result.sort((a,b) => a.key.localeCompare(b.key)) : null;
}
/** Rebuild persisted public data, including nested rules; never spread stored objects into ModelInfo. */
export function readPublicModelPricing(value: unknown): PublicModelPricing | null {
  if (!record(value) || !record(value.numbers) || typeof value.limited !== 'boolean' || !(value.mode === null || text(value.mode) !== null)) return null;
  const values = value.numbers;
  if (!numericKeys.every(key => values[key] === null || number(values[key]) !== null)) return null;
  const expr = readExpression(value.expression), usage = readSchema(value.schema), groups = readNames(value.groups), groupRatios = readRatios(value.groupRatios);
  if (!expr || !usage || !groups || !groupRatios || !Array.isArray(value.variants) || value.variants.length > MAX_VARIANTS) return null;
  const variants: PublicVariant[] = [];
  for (const v of value.variants) {
    if (!record(v) || text(v.key) === null || !(v.mode === null || text(v.mode) !== null)) return null;
    const variantExpr = readExpression(v.expression), variantSchema = readSchema(v.schema);
    if (!variantExpr || !variantSchema) return null;
    variants.push({key: v.key as string, mode: v.mode as string | null, expression: variantExpr, schema: variantSchema});
  }
  return {numbers: Object.fromEntries(numericKeys.map(key => [key, (value.numbers as Record<string,unknown>)[key]])) as Numbers, mode: value.mode as string | null, expression: expr, schema: usage, variants, groups, groupRatios, limited: value.limited};
}
export function readPublicCatalogPricing(value: unknown): PublicCatalogPricing | null {
  if (!record(value) || number(value.quotaPerUnit) === null || text(value.currency) === null || number(value.exchangeRate) === null || typeof value.limited !== 'boolean' || !(value.symbol === null || text(value.symbol) !== null)) return null;
  const groupRatios = readRatios(value.groupRatios), groups = readNames(value.groups), autoGroups = readNames(value.autoGroups);
  return groupRatios && groups && autoGroups ? {quotaPerUnit: value.quotaPerUnit as number, currency: value.currency as string, exchangeRate: value.exchangeRate as number, symbol: value.symbol as string | null, groupRatios, groups, autoGroups, limited: value.limited} : null;
}
function usageSchema(fields: PublicUsage[]): Record<string,UsageField> {
  return Object.fromEntries(fields.map(f => [f.key, {...(f.type ? {type: f.type} : {}), ...(f.unit ? {unit: f.unit} : {}), ...(f.enum.length ? {enum: f.enum} : {})}])) as Record<string,UsageField>;
}
function modelOf(data: PublicModelPricing): ModelInfo {
  return {
    model_name: 'public-pricing', ...Object.fromEntries(numericKeys.filter(key => data.numbers[key] !== null).map(key => [key, data.numbers[key]])),
    quota_type: data.numbers.quota_type ?? NaN, model_ratio: data.numbers.model_ratio ?? NaN,
    model_price: data.numbers.model_price ?? NaN, completion_ratio: data.numbers.completion_ratio ?? NaN,
    enable_groups: data.groups, supported_endpoint_types: [], ...(data.mode ? {billing_mode: data.mode} : {}),
    ...(data.expression.source ? {billing_expr: data.expression.source} : {}), billing_usage_schema: usageSchema(data.schema),
    billing_plugin_variants: data.variants.map(v => ({plugin_key: v.key, plugin_name: v.key, billing_mode: v.mode || 'tiered_expr', ...(v.expression.source ? {billing_expr: v.expression.source} : {}), billing_usage_schema: usageSchema(v.schema)})),
  } as ModelInfo;
}
function statusOf(data: PublicCatalogPricing): SiteStatus {
  return {system_name: 'Public pricing', quota_per_unit: data.quotaPerUnit, quota_display_type: data.currency, usd_exchange_rate: data.exchangeRate, custom_currency_exchange_rate: data.exchangeRate, custom_currency_symbol: data.symbol || '¤'};
}
const variableLabels: Record<string,string> = {p:'输入 Tokens',c:'输出 Tokens',len:'上下文长度',cr:'缓存读取 Tokens',cc:'缓存写入 Tokens',cc1h:'1h 缓存写入 Tokens',img:'图片输入 Tokens',img_cr:'图片缓存 Tokens',img_o:'图片输出 Tokens',ai:'音频输入 Tokens',ao:'音频输出 Tokens',image_count:'图片数量'};
const functionLabels: Record<string,string> = {tier:'档位',fixed:'每次调用金额',min:'取较小值',max:'取较大值',abs:'绝对值',ceil:'向上取整',floor:'向下取整',u:'用量',header:'请求头',param:'请求参数',hour:'小时',minute:'分钟',weekday:'星期',month:'月份',day:'日期',has:'包含'};
function readable(node: PriceNode): string {
  if (node.k === 'value') return typeof node.value === 'string' ? '「' + node.value + '」' : String(node.value);
  if (node.k === 'var') return variableLabels[node.name] || node.name;
  if (node.k === 'call') return (functionLabels[node.name] || node.name) + '(' + node.args.map(readable).join('，') + ')';
  if (node.k === 'unary') return (node.op === '!' ? '非' : node.op) + '(' + readable(node.right) + ')';
  if (node.k === 'binary') return '(' + readable(node.left) + ' ' + ({'*':'×','/':'÷','&&':'且','||':'或','<=':'≤','>=':'≥',has:'包含'}[node.op] || node.op) + ' ' + readable(node.right) + ')';
  return '若 ' + readable(node.cond) + '，则 ' + readable(node.yes) + '；否则 ' + readable(node.no);
}
function formula(data: PublicExpression): string {
  if (data.source) {try {return readable(compilePrice(data.source).node).slice(0, MAX_EXPRESSION);} catch {}}
  return data.state === 'none' ? '未公布表达式' : data.state === 'limited' ? '规则超出本地保存或解析长度上限' : '规则无法通过受限解析，未保存原式或推导单价';
}
function equal(a: unknown, b: unknown): boolean {return JSON.stringify(a) === JSON.stringify(b);}
function pair(label: string, before: string | undefined, after: string | undefined, note?: string): CatalogChangeDetail {return {label: label.slice(0,240), ...(before === undefined ? {} : {before: before.slice(0,800)}), ...(after === undefined ? {} : {after: after.slice(0,800)}), ...(note ? {note: note.slice(0,800)} : {})};}
function prettyNumber(value: number): string {return value.toLocaleString('en-US', {maximumSignificantDigits: 12});}
function priceText(usd: number, status: SiteStatus): string {
  const c = currency(status);
  return c.symbol + prettyNumber(c.value(usd * (status.quota_per_unit || 500000)));
}
function multiplier(value: number | undefined | null): string | undefined {return value == null ? undefined : '×' + prettyNumber(value);}
function ratioDetails(before: [string,number][], after: [string,number][], label: string, oldFallback: [string,number][] = [], newFallback: [string,number][] = []): CatalogChangeDetail[] {
  const old = new Map(before), next = new Map(after), a = new Map(oldFallback), b = new Map(newFallback);
  const value = (own: Map<string,number>, fallback: Map<string,number>, key: string) => {
    const amount = multiplier(own.get(key) ?? fallback.get(key));
    return amount && !own.has(key) && fallback.has(key) ? amount + '（沿用站点）' : amount;
  };
  return [...new Set([...old.keys(), ...next.keys()])].sort().filter(key => old.get(key) !== next.get(key)).map(key => pair(label + '「' + key + '」倍率', value(old,a,key), value(next,b,key), label === '模型渠道' ? '此模型的专属渠道倍率；未设置时沿用站点倍率，不改动站点渠道规则。' : '站点公布的渠道倍率；模型的专属覆盖倍率仍单独生效。'));
}
function choices(data: PublicModelPricing, status: SiteStatus, now: Date): PricingChoice[] {
  const model = modelOf(data);
  // A missing safe expression is not evidence that the legacy ratio is the active price.
  if (data.expression.state !== 'none' && data.expression.state !== 'parsed' && data.mode !== 'ratio') return [];
  return pricingChoices(model, status, now).filter(choice => {
    const variant = data.variants.find(v => 'plugin:' + v.key === choice.sourceKey);
    return !variant || variant.expression.state === 'parsed' || variant.expression.state === 'none';
  });
}
function choiceLabel(choice: PricingChoice): string {return [choice.sourceName ? '插件「' + choice.sourceName + '」' : '', choice.label !== '默认' ? choice.label : ''].filter(Boolean).join(' · ');}
function timeRule(rule: PricingChoice['timeRates'][number]): string {return rule.condition + (rule.multiplier === undefined ? '' : ' ' + multiplier(rule.multiplier));}
function bounded(details: CatalogChangeDetail[]): CatalogChangeDetail[] {
  const unique = details.filter((d,i) => details.findIndex(v => equal(v,d)) === i);
  return unique.length <= MAX_DETAILS ? unique : [...unique.slice(0,MAX_DETAILS-1), {label:'更多变化',note:'明细达到本地保存上限，已保留规则指纹；其余变化未逐项保存。'}];
}
/** Compare both public rules at ONE detection time. Live prices never feed the monitor fingerprint. */
export function modelPricingDetails(before: PublicModelPricing, after: PublicModelPricing, oldCatalog: PublicCatalogPricing, newCatalog: PublicCatalogPricing, detectedAt: number): CatalogChangeDetail[] {
  const details: CatalogChangeDetail[] = [], oldStatus = statusOf(oldCatalog), newStatus = statusOf(newCatalog), now = new Date(detectedAt);
  const oldChoices = choices(before,oldStatus,now), newChoices = choices(after,newStatus,now), used = new Set<number>();
  let ruleExplained = false;
  const explainedSources = new Set<string>(), formulaSources = new Set<string>();
  for (const next of newChoices) {
    const condition = next.section?.selectionCondition ?? '';
    let index = oldChoices.findIndex((old,i) => !used.has(i) && old.sourceKey === next.sourceKey && (old.section?.selectionCondition ?? '') === condition && old.section?.label === next.section?.label);
    if (index < 0) index = oldChoices.findIndex((old,i) => !used.has(i) && old.sourceKey === next.sourceKey);
    const old = index < 0 ? undefined : oldChoices[index];
    if (old) used.add(index);
    const label = choiceLabel(next), prefix = label ? label + ' · ' : '';
    if (old && (old.section?.selectionCondition ?? '') !== condition) {details.push(pair(prefix + '适用条件',choiceLabel(old) || '默认',label || '默认')); ruleExplained = true; explainedSources.add(next.sourceKey);}
    if (!old?.section || !next.section || [...(old?.timeRates || []),...next.timeRates].some(rate => rate.multiplier === undefined)) formulaSources.add(next.sourceKey);
    const oldRows = new Map(old?.section?.rows.map(row => [row.key,row]) || []), nextRows = new Map(next.section?.rows.map(row => [row.key,row]) || []);
    for (const key of new Set([...oldRows.keys(),...nextRows.keys()])) {
      const a = oldRows.get(key), b = nextRows.get(key);
      const price = (row: typeof a, status: SiteStatus) => row ? priceText(row.usd,status) + ' / ' + row.unit : undefined;
      const from = price(a,oldStatus), to = price(b,newStatus);
      if (from !== to) {details.push(pair(prefix + (b?.label || a!.label) + '价格',from,to,(old?.timeRates.length || next.timeRates.length) ? '旧新价格均按本次检测时刻适用的时间规则计算；其他时段见时间规则。' : undefined)); ruleExplained = true; explainedSources.add(next.sourceKey);}
    }
    if (old && !equal(old.timeRates.map(timeRule),next.timeRates.map(timeRule))) {
      const length = Math.max(old.timeRates.length,next.timeRates.length);
      for (let i=0;i<length;i++) {const a=old.timeRates[i],b=next.timeRates[i];if(!equal(a && timeRule(a),b && timeRule(b))) details.push(pair(prefix + '时间规则',a && timeRule(a),b && timeRule(b)));}
      ruleExplained = true;
      explainedSources.add(next.sourceKey);
    }
  }
  for (let i=0;i<oldChoices.length;i++) if (!used.has(i)) {
    const old = oldChoices[i];
    for (const row of old.section?.rows || []) details.push(pair([choiceLabel(old), row.label + '价格'].filter(Boolean).join(' · '),priceText(row.usd,oldStatus) + ' / ' + row.unit,undefined,'此公布档位或插件规则已移除，或新规则无法推导固定单价。'));
  }
  if (before.numbers.quota_type !== after.numbers.quota_type) details.push(pair('计费单位',before.numbers.quota_type === 1 ? '按次调用' : '按 Tokens',after.numbers.quota_type === 1 ? '按次调用' : '按 Tokens'));
  if (before.mode !== after.mode) details.push(pair('计算方式',before.mode === 'ratio' || !before.mode ? '倍率计价' : '表达式计价',after.mode === 'ratio' || !after.mode ? '倍率计价' : '表达式计价'));
  const oldSources = new Map([['base',before.expression],...before.variants.map(v => ['plugin:'+v.key,v.expression] as const)]), nextSources = new Map([['base',after.expression],...after.variants.map(v => ['plugin:'+v.key,v.expression] as const)]);
  for (const key of new Set([...oldSources.keys(),...nextSources.keys()])) {
    const a = oldSources.get(key), b = nextSources.get(key);
    if (equal(a,b) && (a?.state === 'none' || a?.state === 'parsed' || explainedSources.has(key))) continue;
    if (!explainedSources.has(key) || formulaSources.has(key) || !a?.source || !b?.source) {
      details.push({label:(key === 'base' ? '默认计价' : '插件「'+key.slice(7)+'」')+'公式',note:'公布的公式或条件发生变化；无法线性拆分的规则不推测单价。',formula:{...(a ? {before:formula(a)} : {}),...(b ? {after:formula(b)} : {})}});
    }
  }
  const oldSchemas = new Map([['默认计价',before.schema],...before.variants.map(v => ['插件「'+v.key+'」',v.schema] as const)]), newSchemas = new Map([['默认计价',after.schema],...after.variants.map(v => ['插件「'+v.key+'」',v.schema] as const)]);
  for (const key of new Set([...oldSchemas.keys(),...newSchemas.keys()])) {
    const a = new Map(oldSchemas.get(key)?.map(f => [f.key,f]) || []), b = new Map(newSchemas.get(key)?.map(f => [f.key,f]) || []);
    for (const name of new Set([...a.keys(),...b.keys()])) {
      const from = a.get(name), to = b.get(name);
      const description = (f: PublicUsage | undefined) => f ? [f.type && '类型 '+f.type,f.unit && '单位 '+f.unit,f.enum.length && '可选 '+f.enum.join('、')].filter(Boolean).join('；') || '用量字段' : undefined;
      if (!equal(from,to)) details.push(pair(key+' · 用量「'+name+'」',description(from),description(to)));
    }
  }
  details.push(...ratioDetails(before.groupRatios,after.groupRatios,'模型渠道',oldCatalog.groupRatios,newCatalog.groupRatios));
  if (!equal(before.groups,after.groups)) details.push(pair('可用渠道',before.groups.join('、') || '无',after.groups.join('、') || '无'));
  // Changes to a dormant legacy rule still deserve a readable value, rather than a raw field name.
  const labels = {model_ratio:'输入倍率',completion_ratio:'输出倍率',cache_ratio:'缓存读取倍率',create_cache_ratio:'缓存写入倍率',image_ratio:'图片倍率',audio_ratio:'音频输入倍率',audio_completion_ratio:'音频输出倍率'};
  if (!ruleExplained || isExpression(modelOf(after))) for (const key of Object.keys(labels) as (keyof typeof labels)[]) if(before.numbers[key]!==after.numbers[key]) details.push(pair(labels[key],multiplier(before.numbers[key]),multiplier(after.numbers[key]),isExpression(modelOf(after)) ? '倍率备用规则；当前公布价由表达式决定。' : undefined));
  if (before.numbers.model_price !== after.numbers.model_price && !details.some(d => d.label.includes('每次调用'))) details.push(pair('按次价格',before.numbers.model_price === null ? undefined : priceText(before.numbers.model_price,oldStatus)+' / 次',after.numbers.model_price === null ? undefined : priceText(after.numbers.model_price,newStatus)+' / 次',after.numbers.quota_type === 1 ? undefined : '按次备用规则；当前计费单位为 Tokens。'));
  if (before.limited || after.limited) details.push({label:'保存范围',note:'公共规则超过本地条目上限，部分明细无法展开；指纹仍比较完整公布规则。'});
  return bounded(details.length ? details : [{label:'公布规则已更新',note:'解析后的可读值未变化，或该规则无法安全解析；保留规则变动提示，不推测旧价。'}]);
}
export function catalogPricingDetails(before: PublicCatalogPricing, after: PublicCatalogPricing): CatalogChangeDetail[] {
  const details = ratioDetails(before.groupRatios,after.groupRatios,'站点渠道');
  if (before.quotaPerUnit !== after.quotaPerUnit) details.push(pair('额度换算单位',prettyNumber(before.quotaPerUnit),prettyNumber(after.quotaPerUnit),'每 1 USD 对应的额度单位；Tokens 倍率单价据此换算。'));
  if (before.currency !== after.currency || before.symbol !== after.symbol) details.push(pair('价格显示币种',before.currency+(before.symbol ? '（'+before.symbol+'）' : ''),after.currency+(after.symbol ? '（'+after.symbol+'）' : '')));
  if (before.exchangeRate !== after.exchangeRate) details.push(pair('价格币种换算倍率',multiplier(before.exchangeRate),multiplier(after.exchangeRate)));
  for (const [key,label] of [['groups','站点可用渠道'],['autoGroups','自动路由渠道']] as const) if (!equal(before[key],after[key])) details.push(pair(label,before[key].join('、') || '无',after[key].join('、') || '无'));
  if (before.limited || after.limited) details.push({label:'保存范围',note:'部分渠道超过本地保存上限，未逐项展开。'});
  return bounded(details.length ? details : [{label:'站点规则已更新',note:'变动部分未包含在可读基线中，无法还原数值。'}]);
}
export function readCatalogChangeDetails(value: unknown): CatalogChangeDetail[] | null {
  if (!Array.isArray(value) || !value.length || value.length > MAX_DETAILS) return null;
  const result: CatalogChangeDetail[] = [];
  for (const v of value) {
    if (!record(v) || typeof v.label !== 'string' || !v.label || v.label.length > 240) return null;
    const d: CatalogChangeDetail = {label:v.label};
    for (const key of ['before','after','note'] as const) if (v[key] !== undefined) {if(typeof v[key] !== 'string' || v[key].length > 800) return null;d[key]=v[key];}
    if (v.formula !== undefined) {
      if (!record(v.formula)) return null;
      d.formula = {};
      for (const key of ['before','after'] as const) if(v.formula[key] !== undefined) {if(typeof v.formula[key] !== 'string' || v.formula[key].length > MAX_EXPRESSION) return null;d.formula[key]=v.formula[key];}
      if (!d.formula.before && !d.formula.after) return null;
    }
    if (d.before === undefined && d.after === undefined && !d.note && !d.formula) return null;
    result.push(d);
  }
  return result;
}
