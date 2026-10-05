import {logMetadata} from './logs';
import {publishedRequestPricing,publishedPriceSections,requestPriceRuleLabel,isTimePriceRule,type PublishedPriceSection,type RequestPriceRule} from './pricing';
import type {ModelInfo,SiteStatus,UsageLog} from './types';

const number=(value:unknown):number|undefined=>typeof value==='number' && Number.isFinite(value) && value>=0 ? value : undefined;
function expressionSnapshot(value:unknown):string|undefined {
  if(typeof value!=='string' || value.length>40000)return;
  try{return new TextDecoder('utf-8',{fatal:true}).decode(Uint8Array.from(atob(value),char=>char.charCodeAt(0)));}catch{return;}
}
/** Only recorded public billing facts are used; current catalog prices cannot replace historical prices. */
export function requestBilling(log:UsageLog,status:SiteStatus) {
  const other=logMetadata(log),expression=expressionSnapshot(other.expr_b64);
  const ratio=number(other.user_group_ratio) ?? number(other.group_ratio);
  const tier=typeof other.matched_tier==='string' ? other.matched_tier : undefined;
  let sections:PublishedPriceSection[]=[],rules:RequestPriceRule[]=[],source='站点未提供计费单价';
  const model:ModelInfo={model_name:log.model_name,quota_type:0,model_price:0,model_ratio:NaN,completion_ratio:NaN,enable_groups:[],supported_endpoint_types:[]};
  if(other.billing_mode==='tiered_expr'){
    source=expression ? '本次请求计费快照' : '站点未提供计费规则快照';
    if(expression){
      const pricing=publishedRequestPricing({...model,billing_mode:'tiered_expr',billing_expr:expression});
      sections=publishedPriceSections(pricing.model,status,new Date(log.created_at*1000));rules=pricing.rules;
    }
  }else if(number(other.model_ratio)!==undefined && number(other.completion_ratio)!==undefined || number(other.model_price)!==undefined && (other.billing_unit==='request' || Number(other.model_price)>0)){
    source='本次请求计费快照';
    sections=publishedPriceSections({...model,quota_type:other.billing_unit==='request' || Number(other.model_price)>0 ? 1 : 0,model_price:number(other.model_price) ?? NaN,model_ratio:number(other.model_ratio) ?? NaN,completion_ratio:number(other.completion_ratio) ?? NaN,cache_ratio:number(other.cache_ratio),create_cache_ratio:number(other.cache_creation_ratio)},status);
  }
  const traces=Array.isArray(other.request_rules) ? other.request_rules : undefined;
  if(traces)rules=traces.slice(0,32).flatMap(raw=>{
    if(!raw || typeof raw!=='object' || Array.isArray(raw))return [];
    const rule=raw as Record<string,unknown>;
    if(typeof rule.cond!=='string' || rule.cond.length>4000 || number(rule.multiplier)===undefined)return [];
    return [{condition:rule.cond,label:requestPriceRuleLabel(rule.cond),multiplier:number(rule.multiplier)!,matched:typeof rule.matched==='boolean' ? rule.matched : undefined}];
  });
  // Clock factors are already included in the timestamp-specific base rows.
  const requestRules=rules.filter(rule=>!isTimePriceRule(rule.condition));
  const complete=(!Object.hasOwn(other,'request_rules') || !!traces && rules.length===traces.length) && rules.every(rule=>rule.matched!==undefined);
  const requestMultiplier=complete && (traces || expression || other.billing_mode!=='tiered_expr') ? requestRules.reduce((total,rule)=>total*(rule.matched ? rule.multiplier : 1),1) : undefined;
  sections=sections.filter(section=>section.current!==false);
  const candidates=sections.filter(section=>!tier || section.label===tier);
  const selected=candidates.length===1 ? candidates[0] : undefined;
  return {sections,selected,rules,requestRules,ratio,tier,requestMultiplier,source,dynamic:other.billing_mode==='tiered_expr',expression,
    path:typeof other.request_path==='string' ? other.request_path : undefined,
    conversion:Array.isArray(other.request_conversion) ? other.request_conversion.filter((value):value is string=>typeof value==='string').slice(0,8) : [],
  };
}
