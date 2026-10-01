import {groupRatio} from '../../shared/catalog';
import type {ModelCatalog, ModelInfo} from '../../shared/types';
import {Select} from './Select';
export function ChannelLabel({catalog, model, group}:{catalog:ModelCatalog;model?:ModelInfo;group:string}) {
  const ratio=groupRatio(catalog,group,model);
  return <span className="channel-label"><span>{catalog.usableGroups[group] || group}</span><strong>{group==='auto' ? '浮动' : ratio===undefined ? '—' : '×'+ratio}</strong></span>;
}
export function ChannelSelect({catalog,model,groups,value,onChange,label,disabled=false,className=''}:{catalog:ModelCatalog;model?:ModelInfo;groups:string[];value:string;onChange(value:string):void;label:string;disabled?:boolean;className?:string}) {
  return <Select className={className} label={label} value={value} onChange={onChange} disabled={disabled} displayValue={value ? <ChannelLabel catalog={catalog} model={model} group={value}/> : undefined}>
    {!value && <option value="">{disabled ? '请先选择模型' : '选择可用渠道'}</option>}
    {groups.map(group=>{const ratio=groupRatio(catalog,group,model),text=(catalog.usableGroups[group] || group)+' '+(group==='auto' ? '浮动' : ratio===undefined ? '—' : '×'+ratio);return <option key={group} value={group} aria-label={text}><ChannelLabel catalog={catalog} model={model} group={group}/></option>;})}
  </Select>;
}
