import type { ModelCatalog, ModelInfo } from './types';
export function normalizeCatalog(j: any): ModelCatalog {
  const vendors = Array.isArray(j.vendors) ? j.vendors : [];
  const groupRatio: Record<string, number> = {};
  for (const [g, ratio] of Object.entries(j.group_ratio || {})) if (typeof ratio === 'number' && Number.isFinite(ratio) && ratio >= 0) groupRatio[g] = ratio;
  const usableGroups: Record<string, string> = {};
  for (const [g, value] of Object.entries(j.usable_group || {})) {
    usableGroups[g] = typeof value === 'string' ? value : (value as any)?.desc || g;
    if (!(g in groupRatio) && typeof (value as any)?.ratio === 'number') groupRatio[g] = (value as any).ratio;
  }
  return { models: (Array.isArray(j.data) ? j.data : []).map((m: any) => ({ ...m, vendor: vendors.find((v: any) => v.id === m.vendor_id)?.name || m.vendor_name || m.owner_by || '其他', enable_groups: Array.isArray(m.enable_groups) ? m.enable_groups : [], supported_endpoint_types: Array.isArray(m.supported_endpoint_types) ? m.supported_endpoint_types : [], create_cache_ratio: m.create_cache_ratio ?? m.cache_creation_ratio })), groupRatio, usableGroups, autoGroups: Array.isArray(j.auto_groups) ? j.auto_groups : [], vendors };
}
export function availableGroups(m: ModelInfo, catalog: ModelCatalog) {
  const direct = (g: string) => m.enable_groups.includes(g) || m.enable_groups.includes('all');
  return Object.keys(catalog.usableGroups).filter(g => g === 'auto' ? direct(g) || catalog.autoGroups.some(direct) : direct(g));
}
export function groupRatio(catalog: ModelCatalog, group: string, model?: ModelInfo): number | undefined {
  if (group === 'auto') return undefined;
  const custom = (model?.group_ratio as Record<string, number> | undefined)?.[group];
  const value = custom ?? catalog.groupRatio[group];
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined;
}
export function groupLabel(catalog: ModelCatalog, group: string, model?: ModelInfo) {
  const name = catalog.usableGroups[group] || group;
  const r = groupRatio(catalog, group, model);
  return name + (name !== group ? ' (' + group + ')' : '') + (group === 'auto' ? ' · 自动路由' : r === undefined ? ' · 倍率未公布' : ' · ×' + r);
}

/** Lowest effective account/model multiplier, among reachable routes with a known fixed price. */
export function cheapestGroup(model: ModelInfo, catalog: ModelCatalog): string | undefined {
  let cheapest: string | undefined; let lowest = Infinity;
  for (const group of availableGroups(model,catalog)) {
    const ratio=groupRatio(catalog,group,model);
    if (ratio !== undefined && ratio < lowest) {cheapest=group;lowest=ratio;}
  }
  return cheapest;
}
export function defaultModelGroup(model: ModelInfo, catalog: ModelCatalog, preferred = '') {
  const routes=availableGroups(model,catalog);
  if (routes.includes(preferred)) return preferred;
  return cheapestGroup(model,catalog) ?? routes.find(g => g !== 'auto') ?? routes[0] ?? '';
}
const modelNameOrder = new Intl.Collator('en', {numeric:true, sensitivity:'base'});
export function sortModels(models: ModelInfo[], favorites: string[] = []) {
  const saved = new Set(favorites);
  return models.slice().sort((a,b) => Number(saved.has(b.model_name))-Number(saved.has(a.model_name)) || modelNameOrder.compare(a.model_name,b.model_name) || a.model_name.localeCompare(b.model_name));
}
