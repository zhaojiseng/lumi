import {useEffect,useRef,useState} from 'react';
import {useApp} from '../context';
import {usePluginSettings} from './plugins';
import {Button,Select} from '../components/ui';
import {BACKGROUND_INTERFACE_ID,MAX_BACKGROUND_LENGTH,type BackgroundFit} from '../../shared/interface-styles';
import {DEFAULT_INTERFACE_ID} from '../../shared/contracts/interface';
import './background.css';

export const backgroundFit={stretch:'fill',contain:'contain',cover:'cover',natural:'none'} as const;
export function interfaceCandidates(preferences:{defaultInterfaceEnabled?:boolean},statuses:readonly {manifest:{id:string};state:string}[],interfaces:readonly {manifest:{id:string}}[]){
  return [{id:DEFAULT_INTERFACE_ID,enabled:preferences.defaultInterfaceEnabled!==false,priority:0},{id:BACKGROUND_INTERFACE_ID,enabled:statuses.some(status=>status.manifest.id===BACKGROUND_INTERFACE_ID && status.state==='active'),priority:200},...interfaces.map(plugin=>({id:plugin.manifest.id,enabled:statuses.some(status=>status.manifest.id===plugin.manifest.id && status.state==='active'),priority:100}))];
}
export function UserBackgroundLayer(){
  const {preferences}=useApp(),{statuses=[]}=usePluginSettings();
  const enabled=statuses.some(status=>status.manifest.id===BACKGROUND_INTERFACE_ID && status.state==='active');
  const background=preferences.background;
  if(!enabled || !background?.image)return null;
  return <div className="user-background-layer" aria-hidden="true"><img src={background.image} alt="" draggable={false} style={{objectFit:backgroundFit[background.fit]}}/></div>;
}
export function BackgroundSettings(){
  const {preferences,updatePreferences,toast}=useApp(),[busy,setBusy]=useState(false),input=useRef<HTMLInputElement>(null),version=useRef(0),current=useRef(preferences.background);current.current=preferences.background;
  useEffect(()=>()=>{++version.current;},[]);
  const save=(patch:Partial<typeof preferences.background>)=>updatePreferences({background:{...current.current,...patch}}).catch(error=>toast(error.message,'error'));
  async function choose(file:File){
    const request=++version.current;setBusy(true);
    let bitmap:ImageBitmap|undefined;
    try{
      if(!['image/png','image/jpeg','image/webp'].includes(file.type) || file.size>8*1024*1024)throw new Error('请选择不超过 8 MB 的 PNG、JPEG 或 WebP 图片。');
      bitmap=await createImageBitmap(file);
      const scale=Math.min(1,2048/Math.max(bitmap.width,bitmap.height)),canvas=document.createElement('canvas');
      canvas.width=Math.max(1,Math.round(bitmap.width*scale));canvas.height=Math.max(1,Math.round(bitmap.height*scale));
      const context=canvas.getContext('2d');if(!context)throw new Error('无法处理这张图片。');context.drawImage(bitmap,0,0,canvas.width,canvas.height);
      const image=canvas.toDataURL('image/webp',.9);if(image.length>MAX_BACKGROUND_LENGTH)throw new Error('图片处理后仍过大，请选择尺寸更小的图片。');
      if(request===version.current)await save({image,name:file.name.slice(0,120)});
    }catch(error){if(request===version.current)toast(error instanceof Error ? error.message : '图片无法读取。','error');}
    finally{bitmap?.close();if(request===version.current)setBusy(false);}
  }
  const background=preferences.background;
  return <div className="background-settings">
    <p className="muted">图片仅保存在本机。启用后叠加到当前界面风格，保留其布局与外观设置，不参与风格替换。</p>
    <input ref={input} type="file" hidden accept="image/png,image/jpeg,image/webp" aria-label="选择背景图片" onChange={event=>{const file=event.target.files?.[0];event.target.value='';if(file)void choose(file);}}/>
    <div className="background-actions"><Button busy={busy} onClick={()=>input.current?.click()}>选择本地图片</Button><Button disabled={busy || !background.image} onClick={()=>{++version.current;void save({image:'',name:''});}}>移除背景</Button><span title={background.name}>{background.name || '尚未选择图片'}</span></div>
    <div className="setting-control"><strong>背景显示方式</strong><Select label="背景显示方式" value={background.fit} onChange={fit=>void save({fit:fit as BackgroundFit})}><option value="stretch">自动拉伸</option><option value="contain">自动缩放（完整显示）</option><option value="cover">自动裁切（填满窗口）</option><option value="natural">原始尺寸（居中）</option></Select></div>
    {background.image && <div className="background-preview" aria-label="背景预览"><img src={background.image} alt="所选背景预览" style={{objectFit:backgroundFit[background.fit]}}/></div>}
  </div>;
}
