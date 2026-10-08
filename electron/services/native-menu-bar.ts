import {spawn,type ChildProcessWithoutNullStreams} from 'node:child_process';
import {createInterface} from 'node:readline';
import type {MenuBarSelection,Page} from '../../shared/types';
import type {NativeMenuBarState} from '../../shared/menu-bar';

export type NativeMenuEvent={type:'opened'|'closed'|'refresh'|'quit'}|{type:'navigate';page:Page}|{type:'select';selection:MenuBarSelection};
/** Native process can emit a small allowlist of UI actions, never commands or paths. */
export function parseNativeMenuEvent(line:string):NativeMenuEvent|null {
  if(line.length>4096)return null;
  try{const e=JSON.parse(line);if(!e || typeof e!=='object')return null;
    if(['opened','closed','refresh','quit'].includes(e.type) && Object.keys(e).length===1)return e;
    if(e.type==='navigate' && ['overview','usage','settings'].includes(e.page) && Object.keys(e).length===2)return e;
    if(e.type==='select' && [1,7,30].includes(e.days) && ['all','codex','claude'].includes(e.tool) && Object.keys(e).length===3)return {type:'select',selection:{days:e.days,tool:e.tool}};
  }catch{}return null;
}
export class NativeMenuBar {
  private child?:ChildProcessWithoutNullStreams;private closed=false;private queued?:NativeMenuBarState;
  constructor(private options:{executable:string;state():NativeMenuBarState;event(e:NativeMenuEvent):void;failed?():void;}){}
  async start(smoke=false):Promise<boolean>{
    if(this.child)return true;if(this.closed)return false;
    const env=Object.fromEntries(['HOME','USER','LOGNAME','LANG','LC_ALL','TMPDIR','__CF_USER_TEXT_ENCODING'].filter(k=>process.env[k]).map(k=>[k,process.env[k]!]));
    const child=spawn(this.options.executable,smoke ? ['--smoke'] : [],{stdio:['pipe','pipe','pipe'],env,windowsHide:true});this.child=child;
    child.stderr.on('data',()=>{});child.stdin.on('error',()=>{});
    return new Promise<boolean>(resolve=>{
      let ready=false,finished=false;const finish=(ok:boolean)=>{if(finished)return;finished=true;clearTimeout(timer);if(!ok){this.child=undefined;child.kill();}resolve(ok);};
      const reader=createInterface({input:child.stdout});
      reader.on('line',line=>{
        if(line.length>4096)return;
        let info:any;try{info=JSON.parse(line);}catch{return;}
        if(info.type==='ready' && info.schemaVersion===1 && info.nativeCard===true && info.nativeChart===true && info.nativeSelectors===true && info.equalSelectorHeight===true && info.lumiIcon===true && info.layoutValid===true){ready=true;this.update();if(!smoke)finish(true);return;}
        if(smoke && ready && info.type==='applied' && info.schemaVersion===1){finish(info.layoutValid===true && info.typographyValid===true);return;}
        const event=parseNativeMenuEvent(line);if(ready && !this.closed && event)this.options.event(event);
      });
      child.once('error',()=>finish(false));child.once('exit',()=>{reader.close();if(this.child===child)this.child=undefined;if(!finished)finish(false);else if(!this.closed && !smoke)this.options.failed?.();});
      const timer=setTimeout(()=>finish(false),8000);timer.unref();
    });
  }
  update(){
    const child=this.child;if(!child || this.closed || child.stdin.destroyed)return;
    const state=this.options.state();
    if(child.stdin.writableNeedDrain){this.queued=state;return;}
    if(!child.stdin.write(JSON.stringify(state)+'\n'))child.stdin.once('drain',()=>{if(this.queued){this.queued=undefined;this.update();}});
  }
  close(){this.closed=true;this.queued=undefined;const child=this.child;this.child=undefined;if(child){child.stdin.end();const timer=setTimeout(()=>child.kill(),1000);timer.unref();}}
}
