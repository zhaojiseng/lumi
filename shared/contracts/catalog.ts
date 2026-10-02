import type {HealthSummary,ModelCatalog,SiteStatus} from '../types';

export interface CatalogReadRequest {siteId:string;siteUrl:string;force?:boolean;}
export interface CatalogSnapshot {
  siteId:string;siteUrl:string;loggedIn:boolean;catalog:ModelCatalog;status:SiteStatus;
  health?:HealthSummary|null;healthError?:string;warnings:string[];fetchedAt:number;
}
export interface CatalogReadCapability {read(input:CatalogReadRequest):Promise<CatalogSnapshot>;}
