import type { ModelInfo, SiteStatus } from './types';
import { currency } from './utils';
type Node = { k: 'value'; value: unknown } | { k: 'var'; name: string } | { k: 'call'; name: string; args: Node[] } | { k: 'unary'; op: string; right: Node } | { k: 'binary'; op: string; left: Node; right: Node } | { k: 'choose'; cond: Node; yes: Node; no: Node };
interface Token { text: string; value?: unknown; kind: 'number' | 'string' | 'id' | 'op'; }
const VARIABLES = ['p','c','len','cr','cc','cc1h','img','img_cr','img_o','ai','ao','image_count'];
const precedence: Record<string, number> = { '||':1, '&&':2, '==':3, '!=':3, '<':4, '<=':4, '>':4, '>=':4, has:4, '+':5, '-':5, '*':6, '/':6, '%':6, '**':7 };
function lex(source: string): Token[] {
  if (source.length > 30000) throw new Error('表达式过长');
  const out: Token[] = []; let i = 0;
  while (i < source.length) {
    if (/\s/.test(source[i])) { i++; continue; }
    const rest = source.slice(i); let m: RegExpMatchArray | null;
    if (source[i] === '"' || source[i] === "'") {
      const quote = source[i++]; let value = ''; let ended = false;
      while (i < source.length) { let c = source[i++]; if (c === quote) { ended = true; break; } if (c === '\u005c') { const escaped = source[i++]; if (escaped === 'u') { const hex = source.slice(i,i+4); if (!/^[0-9a-f]{4}$/i.test(hex)) throw new Error('字符串转义无效'); value += String.fromCharCode(parseInt(hex,16)); i+=4; } else value += ({n:'\n',r:'\r',t:'\t'} as Record<string,string>)[escaped] ?? escaped; } else value += c; }
      if (!ended) throw new Error('字符串未闭合'); out.push({text:value,value,kind:'string'});
    } else if ((m = rest.match(/^(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?/))) { out.push({text:m[0],value:Number(m[0]),kind:'number'}); i+=m[0].length; }
    else if ((m = rest.match(/^[且或非≤≥≠]/))) { out.push({text:({'且':'&&','或':'||','非':'!','≤':'<=','≥':'>=','≠':'!='} as Record<string,string>)[m[0]],kind:'op'}); i+=m[0].length; }
    else if ((m = rest.match(/^[A-Za-z_]\w*/))) { const word = m[0]; out.push({text:({and:'&&',or:'||',not:'!'} as Record<string,string>)[word] || word,kind:'id'}); i+=word.length; }
    else if ((m = rest.match(/^(?:&&|\|\||==|!=|<=|>=|\*\*|[+\-*/%<>!?:(),])/))) { out.push({text:m[0],kind:'op'}); i+=m[0].length; }
    else throw new Error('不支持的表达式字符：' + source[i]);
    if (out.length > 5000) throw new Error('表达式超出计算限制');
  }
  return out;
}
class Parser {
  index = 0; depth = 0; variables = new Set<string>();
  constructor(private tokens: Token[]) {}
  peek() { return this.tokens[this.index]?.text; }
  take(text?: string) { const token = this.tokens[this.index++]; if (!token || (text !== undefined && token.text !== text)) throw new Error('定价表达式语法无效'); return token; }
  expression(min = 0): Node {
    if (++this.depth > 128) throw new Error('表达式嵌套过深');
    try {
      const token = this.take(); let left: Node;
      if (['+','-','!'].includes(token.text)) left = {k:'unary',op:token.text,right:this.expression(8)};
      else if (token.text === '(') { left = this.expression(); this.take(')'); }
      else if (token.kind === 'number' || token.kind === 'string') left = {k:'value',value:token.value};
      else if (['true','false','nil','null'].includes(token.text)) left = {k:'value',value:token.text === 'true' ? true : token.text === 'false' ? false : null};
      else if (token.kind === 'id') {
        if (this.peek() === '(') { this.take('('); const args: Node[] = []; if (this.peek() !== ')') { do { args.push(this.expression()); if (this.peek() !== ',') break; this.take(','); } while (true); } this.take(')'); left={k:'call',name:token.text,args}; }
        else { if (!VARIABLES.includes(token.text)) throw new Error('未支持的变量：' + token.text); this.variables.add(token.text); left={k:'var',name:token.text}; }
      } else throw new Error('无法解析定价表达式');
      while (this.peek() && (precedence[this.peek()] ?? -1) >= min) { const op = this.take().text; left={k:'binary',op,left,right:this.expression(precedence[op]+(op === '**' ? 0 : 1))}; }
      if (min === 0 && this.peek() === '?') { this.take('?'); const yes=this.expression(); this.take(':'); left={k:'choose',cond:left,yes,no:this.expression()}; }
      return left;
    } finally { this.depth--; }
  }
  parse() { const node=this.expression(); if (this.index !== this.tokens.length) throw new Error('定价表达式存在不支持的语法'); return node; }
}
function expandRules(source: string) {
  const version = source.match(/^v(\d+):/); if (version && version[1] !== '1') throw new Error('未支持的计价版本：' + version[0]);
  const parts = source.replace(/^v1:/,'').split('|||'); let result=parts.shift()!.trim();
  for (const part of parts) { const m=part.trim().match(/^when\(([\s\S]*)\)\s*\*\s*(\d+(?:\.\d+)?(?:[eE][+-]?\d+)?)$/); if (!m) throw new Error('未支持的请求倍率规则'); result='(' + result + ') * ((' + m[1] + ') ? ' + m[2] + ' : 1)'; }
  return result;
}
const KNOWN_FUNCTIONS = new Set(['tier','fixed','min','max','abs','ceil','floor','has','u','header','param','hour','minute','weekday','month','day']);
export function compilePrice(expression: string) { const parser=new Parser(lex(expandRules(expression.trim()))); const node=parser.parse();const inspect=(n:Node):void => {if(n.k === 'call'){if(!KNOWN_FUNCTIONS.has(n.name))throw new Error('暂不支持函数：'+n.name);n.args.forEach(inspect);}else if(n.k === 'choose'){inspect(n.cond);inspect(n.yes);inspect(n.no);}else if(n.k === 'binary'){inspect(n.left);inspect(n.right);}else if(n.k === 'unary')inspect(n.right);};inspect(node);return {node,variables:parser.variables}; }
export function isExpression(model: ModelInfo) { return !!model.billing_expr?.trim() && model.billing_mode !== 'ratio'; }
export const TOKEN_FIELDS = [{key:'p',label:'普通输入'},{key:'c',label:'输出'},{key:'cr',label:'缓存读取'},{key:'cc',label:'缓存写入'},{key:'cc1h',label:'缓存写入 · 1h'},{key:'img',label:'图片输入'},{key:'img_cr',label:'图片缓存读取'},{key:'img_o',label:'图片输出'},{key:'ai',label:'音频输入'},{key:'ao',label:'音频输出'}];
export interface PriceRow { key:string; label:string; usd:number; unit:string; }
export interface TimeRate { condition:string; identity?:string; multiplier?:number; current?:boolean; }
export interface PublishedPriceSection { label:string; condition:string; rows:PriceRow[]; current?:boolean; selectionCondition?:string; timeRates?:TimeRate[]; }
export function legacyPrices(model:ModelInfo,status:SiteStatus):PriceRow[] {
  if(model.quota_type===1)return [{key:'request',label:'每次调用',usd:model.model_price,unit:'次'}];
  const base=model.model_ratio*1e6/(status.quota_per_unit || 500000);
  const rows:PriceRow[]=[{key:'p',label:'输入',usd:base,unit:'1M Tokens'},{key:'c',label:'输出',usd:base*model.completion_ratio,unit:'1M Tokens'}];
  for(const [key,label,ratio] of [['cr','缓存读取',model.cache_ratio],['cc','缓存写入',model.create_cache_ratio],['img','图片输入',model.image_ratio],['ai','音频输入',model.audio_ratio],['ao','音频输出',model.audio_ratio==null || model.audio_completion_ratio==null ? undefined : model.audio_ratio*model.audio_completion_ratio]] as const)if(ratio!=null && Number.isFinite(ratio))rows.push({key,label,usd:base*ratio,unit:'1M Tokens'});
  return rows.filter(r=>Number.isFinite(r.usd) && r.usd>=0);
}
function literal(n:Node):number|null {
  if(n.k==='value')return typeof n.value==='number' && Number.isFinite(n.value) ? n.value : null;
  if(n.k==='unary' && ['+','-'].includes(n.op)){const v=literal(n.right);return v===null ? null : n.op==='-' ? -v : v;}
  if(n.k==='binary'){
    const a=literal(n.left),b=literal(n.right);if(a===null || b===null)return null;
    const result=n.op==='+' ? a+b : n.op==='-' ? a-b : n.op==='*' ? a*b : n.op==='/' && b!==0 ? a/b : n.op==='%' && b!==0 ? a%b : n.op==='**' ? a**b : NaN;
    return Number.isFinite(result) ? result : null;
  }
  return null;
}
/** Reads literal coefficients only. No token facts, sample requests, clock evaluation or cost simulation. */
function coefficients(n:Node):Map<string,number>|null {
  if(n.k==='call' && n.name==='tier' && n.args.length===2)return coefficients(n.args[1]);
  if(n.k==='var' && TOKEN_FIELDS.some(f=>f.key===n.name))return new Map([[n.name,1]]);
  if(n.k==='value' && n.value===0)return new Map();
  if(n.k==='binary' && (n.op==='+' || n.op==='-')) {
    const a=coefficients(n.left),b=coefficients(n.right);if(!a || !b)return null;
    for(const [key,value] of b)a.set(key,(a.get(key) || 0)+(n.op==='+' ? value : -value));return a;
  }
  if(n.k==='binary' && (n.op==='*' || n.op==='/')) {
    const left=literal(n.left),right=literal(n.right);let terms:Map<string,number>|null=null;let factor=0;
    if(right!==null && (n.op!=='/' || right!==0)){terms=coefficients(n.left);factor=n.op==='/' ? 1/right : right;}
    else if(n.op==='*' && left!==null){terms=coefficients(n.right);factor=left;}
    if(terms)return new Map([...terms].map(([key,value])=>[key,value*factor]));
  }
  return null;
}
function conditionText(n:Node):string {
  if(n.k==='value')return typeof n.value==='string' ? JSON.stringify(n.value) : String(n.value);
  if(n.k==='var')return n.name==='len' ? '上下文长度' : TOKEN_FIELDS.find(f=>f.key===n.name)?.label || n.name;
  if(n.k==='call')return n.name+'('+n.args.map(conditionText).join(', ')+')';
  if(n.k==='unary')return n.op+'('+conditionText(n.right)+')';
  if(n.k==='binary')return '('+conditionText(n.left)+' '+(({'<=':'≤','>=':'≥','&&':'且','||':'或'} as Record<string,string>)[n.op] || n.op)+ ' '+conditionText(n.right)+')';
  return '条件分支';
}
/** Expand embedded conditional rates without choosing fabricated token facts or request values. */
function clockCondition(node:Node,now:Date):boolean|null {
  function value(n:Node):number|boolean|null {
    if(n.k==='value')return typeof n.value==='number' || typeof n.value==='boolean' ? n.value : null;
    if(n.k==='call' && ['hour','minute','weekday','month','day'].includes(n.name) && n.args.length===1 && n.args[0].k==='value' && typeof n.args[0].value==='string'){
      try{
        const parts=new Intl.DateTimeFormat('en-US',{timeZone:n.args[0].value,hour:'numeric',minute:'numeric',weekday:'short',month:'numeric',day:'numeric',hourCycle:'h23'}).formatToParts(now);
        const part=parts.find(p=>p.type===n.name)?.value;
        return n.name==='weekday' ? ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'].indexOf(part || '') : part===undefined ? null : Number(part);
      }catch{return null;}
    }
    if(n.k==='unary' && n.op==='!'){const a=value(n.right);return typeof a==='boolean' ? !a : null;}
    if(n.k==='binary'){
      const a=value(n.left),b=value(n.right);
      if(n.op==='&&')return a===false || b===false ? false : a===true && b===true ? true : null;
      if(n.op==='||')return a===true || b===true ? true : a===false && b===false ? false : null;
      if(typeof a==='number' && typeof b==='number')return n.op==='>=' ? a>=b : n.op==='>' ? a>b : n.op==='<=' ? a<=b : n.op==='<' ? a<b : n.op==='==' ? a===b : n.op==='!=' ? a!==b : null;
    }
    return null;
  }
  // Evaluate only clock conditions, never request/context facts.
  const result=value(node);return typeof result==='boolean' ? result : null;
}
function onlyClock(n:Node):boolean {
  if(n.k==='value')return true;
  if(n.k==='call')return ['hour','minute','weekday','month','day'].includes(n.name) && n.args.length===1 && n.args[0].k==='value' && typeof n.args[0].value==='string';
  if(n.k==='binary')return onlyClock(n.left) && onlyClock(n.right);
  if(n.k==='unary')return onlyClock(n.right);
  return false;
}
function clockDescription(n:Node):string {
  const zones=new Set<string>();
  function text(n:Node):string {
    if(n.k==='call' && n.args[0]?.k==='value' && typeof n.args[0].value==='string')zones.add(n.args[0].value);
    if(n.k==='binary'){
      if(n.op==='&&' && n.left.k==='binary' && n.right.k==='binary'){
        const a=n.left,b=n.right;
        if(a.left.k==='call' && a.left.name==='hour' && b.left.k==='call' && b.left.name==='hour' && conditionText(a.left)===conditionText(b.left) && a.op==='>=' && b.op==='<' && literal(a.right)!==null && literal(b.right)!==null){text(a.left);return String(literal(a.right)).padStart(2,'0')+':00–'+String(literal(b.right)).padStart(2,'0')+':00';}
      }
      if(n.left.k==='call' && n.left.name==='weekday' && n.op==='==' && literal(n.right)!==null){text(n.left);return ['周日','周一','周二','周三','周四','周五','周六'][literal(n.right)!] || conditionText(n);}
      const left=text(n.left),right=text(n.right);
      if(n.op==='||' && ['周日','周六'].includes(left) && ['周日','周六'].includes(right) && left!==right)return '周末';
      return left+(({'&&':' 且 ','||':' 或 ','>=':' ≥ ','<=':' ≤ '} as Record<string,string>)[n.op] || ' '+n.op+' ')+right;
    }
    if(n.k==='call')return ({hour:'小时',minute:'分钟',weekday:'星期',month:'月份',day:'日期'} as Record<string,string>)[n.name] || conditionText(n);
    if(n.k==='unary')return '非（'+text(n.right)+'）';
    return conditionText(n);
  }
  const label=text(n),zone=[...zones].map(z=>z==='Asia/Shanghai' ? '上海时间' : z).join(' / ');
  return (zone ? zone+'：' : '')+label;
}
interface PriceBranch {node:Node;conditions:string[];selectionConditions:string[];timeRates:TimeRate[];current?:boolean;}
function priceBranches(node:Node,now:Date):PriceBranch[] {
  let work=0;
  function expand(n:Node):PriceBranch[] {
    if(++work>2000)throw new Error('定价分支过多');
    if(n.k==='choose'){
      const condition=conditionText(n.cond),clock=onlyClock(n.cond),active=clock ? clockCondition(n.cond,now) : null;
      const mark=(b:PriceBranch,yes:boolean):PriceBranch=>{
        const label=yes ? condition : '非 '+condition;
        const factor=literal(yes ? n.yes : n.no);
        return {...b,...(active===null ? {} : {current:b.current===false ? false : yes ? active : !active}),conditions:[label,...b.conditions],selectionConditions:clock ? b.selectionConditions : [label,...b.selectionConditions],timeRates:clock ? [{condition:yes ? clockDescription(n.cond) : '其余时段',identity:label,...(factor===null ? {} : {multiplier:factor}),...(active===null ? {} : {current:yes ? active : !active})},...b.timeRates] : b.timeRates};
      };
      return [...expand(n.yes).map(b=>mark(b,true)),...expand(n.no).map(b=>mark(b,false))];
    }
    if(n.k==='binary'){
      const a=expand(n.left),b=expand(n.right);if(a.length*b.length>32)throw new Error('定价分支过多');
      return a.flatMap(left=>b.map(right=>({node:{...n,left:left.node,right:right.node},conditions:[...new Set([...left.conditions,...right.conditions])],selectionConditions:[...new Set([...left.selectionConditions,...right.selectionConditions])],timeRates:[...left.timeRates,...right.timeRates],...(left.current===undefined && right.current===undefined ? {} : {current:left.current!==false && right.current!==false})})))
        .filter(b=>!b.conditions.some(c=>b.conditions.includes(c.startsWith('非 ') ? c.slice(2) : '非 '+c)));
    }
    if(n.k==='unary')return expand(n.right).map(b=>({...b,node:{...n,right:b.node}}));
    if(n.k==='call' && ['tier','fixed'].includes(n.name)){
      const index=n.name==='tier' ? 1 : 0;if(!n.args[index])return [{node:n,conditions:[],selectionConditions:[],timeRates:[]}];
      return expand(n.args[index]).map(b=>({...b,node:{...n,args:n.args.map((arg,i)=>i===index ? b.node : arg)}}));
    }
    return [{node:n,conditions:[],selectionConditions:[],timeRates:[]}];
  }
  const branches=expand(node);if(branches.length>32)throw new Error('定价分支过多');return branches;
}
function fixedAmount(n:Node):number|null {
  if(n.k==='call' && n.name==='fixed' && n.args.length===1)return literal(n.args[0]);
  if(n.k==='binary' && ['*','/'].includes(n.op)){
    const a=fixedAmount(n.left),b=literal(n.right);
    if(a!==null && b!==null && (n.op!=='/' || b!==0))return n.op==='*' ? a*b : a/b;
    const c=literal(n.left),d=fixedAmount(n.right);if(n.op==='*' && c!==null && d!==null)return c*d;
  }
  return null;
}
/** Static published price rows. Conditional branches remain separate; unsupported formulas stay as original rules. */
export function publishedPriceSections(model:ModelInfo,status:SiteStatus,now=new Date()):PublishedPriceSection[] {
  if(!isExpression(model))return [{label:'站点单价',condition:'',rows:legacyPrices(model,status)}];
  if(Object.keys(model.billing_usage_schema || {}).length)return [];
  try {
    const {node,variables}=compilePrice(model.billing_expr!);const result:PublishedPriceSection[]=[];
    const tierNames=(n:Node):string[]=>n.k==='call' && n.name==='tier' && n.args[0]?.k==='value' && typeof n.args[0].value==='string' ? [n.args[0].value] : n.k==='binary' ? [...tierNames(n.left),...tierNames(n.right)] : [];
    const walk=(n:Node,label:string,conditions:string[],depth:number,current?:boolean):void=> {
      if(depth>12 || result.length>=32)return;
      if(n.k==='choose'){const condition=conditionText(n.cond);walk(n.yes,label,[...conditions,condition],depth+1);walk(n.no,label,[...conditions,'非 '+condition],depth+1);return;}
      if(n.k==='call' && n.name==='tier' && n.args.length===2 && n.args[0].k==='value' && typeof n.args[0].value==='string'){walk(n.args[1],n.args[0].value,conditions,depth+1,current);return;}
      let rows:PriceRow[]=[];
      const fixed=fixedAmount(n);
      if(fixed!==null){if(Number.isFinite(fixed) && fixed>=0)rows=[{key:'request',label:'每次调用',usd:fixed,unit:'次'}];}
      else {const terms=coefficients(n);if(!terms || [...terms.values()].some(v=>!Number.isFinite(v) || v<0))return;
        rows=TOKEN_FIELDS.filter(f=>terms.has(f.key)).map(f=>({key:f.key,label:f.key==='cc' && variables.has('cc1h') ? '缓存写入 · 5m' : f.label,usd:terms.get(f.key)!,unit:'1M Tokens'}));}
      if(rows.length)result.push({label:label || [...new Set(tierNames(n))].join(' / ') || '站点单价',condition:conditions.join(' 且 '),rows,...(current===undefined ? {} : {current})});
    };
    for(const branch of priceBranches(node,now)){
      const start=result.length;walk(branch.node,'',branch.conditions,0,branch.current);
      for(const section of result.slice(start)){section.selectionCondition=branch.selectionConditions.join(' 且 ');section.timeRates=branch.timeRates;}
    }
    return result;
  }catch{return [];}
}
export function defaultPricingModel(model:ModelInfo):ModelInfo {
  const variant=model.billing_plugin_variants?.[0];return variant && !model.billing_expr && model.billing_mode!=='ratio' ? {...model,...variant,billing_mode:variant.billing_mode || 'tiered_expr'} : model;
}
export interface PublishedPricingState {
  key:string; label:string; condition:string; model:ModelInfo; section?:PublishedPriceSection;
}
function shortCondition(condition:string):string {
  if(condition.includes('hour('))return condition.replace(/(非 )?\(上下文长度 (≤|≥|<|>) (\d+)\)/g,(_,negative:string,op:string,raw:string)=>shortCondition((negative || '')+'(上下文长度 '+op+' '+raw+')')).replace(/(非 )?\(\(hour\("([^"]+)"\) ≥ (\d+)\) 且 \(hour\("\2"\) < (\d+)\)\)/g,(_,negative:string,zone:string,start:string,end:string)=>{const h=(v:string)=>v.padStart(2,'0')+':00';return (zone==='Asia/Shanghai' ? '上海时间' : zone)+' '+(negative ? h(end)+'–次日'+h(start) : h(start)+'–'+h(end));}).replaceAll(' 且 ',' · ');
  const simple=condition.match(/^(非 )?\(上下文长度 (≤|≥|<|>|==|!=) (\d+)\)$/);
  if(!simple)return condition;
  const [,negative,operator,raw]=simple;
  const op=negative ? ({'≤':'>','≥':'<','<':'≥','>':'≤','==':'!=','!=':'=='} as Record<string,string>)[operator] : operator;
  const value=Number(raw),number=value>=1000 && value%1000===0 ? value/1000+'K' : value.toLocaleString('en-US');
  return '上下文 '+op+' '+number;
}
/** Picker states come exclusively from published branches/plugins, never fabricated context sizes. */
export function publishedPricingStates(model:ModelInfo,status:SiteStatus,now=new Date()):PublishedPricingState[] {
  const variants=model.billing_plugin_variants || [];
  const sources:{key:string;name:string;model:ModelInfo}[]=[];
  if(!variants.length || model.billing_expr || model.billing_mode==='ratio')sources.push({key:'base',name:variants.length ? '默认计价' : '',model});
  for(const variant of variants)sources.push({key:'plugin:'+variant.plugin_key,name:variant.plugin_name,model:{...model,...variant,billing_mode:variant.billing_mode || 'tiered_expr'}});
  return sources.flatMap(source=>{
    const sections=publishedPriceSections(source.model,status,now);
    if(!sections.length)return [{key:source.key,label:source.name || '站点规则',condition:'',model:source.model}];
    return sections.map((section,index)=>({
      key:source.key+':'+index,model:source.model,section,condition:section.condition,
      label:[source.name,section.condition ? shortCondition(section.condition) : sections.length>1 ? section.label : ''].filter(Boolean).join(' · ') || '站点单价',
    }));
  });
}
export interface PricingChoice { key:string; label:string; sourceKey:string; sourceName:string; model:ModelInfo; section?:PublishedPriceSection; timeRates:TimeRate[]; }
export interface RequestPriceRule {condition:string;label:string;multiplier:number;matched?:boolean;}
/** Display equivalent Fast/Priority aliases together without changing the underlying billing rules. */
export function requestPricingOptions(rules:RequestPriceRule[]){
  const options:(RequestPriceRule & {conditions:string[]})[]=[];
  for(const rule of rules){
    const fast=['Fast','Fast（Priority）'].includes(rule.label),label=fast ? 'Fast' : rule.label;
    const existing=fast ? options.find(option=>option.label===label && option.multiplier===rule.multiplier) : undefined;
    if(existing)existing.conditions.push(rule.condition);
    else options.push({...rule,label,conditions:[rule.condition]});
  }
  return options;
}
function nodeText(n:Node):string {
  if(n.k==='value')return JSON.stringify(n.value);
  if(n.k==='var')return n.name;
  if(n.k==='call')return n.name+'('+n.args.map(nodeText).join(',')+')';
  if(n.k==='unary')return '('+n.op+nodeText(n.right)+')';
  if(n.k==='choose')return '('+nodeText(n.cond)+'?'+nodeText(n.yes)+':'+nodeText(n.no)+')';
  return '('+nodeText(n.left)+' '+n.op+' '+nodeText(n.right)+')';
}
export function requestPriceRuleLabel(condition:string):string {
  try {
    const node=compilePrice(condition).node;
    if(isTimePriceRule(condition))return clockDescription(node);
    const friendly=(n:Node):string=>{
      if(n.k==='binary' && n.op==='||')return friendly(n.left)+' / '+friendly(n.right);
      if(n.k==='binary' && n.op==='&&')return friendly(n.left)+' · '+friendly(n.right);
      if(n.k==='binary' && ['==','has'].includes(n.op) && n.left.k==='call' && ['param','header'].includes(n.left.name) && n.left.args[0]?.k==='value' && n.right.k==='value'){
        const key=String(n.left.args[0].value),value=String(n.right.value);
        if(key==='service_tier' && ['fast','priority'].includes(value))return value==='fast' ? 'Fast' : 'Fast（Priority）';
        if(key==='anthropic-beta' && value==='fast-mode')return 'Fast（fast-mode）';
        return (n.left.name==='header' ? '请求头 ' : '请求参数 ')+key+' = '+value;
      }
      return conditionText(n);
    };
    return friendly(node);
  }catch{return condition;}
}
/** Separate global request factors from context tiers; retain clock pricing in the base. */
export function publishedRequestPricing(model:ModelInfo):{model:ModelInfo;rules:RequestPriceRule[]} {
  if(!isExpression(model))return {model,rules:[]};
  try {
    const rules:RequestPriceRule[]=[];
    const requestCondition=(n:Node):boolean=>n.k==='value' || n.k==='call' && (['param','header'].includes(n.name) && n.args.every(arg=>arg.k==='value') || n.name==='has' && n.args.every(requestCondition)) || n.k==='binary' && requestCondition(n.left) && requestCondition(n.right) || n.k==='unary' && requestCondition(n.right);
    const factor=(n:Node)=>{
      if(n.k!=='choose')return false;
      const multiplier=literal(n.yes);
      return !onlyClock(n.cond) && requestCondition(n.cond) && literal(n.no)===1 && multiplier!==null && multiplier>=0;
    };
    const strip=(n:Node):Node=>{
      if(n.k!=='binary' || n.op!=='*')return n;
      for(const [rate,base] of [[n.right,n.left],[n.left,n.right]])if(factor(rate) && rate.k==='choose'){
        const condition=nodeText(rate.cond);rules.unshift({condition,label:requestPriceRuleLabel(condition),multiplier:literal(rate.yes)!});return strip(base);
      }
      return {...n,left:strip(n.left),right:strip(n.right)};
    };
    const node=strip(compilePrice(model.billing_expr!).node);
    return {model:rules.length ? {...model,billing_expr:nodeText(node)} : model,rules};
  }catch{return {model,rules:[]};}
}
export function isTimePriceRule(condition:string):boolean {
  const hasClock=(n:Node):boolean=>n.k==='call' && ['hour','minute','weekday','month','day'].includes(n.name) || n.k==='binary' && (hasClock(n.left) || hasClock(n.right)) || n.k==='unary' && hasClock(n.right);
  try{const node=compilePrice(condition).node;return onlyClock(node) && hasClock(node);}catch{return false;}
}
export const pricingConditionLabel=shortCondition;
export function displayPricingChoices(model:ModelInfo,status:SiteStatus,now=new Date()):PricingChoice[] {
  const base=publishedRequestPricing(model).model;
  return pricingChoices({...base,billing_plugin_variants:model.billing_plugin_variants?.map(variant=>{
    const priced=publishedRequestPricing({...model,...variant,billing_mode:variant.billing_mode || 'tiered_expr'}).model;
    return {...variant,billing_expr:priced.billing_expr ?? variant.billing_expr};
  })},status,now);
}
/** Clock branches follow the live time. The button cycles only published context/request states. */
export function pricingChoices(model:ModelInfo,status:SiteStatus,now=new Date()):PricingChoice[] {
  const groups=new Map<string, {sourceKey:string;sourceName:string;states:PublishedPricingState[]}>();
  for(const state of publishedPricingStates(model,status,now)){
    const sourceKey=state.key.replace(/:\d+$/,''),sourceName=sourceKey==='base' ? '' : model.billing_plugin_variants?.find(v=>'plugin:'+v.plugin_key===sourceKey)?.plugin_name || '';
    const key=sourceKey+'|'+(state.section?.selectionCondition ?? state.condition);
    const group=groups.get(key) || {sourceKey,sourceName,states:[]};group.states.push(state);groups.set(key,group);
  }
  const sourceIndexes=new Map<string,number>();
  return [...groups.values()].map(group=>{
    const index=sourceIndexes.get(group.sourceKey) || 0;sourceIndexes.set(group.sourceKey,index+1);
    const selected=group.states.find(s=>s.section?.current===true) || group.states.find(s=>s.section?.current!==false) || group.states[0];
    const condition=selected.section?.selectionCondition ?? selected.condition;
    const timeRates=group.states.flatMap(s=>s.section?.timeRates || []).filter((r,i,all)=>all.findIndex(v=>v.condition===r.condition && v.multiplier===r.multiplier)===i);
    return {key:group.sourceKey+':state:'+index,label:shortCondition(condition).replace(/^上下文 /,'') || '默认',sourceKey:group.sourceKey,sourceName:group.sourceName,model:selected.model,section:selected.section,timeRates};
  });
}
export function defaultPricingChoice(choices:PricingChoice[]) {
  const source=choices[0]?.sourceKey;
  return choices.find(c=>c.sourceKey===source && /^≤ |^< /.test(c.label)) || choices[0];
}
export function priceText(usd:number,status:SiteStatus,ratio=1) {const c=currency(status);return c.symbol+c.value(usd*(status.quota_per_unit || 500000)*ratio).toLocaleString('en-US',{maximumFractionDigits:6});}
export function routePriceSummary(model:ModelInfo,status:SiteStatus,ratio:number|undefined) {
  if(ratio===undefined)return '价格未固定';
  const priced=defaultPricingModel(model),sections=publishedPriceSections(priced,status);
  if(sections.length===1 && !sections[0].condition)return sections[0].rows.slice(0,2).map(r=>r.label+' '+priceText(r.usd,status,ratio)+'/'+r.unit).join(' · ');
  if(sections.length)return '条件定价 · '+sections.length+' 个档位';
  return Object.keys(priced.billing_usage_schema || {}).length ? '任务用量定价' : '按站点计价规则';
}
