import type {LumiBridge,DashboardQuery,LocalUsage,LocalUsageProgress,LocalSessionLoad,LocalSessionSnapshot,LocalSessionProgress,Tool} from '../types';
import type {UsagePriceFacts} from '../usage-pricing';
import type {WidgetPeriod} from '../widget-period';
import type {WidgetUsage} from '../widget';

export interface LocalWidgetOptions {period?:WidgetPeriod;revision?:string;quote?:(tool:Tool,model:string,facts:UsagePriceFacts)=>number|null;}
export interface LocalSessionsCapability extends Pick<LumiBridge,'localSessionDetails'|'localSessionRecords'|'localSessionContent'|'localSessionRaw'|'releaseLocalSession'> {
  scan(query:DashboardQuery,notify?:(value:Omit<LocalUsageProgress,'requestId'>)=>void):Promise<LocalUsage>;
  loadLocalSession(input:LocalSessionLoad,notify?:(value:LocalSessionProgress)=>void):Promise<LocalSessionSnapshot>;
  widgetUsage(now?:number,options?:LocalWidgetOptions):Promise<WidgetUsage>;
}
