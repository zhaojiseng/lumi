import {useContext,type KeyboardEvent} from 'react';
import {Check,Sun,Moon,Laptop} from 'lucide-react';
import {SectionHeading,SegmentedSwitch,Select,Button} from '../components/ui';
import {FONT_FAMILIES,MIN_FONT_SIZE,MAX_FONT_SIZE,DEFAULT_TYPOGRAPHY,normalizeTypography,type FontFamily} from '../../shared/typography';
import './typography-settings.css';
import {useApp} from '../context';
import {usePluginSettings} from './plugins';
import {InterfaceErrorContext} from './interface-settings';
import {resolveInterfaceAppearance} from '../../shared/interface-appearance';
import {useResolvedTheme} from '../../plugins/theme.default/renderer';
import {AppearancePreview} from './appearance-preview';

function radioKey(event:KeyboardEvent<HTMLDivElement>){
  if(!['ArrowLeft','ArrowRight','ArrowUp','ArrowDown','Home','End'].includes(event.key))return;
  const buttons=[...event.currentTarget.querySelectorAll<HTMLButtonElement>('[role=radio]')],index=buttons.indexOf(document.activeElement as HTMLButtonElement);if(index<0)return;
  event.preventDefault();const next=event.key==='Home' ? 0 : event.key==='End' ? buttons.length-1 : (index+(['ArrowLeft','ArrowUp'].includes(event.key) ? -1 : 1)+buttons.length)%buttons.length;
  buttons[next].focus();buttons[next].click();
}

export function AppearanceSettings(){
  const {preferences,bootstrap,updatePreferences,toast}=useApp(),{extensions}=usePluginSettings(),failure=useContext(InterfaceErrorContext),system=useResolvedTheme('system');
  const style=failure ? undefined : extensions?.interfaceStyle,groups=style?.appearanceGroups || [],values=resolveInterfaceAppearance(groups,style && preferences.interfaceSelections?.[style.id]);
  const save=(patch:Parameters<typeof updatePreferences>[0])=>{void updatePreferences(patch).catch(error=>toast(error.message,'error'));};
  const typography=normalizeTypography(preferences);
  return <section className="surface panel appearance-settings"><SectionHeading title="外观" sub={style ? extensions?.plugins.find(plugin=>plugin.manifest.id===style.id)?.manifest.name : '默认界面'}/>
    <div className="theme-options" role="radiogroup" aria-label="颜色模式" onKeyDown={radioKey}>{([['light',Sun,'浅色'],['dark',Moon,'深色'],['system',Laptop,'跟随系统']] as const).map(([theme,Icon,label])=><button type="button" role="radio" aria-checked={preferences.theme===theme} tabIndex={preferences.theme===theme ? 0 : -1} key={theme} className={preferences.theme===theme ? 'active' : ''} onClick={()=>save({theme})}><AppearancePreview style={style} mode={theme==='system' ? system : theme} values={values} platform={bootstrap.platform || 'browser'}/><span><Icon size={14}/>{label}{preferences.theme===theme && <Check size={13}/>}</span></button>)}</div>
    {groups.map(group=><fieldset className="appearance-group" key={style!.id+':'+group.id}><legend>{group.title}</legend><SegmentedSwitch label={group.title} role="radiogroup" className="appearance-selector">{group.options.map(option=><button type="button" role="radio" aria-checked={values[group.id]===option.id} tabIndex={values[group.id]===option.id ? 0 : -1} className={values[group.id]===option.id ? 'active' : ''} key={option.id} onClick={()=>save({interfaceSelection:{interfaceId:style!.id,values:{[group.id]:option.id}}})}>{option.title}</button>)}</SegmentedSwitch></fieldset>)}
    <fieldset className="appearance-group typography-settings"><legend>全局字体</legend>
      <div className="typography-controls"><label>字体大小<Select label="字体大小" value={String(typography.fontSize)} onChange={value=>save({fontSize:Number(value)})}>{Array.from({length:MAX_FONT_SIZE-MIN_FONT_SIZE+1},(_,i)=>i+MIN_FONT_SIZE).map(size=><option key={size} value={size}>{size}px{size===13 ? '（默认）' : ''}</option>)}</Select></label>
      <label>字体样式<Select label="字体样式" value={typography.fontFamily} onChange={value=>save({fontFamily:value as FontFamily})}>{Object.entries(FONT_FAMILIES).map(([id,font])=><option key={id} value={id}>{font.label}</option>)}</Select></label>
      <Button onClick={()=>save(DEFAULT_TYPOGRAPHY)} disabled={typography.fontSize===13 && typography.fontFamily==='system'}>恢复默认字体</Button></div>
      <div className="typography-preview" aria-label="字体预览"><strong>字体预览 · Lumi</strong><p>让文字更易阅读，让工作台更顺手。Aa 0123456789</p><code>const message = "Hello, Lumi";</code></div>
      <p className="muted typography-help">应用于软件全部页面、弹窗、图表、托盘面板、悬浮窗及采用宿主 UI 的插件，即时生效并自动保存。标题与正文按比例调整；代码保留等宽字体。缺失字体使用系统回退。</p>
    </fieldset>
  </section>;
}
