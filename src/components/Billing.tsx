import {priceText,pricingConditionLabel,type PublishedPriceSection,type RequestPriceRule} from '../../shared/pricing';
import type {SiteStatus} from '../../shared/types';
import './billing.css';

export function BillingPriceMatrix({sections,status,ratio,selected,label='基础单价',multiplier=1}:{sections:PublishedPriceSection[];status:SiteStatus;ratio?:number;selected?:PublishedPriceSection;label?:string;multiplier?:number}) {
  const fields=[...new Map(sections.flatMap(section=>section.rows).map(row=>[row.key,{key:row.key,label:row.key==='p' ? '输入' : row.label}])).values()];
  if(!fields.length)return <p className="billing-empty">站点未提供可展开的单价，费用以实际账单为准。</p>;
  return <div className="billing-matrix"><div className="billing-section-heading"><h3>{label}</h3><span>{fields.some(field=>field.key!=='request') ? '每百万 Tokens' : '每次调用'}</span></div><div className="billing-table-wrap"><table><thead><tr><th>档位 / 条件</th>{fields.map(field=><th key={field.key}>{field.label}</th>)}</tr></thead><tbody>{sections.map((section,index)=><tr key={index} className={section===selected ? 'billing-tier-selected' : undefined}><th><strong>{section.label}</strong>{section===selected && <span className="billing-hit">已命中</span>}{section.selectionCondition && <small title={section.selectionCondition}>{pricingConditionLabel(section.selectionCondition)}</small>}</th>{fields.map(field=>{const row=section.rows.find(row=>row.key===field.key);return <td key={field.key}>{row ? priceText(row.usd,status,(ratio ?? 1)*multiplier) : '—'}</td>;})}</tr>)}</tbody></table></div></div>;
}
export function BillingRules({rules,actual=false}:{rules:RequestPriceRule[];actual?:boolean}) {
  if(!rules.length)return null;
  return <div className="billing-rules"><div className="billing-section-heading"><h3>条件倍率</h3><span>{actual ? '本次请求命中情况' : '命中时按规则叠乘'}</span></div><div className="billing-rule-list">{rules.map((rule,index)=><div key={index} className={'billing-rule '+(rule.matched===true ? 'matched' : '')} title={rule.condition}><span>{rule.label}</span><strong>×{rule.multiplier}{actual && <small>{rule.matched===true ? '已命中' : rule.matched===false ? '未命中' : '未提供命中结果'}</small>}</strong></div>)}</div></div>;
}
export function BillingEffectivePrices({section,status,ratio}:{section:PublishedPriceSection;status:SiteStatus;ratio:number}) {
  return <><div className="billing-section-heading"><h3>本次生效单价</h3><span>已含分组与请求倍率 · {section.rows[0]?.unit==='次' ? '每次调用' : '每百万 Tokens'}</span></div><div className="billing-effective-prices">{section.rows.map(row=><div key={row.key}><span>{row.key==='p' ? '输入' : row.label}</span><strong>{priceText(row.usd,status,ratio)}</strong></div>)}</div></>;
}
