import type {MenuBarUsage,MenuBarDetails} from '../types';
import type {WidgetUsage} from '../widget';
export interface DesktopProjectionCapability {
  loadWidget(now?:number):Promise<WidgetUsage>;
  loadMenu(force?:boolean):Promise<MenuBarUsage>;
  loadMenuDetails():Promise<MenuBarDetails>;
}
/** Headless system presentation ports; they do not depend on a mounted React page. */
export interface WorkbenchPresentationCapability extends Pick<DesktopProjectionCapability,'loadMenu'|'loadMenuDetails'> {}
export interface UsagePresentationCapability extends Pick<DesktopProjectionCapability,'loadWidget'> {}
