import type {PluginManifest} from '../../shared/contracts/plugins';
/** Desktop widgets also use this source, so disabling just the Usage page does not close it. */
export const localSessionsManifest:PluginManifest={id:'source.local-sessions',version:'1.0.0',hostApiVersion:1,configurable:false,requires:[],optional:[],provides:['localSessions.read']};
