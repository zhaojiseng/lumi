import {MotionSwap} from '../components/MotionSwap';
import {useMemo,useState,useRef,useEffect} from 'react';
import {Search,Star,ArrowUpRight,SlidersHorizontal,Info,Repeat2} from 'lucide-react';
import {useApp} from '../context';
import {useSavedSelection} from '../selections';
import {modelSelectionKey,selectionValue} from '../../shared/selections';
import {Button,PageIntro,Select,Pill,Empty,ToolIcon} from '../components/ui';
import {Health} from '../components/Health';
import {ProviderIcon} from '../components/BrandIcon';
import {ChannelSelect} from '../components/ChannelSelect';
import {PricingDetailsModal,PriceTable,PricingTimeInfo} from '../components/Pricing';
import {availableGroups,groupRatio,groupLabel,defaultModelGroup,cheapestGroup,sortModels} from '../../shared/catalog';
import {pricingChoices,defaultPricingChoice} from '../../shared/pricing';
import type {ModelInfo,SelectionValue} from '../../shared/types';

function ModelCard({model:m,filterGroup,onDetails}:{model:ModelInfo;filterGroup:string;onDetails(model:ModelInfo):void}) {
  const {dashboard:d,preferences,updatePreferences,configureModel,toast}=useApp();
  const [savedGroup,setGroup]=useSavedSelection<string>(modelSelectionKey(m.model_name,'group'),'');
  const [priceKey,setPriceKey]=useSavedSelection<string>(modelSelectionKey(m.model_name,'price'),'');
  if(!d)return null;
  const routes=availableGroups(m,d.catalog),displayGroup=defaultModelGroup(m,d.catalog,savedGroup || filterGroup),ratio=groupRatio(d.catalog,displayGroup,m);
  const choices=pricingChoices(m,d.status,new Date(d.fetchedAt)),choice=choices.find(s=>s.key===priceKey) || defaultPricingChoice(choices),index=choices.indexOf(choice!);
  const favorite=preferences.favoriteModels.includes(m.model_name);
  async function toggleFavorite(){try{await updatePreferences({favoriteModels:favorite ? preferences.favoriteModels.filter(n=>n!==m.model_name) : [...preferences.favoriteModels,m.model_name]});}catch(e:any){toast(e.message,'error');}}
  return <article className="surface model-card">
    <div className="model-card-top"><ProviderIcon vendor={m.vendor} modelName={m.model_name}/><span>{m.vendor || '其他'}</span><div className="model-card-actions">
      {choices.length>1 && <button type="button" className="pricing-state-button" aria-label={m.model_name+' 定价档位：'+choice?.label} title={'切换至 '+choices[(index+1)%choices.length].label} onClick={()=>setPriceKey(choices[(index+1)%choices.length].key)}><Repeat2 size={12}/>{choice?.label}</button>}
      <button className={'icon-button star-button '+(favorite ? 'starred' : '')} aria-label={(favorite ? '取消收藏 ' : '收藏 ')+m.model_name} onClick={toggleFavorite}><Star size={16} fill={favorite ? 'currentColor' : 'none'}/></button>
    </div></div>
    <h3 title={m.model_name}>{m.model_name}</h3><p className="model-description">{m.description || '站点可用模型。单价与计费条件由站点提供。'}</p>
    {String(m.tags || '').split(/[,，]/).filter(t=>t && !/responses|anthropic messages|openai api|gemini api/i.test(t)).slice(0,2).length>0 && <div className="model-tags">{String(m.tags || '').split(/[,，]/).filter(t=>t && !/responses|anthropic messages|openai api|gemini api/i.test(t)).slice(0,2).map(t=><Pill tone="muted" key={t}>{t}</Pill>)}</div>}
    <Health health={d.health?.models.find(h=>h.model_name===m.model_name)} error={d.healthError} windowEnd={d.health?.window_end}/>
    <div className="model-channel-control"><ChannelSelect className="model-channel-select" label={m.model_name+' 渠道'} catalog={d.catalog} model={m} groups={routes} value={displayGroup} onChange={setGroup} disabled={!routes.length}/>{!savedGroup && !filterGroup && cheapestGroup(m,d.catalog)===displayGroup && <span>最低价</span>}</div>
    {ratio===undefined ? <p className="price-caption">{displayGroup==='auto' ? '自动路由价格随实际渠道变化' : displayGroup ? '倍率未公布' : '暂无可用渠道'}</p> : <div className="model-published-prices">{choice?.sourceName && <p className="model-price-condition">{choice.sourceName}</p>}{choice?.section ? <PriceTable model={choice.model} status={d.status} ratio={ratio} rows={choice.section.rows}/> : <p className="price-caption">站点规则定价 · 详见定价详情</p>}</div>}
    <button className="model-price-action" onClick={()=>onDetails(m)}><SlidersHorizontal size={13}/>详细定价<ArrowUpRight size={13}/></button>
    {choice && <PricingTimeInfo choice={choice}/>}
    <div className="model-card-bottom"><span>{routes.length} 个可用渠道</span><div><button aria-label={'在 Codex 中配置 '+m.model_name} title="配置 Codex" onClick={()=>configureModel(m.model_name,'codex',displayGroup)}><ToolIcon tool="codex" size={21}/></button><button aria-label={'在 Claude Code 中配置 '+m.model_name} title="配置 Claude Code" onClick={()=>configureModel(m.model_name,'claude',displayGroup)}><ToolIcon tool="claude" size={21}/></button></div></div>
  </article>;
}

export default function Models(){
  const {dashboard:d,preferences,updatePreferences,toast}=useApp();
  const [pricingModel,setPricingModel]=useState<ModelInfo|null>(null),[query,setQuery]=useState('');
  const [vendor,setVendor]=useSavedSelection<string>('models.vendor','all'),[group]=useSavedSelection<string>('models.group',''),[favoritesOnly,setFavoritesOnly]=useSavedSelection<boolean>('models.favoritesOnly',false);
  const searchRef=useRef<HTMLInputElement>(null);
  useEffect(()=>{const key=(e:KeyboardEvent)=>{if(e.key==='/' && !['INPUT','SELECT','TEXTAREA'].includes((e.target as HTMLElement).tagName)){e.preventDefault();searchRef.current?.focus();}};document.addEventListener('keydown',key);return()=>document.removeEventListener('keydown',key);},[]);
  const models=useMemo(()=>sortModels((d?.catalog.models || []).filter(m=>(!query || `${m.model_name} ${m.vendor} ${m.description || ''}`.toLowerCase().includes(query.toLowerCase())) && (vendor==='all' || m.vendor===vendor) && (!favoritesOnly || preferences.favoriteModels.includes(m.model_name)) && (!group || d && availableGroups(m,d.catalog).includes(group))),preferences.favoriteModels),[d,query,vendor,group,favoritesOnly,preferences.favoriteModels]);
  if(!d)return null;
  const vendors=[...new Set(d.catalog.models.map(m=>m.vendor || '其他'))].sort();
  function changeGroup(next:string){
    const values:Record<string,SelectionValue>={'models.group':next};
    for(const m of d!.catalog.models)if(!next || availableGroups(m,d!.catalog).includes(next))values[modelSelectionKey(m.model_name,'group')]=next;
    void updatePreferences({selection:{siteId:preferences.activeSiteId,values}}).catch(e=>toast(e.message,'error'));
  }
  function reset(){setQuery('');void updatePreferences({selection:{siteId:preferences.activeSiteId,values:{'models.vendor':'all','models.group':'','models.favoritesOnly':false}}}).catch(e=>toast(e.message,'error'));}
  return <div className="page"><PageIntro title="发现你的下一份灵感" description="收藏置顶、名称排序，价格与最近 24 小时健康度每分钟更新。" action={<Pill tone="green"><span className="tiny-dot"/>{d.catalog.models.length} 个模型</Pill>}/>
    <div className="surface model-toolbar"><div className="search-input"><Search size={17}/><input ref={searchRef} value={query} onChange={e=>setQuery(e.target.value)} placeholder="搜索模型、提供商或能力…" aria-label="搜索模型"/><kbd>/</kbd></div><Select label="筛选模型渠道" value={group} onChange={changeGroup}><option value="">全部渠道</option>{Object.keys(d.catalog.usableGroups).map(g=><option key={g} value={g}>{groupLabel(d.catalog,g)}</option>)}</Select><button className={'favorite-filter '+(favoritesOnly ? 'active' : '')} onClick={()=>setFavoritesOnly(!favoritesOnly)}><Star size={15} fill={favoritesOnly ? 'currentColor' : 'none'}/>收藏</button></div>
    <div className="vendor-tabs"><button className={vendor==='all' ? 'active' : ''} onClick={()=>setVendor('all')}>全部模型<span>{d.catalog.models.length}</span></button>{vendors.map(v=><button key={v} className={vendor===v ? 'active' : ''} onClick={()=>setVendor(v)}>{v}<span>{d.catalog.models.filter(m=>m.vendor===v).length}</span></button>)}<span className="results-label">{models.length} 个结果</span></div>
    <MotionSwap identity={JSON.stringify([vendor,group,favoritesOnly,query,models.map(m=>m.model_name)])}>{models.length ? <div className="model-grid">{models.map(m=><ModelCard key={m.model_name} model={m} filterGroup={group} onDetails={setPricingModel}/>)}</div> : <Empty title="没有找到模型" description="尝试调整关键词、提供商或渠道。" action={<Button onClick={reset}>重置筛选</Button>}/>}</MotionSwap>
    <div className="info-note"><Info size={15}/><span>首次显示最低价渠道；手动选择后，价格与工具配置沿用所选渠道并自动保存。右上角按钮切换站点公布的上下文档位，单价包含当前时间倍率，时间规则以橙色显示。健康度为最近 24 小时全部渠道统计，渠道健康度见详细定价。</span></div>
    {pricingModel && <PricingDetailsModal key={pricingModel.model_name} model={pricingModel} catalog={d.catalog} status={d.status} initialGroup={selectionValue(preferences,modelSelectionKey(pricingModel.model_name,'group'),group)} health={d.health?.models.find(h=>h.model_name===pricingModel.model_name)} healthError={d.healthError} onClose={()=>setPricingModel(null)}/>}
  </div>;
}
