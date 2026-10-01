import {contextBridge,ipcRenderer} from 'electron';
import type {TrayPanelBridge} from '../shared/tray';
async function call(channel:string,payload?:unknown){const response=await ipcRenderer.invoke('lumi:tray'+channel,payload);if(!response.ok)throw new Error(response.error);return response.data;}
const bridge:TrayPanelBridge={snapshot:()=>call('Snapshot'),action:event=>call('Action',event),onState:listener=>{const receive=(_event:Electron.IpcRendererEvent,state:Parameters<typeof listener>[0])=>listener(state);ipcRenderer.on('lumi:trayState',receive);return()=>ipcRenderer.removeListener('lumi:trayState',receive);}};
contextBridge.exposeInMainWorld('lumiTray',bridge);
