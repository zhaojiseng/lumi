import { contextBridge, ipcRenderer } from 'electron';
import type { LumiBridge } from '../shared/types';
async function call(channel: string, payload?: unknown) {
  const response = await ipcRenderer.invoke(`lumi:${channel}`, payload);
  if (!response.ok) throw new Error(response.error);
  return response.data;
}
const bridge: LumiBridge = {
  syncSurfaceTheme:input=>call('syncSurfaceTheme',input),
  extensionMarket:input=>call('extensionMarket',input),installExtension:input=>call('installExtension',input),removeExtension:id=>call('removeExtension',id),
  extensionInventory:()=>call('extensionInventory'),reloadExtensions:()=>call('reloadExtensions'),openExtensionsDirectory:()=>call('openExtensionsDirectory'),extensionRequest:input=>call('extensionRequest',input),
  readCodexUsage:input=>call('readCodexUsage',input),
  readCatalog:input=>call('readCatalog',input),listPlugins:()=>call('listPlugins'),setPluginEnabled:(id,enabled)=>call('setPluginEnabled',{id,enabled}),
  setPluginView:(id,view,enabled)=>call('setPluginView',{id,view,enabled}),
  onWidgetVisibility:listener=>{const receive=(_event:Electron.IpcRendererEvent,enabled:boolean)=>listener(enabled);ipcRenderer.on('lumi:widgetVisibility',receive);return()=>ipcRenderer.removeListener('lumi:widgetVisibility',receive);},
  bootstrap: () => call('bootstrap'), saveSite: p => call('saveSite', p), removeSite: id => call('removeSite', id),
  inspectConfigs:()=>call('inspectConfigs'),
  appLogs:()=>call('appLogs'),
  appCache:()=>call('appCache'),clearAppCache:()=>call('clearAppCache'),
  onRefresh:listener=>{const receive=()=>listener();ipcRenderer.on('lumi:refresh',receive);return()=>{ipcRenderer.removeListener('lumi:refresh',receive);};},
  onNavigate:listener=>{const receive=(_event:Electron.IpcRendererEvent,page:Parameters<typeof listener>[0])=>listener(page);ipcRenderer.on('lumi:navigate',receive);return()=>{ipcRenderer.removeListener('lumi:navigate',receive);};},
  onAppLog:listener=>{const receive=(_event:Electron.IpcRendererEvent,entry:Parameters<typeof listener>[0])=>listener(entry);ipcRenderer.on('lumi:appLog',receive);return()=>{ipcRenderer.removeListener('lumi:appLog',receive);};},
  toolRuntimes:force=>call('toolRuntimes',force),installTool:tool=>call('installTool',tool),
  onToolRuntime:listener=>{const receive=(_event:Electron.IpcRendererEvent,state:Parameters<typeof listener>[0])=>listener(state);ipcRenderer.on('lumi:toolRuntime',receive);return()=>{ipcRenderer.removeListener('lumi:toolRuntime',receive);};},
  loginInfo:() => call('loginInfo'),login:p => call('login',p),verifyLogin:p => call('verifyLogin',p),browserLogin:() => call('browserLogin'),logout:id => call('logout',id),
  updatePreferences: p => call('preferences', p), modelHealth:model => call('modelHealth',model), dashboard: (query,force) => call('dashboard', {query,force}), logs: q => call('logs', q), localUsage: (query,requestId) => call('localUsage',requestId ? {query,requestId} : query),
  onLocalUsageProgress:listener=>{const receive=(_event:Electron.IpcRendererEvent,progress:Parameters<typeof listener>[0])=>listener(progress);ipcRenderer.on('lumi:localUsageProgress',receive);return()=>ipcRenderer.removeListener('lumi:localUsageProgress',receive);},
  localSessionDetails:input=>call('localSessionDetails',input),
  loadLocalSession:input=>call('loadLocalSession',input),
  onLocalSessionProgress:listener=>{const receive=(_event:Electron.IpcRendererEvent,progress:Parameters<typeof listener>[0])=>listener(progress);ipcRenderer.on('lumi:localSessionProgress',receive);return()=>ipcRenderer.removeListener('lumi:localSessionProgress',receive);},
  localSessionRecords:input=>call('localSessionRecords',input),localSessionContent:input=>call('localSessionContent',input),localSessionRaw:input=>call('localSessionRaw',input),releaseLocalSession:input=>call('releaseLocalSession',input),
  tokenUsage:query=>call('tokenUsage',query),
  usageQuality:query=>call('usageQuality',query),
  updateStatus:()=>call('updateStatus'),checkUpdate:()=>call('checkUpdate'),downloadUpdate:()=>call('downloadUpdate'),cancelUpdate:()=>call('cancelUpdate'),showUpdateFile:()=>call('showUpdateFile'),openUpdateFile:()=>call('openUpdateFile'),restartUpdate:()=>call('restartUpdate'),
  onUpdate:listener=>{const receive=(_event:Electron.IpcRendererEvent,state:Parameters<typeof listener>[0])=>listener(state);ipcRenderer.on('lumi:updateState',receive);return ()=>{ipcRenderer.removeListener('lumi:updateState',receive);};},
  onReviewUpdate:listener=>{const receive=()=>listener();ipcRenderer.on('lumi:reviewUpdate',receive);return()=>{ipcRenderer.removeListener('lumi:reviewUpdate',receive);};},
  previewConfig: q => call('previewConfig', q), applyConfig: id => call('applyConfig', id), backups: () => call('backups'), restoreBackup: id => call('restoreBackup', id),
  onConfigProgress:listener=>{const receive=(_event:Electron.IpcRendererEvent,progress:Parameters<typeof listener>[0])=>listener(progress);ipcRenderer.on('lumi:configProgress',receive);return()=>ipcRenderer.removeListener('lumi:configProgress',receive);},
  createToken: p => call('createToken', p), toggleToken: (id, enabled) => call('toggleToken', { id, enabled }), updateToken:p=>call('updateToken',p), exportLogs: q => call('exportLogs', q),
  getTokenKey: id => call('getTokenKey', id), copyTokenKey: id => call('copyTokenKey', id),
  openExternal: url => call('openExternal', url), windowControl: action => call('window', action),
};
contextBridge.exposeInMainWorld('lumi', bridge);
