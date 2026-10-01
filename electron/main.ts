import {LOG_COLUMN_IDS} from '../shared/types';
import { app, BrowserWindow, ipcMain, safeStorage, shell, dialog, Notification, Tray, Menu, nativeImage, clipboard,screen } from 'electron';
import path from 'node:path';
import { writeFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { z } from 'zod';
import { SettingsStore } from './services/store';
import { NewApiClient } from './services/new-api';
import { ConfigService } from './services/config';
import { LocalUsageService } from './services/local-usage';
import { browserLogin } from './services/browser-login';
import { UpdateService } from './services/updates';
import {nativeUpdater} from './services/native-updater';
import {ToolRuntimeService} from './services/tool-runtime';
import {macUpdater} from './services/mac-updater';
import {appLogs,captureConsole} from './services/app-logs';
import {windowLayout,macMenu} from './window-layout';
import {startupHtml} from './startup';
import { currency, logsToCsv } from '../shared/utils';
import type { ConfigRequest, LogQuery, SiteInput, CreateTokenInput, UpdateTokenInput } from '../shared/types';
const root = path.resolve(__dirname, '..');
captureConsole();
appLogs.write('info','启动',`Lumi ${app.getVersion()} · ${process.platform}/${process.arch} · Electron ${process.versions.electron}`);
let quitting=false;app.on('before-quit',()=>{quitting=true;appLogs.write('info','生命周期','程序退出。');});
if (process.env.LUMI_SMOKE === '1') app.disableHardwareAcceleration();
if (process.env.LUMI_TEST_DATA) app.setPath('userData', path.resolve(process.env.LUMI_TEST_DATA));
let win: BrowserWindow;let tray: Tray | undefined;
const timeSchema=z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/);
const dateRangeSchema=z.object({startDate:z.string().regex(/^\d{4}-\d{2}-\d{2}$/),endDate:z.string().regex(/^\d{4}-\d{2}-\d{2}$/),startTime:timeSchema.optional(),endTime:timeSchema.optional()}).strict();
const daySchema = z.number().int().min(1).max(90);
const toolSchema = z.enum(['codex', 'claude']);
const modelsSchema=z.array(z.string().min(1).max(200)).max(500);
const tokenIdsSchema=z.array(z.number().int().positive()).max(500);
const rangeQuerySchema=z.union([daySchema,dateRangeSchema]);
const statisticsSchema=z.union([rangeQuerySchema,z.object({range:rangeQuerySchema,models:modelsSchema.optional(),tokenIds:tokenIdsSchema.optional()}).strict()]);
const logSchema = z.object({ range:dateRangeSchema.optional(), days: daySchema, page: z.number().int().min(1).max(10000), pageSize: z.number().int().min(1).max(100), model: z.string().max(200).optional(), tokenName: z.string().max(100).optional(), models:modelsSchema.optional(),tokenIds:tokenIdsSchema.optional(),type: z.number().int().min(0).max(10).optional() }).strict();
const siteSchema = z.object({ id: z.string().max(100).optional(), name: z.string().trim().min(1).max(80), url: z.string().min(1).max(2000), userId: z.number().int().positive().optional(), allowHttp: z.boolean(), accessToken: z.string().max(10000).optional(), apiKey: z.string().max(10000).optional(), clearAccessToken: z.boolean().optional(), clearApiKey: z.boolean().optional() });
const selectionSchema = z.object({siteId:z.string().min(1).max(100),values:z.record(z.string().min(1).max(600),z.union([z.string().max(4000),z.number().finite(),z.boolean(),dateRangeSchema,z.array(z.string().max(200)).max(500).refine(v=>new Set(v).size===v.length)])).refine(v=>Object.keys(v).length<=5000)}).strict();
const preferenceSchema = z.object({ dismissedUpdateVersion: z.string().max(30).regex(/^(?:|(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*))$/).optional(), activeSiteId: z.string().max(100).optional(), tokenPrefix: z.string().trim().min(1).max(20).regex(/^[a-zA-Z0-9_-]+$/).optional(), theme: z.enum(['light', 'dark', 'system']).optional(), refreshInterval: z.number().int().min(0).max(3600).optional(), lowBalanceThreshold: z.number().min(0).max(1e9).optional(), favoriteModels: z.array(z.string().max(200)).max(500).optional(), logColumns: z.array(z.enum(LOG_COLUMN_IDS)).min(1).max(LOG_COLUMN_IDS.length).refine(v => new Set(v).size === v.length).optional(), selection:selectionSchema.optional() }).strict();
const configSchema = z.object({ tool: toolSchema, model: z.string().trim().min(1).max(200), group: z.string().min(1).max(100), sonnet: z.string().max(200).optional(), opus: z.string().max(200).optional(), haiku: z.string().max(200).optional(), contextWindow:z.number().int().min(4096).max(10000000).optional() }).strict();
const tokenSchema = z.object({ name: z.string().trim().min(1).max(50), tool: toolSchema.optional(), group: z.string().min(1).max(100), unlimited: z.boolean(), quota: z.number().min(0).max(Number.MAX_SAFE_INTEGER), models: z.string().max(5000).optional(), expiredTime:z.number().int().refine(v=>v===-1 || v>0).optional(),allowIps:z.string().max(5000).optional(),crossGroupRetry:z.boolean().optional() }).strict();
function trustedFrame(event: Electron.IpcMainInvokeEvent) {
  const url = event.senderFrame?.url;
  if (event.sender !== win.webContents || event.senderFrame !== event.sender.mainFrame || !url) return false;
  return process.env.LUMI_DEV_URL ? new URL(url).origin === new URL(process.env.LUMI_DEV_URL).origin : url.split('#')[0] === pathToFileURL(path.join(root, 'dist/index.html')).href;
}
function handle<T extends z.ZodType>(channel: string, schema: T, action: (data: z.infer<T>) => unknown | Promise<unknown>) {
  ipcMain.handle(`lumi:${channel}`, async (event, payload) => {
    if (!trustedFrame(event)) return { ok: false, error: '请求来源不可信。' };
    const started=performance.now();
    try {const data=await action(schema.parse(payload));if(channel!=='appLogs')appLogs.write('debug','操作',`${channel} 完成 · ${Math.round(performance.now()-started)} ms`);return { ok: true, data }; }
    catch (e) {const error=e instanceof z.ZodError ? '输入内容无效，请检查必填项与数值范围。' : e instanceof Error ? e.message : '操作失败。';appLogs.write('error','操作',channel+'：'+error);return { ok: false, error }; }
  });
}
async function start() {
  const startupStarted=performance.now();
  const icon = nativeImage.createFromPath(path.join(root, 'public/icon.png'));
  win = new BrowserWindow({ ...windowLayout(process.platform,screen.getPrimaryDisplay().workAreaSize), show: false, backgroundColor: '#f5f7f8', icon,
    webPreferences: { preload: path.join(__dirname, 'preload.cjs'), nodeIntegration: false, contextIsolation: true, sandbox: true, webSecurity: true, devTools: !app.isPackaged },
  });
  Menu.setApplicationMenu(process.platform==='darwin' ? Menu.buildFromTemplate(macMenu()) : null);
  if(process.platform==='darwin')win.setWindowButtonVisibility(true);
  win.on('close',event=>{if(process.platform==='darwin' && !quitting && process.env.LUMI_SMOKE!=='1'){event.preventDefault();win.hide();appLogs.write('info','窗口','窗口关闭，点击 Dock 图标可重新打开。');}});
  win.webContents.on('console-message',details=>appLogs.write(details.level==='warning' ? 'warn' : details.level==='error' ? 'error' : details.level==='debug' ? 'debug' : 'info','界面',details.message));
  win.webContents.on('did-fail-load',(_event,code,description)=>appLogs.write('error','页面加载',`${code} ${description}`));
  win.webContents.on('render-process-gone',(_event,details)=>appLogs.write('error','渲染进程',`${details.reason} · ${details.exitCode}`));
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  win.webContents.on('will-navigate', e => e.preventDefault());
  win.webContents.session.setPermissionRequestHandler((_wc, _permission, callback) => callback(false));
  win.webContents.session.setPermissionCheckHandler(() => false);
  win.once('ready-to-show',()=>{if(process.env.LUMI_SMOKE!=='1')win.show();});
  await win.loadURL('data:text/html;charset=utf-8,'+encodeURIComponent(startupHtml));
  const startupPaintMs=Math.round(performance.now()-startupStarted);
  appLogs.write('info','启动',`启动画面已就绪 · ${startupPaintMs} ms`);
  const data = app.getPath('userData');
  const store = new SettingsStore(data, {
    available: () => safeStorage.isEncryptionAvailable() && (process.platform !== 'linux' || safeStorage.getSelectedStorageBackend() !== 'basic_text'),
    encrypt: text => safeStorage.encryptString(text).toString('base64'), decrypt: text => safeStorage.decryptString(Buffer.from(text, 'base64')),
  });
  await store.load();
  const api = new NewApiClient(store); const configs = new ConfigService(store, data, undefined, req => api.ensureToolToken(req)); const usage = new LocalUsageService();
  const macUpdate=process.platform==='darwin' && process.arch==='arm64';
  const updateEnabled=app.isPackaged && (macUpdate || process.platform==='win32' && process.arch==='x64') && process.env.LUMI_SMOKE!=='1' && !process.env.PORTABLE_EXECUTABLE_FILE;
  const updates=new UpdateService({version:app.getVersion(),enabled:updateEnabled,target:macUpdate ? 'mac-arm64' : 'windows',engine:updateEnabled ? macUpdate ? macUpdater(path.join(data,'updates')) : await nativeUpdater() : undefined});
  const runtimes=new ToolRuntimeService({directory:path.join(data,'tool-installers')});
  let lastNotice = 0;
  const noPayload = z.undefined();
  handle('bootstrap', noPayload, () => ({ preferences: structuredClone(store.preferences), desktop: true, platform:process.platform,version: app.getVersion(), configs: [], secureStorage: store.cipher.available() }));
  handle('appLogs',noPayload,()=>appLogs.snapshot());
  handle('inspectConfigs',noPayload,()=>configs.inspect());
  handle('toolRuntimes',z.boolean().optional(),force=>runtimes.inspect(force));
  handle('installTool',toolSchema,tool=>runtimes.install(tool));
  handle('saveSite', siteSchema, input => store.saveSite(input as SiteInput));
  handle('loginInfo', noPayload, () => api.loginInfo());
  handle('login', z.object({ username:z.string().trim().min(1).max(100),password:z.string().min(1).max(1024),turnstileToken:z.string().max(4096).optional() }).strict(), input => api.login(input));
  handle('verifyLogin', z.object({challengeId:z.string().uuid(),code:z.string().trim().min(1).max(128)}).strict(), input => api.verifyLogin(input));
  let loginPending: Promise<any> | null = null;
  handle('browserLogin', noPayload, async () => { if (loginPending) throw new Error('登录窗口已打开。'); loginPending=browserLogin(win,store,api); try { return await loginPending; } finally { loginPending=null; } });
  handle('logout', z.string().max(100), id => api.logout(id));
  handle('removeSite', z.string().max(100), id => store.removeSite(id));
  handle('preferences', preferenceSchema, patch => store.update(patch));
  handle('modelHealth',z.string().min(1).max(200),model => api.modelHealth(model));
  handle('dashboard', z.object({query:statisticsSchema,force:z.boolean().optional()}).strict(), async input => {
    const d = await api.dashboard(input.query,input.force);
    if (d.user && currency(d.status).value(d.user.quota) <= store.preferences.lowBalanceThreshold && Date.now() - lastNotice > 3600000) {
      lastNotice = Date.now(); if (Notification.isSupported()) new Notification({ title: 'Lumi · 余额提醒', body: `${store.activeSite().name} 的余额低于提醒阈值，请查看账户。` }).show();
    }
    return d;
  });
  handle('logs', logSchema, q => api.logs(q as LogQuery));
  handle('tokenUsage',statisticsSchema,query=>api.tokenUsage(query));
  handle('usageQuality',statisticsSchema,query=>api.usageQuality(query));
  handle('updateStatus',noPayload,()=>updates.snapshot());
  handle('checkUpdate',noPayload,()=>updates.check());
  handle('downloadUpdate',noPayload,()=>updates.download());
  handle('cancelUpdate',noPayload,()=>updates.cancel());
  handle('showUpdateFile',noPayload,async()=>shell.showItemInFolder(await updates.readyFile()));
  handle('openUpdateFile',noPayload,async()=>{if(!macUpdate)throw new Error('此操作仅适用于 macOS 更新。');const error=await shell.openPath(await updates.readyFile());if(error)throw new Error('无法打开更新安装包，请在下载目录中重试。');});
  handle('restartUpdate',noPayload,()=>updates.restart());
  handle('localUsage', statisticsSchema, query => usage.scan(query));
  handle('previewConfig', configSchema, req => configs.preview(req as ConfigRequest));
  handle('applyConfig', z.string().uuid(), id => configs.apply(id));
  handle('backups', noPayload, () => configs.backups());
  handle('restoreBackup', z.string().uuid(), id => configs.restore(id));
  handle('createToken', tokenSchema, input => api.createToken(input as CreateTokenInput));
  handle('toggleToken', z.object({ id: z.number().int().positive(), enabled: z.boolean() }).strict(), async p => {configs.invalidateTokenPreviews(p.id);await api.toggleToken(p.id,p.enabled);});
  handle('updateToken',tokenSchema.omit({tool:true}).extend({id:z.number().int().positive()}),async input=>{configs.invalidateTokenPreviews(input.id);await api.updateToken(input as UpdateTokenInput);});
  handle('getTokenKey', z.number().int().positive(), id => api.getTokenKey(id));
  handle('copyTokenKey', z.number().int().positive(), async id => {clipboard.writeText(await api.getTokenKey(id));});
  handle('exportLogs', logSchema, async q => {
    const status = await api.status();
    const rows = await api.allLogs(q as LogQuery);
    const target = await dialog.showSaveDialog(win, { title: '导出使用记录', defaultPath: `Lumi-usage-${new Date().toLocaleDateString('sv-SE')}.csv`, filters: [{ name: 'CSV', extensions: ['csv'] }] });
    if (target.canceled || !target.filePath) return { count: 0 };
    await writeFile(target.filePath, logsToCsv(rows, status), 'utf8'); return { count: rows.length, path: target.filePath };
  });
  handle('openExternal', z.string().max(4000), async raw => { const url = new URL(raw); if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password) throw new Error('不支持此链接。'); await shell.openExternal(url.href); });
  handle('window', z.enum(['minimize', 'maximize', 'close']), action => { if (action === 'minimize') win.minimize(); else if (action === 'maximize') win.isMaximized() ? win.unmaximize() : win.maximize(); else win.close(); });
  let updatePhase='';
  const unsubscribeUpdates=updates.subscribe(state=>{if(state.phase!==updatePhase){updatePhase=state.phase;appLogs.write(state.phase==='error' ? 'error' : 'info','更新',state.phase+(state.version ? ' · v'+state.version : '')+(state.error ? ' · '+state.error : ''));}if(!win.isDestroyed())win.webContents.send('lumi:updateState',state);});
  const unsubscribeLogs=appLogs.subscribe(entry=>{if(!win.isDestroyed())win.webContents.send('lumi:appLog',entry);});
  const unsubscribeRuntimes=runtimes.subscribe(state=>{if(win && !win.isDestroyed())win.webContents.send('lumi:toolRuntime',state);});
  const updateInterval=setInterval(()=>{void updates.check();},4*60*60*1000);updateInterval.unref();
  app.once('before-quit',()=>{clearInterval(updateInterval);unsubscribeUpdates();updates.close();unsubscribeRuntimes();runtimes.close();unsubscribeLogs();});
  if (!icon.isEmpty() && process.env.LUMI_SMOKE !== '1') {
    tray = new Tray(icon.resize({ width: 20, height: 20 })); tray.setToolTip('Lumi · AI 工作台');
    tray.setContextMenu(Menu.buildFromTemplate([{ label: '打开 Lumi', click: () => { win.show(); win.focus(); } }, { type: 'separator' }, { label: '退出', click: () => app.quit() }])); tray.on('double-click', () => { win.show(); win.focus(); });
  }
  if (process.env.LUMI_DEV_URL) await win.loadURL(process.env.LUMI_DEV_URL); else await win.loadFile(path.join(root, 'dist/index.html'));
  appLogs.write('info','启动','工作台页面加载完成。');
  if(updateEnabled){const firstUpdate=setTimeout(()=>{void updates.check();},3000);firstUpdate.unref();}
  if (process.env.LUMI_SMOKE === '1') {
    try {
      const result = await win.webContents.executeJavaScript(String.raw`(async () => {
        await new Promise(resolve => setTimeout(resolve,1500));
        const b = await window.lumi.bootstrap();
        let ipcValidation=false;try { await window.lumi.updatePreferences({theme:'invalid'}); } catch { ipcValidation=true; }
        let toolIpcValidation=false;try { await window.lumi.installTool('untrusted-command'); } catch { toolIpcValidation=true; }
        const logs=await window.lumi.appLogs();
        return {desktop:b.desktop,secureStorage:b.secureStorage,contextIsolation:typeof require === 'undefined',ipcValidation,toolIpcValidation,loginVisible:document.body.innerText.includes('登录'),noDemo:!document.body.innerText.includes('演示'),page:document.body.innerText.includes('工作台'),startupLogs:logs.entries.some(e=>e.source==='启动'),platform:b.platform};
      })()`);
      result.startupPaintMs=startupPaintMs;result.startupWindows=BrowserWindow.getAllWindows().length;
      result.nativeMacControls=process.platform!=='darwin' || win.getWindowButtonPosition()?.x===24 && Menu.getApplicationMenu()!==null;
      const updaterProbe=process.platform==='darwin' ? macUpdater(path.join(data,'updates')) : await nativeUpdater();updaterProbe.onError(()=>{})();result.nativeUpdaterLoaded=true;
      if (process.env.LUMI_SMOKE_SCREENSHOT) await writeFile(process.env.LUMI_SMOKE_SCREENSHOT,(await win.webContents.capturePage()).toPNG());
      console.log('LUMI_SMOKE_RESULT=' + JSON.stringify(result));
      if(process.env.LUMI_SMOKE_RESULT_PATH)await writeFile(process.env.LUMI_SMOKE_RESULT_PATH,JSON.stringify(result));
      if (!result.desktop || !result.contextIsolation || !result.noDemo || !result.loginVisible || !result.ipcValidation || !result.toolIpcValidation) process.exitCode=1;
    } catch (e) { console.error('SMOKE_FAILED',String(e));process.exitCode=1; }
    app.exit(Number(process.exitCode) || 0);
  }
}
if (!app.requestSingleInstanceLock() && process.env.LUMI_SMOKE !== '1') app.quit();
else {
  app.on('second-instance', () => { if (win && !win.isDestroyed()) { if (win.isMinimized()) win.restore(); win.show(); win.focus(); } });
  app.on('activate',()=>{if(win && !win.isDestroyed()){if(win.isMinimized())win.restore();win.show();win.focus();}});
  app.whenReady().then(start).catch(e => { if (process.env.LUMI_SMOKE === '1') { console.error('LUMI_SMOKE_FAILED', String(e.message || e)); app.exit(1); } else { dialog.showErrorBox('Lumi 启动失败', String(e.message || e)); app.quit(); } });
  app.on('window-all-closed', () => {if(process.platform!=='darwin'){tray?.destroy();app.quit();} });
}
