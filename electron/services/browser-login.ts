import { BrowserWindow, session } from 'electron';
import { randomUUID } from 'node:crypto';
import type { SettingsStore } from './store';
import type {AccountSessionCapability} from '../../shared/contracts/newapi';
import { BrowserCredentialCapture } from './login-capture';
import {DEFAULT_SITE_URL} from '../../shared/types';
/** Remote login runs without a preload or Node. No remote page can invoke Lumi IPC. */
export function browserLogin(parent: BrowserWindow, store: SettingsStore, api: Pick<AccountSessionCapability,'acceptBrowserSession'>) {
  if(store.activeSite().url===DEFAULT_SITE_URL)throw new Error('请先在设置中填写你的 New API 站点地址。');
  const site = structuredClone(store.activeSite()); const origin = new URL(site.url).origin;
  if (site.url.startsWith('http:') && !site.allowHttp) throw new Error('请先在站点设置中允许 HTTP 再登录。');
  if (!store.cipher.available()) throw new Error('系统加密存储不可用，无法保存登录凭证。');
  const partition = session.fromPartition('lumi-login-' + randomUUID());
  const login = new BrowserWindow({parent,width:1040,height:820,minWidth:700,minHeight:620,modal:true,title:'Lumi · 站点安全登录',autoHideMenuBar:true,webPreferences:{session:partition,nodeIntegration:false,contextIsolation:true,sandbox:true,webSecurity:true,devTools:false}});
  partition.setPermissionRequestHandler((_wc,_p,callback) => callback(false));
  login.webContents.setWindowOpenHandler(() => ({action:'deny'}));
  const restrictNavigation=(e:Electron.Event,url:string) => { if (new URL(url).origin !== origin) e.preventDefault(); };
  login.webContents.on('will-navigate',restrictNavigation);
  login.webContents.on('will-redirect',restrictNavigation);
  return new Promise<ReturnType<SettingsStore['update']> extends Promise<infer T> ? T : never>((resolve,reject) => {
    let finished=false; let token='';
    const filter={urls:[site.url + '/api/*']};
    const capture=new BrowserCredentialCapture(async accessToken => {
      store.assertSite(site.id,site.url);
      const hostname=new URL(site.url).hostname;
      const cookies=(await partition.cookies.get({domain:hostname})).filter(c => c.domain?.replace(/^\./,'') === hostname).map(c => ({name:c.name,value:c.value,path:c.path || '/',expires:c.expirationDate}));
      if (finished || login.isDestroyed()) throw new Error('登录已取消。');
      const preferences=await api.acceptBrowserSession(site.id,site.url,accessToken,cookies,() => !finished && !login.isDestroyed());
      finished=true;resolve(preferences);login.close();
    });
    partition.webRequest.onBeforeSendHeaders(filter,(details,callback) => {
      const url=new URL(details.url);
      if (url.origin === origin && url.pathname.startsWith(new URL(site.url + '/api/').pathname)) {
        const bearer=Object.entries(details.requestHeaders).find(([k]) => k.toLowerCase() === 'authorization')?.[1];
        if (typeof bearer === 'string' && /^Bearer\s+/i.test(bearer)) {token=bearer.replace(/^Bearer\s+/i,'');const observed=token;queueMicrotask(() => {void capture.capture(observed);});}
      }
      callback({requestHeaders:details.requestHeaders});
    });
    partition.webRequest.onCompleted(filter,details => { const endpoint=details.url.split('?')[0]; if (details.statusCode === 200 && ['/api/user/self','/api/user/login','/api/user/login/verify','/api/user/login/2fa'].some(p => endpoint === site.url + p)) void capture.capture(token); });
    login.on('closed',() => {
      capture.stop();
      partition.webRequest.onBeforeSendHeaders(null);partition.webRequest.onCompleted(null);
      void partition.clearStorageData().catch(() => {});
      if (!finished) { finished=true;reject(new Error('站点登录窗口已关闭，未保存新的凭证。')); }
    });
    login.loadURL(site.url + '/login').catch(() => { if (!finished) {finished=true;reject(new Error('站点登录页面无法打开。'));login.close();} });
  });
}
