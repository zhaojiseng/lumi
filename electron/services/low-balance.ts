import { Notification } from 'electron';
import { currency } from '../../shared/utils';
import type { Dashboard } from '../../shared/types';

/**
 * Low-balance reminder observed on dashboard refresh completions. A site is
 * reminded once when its balance crosses below the threshold and stays quiet
 * until it recovers, so a read's return value never depends on notification
 * side effects.
 */
export class LowBalanceNotice {
  private low = new Set<string>();
  observe(dashboard: Dashboard, siteId: string, siteName: string, threshold: number): void {
    const user = dashboard.user;
    const balance = user && Number.isFinite(user.quota) ? currency(dashboard.status).value(user.quota) : null;
    if (balance === null || !Number.isFinite(balance)) { this.low.delete(siteId); return; }
    const below = balance <= threshold;
    if (below === this.low.has(siteId)) return;
    if (below) { this.low.add(siteId); if (Notification.isSupported()) new Notification({ title: 'Lumi · 余额提醒', body: `${siteName} 的余额低于提醒阈值，请查看账户。` }).show(); }
    else this.low.delete(siteId);
  }
}
