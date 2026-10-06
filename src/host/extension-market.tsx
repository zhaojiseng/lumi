import {useEffect,useRef,useState} from 'react';
import {ArrowLeft,ArrowUpRight,Check,Download,Palette,Puzzle,RefreshCw,Search,Trash2} from 'lucide-react';
import {bridge} from '../bridge';
import {useApp} from '../context';
import {Button,Modal,SegmentedSwitch} from '../components/ui';
import {usePluginSettings} from './plugins';
import {AppearancePreview} from './appearance-preview';
import {useResolvedTheme} from '../../plugins/theme.default/renderer';
import {resolveInterfaceAppearance} from '../../shared/interface-appearance';
import {EXTENSION_MARKET_URL,compareExtensionVersions,type ExtensionMarketCatalog,type ExtensionMarketItem} from '../../shared/contracts/extension-market';
import './extension-market.css';

const permissionNames:Record<string,string>={'storage':'插件存储','secrets':'插件加密凭据','network.read':'网络读取','workbench.read':'工作台用量','usage.read':'用量快照','codex.usage.read':'Codex 限额'};
export function ExtensionMarketplace({onClose}:{onClose():void}){
  const {bootstrap,preferences,toast}=useApp(),{extensions,statuses,busyId,installExtension,removeExtension}=usePluginSettings();
  const [catalog,setCatalog]=useState<ExtensionMarketCatalog>(),[loading,setLoading]=useState(false),[error,setError]=useState(''),[query,setQuery]=useState(''),[kind,setKind]=useState<'all'|'feature'|'interface'>('all'),[installedOnly,setInstalledOnly]=useState(false),[detail,setDetail]=useState<string>(),[confirmRemove,setConfirmRemove]=useState(false);
  const version=useRef(0),theme=useResolvedTheme(preferences.theme);
  const load=async(force=false)=>{
    const request=++version.current;setLoading(true);setError('');
    try{const value=await bridge.extensionMarket({force});if(request===version.current)setCatalog(value);}
    catch(e){if(request===version.current)setError(e instanceof Error ? e.message : '插件市场暂不可用。');}
    finally{if(request===version.current)setLoading(false);}
  };
  useEffect(()=>{if(bootstrap.desktop)void load();return()=>{++version.current;};},[bootstrap.desktop]);
  const openSource=(url:string)=>void bridge.openExternal(url).catch(e=>setError(e.message));
  const selected=catalog?.plugins.find(item=>item.manifest.id===detail);
  const installed=(id:string)=>extensions?.plugins.find(pkg=>pkg.manifest.id===id);
  const filtered=(catalog?.plugins || []).filter(item=>{
    const manifest=item.manifest,text=[manifest.name,manifest.id,manifest.description,manifest.author].join(' ').toLowerCase();
    return (kind==='all' || (manifest.kind || 'feature')===kind) && (!installedOnly || installed(manifest.id)) && text.includes(query.trim().toLowerCase());
  });
  async function install(item:ExtensionMarketItem){
    if(!catalog || !installExtension)return;const request=version.current;setError('');
    try{await installExtension({id:item.manifest.id,revision:catalog.revision});if(request===version.current)toast('插件已安装，当前为停用状态。','success');}
    catch(e){if(request===version.current)setError(e instanceof Error ? e.message : '插件安装失败。');}
  }
  async function remove(id:string){
    if(!removeExtension)return;const request=version.current;setError('');
    try{await removeExtension(id);if(request===version.current){setConfirmRemove(false);toast('插件已卸载，保存的数据已保留。','success');}}
    catch(e){if(request===version.current)setError(e instanceof Error ? e.message : '插件卸载失败。');}
  }
  const action=(item:ExtensionMarketItem)=>{
    const local=installed(item.manifest.id),comparison=local ? compareExtensionVersions(item.manifest.version,local.manifest.version) : 1,working=busyId==='extensions:'+item.manifest.id;
    return <Button variant={!local || comparison>0 ? 'primary' : 'default'} busy={working} disabled={!!busyId || !installExtension || !!local && comparison<=0} onClick={()=>void install(item)} aria-label={(local && comparison>0 ? '更新' : '安装')+item.manifest.name}>{local && comparison<=0 ? <Check size={15}/> : <Download size={15}/>} {working ? '正在安装' : local ? comparison>0 ? '更新' : comparison<0 ? '本地版本较新' : '已安装' : '安装'}</Button>;
  };
  const preview=(item:ExtensionMarketItem)=>item.preview ? <AppearancePreview style={item.preview} mode={theme} values={resolveInterfaceAppearance(item.preview.appearanceGroups,preferences.interfaceSelections[item.manifest.id])} platform={bootstrap.platform || 'win32'}/> : null;
  const summary=(item:ExtensionMarketItem)=>{
    const manifest=item.manifest,local=installed(manifest.id),active=statuses?.find(status=>status.manifest.id===manifest.id)?.state==='active';
    return <><div className="market-item-heading"><span className={'market-glyph '+(manifest.kind==='interface' ? 'interface' : '')}>{manifest.kind==='interface' ? <Palette size={21}/> : <Puzzle size={21}/>}</span><div><h3>{manifest.name}</h3><span>{manifest.kind==='interface' ? '界面' : '功能'} · v{manifest.version} · {manifest.author}</span></div></div><p className="market-description">{manifest.description}</p>{local && <p className="market-installed">本地 v{local.manifest.version} · {active ? '已启用' : '已停用'}{local.removable===false ? ' · 随程序提供' : ''}</p>}<div className="market-permissions">{manifest.permissions.length ? manifest.permissions.map(permission=><span key={permission}>{permissionNames[permission] || permission}</span>) : <span>无数据权限</span>}</div></>;
  };
  return <Modal title="插件市场" subtitle="Lumi 官方插件" wide className="extension-market" onClose={onClose}>
    <div className="market-source"><span>zhaojiseng / lumi-extensions</span><div><button className="icon-button" title="打开官方仓库" aria-label="打开官方插件仓库" onClick={()=>openSource(EXTENSION_MARKET_URL)}><ArrowUpRight size={17}/></button><button className="icon-button" title="刷新市场" aria-label="刷新插件市场" disabled={loading || !!busyId || !bootstrap.desktop} onClick={()=>void load(true)}><RefreshCw size={16} className={loading ? 'spin' : ''}/></button></div></div>
    {!bootstrap.desktop && <p className="warning-banner">插件市场安装需要 Lumi 桌面应用。</p>}
    {error && <div className="warning-banner error-banner" role="alert">{error}<button className="text-link" disabled={loading || !!busyId} onClick={()=>void load(true)}>重试</button></div>}
    {selected ? <div className="market-detail"><button className="text-link market-back" onClick={()=>{setDetail(undefined);setConfirmRemove(false);}}><ArrowLeft size={15}/>全部插件</button>{preview(selected)}{summary(selected)}<dl className="market-metadata"><div><dt>插件 ID</dt><dd>{selected.manifest.id}</dd></div><div><dt>许可</dt><dd>{selected.manifest.license}</dd></div><div><dt>宿主接口</dt><dd>API v{selected.manifest.hostApiVersion}</dd></div>{selected.manifest.networkOrigins.length>0 && <div><dt>网络来源</dt><dd>{selected.manifest.networkOrigins.join('、')}</dd></div>}{selected.manifest.contributions.length>0 && <div><dt>显示内容</dt><dd>{selected.manifest.contributions.map(view=>view.title).join('、')}</dd></div>}</dl><div className="market-detail-actions"><Button onClick={()=>openSource(selected.sourceUrl)}><ArrowUpRight size={15}/>查看源码</Button>{installed(selected.manifest.id)?.removable && <Button variant="danger" disabled={!!busyId} onClick={()=>setConfirmRemove(true)}><Trash2 size={15}/>卸载</Button>}{action(selected)}</div>{confirmRemove && <div className="market-remove-confirm"><p>卸载“{selected.manifest.name}”？保存的数据和凭据将保留。</p><div><Button disabled={!!busyId} onClick={()=>setConfirmRemove(false)}>取消</Button><Button variant="danger" busy={!!busyId} onClick={()=>void remove(selected.manifest.id)}>确认卸载</Button></div></div>}</div> : <>
      <div className="market-toolbar"><label className="market-search"><Search size={16}/><input type="search" aria-label="搜索插件" placeholder="搜索插件" value={query} onChange={e=>setQuery(e.target.value)}/></label><SegmentedSwitch label="插件类型" className="market-kinds">{(['all','feature','interface'] as const).map(type=><button key={type} type="button" aria-pressed={type===kind} onClick={()=>setKind(type)}>{type==='all' ? '全部' : type==='feature' ? '功能' : '界面'}</button>)}</SegmentedSwitch><label className="market-installed-filter"><input type="checkbox" checked={installedOnly} onChange={e=>setInstalledOnly(e.target.checked)}/>已安装</label></div>
      {loading && <p role="status" className="market-empty">正在读取插件市场…</p>}
      {!loading && !filtered.length && !error && bootstrap.desktop && <p className="market-empty">{query || installedOnly || kind!=='all' ? '没有匹配的插件。' : '暂无可安装插件。'}</p>}
      <div className="market-list">{filtered.map(item=><article key={item.manifest.id} className="market-item" data-market-plugin={item.manifest.id}>{preview(item)}{summary(item)}<div className="market-item-actions"><button className="text-link" onClick={()=>{setDetail(item.manifest.id);setConfirmRemove(false);}} aria-label={'查看'+item.manifest.name+'详情'}>详情<ArrowUpRight size={14}/></button>{action(item)}</div></article>)}</div>
    </>}
    {catalog?.diagnostics.map(diagnostic=><p key={diagnostic.package} className="warning-banner">{diagnostic.package}：{diagnostic.error}</p>)}
  </Modal>;
}
