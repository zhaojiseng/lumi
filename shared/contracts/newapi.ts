import type {LumiBridge,LogQuery,UsageLog,SiteStatus,ModelCatalog,MenuBarSelection,MenuBarUsage,MenuBarDetails} from '../types';
import type {WidgetUsage} from '../widget';
import type {WidgetPeriod} from '../widget-period';

export interface SessionCookie {name:string;value:string;path:string;expires?:number;}
export interface AccountSessionCapability extends Pick<LumiBridge,'loginInfo'|'login'|'verifyLogin'|'logout'> {
  acceptBrowserSession(siteId:string,siteUrl:string,accessToken:string,cookies:SessionCookie[],canCommit?:()=>boolean):ReturnType<LumiBridge['logout']>;
}
export interface OnlineUsageCapability extends Pick<LumiBridge,'dashboard'|'logs'|'tokenUsage'|'usageQuality'|'modelHealth'> {
  status():Promise<SiteStatus>;
  allLogs(input:LogQuery,max?:number):Promise<UsageLog[]>;
}
export interface TokenManagementCapability extends Pick<LumiBridge,'createToken'|'toggleToken'|'updateToken'|'getTokenKey'> {}
export interface WidgetPricingContext {siteId:string;siteName:string;status:SiteStatus;balance:number|null;loggedIn:boolean;catalog:ModelCatalog|null;userGroup:string;error?:string;}
export interface DesktopUsageCapability {
  widgetUsage(now?:number,period?:WidgetPeriod):Promise<WidgetUsage>;
  widgetPricing():Promise<WidgetPricingContext>;
  menuBarUsage(force?:boolean,selection?:MenuBarSelection):Promise<MenuBarUsage>;
  menuBarDetails(selection?:MenuBarSelection):Promise<MenuBarDetails>;
}
