/** Subscription quotas are independent of site billing and local token analytics. */
export interface SubscriptionWindow {
  usedPercent:number|null;
  remainingPercent:number|null;
  durationMinutes:number|null;
  resetsAt:number|null;
}
export interface SubscriptionCredits {remaining:number|null;unlimited:boolean|null;hasCredits:boolean|null;}
export interface SubscriptionUsageSnapshot {
  sourceId:'provider.codex';
  account:{id:string;label:string;plan:string|null}|null;
  state:'ready'|'signed-out'|'unsupported';
  windows:{id:string;label:string;primary:SubscriptionWindow|null;secondary:SubscriptionWindow|null;credits:SubscriptionCredits|null}[];
  fetchedAt:number;
}
export interface SubscriptionUsageCapability {read(input:{force?:boolean}):Promise<SubscriptionUsageSnapshot>;}
