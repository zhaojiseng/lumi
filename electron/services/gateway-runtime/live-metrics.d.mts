import type {GatewayOutputRateWindowDto,GatewayChainSnapshotDto} from '../../../shared/contracts/gateway';
export function emptyOutputRateWindow(elapsedMs?:number):GatewayOutputRateWindowDto;
export function createOutputRateTracker(endpoint:string,input:{elapsed:()=>number}):{begin(input:{sse?:boolean;json?:boolean;encoded?:boolean;successful?:boolean}):void;push(chunk:Uint8Array):void;finish():void;snapshot():GatewayOutputRateWindowDto};
export function createTraceHistory(input?:{recordDto?:(record:any)=>any;liveMetrics?:()=>Array<Record<string,any>>}):{receive(event:Record<string,any>):void;snapshot():GatewayChainSnapshotDto};
