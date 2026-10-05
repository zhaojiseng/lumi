import type { CatalogReadCapability } from './catalog';
import type {AccountSessionCapability,OnlineUsageCapability,TokenManagementCapability,DesktopUsageCapability} from './newapi';
import type {ToolCredentialCapability} from './tool-credentials';
import type {LocalSessionsCapability} from './local-sessions';
import type {ToolConfigAdapter} from './tool-adapter';
import type {WorkbenchPresentationCapability,UsagePresentationCapability} from './desktop-projection';
import type {SubscriptionUsageCapability} from './subscription-usage';
import type {DesktopSurfaceControl} from './desktop-surface';

/** Capabilities exposed by the statically registered, trusted builtins. */
export interface BuiltinCapabilityMap {
  'catalog.read': CatalogReadCapability;
  'account.session':AccountSessionCapability;
  'online.usage':OnlineUsageCapability;
  'tokens.manage':TokenManagementCapability;
  'toolCredential.provision':ToolCredentialCapability;
  'desktopUsage.read':DesktopUsageCapability;
  'localSessions.read':LocalSessionsCapability;
  'toolConfig.build':ToolConfigAdapter;
  'widget.project':UsagePresentationCapability;
  'tray.project':WorkbenchPresentationCapability;
  'subscriptionUsage.read':SubscriptionUsageCapability;
  'workbench.present':WorkbenchPresentationCapability;
  'usage.present':UsagePresentationCapability;
  'surface.control':DesktopSurfaceControl;
}
export const BUILTIN_CAPABILITY_IDS:readonly (keyof BuiltinCapabilityMap)[]=['catalog.read','account.session','online.usage','tokens.manage','toolCredential.provision','desktopUsage.read','localSessions.read','toolConfig.build','widget.project','tray.project','subscriptionUsage.read','workbench.present','usage.present','surface.control'];

export type PluginCapabilityId<Capabilities extends object = BuiltinCapabilityMap> = Extract<keyof Capabilities, string>;

/** sourceId is the provider's manifest ID, not a site/account ID. */
export interface PluginCapabilityReference<Id extends string = PluginCapabilityId> {
  sourceId: string;
  capability: Id;
}

export interface PluginManifest<Id extends string = PluginCapabilityId> {
  id: string;
  version: string;
  hostApiVersion: 1;
  configurable: boolean;
  /** Initial preference for configurable plugins; an explicit saved choice takes priority. */
  defaultEnabled?: boolean;
  requires: readonly PluginCapabilityReference<Id>[];
  optional: readonly PluginCapabilityReference<Id>[];
  provides: readonly Id[];
  /** Serializable declarations; registering an option does not grant IPC privileges. */
  settings?:PluginSettingsDeclaration;
}

export interface PluginSettingsDeclaration {
  title:string;
  description:string;
  order:number;
  group?:'tools';
  views:readonly {id:PluginViewId;title:string;description?:string;defaultEnabled?:boolean}[];
}

export type PluginState = 'disabled' | 'activating' | 'active' | 'deactivating' | 'failed';
export interface PluginStatus<Id extends string = PluginCapabilityId> {
  manifest: PluginManifest<Id>;
  state: PluginState;
  error?: string;
  views?:Partial<Record<PluginViewId,boolean>>;
  generation?:number;
  origin?:'builtin'|'external';
}
/** Validated against the owning manifest, including plugin-specific display options. */
export type PluginViewId=string;

export type PluginDisposer = () => void | Promise<void>;

export interface PluginContext<Capabilities extends object = BuiltinCapabilityMap> {
  readonly manifest: PluginManifest<PluginCapabilityId<Capabilities>>;
  provide<Id extends PluginCapabilityId<Capabilities>>(capability: Id, value: Capabilities[Id]): void;
  onDispose(disposer: PluginDisposer): void;
  getCapability<Id extends PluginCapabilityId<Capabilities>>(sourceId: string, capability: Id): Capabilities[Id] | undefined;
  requireCapability<Id extends PluginCapabilityId<Capabilities>>(sourceId: string, capability: Id): Capabilities[Id];
}

/** No dynamic loading, sandboxing, IPC or arbitrary filesystem/network privileges. */
export interface TrustedBuiltinPlugin<Capabilities extends object = BuiltinCapabilityMap> {
  manifest: PluginManifest<PluginCapabilityId<Capabilities>>;
  activate(context: PluginContext<Capabilities>): void | PluginDisposer | Promise<void | PluginDisposer>;
}
