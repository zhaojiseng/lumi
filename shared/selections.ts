import type {PreferencePatch, Preferences, SelectionValue} from './types';
const forbidden = new Set(['__proto__', 'prototype', 'constructor']);
export function validSelectionValue(value: unknown): value is SelectionValue {
  if (typeof value === 'string') return value.length <= 4000;
  if (typeof value === 'boolean') return true;
  if (typeof value === 'number') return Number.isFinite(value);
  if (Array.isArray(value)) return value.length<=500 && value.every(v=>typeof v==='string' && v.length<=200) && new Set(value).size===value.length;
  if (!value || typeof value !== 'object') return false;
  const range = value as Record<string, unknown>;
  return Object.keys(range).every(k=>['startDate','endDate','startTime','endTime'].includes(k)) && typeof range.startDate === 'string' && typeof range.endDate === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(range.startDate) && /^\d{4}-\d{2}-\d{2}$/.test(range.endDate) && ['startTime','endTime'].every(k=>range[k]===undefined || typeof range[k]==='string' && /^([01]\d|2[0-3]):[0-5]\d$/.test(range[k] as string));
}
export function normalizeSelections(value: unknown): Preferences['viewSelections'] {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  return Object.fromEntries(Object.entries(value).filter(([id, selections]) => !forbidden.has(id) && id.length <= 100 && selections && typeof selections === 'object' && !Array.isArray(selections)).slice(0, 100).map(([id, selections]) => [id, Object.fromEntries(Object.entries(selections as object).filter(([key, item]) => !forbidden.has(key) && key.length > 0 && key.length <= 600 && validSelectionValue(item)).slice(0, 5000))]));
}
/** One-time migration from the former site-bound Usage page. */
export function normalizeSourceSelections(value:unknown,legacy:Preferences['viewSelections'],activeSiteId:string):Preferences['sourceSelections']{
  const normalized=normalizeSelections(value);
  if(value===undefined){
    const saved=legacy[activeSiteId] || {};
    if(['billing','logs','local'].includes(String(saved['usage.tab'])))normalized['feature.usage']={tab:saved['usage.tab']};
    const local:Record<string,SelectionValue>={};
    if(['all','codex','claude'].includes(String(saved['usage.localTool'])))local.tool=saved['usage.localTool'];
    const range=saved['statistics.range'] ?? saved['overview.range'];if(validSelectionValue(range))local.range=range;
    if(Array.isArray(saved['statistics.models']))local.models=saved['statistics.models'];
    if(Object.keys(local).length)normalized['source.local-sessions']=local;
  }
  return Object.fromEntries(Object.entries(normalized).filter(([id])=>id==='source.local-sessions' || id==='feature.usage'));
}
export function applyPreferencePatch(preferences: Preferences, patch: PreferencePatch): Preferences {
  const {selection,sourceSelection,interfaceSelection, ...fields} = patch;
  const next = {...preferences, ...fields};
  if (selection) next.viewSelections = {...preferences.viewSelections, [selection.siteId]: {...preferences.viewSelections[selection.siteId], ...selection.values}};
  if(sourceSelection)next.sourceSelections={...preferences.sourceSelections,[sourceSelection.sourceId]:{...preferences.sourceSelections?.[sourceSelection.sourceId],...sourceSelection.values}};
  if(interfaceSelection)next.interfaceSelections={...preferences.interfaceSelections,[interfaceSelection.interfaceId]:{...preferences.interfaceSelections?.[interfaceSelection.interfaceId],...interfaceSelection.values}};
  return next;
}
export function selectionValue<T extends SelectionValue>(preferences: Preferences, key: string, fallback: T, validate?: (value: T) => boolean): T {
  const saved = preferences.viewSelections?.[preferences.activeSiteId]?.[key];
  if (!validSelectionValue(saved) || (validate ? !validate(saved as T) : typeof saved !== typeof fallback)) return fallback;
  return saved as T;
}
export const modelSelectionKey = (model: string, field: 'group' | 'price') => 'model.' + model + '.' + field;
