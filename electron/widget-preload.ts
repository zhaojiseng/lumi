import {contextBridge,ipcRenderer} from 'electron';
import type {WidgetBridge} from '../shared/widget';
async function call(channel:string,payload?:unknown){const response=await ipcRenderer.invoke('lumi:widget'+channel,payload);if(!response.ok)throw new Error(response.error);return response.data;}
const bridge:WidgetBridge={snapshot:()=>call('Snapshot'),action:event=>call('Action',event),onState:listener=>{const receive=(_event:Electron.IpcRendererEvent,state:Parameters<typeof listener>[0])=>listener(state);ipcRenderer.on('lumi:widgetState',receive);return()=>ipcRenderer.removeListener('lumi:widgetState',receive);}};
contextBridge.exposeInMainWorld('lumiWidget',bridge);
