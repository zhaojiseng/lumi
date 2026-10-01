import {useApp} from './context';
import {selectionValue} from '../shared/selections';
import type {SelectionValue} from '../shared/types';
/** Each change is merged into the site's saved selections, including before config is applied. */
export function useSavedSelection<T extends SelectionValue>(key: string, fallback: T, validate?: (value: T) => boolean): [T, (value: T) => void] {
  const {preferences, updatePreferences, toast} = useApp();
  return [selectionValue(preferences, key, fallback, validate), value => {
    void updatePreferences({selection: {siteId: preferences.activeSiteId, values: {[key]: value}}}).catch(e => toast(e.message, 'error'));
  }];
}
