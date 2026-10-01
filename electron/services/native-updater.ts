import type {UpdateEngine,NativeUpdateInfo} from './updates';

/** Use electron-updater's public NSIS lifecycle; no custom file replacement or installer command. */
export async function nativeUpdater():Promise<UpdateEngine> {
  const {NsisUpdater,CancellationToken}=await import('electron-updater');
  const updater=new NsisUpdater({provider:'github',owner:'zhaojiseng',repo:'lumi',private:false,releaseType:'release'});
  updater.autoDownload=false;updater.autoInstallOnAppQuit=false;updater.autoRunAppAfterInstall=true;
  updater.allowPrerelease=false;updater.allowDowngrade=false;updater.disableWebInstaller=true;updater.logger=null;
  updater.requestHeaders={'User-Agent':'Lumi updater','Cache-Control':'no-cache'};
  updater.on('error',()=>{});
  return {
    check:async()=>{const result=await updater.checkForUpdates();return result?.updateInfo as NativeUpdateInfo || null;},
    download:async(signal,progress)=>{
      const token=new CancellationToken(),cancel=()=>token.cancel(),receive=(p:{transferred:number;total:number})=>progress(p.transferred,p.total);
      signal.addEventListener('abort',cancel,{once:true});if(signal.aborted)cancel();updater.on('download-progress',receive);
      try{const files=await updater.downloadUpdate(token);if(files.length!==1)throw new Error('更新下载结果无效。');return files[0];}
      finally{signal.removeEventListener('abort',cancel);updater.removeListener('download-progress',receive);}
    },
    install:()=>updater.quitAndInstall(true,true),
    onError:listener=>{updater.on('error',listener);return()=>{updater.removeListener('error',listener);};},
  };
}
