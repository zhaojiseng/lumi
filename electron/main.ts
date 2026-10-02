import {LOG_COLUMN_IDS,MENU_BAR_SECTION_IDS} from '../shared/types';
import { app, BrowserWindow, ipcMain, safeStorage, shell, dialog, Notification, Menu, nativeImage, clipboard,screen,nativeTheme,protocol } from 'electron';
import path from 'node:path';
import { writeFile,readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import {createHash} from 'node:crypto';
import { z } from 'zod';
import {createBuiltinPlugins} from './host/plugins';
import {ExtensionHost} from './extensions/host';
import {formattedWidget} from '../shared/widget';
import {nativeMenuBarState,menuBarSelection} from '../shared/menu-bar';
import { SettingsStore } from './services/store';
import { ConfigService } from './services/config';
import {WIDGET_PERIODS,type WidgetPeriod} from '../shared/widget-period';
import { browserLogin } from './services/browser-login';
import { UpdateService } from './services/updates';
import {AppCacheService,isolateLumiDataPaths,lumiBrowserCacheRoots,lumiUpdateCacheRoots} from './services/app-cache';
import {nativeUpdater} from './services/native-updater';
import {ToolRuntimeService} from './services/tool-runtime';
import {macUpdater} from './services/mac-updater';
import {appLogs,captureConsole} from './services/app-logs';
import {windowLayout,macMenu} from './window-layout';
import {DATA_REFRESH_ANIMATIONS} from '../shared/motion';
import {startupHtml} from './startup';
import { currency, logsToCsv } from '../shared/utils';
import type { ConfigRequest, LogQuery, SiteInput, CreateTokenInput, UpdateTokenInput,Page } from '../shared/types';
const root = path.resolve(__dirname, '..');
protocol.registerSchemesAsPrivileged([{scheme:'lumi-extension',privileges:{standard:true,secure:true,supportFetchAPI:true}}]);
captureConsole();
appLogs.write('info','启动',`Lumi ${app.getVersion()} · ${process.platform}/${process.arch} · Electron ${process.versions.electron}`);
let quitting=false;app.on('before-quit',()=>{quitting=true;appLogs.write('info','生命周期','程序退出。');});
if (process.env.LUMI_SMOKE === '1') app.disableHardwareAcceleration();
const isolatedData=isolateLumiDataPaths(app);
let win: BrowserWindow;
const timeSchema=z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/);
const dateRangeSchema=z.object({startDate:z.string().regex(/^\d{4}-\d{2}-\d{2}$/),endDate:z.string().regex(/^\d{4}-\d{2}-\d{2}$/),startTime:timeSchema.optional(),endTime:timeSchema.optional()}).strict();
const daySchema = z.number().int().min(1).max(90);
const toolSchema = z.enum(['codex', 'claude']);
const modelsSchema=z.array(z.string().min(1).max(200)).max(500);
const tokenIdsSchema=z.array(z.number().int().positive()).max(500);
const rangeQuerySchema=z.union([daySchema,z.literal('24h'),dateRangeSchema]);
const statisticsSchema=z.union([rangeQuerySchema,z.object({range:rangeQuerySchema,models:modelsSchema.optional(),tokenIds:tokenIdsSchema.optional()}).strict()]);
const logSchema = z.object({ range:rangeQuerySchema.optional(), days: daySchema, page: z.number().int().min(1).max(10000), pageSize: z.number().int().min(1).max(100), model: z.string().max(200).optional(), tokenName: z.string().max(100).optional(), models:modelsSchema.optional(),tokenIds:tokenIdsSchema.optional(),type: z.number().int().min(0).max(10).optional() }).strict();
const siteSchema = z.object({ id: z.string().max(100).optional(), name: z.string().trim().min(1).max(80), url: z.string().min(1).max(2000), userId: z.number().int().positive().optional(), allowHttp: z.boolean(), accessToken: z.string().max(10000).optional(), apiKey: z.string().max(10000).optional(), clearAccessToken: z.boolean().optional(), clearApiKey: z.boolean().optional() });
const selectionSchema = z.object({siteId:z.string().min(1).max(100),values:z.record(z.string().min(1).max(600),z.union([z.string().max(4000),z.number().finite(),z.boolean(),dateRangeSchema,z.array(z.string().max(200)).max(500).refine(v=>new Set(v).size===v.length)])).refine(v=>Object.keys(v).length<=5000)}).strict();
const barRangeSchema=z.union([z.literal('follow'),z.literal('24h'),z.literal(1),z.literal(7),z.literal(30)]);
const preferenceSchema = z.object({ dismissedUpdateVersion: z.string().max(30).regex(/^(?:|(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*))$/).optional(), activeSiteId: z.string().max(100).optional(), tokenPrefix: z.string().trim().min(1).max(20).regex(/^[a-zA-Z0-9_-]+$/).optional(), theme: z.enum(['light', 'dark', 'system']).optional(), refreshInterval: z.number().int().min(0).max(3600).optional(), menuBarRefreshInterval:z.number().int().min(0).max(3600).optional(),widgetDataSource:z.enum(['api','local']).optional(),widgetPeriod:z.union([z.literal('latest'),z.number().refine(value=>WIDGET_PERIODS.some(option=>option.value===value)).transform(value=>value as WidgetPeriod)]).optional(),widgetInputMode:z.enum(['total','uncached']).optional(),menuBarTotalsRange:barRangeSchema.optional(),menuBarChartRange:barRangeSchema.optional(), menuBarContents:z.array(z.enum(MENU_BAR_SECTION_IDS)).max(MENU_BAR_SECTION_IDS.length).refine(v=>new Set(v).size===v.length).optional(), lowBalanceThreshold: z.number().min(0).max(1e9).optional(), favoriteModels: z.array(z.string().max(200)).max(500).optional(), logColumns: z.array(z.enum(LOG_COLUMN_IDS)).min(1).max(LOG_COLUMN_IDS.length).refine(v => new Set(v).size === v.length).optional(), selection:selectionSchema.optional(),sourceSelection:z.object({sourceId:z.enum(['source.local-sessions','feature.usage']),values:selectionSchema.shape.values}).strict().optional() }).strict();
const configSchema = z.object({ tool: toolSchema, model: z.string().trim().min(1).max(200), group: z.string().min(1).max(100), sonnet: z.string().max(200).optional(), opus: z.string().max(200).optional(), haiku: z.string().max(200).optional(), contextWindow:z.number().int().min(4096).max(10000000).optional(), disableAttributionHeader:z.boolean().optional() }).strict();
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
  win.on('closed',()=>{if(process.platform!=='darwin' && !quitting)app.quit();});
  win.webContents.on('console-message',details=>appLogs.write(details.level==='warning' ? 'warn' : details.level==='error' ? 'error' : details.level==='debug' ? 'debug' : 'info','界面',details.message));
  win.webContents.on('did-fail-load',(_event,code,description)=>appLogs.write('error','页面加载',`${code} ${description}`));
  win.webContents.on('render-process-gone',(_event,details)=>appLogs.write('error','渲染进程',`${details.reason} · ${details.exitCode}`));
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  win.webContents.on('will-navigate', e => e.preventDefault());
  win.webContents.on('will-frame-navigate',event=>{if(!event.isMainFrame && !event.url.startsWith('lumi-extension://'))event.preventDefault();});
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
  const runtimes=new ToolRuntimeService({directory:path.join(data,'tool-installers')});
  const showWindow=()=>{if(!win.isDestroyed()){if(win.isMinimized())win.restore();win.show();win.focus();}};
  const navigate=(page:Page)=>{showWindow();win.webContents.send('lumi:navigate',page);};
  let plugins:Awaited<ReturnType<typeof createBuiltinPlugins>>;
  plugins=await createBuiltinPlugins(store,{resolveCodex:process.env.LUMI_SMOKE==='1' ? async()=>undefined : ()=>runtimes.resolveCodexUsageCommand(),beforeDisable:id=>{if(id==='provider.newapi')configs.invalidatePreviews();},desktop:{
    root,preloadDirectory:__dirname,devUrl:process.env.LUMI_DEV_URL,platform:process.platform,packaged:app.isPackaged,resourcesPath:process.resourcesPath,smoke:process.env.LUMI_SMOKE==='1',
    preferences:()=>store.preferences,identity:()=>{const site=store.activeSite(),secret=store.credentials(site.id);return createHash('sha256').update(JSON.stringify([site.id,site.url,secret.userId,secret.sessionId,secret.accessToken,secret.cookies])).digest('hex');},
    theme:()=>store.preferences.theme==='system' ? nativeTheme.shouldUseDarkColors ? 'dark' : 'light' : store.preferences.theme,
    onThemeChanged:listener=>{nativeTheme.on('updated',listener);return()=>nativeTheme.removeListener('updated',listener);},
    patch:async patch=>{const saved=await store.update(patch);await plugins.notifySurfaces();return saved;},
    setEnabled:async(id,enabled)=>{const statuses=await plugins.setEnabled(id,enabled);if(id==='surface.widget' && !win.isDestroyed())win.webContents.send('lumi:widgetVisibility',enabled);return statuses;},
    navigate,showMain:showWindow,quit:()=>app.quit(),isQuitting:()=>quitting,log:(source,message)=>appLogs.write('warn',source,message),
  }});
  const accountApi=plugins.port('provider.newapi','account.session'),onlineApi=plugins.port('provider.newapi','online.usage'),tokensApi=plugins.port('provider.newapi','tokens.manage');
  const usage=plugins.require('source.local-sessions','localSessions.read');
  const configs = new ConfigService(store, data, undefined, req => plugins.require('provider.newapi','toolCredential.provision').provision(req),tool=>plugins.require('adapter.tool.'+tool,'toolConfig.build'));
  const extensions=new ExtensionHost({directory:path.join(data,'extensions'),roots:process.env.LUMI_SMOKE==='1' ? [] : app.isPackaged ? [path.join(process.resourcesPath,'extensions')] : [path.join(root,'extensions','packages')],settingsDirectory:data,cipher:store.cipher,sdk:await readFile(path.join(root,process.env.LUMI_DEV_URL && !app.isPackaged ? 'public/lumi-extension-sdk.js' : 'dist/lumi-extension-sdk.js')),
    context:()=>{const site=store.activeSite();return {theme:store.preferences.theme==='system' ? nativeTheme.shouldUseDarkColors ? 'dark' : 'light' : store.preferences.theme,locale:'zh-CN',site:{id:site.id,name:site.name,url:site.url}};},
    scope:()=>{const site=store.activeSite(),secret=store.credentials(site.id);return JSON.stringify([site.id,site.url,secret.sessionId,secret.userId,secret.accessToken,secret.cookies,plugins.generation('provider.newapi'),plugins.isEnabled('provider.newapi')]);},
    read:async(method,input)=>{
      if(method==='codex.usage.read')return plugins.require('provider.codex','subscriptionUsage.read').read(input as {force?:boolean});
      if(method==='usage.read'){const usage=await plugins.require('feature.usage','usage.present').loadWidget();return formattedWidget('ready',usage,{enabled:true,viewKey:'extension',theme:store.preferences.theme==='dark' ? 'dark' : 'light'});}
      const usage=await plugins.require('feature.workbench','workbench.present').loadMenu((input as {force?:boolean}).force);return nativeMenuBarState({phase:'ready',usage},menuBarSelection(store.preferences.viewSelections[store.preferences.activeSiteId]),store.preferences.menuBarContents);
    },
  });
  await extensions.start();
  protocol.handle('lumi-extension',request=>{const asset=extensions.asset(request.url);return asset ? new Response(new Uint8Array(asset.body),{headers:{'Content-Type':asset.type,'Content-Security-Policy':asset.csp,'Cache-Control':'no-store','Access-Control-Allow-Origin':'*','X-Content-Type-Options':'nosniff'}}) : new Response('Extension unavailable',{status:404});});
  win.webContents.session.webRequest.onBeforeRequest((details,done)=>{
    const source=details.frame?.url || '';if(!source.startsWith('lumi-extension://')){done({});return;}
    try{const current=new URL(source),target=new URL(details.url);done({cancel:target.protocol!=='data:' && (target.protocol!=='lumi-extension:' || current.host!==target.host)});}catch{done({cancel:true});}
  });
  app.on('before-quit',()=>extensions.dispose());
  const allPluginStatuses=()=>[...plugins.list().map(s=>({...s,origin:'builtin' as const})),...extensions.statuses()];
  app.on('before-quit',()=>{void plugins.dispose().catch(error=>appLogs.write('error','插件',error instanceof Error ? error.message : '插件清理失败。'));});
  const stopConfigProgress=configs.subscribe(progress=>{if(!win.isDestroyed())win.webContents.send('lumi:configProgress',progress);});
  app.on('before-quit',stopConfigProgress);
  const macUpdate=process.platform==='darwin' && process.arch==='arm64';
  const updateEnabled=app.isPackaged && !isolatedData && (macUpdate || process.platform==='win32' && process.arch==='x64') && process.env.LUMI_SMOKE!=='1' && !process.env.PORTABLE_EXECUTABLE_FILE;
  const updates=new UpdateService({version:app.getVersion(),enabled:updateEnabled,target:macUpdate ? 'mac-arm64' : 'windows',engine:updateEnabled ? macUpdate ? macUpdater(path.join(data,'updates')) : await nativeUpdater() : undefined});
  const macMounted=macUpdate && app.getPath('exe').startsWith('/Volumes/');
  const appCache=new AppCacheService({version:app.getVersion(),browserRoots:lumiBrowserCacheRoots(app.getPath('sessionData')),updateRoots:lumiUpdateCacheRoots(data,process.platform,process.env,undefined,isolatedData),protection:()=>({...updates.cacheProtection(),busy:updates.cacheProtection().busy || macMounted}),clearBrowser:async()=>{
    const current=win.webContents.session;const result=await Promise.allSettled([current.clearCache(),current.clearCodeCaches({})]);
    if(result.some(r=>r.status==='rejected'))throw new Error('网页缓存未能全部清理。');
  }});
  let cacheRetry:ReturnType<typeof setTimeout>|undefined;
  const cleanInstalledPackages=async(retries=2)=>{
    try{const result=await updates.withCacheMaintenance(()=>appCache.cleanupInstalled());if(result.freedBytes)appLogs.write('info','缓存',`已清理历史更新安装包 · ${result.freedBytes} bytes`);
      if(result.warnings.length){appLogs.write('warn','缓存',result.warnings.join(' '));if(retries && !quitting){cacheRetry=setTimeout(()=>{void cleanInstalledPackages(retries-1);},30000);cacheRetry.unref();}}
    }catch{appLogs.write('warn','缓存','历史更新缓存暂未能清理，将在下次启动时重试。');}
  };
  // Run after startup paint, without delaying settings/account initialization or scanning browser caches.
  const initialCacheCleanup=updateEnabled && !macMounted ? cleanInstalledPackages() : Promise.resolve();
  const updatePanels=()=>{void plugins.notifySurfaces();};
  if(process.platform==='darwin')Menu.setApplicationMenu(Menu.buildFromTemplate(macMenu({navigate,show:showWindow,refresh:()=>{void plugins.refreshSurfaces(true);win.webContents.send('lumi:refresh');},checkUpdate:()=>{navigate('settings');win.webContents.send('lumi:reviewUpdate');}})));
  let lastNotice = 0;
  const noPayload = z.undefined();
  handle('bootstrap', noPayload, () => ({ preferences: structuredClone(store.preferences), desktop: true, platform:process.platform,version: app.getVersion(), configs: [], secureStorage: store.cipher.available() }));
  handle('listPlugins',noPayload,allPluginStatuses);
  handle('extensionInventory',noPayload,()=>extensions.inventory());
  handle('reloadExtensions',noPayload,()=>extensions.reload());
  handle('openExtensionsDirectory',noPayload,async()=>{const error=await shell.openPath(extensions.inventory().directory);if(error)throw new Error('扩展目录暂未能打开。');});
  handle('extensionRequest',z.object({id:z.string().regex(/^extension\.[a-z][a-z0-9-]{0,39}\.[a-z][a-z0-9-]{0,39}$/),generation:z.number().int().positive(),view:z.string().regex(/^[a-z][a-z0-9.-]{0,79}$/),method:z.enum(['context.read','storage.read','storage.write','secret.set','secret.has','network.read','workbench.read','usage.read','codex.usage.read']),input:z.unknown().optional()}).strict(),input=>extensions.request(input));
  handle('readCodexUsage',z.object({force:z.boolean().optional()}).strict(),input=>plugins.require('provider.codex','subscriptionUsage.read').read(input));
  handle('setPluginEnabled',z.object({id:z.string().min(1).max(100),enabled:z.boolean()}).strict(),async input=>{if(extensions.has(input.id))await extensions.setEnabled(input.id,input.enabled);else await plugins.setEnabled(input.id,input.enabled);if(input.id==='surface.widget')win.webContents.send('lumi:widgetVisibility',input.enabled);return allPluginStatuses();});
  handle('setPluginView',z.object({id:z.string().min(1).max(100),view:z.string().regex(/^[a-z][a-z0-9.-]{0,79}$/),enabled:z.boolean()}).strict(),async input=>{if(extensions.has(input.id))await extensions.setView(input.id,input.view,input.enabled);else await plugins.setView(input.id,input.view,input.enabled);return allPluginStatuses();});
  handle('readCatalog',z.object({siteId:z.string().min(1).max(100),siteUrl:z.string().min(1).max(2000),force:z.boolean().optional()}).strict(),input=>plugins.readCatalog(input));
  handle('appLogs',noPayload,()=>appLogs.snapshot());
  handle('appCache',noPayload,()=>appCache.snapshot());
  handle('clearAppCache',noPayload,()=>updates.withCacheMaintenance(()=>appCache.clear()));
  handle('inspectConfigs',noPayload,()=>configs.inspect());
  handle('toolRuntimes',z.boolean().optional(),force=>runtimes.inspect(force));
  handle('installTool',toolSchema,tool=>plugins.runFeature('feature.tool-config',()=>runtimes.install(tool)));
  handle('saveSite', siteSchema, async input => {const p=await store.saveSite(input as SiteInput);updatePanels();return p;});
  handle('loginInfo', noPayload, () => accountApi.loginInfo());
  handle('login', z.object({ username:z.string().trim().min(1).max(100),password:z.string().min(1).max(1024),turnstileToken:z.string().max(4096).optional() }).strict(), input => plugins.runFeature('provider.newapi',()=>accountApi.login(input)));
  handle('verifyLogin', z.object({challengeId:z.string().uuid(),code:z.string().trim().min(1).max(128)}).strict(), input => plugins.runFeature('provider.newapi',()=>accountApi.verifyLogin(input)));
  let loginPending: Promise<any> | null = null;
  handle('browserLogin', noPayload, () => plugins.runFeature('provider.newapi',async () => { if (loginPending) throw new Error('登录窗口已打开。'); loginPending=browserLogin(win,store,accountApi); try { return await loginPending; } finally { loginPending=null; } }));
  handle('logout', z.string().max(100), id => plugins.runFeature('provider.newapi',async () => {const p=await accountApi.logout(id);updatePanels();return p;}));
  handle('removeSite', z.string().max(100), async id => {const p=await store.removeSite(id);updatePanels();return p;});
  handle('preferences', preferenceSchema.extend({skippedUpdateVersion:preferenceSchema.shape.dismissedUpdateVersion,dataRefreshAnimation:z.enum(DATA_REFRESH_ANIMATIONS).optional(),widgetEnabled:z.boolean().optional(),widgetPosition:z.object({x:z.number().int().min(-100000).max(100000),y:z.number().int().min(-100000).max(100000)}).strict().nullable().optional()}), async patch => {if(patch.widgetEnabled!==undefined)await plugins.setEnabled('surface.widget',patch.widgetEnabled);const p=await store.update(patch);await plugins.notifySurfaces();if(patch.widgetEnabled!==undefined && !win.isDestroyed())win.webContents.send('lumi:widgetVisibility',store.preferences.widgetEnabled);return p;});
  handle('modelHealth',z.string().min(1).max(200),model => onlineApi.modelHealth(model));
  handle('dashboard', z.object({query:statisticsSchema,force:z.boolean().optional()}).strict(), async input => {
    const d = await onlineApi.dashboard(input.query,input.force);
    void plugins.refreshSurfaces();
    if (d.user && currency(d.status).value(d.user.quota) <= store.preferences.lowBalanceThreshold && Date.now() - lastNotice > 3600000) {
      lastNotice = Date.now(); if (Notification.isSupported()) new Notification({ title: 'Lumi · 余额提醒', body: `${store.activeSite().name} 的余额低于提醒阈值，请查看账户。` }).show();
    }
    return d;
  });
  handle('logs', logSchema, q => onlineApi.logs(q as LogQuery));
  handle('tokenUsage',statisticsSchema,query=>onlineApi.tokenUsage(query));
  handle('usageQuality',statisticsSchema,query=>onlineApi.usageQuality(query));
  handle('updateStatus',noPayload,()=>updates.snapshot());
  handle('checkUpdate',noPayload,()=>updates.check());
  handle('downloadUpdate',noPayload,()=>updates.download());
  handle('cancelUpdate',noPayload,()=>updates.cancel());
  handle('showUpdateFile',noPayload,async()=>shell.showItemInFolder(await updates.readyFile()));
  handle('openUpdateFile',noPayload,()=>updates.openMacInstaller(file=>shell.openPath(file),()=>{setImmediate(()=>app.quit());}));
  handle('restartUpdate',noPayload,()=>updates.restart());
  handle('localUsage', z.union([statisticsSchema,z.object({query:statisticsSchema,requestId:z.string().uuid()}).strict()]), input => {
    const identified=typeof input==='object' && 'query' in input;
    return usage.scan(identified ? input.query : input,identified ? progress=>{if(!win.isDestroyed())win.webContents.send('lumi:localUsageProgress',{...progress,requestId:input.requestId});} : undefined);
  });
  handle('localSessionDetails',z.object({sessionId:z.string().regex(/^[a-f0-9]{64}$/),query:statisticsSchema,cursor:z.string().uuid().optional()}).strict(),input=>usage.localSessionDetails(input));
  const snapshotPageSchema=z.object({snapshotId:z.string().uuid(),page:z.number().int().min(1).max(100000000),pageSize:z.number().int().min(1).max(50)}).strict();
  handle('loadLocalSession',z.object({sessionId:z.string().regex(/^[a-f0-9]{64}$/),query:statisticsSchema,requestId:z.string().uuid()}).strict(),input=>usage.loadLocalSession(input,progress=>{if(!win.isDestroyed())win.webContents.send('lumi:localSessionProgress',progress);}));
  handle('localSessionRecords',snapshotPageSchema,input=>usage.localSessionRecords(input));
  handle('localSessionContent',snapshotPageSchema.extend({pageSize:z.number().int().min(1).max(20),recordId:z.string().min(1).max(200).optional()}),input=>usage.localSessionContent(input));
  handle('localSessionRaw',z.object({snapshotId:z.string().uuid(),eventId:z.string().regex(/^[1-9]\d{0,15}$/),offset:z.number().int().min(0).max(Number.MAX_SAFE_INTEGER)}).strict(),input=>usage.localSessionRaw(input));
  handle('releaseLocalSession',z.object({requestId:z.string().uuid().optional(),snapshotId:z.string().uuid().optional()}).strict().refine(value=>!!(value.requestId || value.snapshotId)),input=>usage.releaseLocalSession(input));
  handle('previewConfig', configSchema, req => plugins.runFeature('provider.newapi',()=>configs.preview(req as ConfigRequest)));
  handle('applyConfig', z.string().uuid(), id => plugins.runFeature('provider.newapi',()=>configs.apply(id)));
  handle('backups', noPayload, () => configs.backups());
  handle('restoreBackup', z.string().uuid(), id => plugins.runFeature('feature.tool-config',()=>configs.restore(id)));
  handle('createToken', tokenSchema, input => plugins.runView('provider.newapi','tokens',()=>tokensApi.createToken(input as CreateTokenInput)));
  handle('toggleToken', z.object({ id: z.number().int().positive(), enabled: z.boolean() }).strict(), p => plugins.runView('provider.newapi','tokens',async()=>{configs.invalidateTokenPreviews(p.id);await tokensApi.toggleToken(p.id,p.enabled);}));
  handle('updateToken',tokenSchema.omit({tool:true}).extend({id:z.number().int().positive()}),input=>plugins.runView('provider.newapi','tokens',async()=>{configs.invalidateTokenPreviews(input.id);await tokensApi.updateToken(input as UpdateTokenInput);}));
  handle('getTokenKey', z.number().int().positive(), id => plugins.runView('provider.newapi','tokens',()=>tokensApi.getTokenKey(id)));
  handle('copyTokenKey', z.number().int().positive(), id => plugins.runView('provider.newapi','tokens',async()=>{clipboard.writeText(await tokensApi.getTokenKey(id));}));
  handle('exportLogs', logSchema, async q => {
    const status = await onlineApi.status();
    const rows = await onlineApi.allLogs(q as LogQuery);
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
  app.once('before-quit',()=>{clearTimeout(cacheRetry);clearInterval(updateInterval);unsubscribeUpdates();updates.close();unsubscribeRuntimes();runtimes.close();unsubscribeLogs();});
  if (process.env.LUMI_DEV_URL) await win.loadURL(process.env.LUMI_DEV_URL); else await win.loadFile(path.join(root, 'dist/index.html'));
  appLogs.write('info','启动','工作台页面加载完成。');
  if(updateEnabled){const firstUpdate=setTimeout(()=>{void initialCacheCleanup.then(()=>updates.check());},3000);firstUpdate.unref();}
  if (process.env.LUMI_SMOKE === '1') {
    try {
      const result = await win.webContents.executeJavaScript(String.raw`(async () => {
        await new Promise(resolve => setTimeout(resolve,1500));
        const b = await window.lumi.bootstrap();
        let ipcValidation=false;try { await window.lumi.updatePreferences({theme:'invalid'}); } catch { ipcValidation=true; }
        let toolIpcValidation=false;try { await window.lumi.installTool('untrusted-command'); } catch { toolIpcValidation=true; }
        const pluginStatuses=await window.lumi.listPlugins();
        const catalogInput={siteId:b.preferences.activeSiteId,siteUrl:b.preferences.sites.find(site=>site.id===b.preferences.activeSiteId).url};
        const catalog=await window.lumi.readCatalog(catalogInput);
        let invalidPlugin=false,fixedRejected=false,invalidCatalog=false,invalidView=false;
        try{await window.lumi.setPluginEnabled('../untrusted',true);}catch{invalidPlugin=true;}
        try{await window.lumi.setPluginEnabled('feature.models',false);}catch{fixedRejected=true;}
        try{await window.lumi.readCatalog({...catalogInput,force:'true'});}catch{invalidCatalog=true;}
        try{await window.lumi.setPluginView('provider.codex','tokens',false);}catch{invalidView=true;}
        await window.lumi.setPluginView('provider.newapi','models',false);
        let disabledCatalog=false;try{await window.lumi.readCatalog(catalogInput);}catch{disabledCatalog=true;}
        const savedChild=(await window.lumi.bootstrap()).preferences.pluginViews['provider.newapi'].models===false;
        await window.lumi.setPluginView('provider.newapi','models',true);
        await window.lumi.setPluginEnabled('provider.newapi',false);
        let disabledTokens=false,disabledTools=false;
        try{await window.lumi.getTokenKey(1);}catch(error){disabledTokens=error.message.includes('未启用');}
        try{await window.lumi.previewConfig({tool:'codex',model:'fixture',group:'default'});}catch(error){disabledTools=error.message.includes('未启用');}
        const savedParent=(await window.lumi.bootstrap()).preferences.pluginEnabled['provider.newapi']===false;
        const fixedActive=(await window.lumi.listPlugins()).filter(s=>!s.manifest.configurable).every(s=>s.state==='active');
        const localTools=Array.isArray(await window.lumi.inspectConfigs());
        await window.lumi.setPluginEnabled('provider.newapi',true);
        const restartedCatalog=await window.lumi.readCatalog(catalogInput);
        await window.lumi.setPluginEnabled('surface.tray',false);
        const trayDisabled=(await window.lumi.listPlugins()).some(s=>s.manifest.id==='surface.tray' && s.state==='disabled');
        await window.lumi.setPluginEnabled('surface.tray',true);
        let invalidCodex=false,noCodex=false;try{await window.lumi.readCodexUsage({path:'../auth.json'});}catch{invalidCodex=true;}try{await window.lumi.readCodexUsage({});}catch{noCodex=true;}
        const pluginIpcValid=invalidPlugin && fixedRejected && invalidCatalog && invalidView && disabledCatalog && savedChild && savedParent && disabledTokens && disabledTools && fixedActive && localTools && trayDisabled && invalidCodex && noCodex && !restartedCatalog.loggedIn && !catalog.loggedIn && !('tokens' in catalog) && !('logs' in catalog) && pluginStatuses.filter(s=>s.manifest.configurable && s.origin!=='external').length===4;
        let invalidDetails=false;try{await window.lumi.localSessionDetails({sessionId:'../auth.json',query:1});}catch{invalidDetails=true;}
        const requestId=crypto.randomUUID(),progress=[];
        const stopProgress=window.lumi.onLocalUsageProgress(value=>{if(value.requestId===requestId)progress.push(value);});
        const local=await window.lumi.localUsage(1,requestId);stopProgress();
        let snapshotValid=false;
        if(local.sessions?.length){
          const requestId=crypto.randomUUID(),progress=[];const stop=window.lumi.onLocalSessionProgress(value=>{if(value.requestId===requestId)progress.push(value);});
          const snapshot=await window.lumi.loadLocalSession({sessionId:local.sessions[0].id,query:1,requestId});stop();
          const records=await window.lumi.localSessionRecords({snapshotId:snapshot.snapshotId,page:1,pageSize:50});
          const content=await window.lumi.localSessionContent({snapshotId:snapshot.snapshotId,page:1,pageSize:20});
          const raw=await window.lumi.localSessionRaw({snapshotId:snapshot.snapshotId,eventId:content.items[0].id,offset:0});
          let invalidRaw=false;try{await window.lumi.localSessionRaw({snapshotId:snapshot.snapshotId,eventId:'../auth.json',offset:0});}catch{invalidRaw=true;}
          await window.lumi.releaseLocalSession({snapshotId:snapshot.snapshotId});let released=false;try{await window.lumi.localSessionRecords({snapshotId:snapshot.snapshotId,page:1,pageSize:50});}catch{released=true;}
          snapshotValid=snapshot.total===1 && records.items.length===1 && content.items.some(item=>item.text.includes('本地消息检查')) && raw.totalBytes>0 && snapshot.metadata.title==='桌面会话检查' && progress.some(value=>value.phase==='complete') && invalidRaw && released;
        }
        const changed=await window.lumi.updatePreferences({widgetInputMode:'uncached',widgetPeriod:'latest'});
        const localSessionIpcValid=snapshotValid && invalidDetails && Array.isArray(local.sessions) && progress.some(value=>value.phase==='complete') && changed.widgetInputMode==='uncached' && changed.widgetPeriod==='latest';
        await window.lumi.updatePreferences({widgetInputMode:'total',widgetPeriod:60});
        const cacheBefore=await window.lumi.appCache(),cleared=await window.lumi.clearAppCache();
        const appCacheValid=Number.isFinite(cacheBefore.totalBytes) && cleared.freedBytes>=0 && Array.isArray(cleared.cache.warnings);
        const logs=await window.lumi.appLogs();
        const header=document.querySelector('.titlebar'),sidebar=document.querySelector('.sidebar'),rect=header?.getBoundingClientRect(),side=sidebar?.getBoundingClientRect();
        const platformLayout=!!rect && !!side && (rect.x===0 && Math.abs(rect.width-innerWidth)<1 && side.top>=rect.bottom && parseFloat(getComputedStyle(sidebar).borderTopLeftRadius)>0);
        const titlebarGeometry=platformLayout && rect.y===0 && header.parentElement.classList.contains('desktop-shell') && getComputedStyle(header).getPropertyValue('-webkit-app-region')==='drag' && getComputedStyle(document.querySelector('.titlebar-actions')).getPropertyValue('-webkit-app-region')==='no-drag';
        return {desktop:b.desktop,secureStorage:b.secureStorage,contextIsolation:typeof require === 'undefined',ipcValidation,toolIpcValidation,pluginIpcValid,localSessionIpcValid,appCacheValid,loginVisible:document.body.innerText.includes('登录'),noDemo:!document.body.innerText.includes('演示'),page:document.body.innerText.includes('工作台'),startupLogs:logs.entries.some(e=>e.source==='启动'),platform:b.platform,titlebarGeometry};
      })()`);
      result.startupPaintMs=startupPaintMs;result.startupWindows=BrowserWindow.getAllWindows().length;
      await win.webContents.executeJavaScript(String.raw`(async()=>{
        document.querySelector('.settings-nav').click();
        const until=async(fn)=>{const end=performance.now()+6000;while(!fn()){if(performance.now()>end)throw new Error('Extension smoke view timed out');await new Promise(r=>setTimeout(r,20));}};
        await until(()=>document.querySelector('[aria-label="启用工作台便笺"]'));
        document.querySelector('[aria-label="启用工作台便笺"]').click();
        await until(()=>document.querySelector('iframe[src^="lumi-extension:"]'));
      })()`);
      let externalFrame:Electron.WebFrameMain|undefined;
      for(let attempt=0;attempt<100;attempt++){externalFrame=win.webContents.mainFrame.frames.find(frame=>frame.url.startsWith('lumi-extension://'));if(externalFrame && await externalFrame.executeJavaScript('!!window.lumiExtension').catch(()=>false))break;await new Promise(r=>setTimeout(r,25));}
      if(!externalFrame)throw new Error('External extension frame failed to load');
      const externalIsolation=await externalFrame.executeJavaScript(String.raw`(async()=>{
        await lumiExtension.ready;let parentDenied=false,networkDenied=false;try{void parent.document.body;}catch{parentDenied=true;}try{await lumiExtension.network.read({url:'https://fixture.invalid'});}catch{networkDenied=true;}
        await lumiExtension.storage.write('smoke','independent');const value=await lumiExtension.storage.read('smoke');
        return parentDenied && networkDenied && typeof require==='undefined' && typeof window.lumi==='undefined' && value==='independent';
      })()`);
      const oldGeneration=extensions.statuses()[0].generation!;
      await win.webContents.executeJavaScript(String.raw`(async()=>{document.querySelector('[aria-label="启用工作台便笺"]').click();const end=performance.now()+4000;while(document.querySelector('iframe[src^="lumi-extension:"]')){if(performance.now()>end)throw new Error('Revoked extension frame retained');await new Promise(r=>setTimeout(r,20));}})()`);
      result.externalPluginValid=externalIsolation && extensions.statuses()[0].state==='disabled' && !extensions.asset('lumi-extension://extension.lumi.notes/'+oldGeneration+'/index.html');
      await plugins.setEnabled('surface.widget',true);
      result.widgetPanel=await plugins.require('surface.widget','surface.control').smoke();result.widgetPanelValid=Object.values(result.widgetPanel).every(Boolean);
      await plugins.setEnabled('surface.widget',false);
      const widgetReleased=!plugins.isEnabled('surface.widget') && BrowserWindow.getAllWindows().length===1;
      await plugins.setEnabled('surface.widget',true);
      const restartedWidget=await plugins.require('surface.widget','surface.control').smoke();
      await plugins.setEnabled('surface.widget',false);
      const buttons=process.platform==='darwin' ? win.getWindowButtonPosition() : null;
      result.nativeMacControls=process.platform!=='darwin' || buttons?.x===24 && buttons?.y===22 && result.titlebarGeometry && Menu.getApplicationMenu()!==null;
      Object.assign(result,await plugins.require('surface.tray','surface.control').smoke());
      await plugins.setEnabled('surface.tray',false);
      const trayReleased=!plugins.isEnabled('surface.tray') && BrowserWindow.getAllWindows().length===1;
      await plugins.setEnabled('surface.tray',true);
      const restartedTray=await plugins.require('surface.tray','surface.control').smoke();
      result.surfaceLifecycleValid=widgetReleased && trayReleased && Object.values(restartedWidget).every(Boolean) && restartedTray.nativeWindowsTray===true && restartedTray.nativeStatusCard===true && BrowserWindow.getAllWindows().length===1;
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
  app.on('window-all-closed', () => {if(process.platform!=='darwin'){app.quit();} });
}
