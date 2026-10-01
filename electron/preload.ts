import { contextBridge, ipcRenderer } from 'electron';
import type { LumiBridge } from '../shared/types';
async function call(channel: string, payload?: unknown) {
  const response = await ipcRenderer.invoke(`lumi:${channel}`, payload);
  if (!response.ok) throw new Error(response.error);
  return response.data;
}
const bridge: LumiBridge = {
  bootstrap: () => call('bootstrap'), saveSite: p => call('saveSite', p), removeSite: id => call('removeSite', id),
  loginInfo:() => call('loginInfo'),login:p => call('login',p),verifyLogin:p => call('verifyLogin',p),browserLogin:() => call('browserLogin'),logout:id => call('logout',id),
  updatePreferences: p => call('preferences', p), modelHealth:model => call('modelHealth',model), dashboard: days => call('dashboard', days), logs: q => call('logs', q), localUsage: days => call('localUsage', days),
  previewConfig: q => call('previewConfig', q), applyConfig: id => call('applyConfig', id), backups: () => call('backups'), restoreBackup: id => call('restoreBackup', id),
  createToken: p => call('createToken', p), toggleToken: (id, enabled) => call('toggleToken', { id, enabled }), updateToken:p=>call('updateToken',p), exportLogs: q => call('exportLogs', q),
  getTokenKey: id => call('getTokenKey', id), copyTokenKey: id => call('copyTokenKey', id),
  openExternal: url => call('openExternal', url), windowControl: action => call('window', action),
};
contextBridge.exposeInMainWorld('lumi', bridge);
