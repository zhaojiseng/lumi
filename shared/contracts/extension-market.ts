import type {ExtensionManifest} from './extensions';
import type {InterfaceStyle} from './interface';

export const EXTENSION_MARKET_REPOSITORY='zhaojiseng/lumi-extensions';
export const EXTENSION_MARKET_URL='https://github.com/'+EXTENSION_MARKET_REPOSITORY;
export interface ExtensionMarketItem {
  manifest:ExtensionManifest;
  sourceUrl:string;
  preview?:InterfaceStyle;
}
export interface ExtensionMarketCatalog {
  revision:string;
  fetchedAt:number;
  plugins:ExtensionMarketItem[];
  diagnostics:{package:string;error:string}[];
}
export interface ExtensionMarketInstall {id:string;revision:string;}

export function compareExtensionVersions(left:string,right:string):number {
  const [leftCore]=left.split('-'),[rightCore]=right.split('-');
  const leftPre=left.includes('-') ? left.slice(leftCore.length+1) : undefined,rightPre=right.includes('-') ? right.slice(rightCore.length+1) : undefined;
  const a=leftCore.split('.').map(BigInt),b=rightCore.split('.').map(BigInt);
  for(let i=0;i<3;i++)if(a[i]!==b[i])return a[i]>b[i] ? 1 : -1;
  if(leftPre===rightPre)return 0;
  if(leftPre===undefined)return 1;
  if(rightPre===undefined)return -1;
  const x=left.slice(leftCore.length+1).split('.'),y=right.slice(rightCore.length+1).split('.');
  for(let i=0;i<Math.max(x.length,y.length);i++){
    if(x[i]===undefined)return -1;if(y[i]===undefined)return 1;if(x[i]===y[i])continue;
    const xn=/^\d+$/.test(x[i]),yn=/^\d+$/.test(y[i]);
    if(xn && yn){const n=BigInt(x[i]),m=BigInt(y[i]);if(n!==m)return n>m ? 1 : -1;continue;}
    if(xn!==yn)return xn ? -1 : 1;
    return x[i]>y[i] ? 1 : -1;
  }
  return 0;
}
