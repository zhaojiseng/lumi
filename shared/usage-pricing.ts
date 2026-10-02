import {compilePrice,defaultPricingModel,isExpression,legacyPrices} from './pricing';
import type {ModelInfo,SiteStatus} from './types';

/** Actual text usage: input excludes cached reads and cache creation. */
export interface UsagePriceFacts {
  inputTokens:number;outputTokens:number;cacheReadTokens:number;cacheWriteTokens:number;contextTokens:number;
  cacheWriteShortTokens?:number;cacheWriteLongTokens?:number;createdAt:number;requests?:number;
}
type PriceNode=ReturnType<typeof compilePrice>['node'];
const compiled=new Map<string,PriceNode>();
const finite=(value:unknown):value is number=>typeof value==='number' && Number.isFinite(value);
function expressionNode(expression:string){
  let node=compiled.get(expression);if(!node){node=compilePrice(expression).node;compiled.set(expression,node);if(compiled.size>64)compiled.delete(compiled.keys().next().value!);}return node;
}
function usesVariable(node:PriceNode,name:string):boolean {
  if(node.k==='var')return node.name===name;
  if(node.k==='value')return false;
  if(node.k==='unary')return usesVariable(node.right,name);
  if(node.k==='binary')return usesVariable(node.left,name) || usesVariable(node.right,name);
  if(node.k==='choose')return usesVariable(node.cond,name) || usesVariable(node.yes,name) || usesVariable(node.no,name);
  return node.args.some(arg=>usesVariable(arg,name));
}
function evaluate(node:PriceNode,values:Record<string,number|undefined>,date:Date):unknown {
  if(node.k==='value')return node.value;
  if(node.k==='var'){const value=values[node.name];if(!finite(value))throw new Error('Missing actual usage field');return value;}
  if(node.k==='choose')return evaluate(evaluate(node.cond,values,date) ? node.yes : node.no,values,date);
  if(node.k==='unary'){
    const value=evaluate(node.right,values,date);if(node.op==='!')return !value;
    if(!finite(value))throw new Error('Invalid numeric price');return node.op==='-' ? -value : value;
  }
  if(node.k==='binary'){
    const left=evaluate(node.left,values,date);
    if(node.op==='&&')return left ? evaluate(node.right,values,date) : left;
    if(node.op==='||')return left || evaluate(node.right,values,date);
    const right=evaluate(node.right,values,date);
    if(node.op==='==')return left===right;if(node.op==='!=')return left!==right;
    if(!finite(left) || !finite(right))throw new Error('Invalid numeric operands');
    switch(node.op){
      case '+':return left+right;case '-':return left-right;case '*':return left*right;case '/':return left/right;
      case '%':return left%right;case '**':return left**right;case '<':return left<right;case '<=':return left<=right;
      case '>':return left>right;case '>=':return left>=right;default:throw new Error('Unsupported actual usage rule');
    }
  }
  if(node.name==='tier' && node.args.length===2)return evaluate(node.args[1],values,date);
  if(node.name==='fixed' && node.args.length===1)return evaluate(node.args[0],values,date);
  if(['hour','minute','weekday','month','day'].includes(node.name) && node.args.length===1){
    const zone=evaluate(node.args[0],values,date);if(typeof zone!=='string')throw new Error('Invalid price time zone');
    const parts=new Intl.DateTimeFormat('en-US',{timeZone:zone,hour:'numeric',minute:'numeric',weekday:'short',month:'numeric',day:'numeric',hourCycle:'h23'}).formatToParts(date);
    const raw=parts.find(part=>part.type===node.name)?.value;
    return node.name==='weekday' ? ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'].indexOf(raw || '') : Number(raw);
  }
  const args=node.args.map(arg=>evaluate(arg,values,date));
  if(!args.every(finite))throw new Error('Unavailable request pricing facts');
  switch(node.name){
    case 'min':return args.length ? Math.min(...args) : NaN;case 'max':return args.length ? Math.max(...args) : NaN;
    case 'abs':return args.length===1 ? Math.abs(args[0]) : NaN;case 'ceil':return args.length===1 ? Math.ceil(args[0]) : NaN;
    case 'floor':return args.length===1 ? Math.floor(args[0]) : NaN;default:throw new Error('Unavailable request pricing facts');
  }
}
/** Price real recorded usage with the site's published rule, in account quota units. */
export function usageQuota(model:ModelInfo,status:SiteStatus,facts:UsagePriceFacts,multiplier:number):number|null {
  if(!finite(multiplier) || multiplier<0 || ![facts.inputTokens,facts.outputTokens,facts.cacheReadTokens,facts.cacheWriteTokens,facts.contextTokens,facts.createdAt].every(value=>finite(value) && value>=0))return null;
  const unit=status.quota_per_unit;if(!finite(unit) || unit<=0)return null;
  for(const tokens of [facts.cacheWriteShortTokens,facts.cacheWriteLongTokens])if(tokens!==undefined && (!finite(tokens) || tokens<0 || tokens>facts.cacheWriteTokens))return null;
  if(facts.cacheWriteShortTokens!==undefined && facts.cacheWriteLongTokens!==undefined && facts.cacheWriteShortTokens+facts.cacheWriteLongTokens!==facts.cacheWriteTokens)return null;
  const priced=defaultPricingModel(model);
  try{
    let usd:number;
    if(isExpression(priced)){
      if(Object.keys(priced.billing_usage_schema || {}).length)return null;
      const node=expressionNode(priced.billing_expr!),split=usesVariable(node,'cc1h');
      const values={p:facts.inputTokens/1e6,c:facts.outputTokens/1e6,cr:facts.cacheReadTokens/1e6,
        cc:!split ? facts.cacheWriteTokens/1e6 : (facts.cacheWriteShortTokens ?? (facts.cacheWriteLongTokens===undefined ? facts.cacheWriteTokens : facts.cacheWriteTokens-facts.cacheWriteLongTokens))/1e6,
        cc1h:facts.cacheWriteLongTokens===undefined ? facts.cacheWriteTokens===0 ? 0 : undefined : facts.cacheWriteLongTokens/1e6,len:facts.contextTokens};
      const result=evaluate(node,values,new Date(facts.createdAt*1000));
      if(!finite(result))return null;usd=result;
    }else{
      const prices=new Map(legacyPrices(priced,status).map(row=>[row.key,row]));
      const request=prices.get('request');
      if(request)usd=request.usd;
      else{
        const categories=[['p',facts.inputTokens],['c',facts.outputTokens],['cr',facts.cacheReadTokens],['cc',facts.cacheWriteTokens]] as const;
        usd=0;for(const [key,tokens] of categories){if(tokens===0)continue;const row=prices.get(key);if(!row)return null;usd+=tokens/1e6*row.usd;}
      }
    }
    const quota=usd*unit*multiplier;return finite(quota) && quota>=0 ? quota : null;
  }catch{return null;}
}
