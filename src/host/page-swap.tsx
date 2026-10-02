import {Fragment,useLayoutEffect,useRef,type ReactNode} from 'react';
import type {Page} from '../../shared/types';
import type {PluginStatus} from '../../shared/contracts/plugins';
import {MotionSwap} from '../components/MotionSwap';
import {isRendererPageAvailable,independentRendererPage} from './renderer-registry';

/** Account-bound page children carry their own scope keys; neutral shells stay mounted. */
export function RendererPageSwap({identity,accountKey,statuses,children}:{identity:Page;accountKey:string;statuses:readonly PluginStatus[];children:ReactNode}) {
  const previous=useRef(accountKey),changed=previous.current!==accountKey;
  useLayoutEffect(()=>{previous.current=accountKey;},[accountKey]);
  return <MotionSwap identity={identity} canRetain={page=>isRendererPageAvailable(page,statuses) && (!changed || independentRendererPage(page))}><Fragment key={independentRendererPage(identity) ? identity : accountKey}>{children}</Fragment></MotionSwap>;
}
