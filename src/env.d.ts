import type { LumiBridge } from '../shared/types';
import type {TrayPanelBridge} from '../shared/tray';
declare global { interface Window { lumi?: LumiBridge; lumiTray?:TrayPanelBridge; } }
export {};
