import {newApiManifest} from './provider.newapi/manifest';
import {localSessionsManifest} from './source.local-sessions/manifest';
import {workbenchManifest} from './feature.workbench/manifest';
import {usageManifest} from './feature.usage/manifest';
import {modelsManifest} from './feature.models/manifest';
import {toolConfigManifest} from './feature.tool-config/manifest';
import {codexAdapterManifest} from './adapter.tool.codex/manifest';
import {claudeAdapterManifest} from './adapter.tool.claude/manifest';
import {defaultThemeManifest} from './theme.default/manifest';
import {widgetManifest} from './surface.widget/manifest';
import {trayManifest} from './surface.tray/manifest';
import {codexProviderManifest} from './provider.codex/manifest';
import {tokensManifest} from './feature.tokens/manifest';
import {defaultInterfaceManifest} from './interface.default/manifest';
import {backgroundInterfaceManifest} from './interface.background/manifest';
/** Shared static metadata only; main implementations must never enter this module. */
export const builtinManifests=[newApiManifest,codexProviderManifest,widgetManifest,trayManifest,localSessionsManifest,codexAdapterManifest,claudeAdapterManifest,defaultThemeManifest,defaultInterfaceManifest,backgroundInterfaceManifest,workbenchManifest,usageManifest,modelsManifest,toolConfigManifest,tokensManifest] as const;
