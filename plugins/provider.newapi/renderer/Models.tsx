import {ModalPresence} from '../../../src/components/ModalPresence';
import {MotionSwap} from '../../../src/components/MotionSwap';
import {useMemo,useState,useRef,useEffect,useLayoutEffect} from 'react';
import {Search,Star,ArrowUpRight,SlidersHorizontal,Info,Repeat2,Bell,Check,History} from 'lucide-react';
import {useApp} from '../../../src/context';
import {useCatalog} from '../../../src/host/catalog';
import type {CatalogSnapshot} from '../../../shared/contracts/catalog';
import {useSavedSelection} from '../../../src/selections';
import {modelSelectionKey,selectionValue} from '../../../shared/selections';
import {Button,PageIntro,Select,Pill,Empty,ToolIcon,Modal,Skeleton} from '../../../src/components/ui';
import {Health} from '../../../src/components/Health';
import {ProviderIcon} from '../../../src/components/BrandIcon';
import {ChannelSelect} from '../../../src/components/ChannelSelect';
import {PricingDetailsModal,PriceTable,PricingTimeInfo} from '../../../src/components/Pricing';
import {availableGroups,groupRatio,groupLabel,defaultModelGroup,cheapestGroup,sortModels} from '../../../shared/catalog';
import {pricingChoices,defaultPricingChoice} from '../../../shared/pricing';
import {CATALOG_CHANGE_LABELS,acknowledgeCatalogChanges,catalogChangesStorageKey,getCatalogChanges,subscribeCatalogChanges,type CatalogChangeState,type CatalogChangeView} from '../../../shared/catalog-changes';
import type {ModelInfo,SelectionValue} from '../../../shared/types';
import '../../../src/models-market.css';

function useCatalogMonitor() {
  const {preferences}=useApp();
  const site=preferences.sites.find(s=>s.id===preferences.activeSiteId),key=site ? catalogChangesStorageKey(site) : '';
  const [view,setView]=useState<CatalogChangeView>({key:'',state:null,persisted:true,pendingCount:0});
  useEffect(()=>{
    if(!site)return;
    const scope={id:site.id,url:site.url},update=()=>setView(getCatalogChanges(scope));
    const unsubscribe=subscribeCatalogChanges(scope,update);
    update();return unsubscribe;
  },[key]);
  function markRead(eventIds?:string[]) {
    if(site)setView(acknowledgeCatalogChanges(site,eventIds));
  }
  return {state:view.key===key ? view.state : null,persisted:view.key!==key || view.persisted,markRead};
}

function CatalogChanges({state,persisted,catalogReady,onRead}:{state:CatalogChangeState|null;persisted:boolean;catalogReady:boolean;onRead(ids?:string[]):void}) {
  const [open,setOpen]=useState(false),events=state?.events || [],unread=events.filter(event=>!event.read);
  const pending=unread.reduce((sum,event)=>sum+event.changes.length,0);
  return <>
    <section className={'surface catalog-monitor '+(pending ? 'has-changes' : '')} aria-label="本地模型目录变动监控">
      <div className="catalog-monitor-icon">{pending ? <Bell size={19}/> : <History size={19}/>}</div>
      <div className="catalog-monitor-copy"><strong aria-live="polite">{pending ? `发现 ${pending} 项目录变动` : '本地变动监控'}</strong><span>{!catalogReady ? '等待有效目录，保留上次基线与变动记录' : !state ? '等待完整目录，首次读取仅建立基线' : pending ? `${unread.length} 次更新未读 · 模型增删与计价规则变动` : events.length ? '变动已读，将继续比较后续目录' : '已建立基线，后续模型增删与计价规则变动会在这里提示'}{!persisted && ' · 本地存储不可用，仅本次打开有效'}</span></div>
      <div className="catalog-monitor-actions"><Button variant="ghost" disabled={!events.length} onClick={()=>setOpen(true)}><History size={14}/>查看明细{events.length>0 && <span>{events.length}</span>}</Button>{pending>0 && <Button onClick={()=>onRead()}><Check size={14}/>全部已读</Button>}</div>
    </section>
    <ModalPresence>{open && <Modal className="catalog-changes-modal" title="模型目录变动" subtitle="仅在本机保存有限的公共计价规则和价格变动，保留最近 20 次变动。" onClose={()=>setOpen(false)}>
      <p className="catalog-change-price-note">单价为模型基础价，未乘渠道倍率；渠道倍率单独比较。</p>
      <div className="catalog-change-history">{events.map(event=><section className="catalog-change-event" key={event.id}>
        <div className="catalog-change-event-heading"><time dateTime={new Date(event.detectedAt).toISOString()}>{new Date(event.detectedAt).toLocaleString('zh-CN',{hour12:false})}</time><Pill tone={event.read ? 'muted' : 'orange'}>{event.read ? '已读' : '未读'}</Pill>{!event.read && <button className="text-link" onClick={()=>onRead([event.id])}>标为已读</button>}</div>
        <ul>{event.changes.map((change,index)=><li key={index}>
          <div><strong>{change.modelName || '站点价格规则'}</strong><Pill tone={change.kind==='added' ? 'green' : change.kind==='removed' ? 'red' : 'orange'}>{change.kind==='added' ? '新增模型' : change.kind==='removed' ? '移除模型' : change.kind==='pricing' ? '计价变动' : '站点规则变动'}</Pill></div>
          {change.details?.length ? <dl className="catalog-change-details">{change.details.map((detail,detailIndex)=><div className="catalog-change-detail" key={detailIndex}>
            <dt>{detail.label}</dt>
            {(detail.before!==undefined || detail.after!==undefined) && <dd className="catalog-change-values"><span className="catalog-change-before">{detail.before ?? '未公布 / 已移除'}</span><span aria-label="变更为">→</span><span className="catalog-change-after">{detail.after ?? '未公布 / 已移除'}</span></dd>}
            {detail.note && <dd className="catalog-change-note">{detail.note}</dd>}
            {detail.formula && <dd><details className="catalog-change-formula"><summary>展开公式与条件对比</summary><div><span>原规则</span><code>{detail.formula.before ?? '未公布 / 已移除'}</code></div><div><span>新规则</span><code>{detail.formula.after ?? '未公布 / 已移除'}</code></div></details></dd>}
          </div>)}</dl> : change.fields.length>0 && <p className="catalog-change-legacy"><span>{change.fields.map(field=>CATALOG_CHANGE_LABELS[field]).join('、')}已变更。</span><span>此历史记录未保存价格值，无法还原旧价。</span></p>}
        </li>)}</ul>
      </section>)}</div>
      <div className="modal-actions">{pending>0 && <Button onClick={()=>onRead()}><Check size={14}/>全部标为已读</Button>}<Button onClick={()=>setOpen(false)}>关闭</Button></div>
    </Modal>}</ModalPresence>
  </>;
}

function ModelGrid({models,filterGroup,onDetails,snapshot}:{models:ModelInfo[];filterGroup:string;snapshot:CatalogSnapshot;onDetails(model:ModelInfo):void}) {
  const gridRef=useRef<HTMLDivElement>(null);
  useLayoutEffect(()=>{
    const grid=gridRef.current;
    if(!grid)return;
    let frame=0,disposed=false;
    const items=Array.from(grid.children) as HTMLElement[];
    function measure() {
      // Clear old placement so a narrower breakpoint cannot retain implicit columns.
      items.forEach(item=>{item.style.gridColumnStart='';item.style.gridRowStart='';});
      const style=getComputedStyle(grid!),row=parseFloat(style.gridAutoRows),gap=parseFloat(style.rowGap) || 0;
      if(!Number.isFinite(row) || row<=0)return;
      const columns=style.gridTemplateColumns==='none' ? 1 : style.gridTemplateColumns.trim().split(/\s+/).length;
      const nextRow=Array<number>(columns).fill(1);
      const spans=items.map(item=>Math.max(1,Math.ceil(((item.firstElementChild?.getBoundingClientRect().height || 0)+gap)/(row+gap))));
      items.forEach((item,index)=>{
        let column=0;
        for(let candidate=1;candidate<columns;candidate++)if(nextRow[candidate]<nextRow[column])column=candidate;
        item.style.gridColumnStart=String(column+1);
        item.style.gridRowStart=String(nextRow[column]);
        const span='span '+spans[index];
        if(item.style.gridRowEnd!==span)item.style.gridRowEnd=span;
        nextRow[column]+=spans[index];
      });
    }
    function schedule() {cancelAnimationFrame(frame);frame=requestAnimationFrame(measure);}
    measure();
    const observer=typeof ResizeObserver==='undefined' ? null : new ResizeObserver(schedule);
    observer?.observe(grid);items.forEach(item=>{if(item.firstElementChild)observer?.observe(item.firstElementChild);});
    const fallback=observer ? null : new MutationObserver(schedule);
    fallback?.observe(grid,{childList:true,subtree:true,characterData:true});
    window.addEventListener('resize',schedule);
    void document.fonts?.ready.then(()=>{if(!disposed)schedule();});
    return()=>{disposed=true;cancelAnimationFrame(frame);observer?.disconnect();fallback?.disconnect();window.removeEventListener('resize',schedule);};
  },[models]);
  return <div ref={gridRef} className="model-grid model-market-grid">{models.map(model=><div className="model-market-item" key={model.model_name}><ModelCard model={model} snapshot={snapshot} filterGroup={filterGroup} onDetails={onDetails}/></div>)}</div>;
}

function ModelCard({model:m,filterGroup,onDetails,snapshot:d}:{model:ModelInfo;filterGroup:string;snapshot:CatalogSnapshot;onDetails(model:ModelInfo):void}) {
  const {preferences,updatePreferences,configureModel,toast}=useApp();
  const [savedGroup,setGroup]=useSavedSelection<string>(modelSelectionKey(m.model_name,'group'),'');
  const [priceKey,setPriceKey]=useSavedSelection<string>(modelSelectionKey(m.model_name,'price'),'');
  if(!d)return null;
  const routes=availableGroups(m,d.catalog),displayGroup=defaultModelGroup(m,d.catalog,savedGroup || filterGroup),ratio=groupRatio(d.catalog,displayGroup,m);
  const choices=pricingChoices(m,d.status,new Date(d.fetchedAt)),choice=choices.find(s=>s.key===priceKey) || defaultPricingChoice(choices),index=choices.indexOf(choice!);
  const favorite=preferences.favoriteModels.includes(m.model_name);
  async function toggleFavorite(){try{await updatePreferences({favoriteModels:favorite ? preferences.favoriteModels.filter(n=>n!==m.model_name) : [...preferences.favoriteModels,m.model_name]});}catch(e:any){toast(e.message,'error');}}
  return <article className="surface model-card">
    <div className="model-card-top"><ProviderIcon vendor={m.vendor} modelName={m.model_name} size={32}/><div className="model-card-heading"><h3 title={m.model_name}>{m.model_name}</h3><span>{m.vendor || '其他'}</span></div><div className="model-card-actions">
      <button className={'icon-button star-button '+(favorite ? 'starred' : '')} aria-label={(favorite ? '取消收藏 ' : '收藏 ')+m.model_name} onClick={toggleFavorite}><Star size={16} fill={favorite ? 'currentColor' : 'none'}/></button>
      {choices.length>1 && <button type="button" className="pricing-state-button" aria-label={m.model_name+' 定价档位：'+choice?.label} title={'切换至 '+choices[(index+1)%choices.length].label} onClick={()=>setPriceKey(choices[(index+1)%choices.length].key)}><Repeat2 size={12}/>{choice?.label}</button>}
    </div></div>
    <p className="model-description" title={m.description}>{m.description || '站点可用模型。单价与计费条件由站点提供。'}</p>
    {String(m.tags || '').split(/[,，]/).filter(t=>t && !/responses|anthropic messages|openai api|gemini api/i.test(t)).slice(0,2).length>0 && <div className="model-tags">{String(m.tags || '').split(/[,，]/).filter(t=>t && !/responses|anthropic messages|openai api|gemini api/i.test(t)).slice(0,2).map(t=><Pill tone="muted" key={t}>{t}</Pill>)}</div>}
    <Health health={d.health?.models.find(h=>h.model_name===m.model_name)} error={d.healthError} windowEnd={d.health?.window_end}/>
    <div className="model-channel-control"><ChannelSelect className="model-channel-select" label={m.model_name+' 渠道'} catalog={d.catalog} model={m} groups={routes} value={displayGroup} onChange={setGroup} disabled={!routes.length}/>{!savedGroup && !filterGroup && cheapestGroup(m,d.catalog)===displayGroup && <span>最低价</span>}</div>
    {ratio===undefined ? <p className="price-caption">{displayGroup==='auto' ? '自动路由价格随实际渠道变化' : displayGroup ? '倍率未公布' : '暂无可用渠道'}</p> : <div className="model-published-prices">{choice?.sourceName && <p className="model-price-condition">{choice.sourceName}</p>}{choice?.section ? <PriceTable model={choice.model} status={d.status} ratio={ratio} rows={choice.section.rows}/> : <p className="price-caption">站点规则定价 · 详见定价详情</p>}</div>}
    <div className="model-card-price-actions"><button className="model-price-action" onClick={()=>onDetails(m)}><SlidersHorizontal size={13}/>详细定价<ArrowUpRight size={13}/></button></div>
    {choice && <PricingTimeInfo choice={choice}/>}
    <div className="model-card-bottom"><span>{routes.length} 个可用渠道</span><div><button aria-label={'在 Codex 中配置 '+m.model_name} title="配置 Codex" onClick={()=>configureModel(m.model_name,'codex',displayGroup)}><ToolIcon tool="codex" size={21}/></button><button aria-label={'在 Claude Code 中配置 '+m.model_name} title="配置 Claude Code" onClick={()=>configureModel(m.model_name,'claude',displayGroup)}><ToolIcon tool="claude" size={21}/></button></div></div>
  </article>;
}

export default function Models(){
  const {preferences,updatePreferences,toast}=useApp();
  const {snapshot:d,loading,error,refresh}=useCatalog();
  const monitor=useCatalogMonitor();
  const [pricingModel,setPricingModel]=useState<ModelInfo|null>(null),[query,setQuery]=useState('');
  const [vendor,setVendor]=useSavedSelection<string>('models.vendor','all'),[group]=useSavedSelection<string>('models.group',''),[favoritesOnly,setFavoritesOnly]=useSavedSelection<boolean>('models.favoritesOnly',false);
  const searchRef=useRef<HTMLInputElement>(null);
  useEffect(()=>{const key=(e:KeyboardEvent)=>{if(e.key==='/' && !['INPUT','SELECT','TEXTAREA'].includes((e.target as HTMLElement).tagName)){e.preventDefault();searchRef.current?.focus();}};document.addEventListener('keydown',key);return()=>document.removeEventListener('keydown',key);},[]);
  const models=useMemo(()=>sortModels((d?.catalog.models || []).filter(m=>(!query || `${m.model_name} ${m.vendor} ${m.description || ''}`.toLowerCase().includes(query.toLowerCase())) && (vendor==='all' || m.vendor===vendor) && (!favoritesOnly || preferences.favoriteModels.includes(m.model_name)) && (!group || d && availableGroups(m,d.catalog).includes(group))),preferences.favoriteModels),[d,query,vendor,group,favoritesOnly,preferences.favoriteModels]);
  if(!d)return <div className="page models-market"><PageIntro title="模型广场" description="独立读取当前站点发布的模型目录与定价。"/>{loading ? <Skeleton/> : <Empty title="暂时无法读取模型目录" description={error || '选择站点后重试；浏览器预览中的模型目录读取仅支持桌面应用。'} action={<Button onClick={()=>void refresh(true)}>重试</Button>}/>}</div>;
  const vendors=[...new Set(d.catalog.models.map(m=>m.vendor || '其他'))].sort();
  function changeGroup(next:string){
    const values:Record<string,SelectionValue>={'models.group':next};
    for(const m of d!.catalog.models)if(!next || availableGroups(m,d!.catalog).includes(next))values[modelSelectionKey(m.model_name,'group')]=next;
    void updatePreferences({selection:{siteId:preferences.activeSiteId,values}}).catch(e=>toast(e.message,'error'));
  }
  function reset(){setQuery('');void updatePreferences({selection:{siteId:preferences.activeSiteId,values:{'models.vendor':'all','models.group':'','models.favoritesOnly':false}}}).catch(e=>toast(e.message,'error'));}
  return <div className="page models-market"><PageIntro title="发现你的下一份灵感" description="收藏置顶、名称排序，价格与最近 24 小时健康度按同步设置刷新。" action={<Pill tone="green"><span className="tiny-dot"/>{d.catalog.models.length} 个模型</Pill>}/>
    {error && <div className="warning-banner error-banner" role="alert"><span>{error}</span><Button onClick={()=>void refresh(true)}>重试</Button></div>}
    {d.warnings.length>0 && <details className="sync-warnings"><summary>{d.warnings.length} 项模型目录信息未能同步</summary>{d.warnings.map((warning,index)=><p key={index}>{warning}</p>)}</details>}
    <CatalogChanges state={monitor.state} persisted={monitor.persisted} catalogReady={d.loggedIn && !loading && !error && !d.warnings.some(w=>w.startsWith('模型广场'))} onRead={monitor.markRead}/>
    <div className="surface model-toolbar"><div className="search-input"><Search size={17}/><input ref={searchRef} value={query} onChange={e=>setQuery(e.target.value)} placeholder="搜索模型、提供商或能力…" aria-label="搜索模型"/><kbd>/</kbd></div><Select label="筛选模型渠道" value={group} onChange={changeGroup}><option value="">全部渠道</option>{Object.keys(d.catalog.usableGroups).map(g=><option key={g} value={g}>{groupLabel(d.catalog,g)}</option>)}</Select><button className={'favorite-filter '+(favoritesOnly ? 'active' : '')} onClick={()=>setFavoritesOnly(!favoritesOnly)}><Star size={15} fill={favoritesOnly ? 'currentColor' : 'none'}/>收藏</button></div>
    <div className="vendor-tabs"><button className={vendor==='all' ? 'active' : ''} onClick={()=>setVendor('all')}>全部模型<span>{d.catalog.models.length}</span></button>{vendors.map(v=><button key={v} className={vendor===v ? 'active' : ''} onClick={()=>setVendor(v)}>{v}<span>{d.catalog.models.filter(m=>m.vendor===v).length}</span></button>)}<span className="results-label">{models.length} 个结果</span></div>
    <MotionSwap identity={JSON.stringify([vendor,group,favoritesOnly,query,models.map(m=>m.model_name)])}>{models.length ? <ModelGrid models={models} snapshot={d} filterGroup={group} onDetails={setPricingModel}/> : <Empty title="没有找到模型" description="尝试调整关键词、提供商或渠道。" action={<Button onClick={reset}>重置筛选</Button>}/>}</MotionSwap>
    <div className="info-note"><Info size={15}/><span>首次显示最低价渠道；手动选择后，价格与工具配置沿用所选渠道并自动保存。卡片档位按钮切换站点公布的上下文档位，单价包含当前时间倍率，时间规则以橙色显示。分时倍率随时钟变化不会产生目录变动提示。健康度为最近 24 小时全部渠道统计，渠道健康度见详细定价。</span></div>
    <ModalPresence>{pricingModel && <PricingDetailsModal key={pricingModel.model_name} snapshot={d} model={pricingModel} catalog={d.catalog} status={d.status} initialGroup={selectionValue(preferences,modelSelectionKey(pricingModel.model_name,'group'),group)} health={d.health?.models.find(h=>h.model_name===pricingModel.model_name)} healthError={d.healthError} onClose={()=>setPricingModel(null)}/>}</ModalPresence>
  </div>;
}
