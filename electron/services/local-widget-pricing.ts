import {createHash} from 'node:crypto';
import {availableGroups,groupRatio} from '../../shared/catalog';
import {usageQuota} from '../../shared/usage-pricing';
import {widgetPeriodLabel,type WidgetPeriod} from '../../shared/widget-period';
import type {ToolBinding,ModelCatalog,SiteStatus,Tool} from '../../shared/types';
import type {WidgetUsage} from '../../shared/widget';
import type {LocalWidgetOptions} from './local-usage';

import type {WidgetPricingContext} from '../../shared/contracts/newapi';
export type {WidgetPricingContext} from '../../shared/contracts/newapi';
export function localWidgetPricing(context:WidgetPricingContext,bindings:ToolBinding[]):LocalWidgetOptions {
  const active=bindings.filter(binding=>binding.siteId===context.siteId);
  const revision=createHash('sha256').update(JSON.stringify([context.siteId,context.catalog?.models.map(model=>[model.model_name,model.quota_type,model.model_ratio,model.model_price,model.completion_ratio,model.cache_ratio,model.create_cache_ratio,model.billing_mode,model.billing_expr,model.billing_plugin_variants,model.billing_usage_schema,model.group_ratio,model.enable_groups]),context.catalog?.groupRatio,context.status.quota_per_unit,context.userGroup,active.map(binding=>[binding.tool,binding.group])])).digest('hex');
  const models=new Map(context.catalog?.models.map(model=>[model.model_name,model]) || []);
  return {revision,quote:(tool:Tool,name,facts)=>{
    const model=models.get(name),catalog=context.catalog;if(!model || !catalog)return null;
    const group=active.find(binding=>binding.tool===tool)?.group || context.userGroup;
    if(!availableGroups(model,catalog).includes(group))return null;
    const ratio=groupRatio(catalog,group,model);return ratio===undefined ? null : usageQuota(model,context.status,facts,ratio);
  }};
}
export function combineLocalWidget(local:WidgetUsage,context:WidgetPricingContext,period:WidgetPeriod):WidgetUsage {
  const unknown=local.minute?.quotaKnown===false;
  return {...local,siteId:context.siteId,siteName:context.siteName,status:context.status,balance:context.balance,loggedIn:context.loggedIn,periodLabel:widgetPeriodLabel(period),
    warnings:[...local.warnings,...(context.error ? [context.error] : []),...(!context.loggedIn ? ['登录当前站点后读取余额与模型价格'] : unknown ? ['部分模型、渠道或计价字段不可用，消费暂不完整'] : []),'本地消费按线上模型价格估算，以站点账单为准']};
}
