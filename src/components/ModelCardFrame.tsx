import type {ReactNode} from 'react';
import {ProviderIcon} from './BrandIcon';

/** The marketplace and its history share the same model identity and card layout. */
export function ModelCardFrame({name,vendor,caption,actions,className='',children}:{name:string;vendor?:string;caption?:string;actions?:ReactNode;className?:string;children:ReactNode}) {
  return <article className={'surface model-card '+className}>
    <div className="model-card-top"><ProviderIcon vendor={vendor} modelName={name} size={32}/><div className="model-card-heading"><h3 title={name}>{name}</h3><span>{caption || vendor || '其他'}</span></div>{actions && <div className="model-card-actions">{actions}</div>}</div>
    {children}
  </article>;
}
