import { createContext, useContext } from 'react';
import type { Bootstrap, Dashboard, RangeQuery, StatisticsQuery, Page, Preferences, PreferencePatch } from '../shared/types';
export interface AppState {
  openLogin():void; bootstrap: Bootstrap; preferences: Preferences; dashboard: Dashboard | null;
  page: Page; setPage(page: Page): void; days: number; setDays(n: number): void;
  overviewQuery: RangeQuery; setOverviewQuery(query: RangeQuery): void; statisticsQuery: StatisticsQuery;
  loading: boolean; error: string; refresh(force?: boolean): Promise<void>;
  updatePreferences(p: PreferencePatch): Promise<void>;
  setPreferences(p: Preferences): void; reloadBootstrap(): Promise<void>;
  toast(message: string, kind?: 'success' | 'error' | 'info'): void;
  configureModel(model: string, tool: 'codex' | 'claude', group?: string): void;
}
export const AppContext = createContext<AppState | null>(null);
export function useApp() { const context = useContext(AppContext); if (!context) throw new Error('Missing AppContext'); return context; }
