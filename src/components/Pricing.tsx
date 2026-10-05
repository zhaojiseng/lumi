import {PopupPresence} from './PopupPresence';
import {useEffect,useState} from 'react';
import {Info,Repeat2} from 'lucide-react';
import {Health,HealthPlaceholder,healthTone,latency,throughput} from './Health';
import {bridge} from '../bridge';
import {useApp} from '../context';
import {useSavedSelection} from '../selections';
import {modelSelectionKey} from '../../shared/selections';
import {availableGroups,groupRatio,defaultModelGroup} from '../../shared/catalog';
import {legacyPrices,priceText,publishedPriceSections,defaultPricingModel,isExpression,displayPricingChoices,publishedRequestPricing,defaultPricingChoice,type PriceRow,type PricingChoice} from '../../shared/pricing';
import {BillingPriceMatrix,BillingRules} from './Billing';
import type {CatalogSnapshot} from '../../shared/contracts/catalog';
import type {ModelHealth,ModelHealthDetails,ModelCatalog,ModelInfo,SiteStatus} from '../../shared/types';
import {Button,Modal,Pill,Select} from './ui';
import {ChannelSelect} from './ChannelSelect';

export function PriceTable({model,status,ratio,rows,limit}:{model:ModelInfo;status:SiteStatus;ratio:number;rows?:PriceRow[];limit?:number}) {
  const entries=rows || legacyPrices(model,status);
  return <div className="price-table">{entries.filter(r=>Number.isFinite(r.usd)).slice(0,limit).map(r=><div key={r.key}><span>{r.label}</span><strong>{priceText(r.usd,status,ratio)}<small>/ {r.unit}</small></strong></div>)}</div>;
}
export function PricingTimeInfo({choice}:{choice:PricingChoice}) {
  if(!choice.timeRates.length)return null;
  const active=choice.timeRates.filter(r=>r.current);
  const multiplier=active.every(r=>r.multiplier!==undefined) && active.length ? active.reduce((n,r)=>n*r.multiplier!,1) : undefined;
  return <div className="pricing-time-info"><strong>{multiplier===undefined ? '时间定价规则' : '当前时间倍率 ×'+multiplier}</strong><span>{choice.timeRates.map((r,i)=><span key={i}>{i>0 && '；'}{r.condition}{r.multiplier===undefined ? '' : ' ×'+r.multiplier}</span>)}</span></div>;
}
export function PublishedPrices({model,status,ratio,compact=false,defaultOnly=false}:{model:ModelInfo;status:SiteStatus;ratio:number;compact?:boolean;defaultOnly?:boolean}) {
  const {dashboard}=useApp(),now=new Date(dashboard?.fetchedAt || Date.now());
  if(defaultOnly){
    const choice=defaultPricingChoice(displayPricingChoices(model,status,now)),rules=publishedRequestPricing(model).rules;
    return choice?.section ? <><div className="default-price-label">{choice.label==='默认' ? '默认价格' : '默认档位 · '+choice.label}</div><PriceTable model={choice.model} status={status} ratio={ratio} rows={choice.section.rows}/>{rules.length>0 && <div className="model-request-rates">{rules.map(rule=><span key={rule.condition} title={rule.condition}>{rule.label} ×{rule.multiplier}</span>)}</div>}<PricingTimeInfo choice={choice}/></> : <p className="price-caption">默认价格按站点规则计费，详见定价详情。</p>;
  }
  const sections=publishedPriceSections(model,status,now);
  if(!sections.length)return <p className="price-caption">{Object.keys(model.billing_usage_schema || {}).length ? '任务用量定价' : '按站点计价规则'}{compact ? ' · 详见定价详情' : '，站点原始规则见下方。'}</p>;
  if(compact && (sections.length>1 || sections[0].condition))return <p className="price-caption">条件定价 · 单价与适用条件见详情</p>;
  return <div className="published-prices">{sections.map((s,i)=><section className="published-price-section" key={i}>{(s.condition || sections.length>1) && <div className="published-price-heading"><strong>{s.label}</strong>{s.condition && <span>{s.condition}</span>}</div>}<PriceTable model={model} status={status} ratio={ratio} rows={s.rows} limit={compact ? 2 : undefined}/></section>)}</div>;
}
export function RouteDetails({model,catalog,status,group,defaultOnly=false}:{model?:ModelInfo;catalog:ModelCatalog;status:SiteStatus;group:string;defaultOnly?:boolean}) {
  const {preferences,updatePreferences,toast}=useApp();
  const r=groupRatio(catalog,group,model),count=catalog.models.filter(m=>availableGroups(m,catalog).includes(group)).length;
  const [open,setOpen]=useState(false);
  function showDetails(){if(model)void updatePreferences({selection:{siteId:preferences.activeSiteId,values:{[modelSelectionKey(model.model_name,'group')]:group}}}).catch(e=>toast(e.message,'error'));setOpen(true);}
  return <div className="route-detail"><strong>{catalog.usableGroups[group] || group || '先选择渠道'}</strong><span className="route-multiplier">{group==='auto' ? 'AUTO' : r===undefined ? '—' : '×'+r}</span><p>{group==='auto' ? '按站点自动路由规则选择渠道，价格随实际命中渠道变化。' : '计费倍率已包含账号分组优惠。'}<br/>{group && count+' 个可用模型 · '+group}</p>{group==='auto' && <div className="route-price-list">{catalog.autoGroups.map(g=><span key={g}>{g} <b>{catalog.groupRatio[g]==null ? '未公布' : '×'+catalog.groupRatio[g]}</b></span>)}</div>}{model && group && <div className="route-model-price"><div className="route-price-heading"><strong>站点公布单价</strong><Button type="button" variant="ghost" onClick={showDetails}>详细定价</Button></div>{r===undefined ? <p className="field-help">{group==='auto' ? '自动路由没有固定价格，请选择具体渠道查看。' : '该渠道倍率未公布。'}</p> : <PublishedPrices model={defaultPricingModel(model)} status={status} ratio={r} defaultOnly={defaultOnly}/>}</div>}<PopupPresence>{open && model && <PricingDetailsModal model={model} catalog={catalog} status={status} initialGroup={group} onClose={()=>setOpen(false)}/>}</PopupPresence></div>;
}
function localText(value:unknown):string {if(typeof value==='string')return value;if(value && typeof value==='object'){const v=value as Record<string,string>;return v['zh-CN'] || v.zh || v.en || Object.values(v)[0] || '';}return '';}
export function PricingDetailsModal({model,catalog,status,initialGroup,onClose,health,healthError,snapshot}:{health?:ModelHealth;healthError?:string;snapshot?:CatalogSnapshot;model:ModelInfo;catalog:ModelCatalog;status:SiteStatus;initialGroup?:string;onClose():void}) {
  const {dashboard}=useApp();
  const [healthDetails,setHealthDetails]=useState<ModelHealthDetails|null>(null),[healthDetailError,setHealthDetailError]=useState('');
  const [selectedGroup,setGroup]=useSavedSelection(modelSelectionKey(model.model_name,'group'),initialGroup || '');
  const [choiceKey,setChoiceKey]=useSavedSelection<string>(modelSelectionKey(model.model_name,'price'),'');
  const [modeKey,setModeKey]=useSavedSelection<string>(modelSelectionKey(model.model_name,'mode'),'');
  useEffect(()=>{
    let active=true,pending=false;
    const load=async()=>{if(pending)return;pending=true;try{const h=await bridge.modelHealth(model.model_name);if(active){setHealthDetails(h);setHealthDetailError('');}}catch(e:any){if(active){setHealthDetails(null);setHealthDetailError(e.message);}}finally{pending=false;}};
    void load();const timer=setInterval(()=>{if(document.visibilityState==='visible')void load();},60000);return()=>{active=false;clearInterval(timer);};
  },[model.model_name]);
  const routes=availableGroups(model,catalog),group=defaultModelGroup(model,catalog,selectedGroup);
  const choices=displayPricingChoices(model,status,new Date(snapshot?.fetchedAt || dashboard?.fetchedAt || Date.now())),choice=choices.find(c=>c.key===choiceKey) || defaultPricingChoice(choices);
  const priced=choice?.model || model,r=groupRatio(catalog,group,priced),routeHealth=healthDetails?.groups.find(h=>h.group===group);
  const sourceChoices=choices.filter(c=>c.sourceKey===choice?.sourceKey),sources=choices.filter((c,i,all)=>all.findIndex(v=>v.sourceKey===c.sourceKey)===i);
  const variant=model.billing_plugin_variants?.find(v=>'plugin:'+v.plugin_key===choice?.sourceKey),original=variant ? {...model,...variant,billing_mode:variant.billing_mode || 'tiered_expr'} : model;
  const rules=publishedRequestPricing(original).rules,mode=rules.find(rule=>rule.condition===modeKey);
  const sections=sourceChoices.flatMap(c=>c.section ? [c.section] : []);
  return <Modal className="pricing-modal" title={model.model_name+' · 定价与健康度'} subtitle="站点公布的单价、计费规则和渠道统计" wide onClose={onClose}>
    <Health health={health} error={healthError}/>
    <div className="pricing-controls"><div className="price-route-control"><span className="field-label">计费渠道</span><ChannelSelect label="定价渠道" catalog={catalog} model={model} groups={routes} value={group} onChange={setGroup}/><Pill tone="green">{r===undefined ? '倍率未固定' : '分组 ×'+r}</Pill></div>{rules.length>0 && <div className="pricing-mode-control"><span>请求条件</span><Select label="定价请求条件" value={mode?.condition || ''} onChange={setModeKey}><option value="">未命中条件 · ×1</option>{rules.map(rule=><option key={rule.condition} value={rule.condition}>{rule.label} · ×{rule.multiplier}</option>)}</Select></div>}</div>
    <div className="route-health-line"><span>渠道健康度 · 24h</span>{routeHealth ? <><b className={'health-rate '+healthTone(routeHealth.success_rate)}>{routeHealth.success_rate.toFixed(1)}%</b>{latency(routeHealth.avg_latency_ms)==='—' ? <HealthPlaceholder label="暂无耗时数据"/> : <span>耗时 {latency(routeHealth.avg_latency_ms)}</span>}{latency(routeHealth.avg_ttft_ms)==='—' ? <HealthPlaceholder label="暂无首字数据"/> : <span>首字 {latency(routeHealth.avg_ttft_ms)}</span>}{throughput(routeHealth.avg_tps)==='—' ? <HealthPlaceholder label="暂无生成速度数据"/> : <span>{throughput(routeHealth.avg_tps)}</span>}</> : <HealthPlaceholder label={healthDetailError || (healthDetails ? '当前渠道暂无健康样本' : '正在读取健康度')}/>}</div>
    {sources.length>1 && <><label className="field-label">计价插件</label><Select label="计价插件" value={choice?.sourceKey || ''} onChange={source=>{const next=defaultPricingChoice(choices.filter(c=>c.sourceKey===source));if(next)setChoiceKey(next.key);}}>{sources.map(s=><option key={s.sourceKey} value={s.sourceKey}>{s.sourceName || '默认计价'}</option>)}</Select></>}
    {r===undefined ? <p className="price-caption">{group==='auto' ? '自动路由价格随实际渠道变化。' : '站点未公布该渠道倍率。'}</p> : <BillingPriceMatrix sections={sections} status={status} ratio={r} multiplier={mode?.multiplier ?? 1} label={'站点单价 · 含分组倍率'+(mode ? ' · '+mode.label+' ×'+mode.multiplier : '')}/>}
    <BillingRules rules={rules}/>
    {choice && <PricingTimeInfo choice={choice}/>}
    {!!Object.keys(priced.billing_usage_schema || {}).length && <><div className="price-section-title">站点计费项目</div><div className="published-usage-fields">{Object.entries(priced.billing_usage_schema!).map(([key,f])=><div key={key}><strong>{localText(f.description) || key}</strong><span>{localText(f.unitLabel) || f.unit || ''}{f.enum?.length ? ' · '+f.enum.map(v=>localText(f.enumLabels?.[v]) || v).join(' / ') : ''}</span></div>)}</div></>}
    {isExpression(original) && <details className="published-rule"><summary>站点原始计价规则</summary><pre className="pricing-expression">{original.billing_expr}</pre></details>}
    <p className="price-caption pricing-disclaimer"><Info size={13} aria-hidden="true"/><span>单价已含所选分组、当前时间及所选条件倍率；多个条件同时命中时按站点规则叠乘。实际费用以账单为准。</span></p><div className="modal-actions"><Button type="button" onClick={onClose}>完成</Button></div>
  </Modal>;
}
