import type {PreferencePatch, Preferences, SelectionValue} from './types';
const forbidden = new Set(['__proto__', 'prototype', 'constructor']);
export function validSelectionValue(value: unknown): value is SelectionValue {
  if (typeof value === 'string') return value.length <= 4000;
  if (typeof value === 'boolean') return true;
  if (typeof value === 'number') return Number.isFinite(value);
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const range = value as Record<string, unknown>;
  return Object.keys(range).length === 2 && typeof range.startDate === 'string' && typeof range.endDate === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(range.startDate) && /^\d{4}-\d{2}-\d{2}$/.test(range.endDate);
}
export function normalizeSelections(value: unknown): Preferences['viewSelections'] {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  return Object.fromEntries(Object.entries(value).filter(([id, selections]) => !forbidden.has(id) && id.length <= 100 && selections && typeof selections === 'object' && !Array.isArray(selections)).slice(0, 100).map(([id, selections]) => [id, Object.fromEntries(Object.entries(selections as object).filter(([key, item]) => !forbidden.has(key) && key.length > 0 && key.length <= 600 && validSelectionValue(item)).slice(0, 5000))]));
}
export function applyPreferencePatch(preferences: Preferences, patch: PreferencePatch): Preferences {
  const {selection, ...fields} = patch;
  const next = {...preferences, ...fields};
  if (selection) next.viewSelections = {...preferences.viewSelections, [selection.siteId]: {...preferences.viewSelections[selection.siteId], ...selection.values}};
  return next;
}
export function selectionValue<T extends SelectionValue>(preferences: Preferences, key: string, fallback: T, validate?: (value: T) => boolean): T {
  const saved = preferences.viewSelections?.[preferences.activeSiteId]?.[key];
  if (!validSelectionValue(saved) || (validate ? !validate(saved as T) : typeof saved !== typeof fallback)) return fallback;
  return saved as T;
}
export const modelSelectionKey = (model: string, field: 'group' | 'price') => 'model.' + model + '.' + field;
