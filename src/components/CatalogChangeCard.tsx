import type {CatalogChange} from '../../shared/catalog-changes';
import {CATALOG_CHANGE_LABELS} from '../../shared/catalog-changes';
import {catalogTierPrice,type CatalogChangeDetail,type CatalogChangePricing,type CatalogPriceDisplay,type CatalogPriceTier} from '../../shared/catalog-change-details';
import {ModelCardFrame} from './ModelCardFrame';
import {Pill} from './ui';
import {useState} from 'react';

function category(detail:CatalogChangeDetail) {
  if(detail.label.endsWith('价格'))return 'price';
  if(/渠道|路由/.test(detail.label))return 'route';
  if(/适用条件|请求条件|时间规则/.test(detail.label))return 'condition';
  return 'rule';
}
function tone(detail:CatalogChangeDetail,kind:CatalogChange['kind']) {
  if(detail.before!==undefined && detail.before===detail.after)return 'unchanged';
  if(kind==='added' || detail.before===undefined && detail.after!==undefined)return 'added';
  if(kind==='removed' || detail.after===undefined && detail.before!==undefined)return 'removed';
  return 'changed';
}
function sharedUnit(detail:CatalogChangeDetail) {
  const before=detail.before?.split(' / '),after=detail.after?.split(' / ');
  return before && after && before.slice(1).join(' / ')===after.slice(1).join(' / ') ? before.slice(1).join(' / ') : !before ? after?.slice(1).join(' / ') : !after ? before.slice(1).join(' / ') : '';
}
function ChangeValues({detail,kind,suppressUnit=false}:{detail:CatalogChangeDetail;kind:CatalogChange['kind'];suppressUnit?:boolean}) {
  const unit=sharedUnit(detail),unchanged=detail.before!==undefined && detail.before===detail.after;
  const value=(amount:string)=>unit ? amount.split(' / ')[0] : amount;
  return <span className="catalog-change-values">
    {detail.before!==undefined && !unchanged && <span className="catalog-change-before">{value(detail.before)}</span>}
    {detail.before!==undefined && detail.after!==undefined && !unchanged && <span className="catalog-change-arrow" aria-label="变更为">→</span>}
    {detail.after!==undefined && <strong className="catalog-change-after">{value(detail.after)}</strong>}
    {kind!=='added' && kind!=='removed' && (detail.before===undefined ? <small className="catalog-change-value-status">新增</small> : detail.after===undefined ? <small className="catalog-change-value-status">移除</small> : null)}
    {unit && !suppressUnit && <small className="catalog-change-unit">/ {unit}</small>}
  </span>;
}
function DetailRow({detail,kind,price=false,suppressUnit=false,labelOverride}:{detail:CatalogChangeDetail;kind:CatalogChange['kind'];price?:boolean;suppressUnit?:boolean;labelOverride?:string}) {
  const label=labelOverride || (price ? detail.label.split(' · ').at(-1)!.replace(/价格$/,'') : detail.label.replace(/公式$/,'档位'));
  return <div className={'catalog-change-detail is-'+tone(detail,kind)+(price ? ' catalog-change-price-row' : '')} data-change-label={detail.label} title={detail.formula ? undefined : detail.note}>
    <dt>{label}</dt>
    {(detail.before!==undefined || detail.after!==undefined) && <dd><ChangeValues detail={detail} kind={kind} suppressUnit={suppressUnit}/></dd>}
    {detail.formula && <dd className="catalog-change-note">此历史规则无法安全推导固定单价，价格未知。</dd>}
    {detail.note && detail.before===undefined && detail.after===undefined && !detail.formula && <dd className="catalog-change-note">{detail.note}</dd>}
  </div>;
}
function pairedTier(display:CatalogPriceDisplay|undefined,tier:CatalogPriceTier) {
  // New keys fingerprint complete conditions. Old index keys only pair when their
  // stored labels also agree; insertion must never pair unrelated context tiers.
  const stable=(value:CatalogPriceTier)=>/:tier:[a-f0-9]{16}$/.test(value.key);
  return display?.tiers.find(candidate=>candidate.sourceKey===tier.sourceKey && (stable(candidate) && stable(tier) ? candidate.key===tier.key : candidate.label===tier.label));
}
function tierChanged(tier:CatalogPriceTier,pricing:CatalogChangePricing,details:CatalogChangeDetail[]) {
  const before=pairedTier(pricing.before,tier),after=pairedTier(pricing.after,tier);
  if(!before || !after)return true;
  return before.label!==after.label || JSON.stringify([before.rows,before.requestModes,before.timeRules,before.unknown])!==JSON.stringify([after.rows,after.requestModes,after.timeRules,after.unknown]) || details.some(detail=>detail.formula && (tier.sourceKey==='base' ? detail.label.startsWith('默认计价') : detail.label.startsWith(tier.sourceLabel)));
}
function RecordedTimeRules({pricing,tier,kind}:{pricing:CatalogChangePricing;tier:CatalogPriceTier;kind:CatalogChange['kind']}) {
  type Rule=CatalogPriceTier['timeRules'][number];
  const same=(a:Rule,b:Rule)=>a.key && b.key ? a.key===b.key : a.label===b.label;
  const context=(display:CatalogPriceDisplay|undefined)=>(display?.tiers || []).filter(item=>item.sourceKey===tier.sourceKey && (item.contextKey && tier.contextKey ? item.contextKey===tier.contextKey : pairedTier(display,tier)?.key===item.key));
  const rules=(display:CatalogPriceDisplay|undefined)=>context(display).flatMap(item=>item.timeRules).filter((rule,index,all)=>all.findIndex(candidate=>same(candidate,rule))===index);
  const before=rules(pricing.before),after=rules(pricing.after),all=[...after,...before.filter(rule=>!after.some(candidate=>same(candidate,rule)))];
  const limited=(display:CatalogPriceDisplay|undefined)=>context(display).some(item=>item.optionsLimited);
  const value=(rule:Rule|undefined,display:CatalogPriceDisplay|undefined)=>rule ? rule.multiplier===undefined ? '按公布规则' : '×'+rule.multiplier : limited(display) ? '未知' : undefined;
  return all.length ? <section className="catalog-change-section catalog-change-time-rules"><h4>时间倍率</h4><dl className="catalog-change-details">{all.map((rule,index)=>{const old=before.find(candidate=>same(candidate,rule)),next=after.find(candidate=>same(candidate,rule));return <DetailRow key={index} kind={kind} detail={{label:rule.label,before:value(old,pricing.before),after:value(next,pricing.after)}}/>;})}</dl></section> : null;
}
function RecordedPricing({pricing,change}:{pricing:CatalogChangePricing;change:CatalogChange}) {
  const display=pricing.after || pricing.before!,side=pricing.after ? 'after' : 'before',defaultKey=side+':'+display.defaultKey;
  const allTiers=[...display.tiers.map(tier=>({key:side+':'+tier.key,tier})),...(pricing.before?.tiers || []).filter(tier=>!pairedTier(display,tier)).map(tier=>({key:'before:'+tier.key,tier}))];
  const [selectedKey,setTier]=useState(defaultKey),[modeKey,setMode]=useState('');
  const selection=allTiers.find(item=>item.key===selectedKey) || allTiers.find(item=>item.key===defaultKey)!,tier=selection.tier,before=pairedTier(pricing.before,tier),after=pairedTier(pricing.after,tier);
  const initialModes=after?.requestModes || before?.requestModes || [],modes=[...initialModes,...(before?.requestModes || []).filter(mode=>!initialModes.some(next=>next.key===mode.key))];
  const selectedMode=modes.find(mode=>mode.key===modeKey),mode=selectedMode?.key || '';
  const factor=(side:CatalogPriceTier|undefined)=>{if(!side)return undefined;if(!mode)return 1;const rule=side.requestModes.find(rule=>rule.key===mode);return rule ? rule.multiplier ?? null : side.unknown || side.optionsLimited ? null : undefined;};
  const oldFactor=factor(before),newFactor=factor(after),oldRows=oldFactor===undefined ? [] : before?.rows || [],newRows=newFactor===undefined ? [] : after?.rows || [];
  const rowKeys=[...new Set([...newRows,...oldRows].map(row=>row.key))],rows:CatalogChangeDetail[]=rowKeys.map(key=>{
    const old=oldRows.find(row=>row.key===key),next=newRows.find(row=>row.key===key),row=next || old!;
    const amount=(entry:typeof row|undefined,multiplier:number|null|undefined)=>entry && multiplier!==undefined ? (multiplier===null ? '未知' : catalogTierPrice(entry,multiplier) || '未知')+' / '+entry.unit : undefined;
    const prefix=[tier.sourceKey==='base' ? '' : tier.sourceLabel,tier.label==='默认' ? '' : tier.label].filter(Boolean).join(' · ');
    return {label:(prefix ? prefix+' · ' : '')+row.label+'价格',...(old ? {before:amount(old,oldFactor)} : before?.unknown && oldFactor!==undefined ? {before:'未知 / '+row.unit} : {}),...(next ? {after:amount(next,newFactor)} : after?.unknown && newFactor!==undefined ? {after:'未知 / '+row.unit} : {})};
  });
  const unit=rows.length && rows.every(row=>sharedUnit(row) && sharedUnit(row)===sharedUnit(rows[0])) ? sharedUnit(rows[0]) : '';
  const tierLabel=(tier:CatalogPriceTier)=>tier.sourceKey==='base' ? tier.label : tier.sourceLabel+' · '+tier.label;
  return <>
    <div className="model-mode-selector catalog-change-tier-selector" role="group" aria-label={(change.modelName || '站点')+' 历史计费档位'}>{allTiers.map(item=>{const old=pairedTier(pricing.before,item.tier),next=pairedTier(pricing.after,item.tier),status=change.kind==='pricing' && (!old || !next) ? !old ? 'added' : 'removed' : '';return <button type="button" key={item.key} className={(tierChanged(item.tier,pricing,change.details || []) ? 'has-change' : '')+(status ? ' is-'+status : '')} aria-pressed={item.key===selection.key} onClick={()=>{setTier(item.key);setMode('');}}><span>{tierLabel(item.tier)}</span>{item.key===defaultKey && item.tier.label!=='默认' && <small>默认</small>}{status && <small>{status==='added' ? '新增' : '移除'}</small>}</button>;})}</div>
    {modes.length>0 && <div className="model-mode-selector catalog-change-mode-selector" role="group" aria-label={(change.modelName || '站点')+' 历史请求条件'}><button type="button" aria-pressed={!mode} onClick={()=>setMode('')}><span>普通</span><small>×1</small></button>{modes.map(rule=>{const old=before?.requestModes.find(item=>item.key===rule.key),next=after?.requestModes.find(item=>item.key===rule.key),oldUnknown=!old && !!(before?.unknown || before?.optionsLimited),newUnknown=!next && !!(after?.unknown || after?.optionsLimited),changed=!!old!==!!next || old?.multiplier!==next?.multiplier || old?.unknown!==next?.unknown,rate=(entry:typeof rule|undefined)=>entry?.multiplier===undefined ? '未知' : '×'+entry.multiplier;return <button type="button" key={rule.key} className={changed ? 'has-change' : ''} data-change-label={(tier.sourceKey==='base' ? '' : tier.sourceLabel+' · ')+'请求条件 · '+rule.label} aria-pressed={mode===rule.key} onClick={()=>setMode(rule.key)}><span>{rule.label}</span><small>{changed && (old && next || oldUnknown || newUnknown) ? rate(old)+' → '+rate(next) : rate(rule)}{changed && (!old || !next) && !oldUnknown && !newUnknown && change.kind==='pricing' ? !old ? ' 新增' : ' 移除' : ''}</small></button>;})}</div>}
    <section className="catalog-change-price-section"><div className="catalog-change-price-heading"><h4>{selectedMode ? selectedMode.label+' 价格' : '普通模式价格'}</h4>{unit && <small>/ {unit}</small>}</div>{rows.length ? <dl className="price-table catalog-change-details">{rows.map((detail,index)=><DetailRow detail={detail} kind={change.kind} price suppressUnit={!!unit} labelOverride={(newRows.find(row=>row.key===rowKeys[index]) || oldRows.find(row=>row.key===rowKeys[index]))?.label} key={index}/>)}</dl> : <p className="catalog-change-unknown">{after?.unknown || before?.unknown || '此历史档位未保存完整价格，单价未知。'}</p>}</section>
    {(before?.unknown || after?.unknown) && rows.length>0 && <p className="catalog-change-unknown">{before?.unknown && '旧档位：'+before.unknown}{before?.unknown && after?.unknown && '；'}{after?.unknown && '新档位：'+after.unknown}</p>}
    <RecordedTimeRules pricing={pricing} tier={tier} kind={change.kind}/>
    {!!(after?.timeRules.length || before?.timeRules.length) && <div className="catalog-change-time-note">当前档位{(after?.timeRules || before?.timeRules || []).every(rule=>rule.active) ? '在检测时生效' : '在检测时未生效'}，价格按此档位计算。</div>}
    {(pricing.before?.limited || pricing.after?.limited) && <p className="catalog-change-unknown">部分档位超过本地保存上限，未保存的项目保持未知。</p>}
  </>;
}
function LegacyPricing({change}:{change:CatalogChange}) {
  const prices=(change.details || []).filter(detail=>category(detail)==='price'),knownGroups=[...new Set(prices.map(detail=>detail.label.split(' · ').slice(0,-1).join(' · ')))];
  const initial=knownGroups.find(group=>group==='' || !group.startsWith('插件') && /^≤ |^< /.test(group)) || '',groups=knownGroups.includes(initial) ? knownGroups : [initial,...knownGroups];
  const [selected,setGroup]=useState(initial),rows=prices.filter(detail=>detail.label.split(' · ').slice(0,-1).join(' · ')===selected),unit=rows.length && rows.every(row=>sharedUnit(row) && sharedUnit(row)===sharedUnit(rows[0])) ? sharedUnit(rows[0]) : '';
  return <>{groups.length>1 && <div className="model-mode-selector catalog-change-tier-selector" role="group" aria-label={(change.modelName || '站点')+' 历史计费档位'}>{groups.map(group=><button type="button" key={group} className={knownGroups.includes(group) ? 'has-change' : ''} aria-pressed={group===selected} onClick={()=>setGroup(group)}><span>{group || '默认档位'}</span></button>)}</div>}<section className="catalog-change-price-section"><div className="catalog-change-price-heading"><h4>{selected || '默认档位'} · 普通模式</h4>{unit && <small>/ {unit}</small>}</div>{rows.length ? <dl className="price-table catalog-change-details">{rows.map((detail,index)=><DetailRow detail={detail} kind={change.kind} price suppressUnit={!!unit} key={index}/>)}</dl> : <p className="catalog-change-unknown">默认档位完整价格未知。</p>}</section><p className="catalog-change-legacy-note">此历史记录仅保存了变更项目，未保存完整档位价格。</p></>;
}

/** Only detection-time snapshots enter the card; neither live prices nor formulas enter its UI. */
export function CatalogChangeCard({change}:{change:CatalogChange}) {
  const details=change.details || [],kind=change.kind,label=kind==='added' ? '新增模型' : kind==='removed' ? '移除模型' : kind==='pricing' ? '计价变动' : '站点规则';
  const listing=kind==='added' || kind==='removed',unitDetail=details.find(detail=>detail.label==='计费单位'),display=change.pricing?.after || change.pricing?.before;
  const groups=[['condition','档位与请求条件'],['route','渠道与倍率'],['rule','计费规则']] as const;
  return <ModelCardFrame name={change.modelName || '站点计费规则'} caption={kind==='catalog' ? '作用于当前站点的模型目录' : '检测时刻的公开计费档位'} className={'catalog-change-card catalog-change-'+kind} actions={<Pill tone={kind==='added' ? 'green' : kind==='removed' ? 'red' : 'orange'}>{label}</Pill>}>
    {kind!=='catalog' && (change.pricing ? <RecordedPricing pricing={change.pricing} change={change}/> : <LegacyPricing change={change}/>)}
    {groups.map(([key,title])=>{const rows=details.filter(detail=>category(detail)===key && !(listing && detail===unitDetail) && !(change.pricing && (detail.formula || /请求条件|时间规则/.test(detail.label))));const routes=listing && key==='route' ? rows.filter(detail=>detail.label!=='可用渠道' || !rows.some(row=>row.label.includes('倍率'))) : rows;return routes.length ? <section className={'catalog-change-section catalog-change-'+key} key={key}><h4>{title}</h4><dl className={'catalog-change-details '+(listing && key==='route' ? 'catalog-listing-routes' : '')}>{routes.map((detail,index)=><DetailRow detail={detail} kind={kind} labelOverride={listing && key==='route' ? detail.label.match(/「([^」]+)」倍率$/)?.[1] : undefined} key={index}/>)}</dl></section> : null;})}
    {!details.length && <div className="catalog-change-legacy">{change.fields.length>0 && <div className="catalog-change-field-tags">{change.fields.map(field=><Pill tone="orange" key={field}>{CATALOG_CHANGE_LABELS[field]}</Pill>)}</div>}<p>此历史记录未保存{listing ? '计费信息' : '变更前后的值'}，无法还原历史价格。</p></div>}
    <div className="model-card-bottom"><span>{(display?.billingUnit || listing && unitDetail) && <span data-change-label="计费单位">{display?.billingUnit || unitDetail?.after || unitDetail?.before} · </span>}{details.length} 项{listing ? '历史计费信息' : '变更明细'}</span><span>{kind==='catalog' ? '站点范围' : '模型范围'}</span></div>
  </ModelCardFrame>;
}
