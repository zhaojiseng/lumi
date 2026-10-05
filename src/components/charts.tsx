import {useLayoutEffect,useRef,useState,type RefObject} from 'react';
import { ComposedChart, Line, Area, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, PieChart, Pie, Cell } from 'recharts';
import { compact } from '../../shared/utils';
import {useInterfaceOverlayTarget} from '../host/overlay';
import {TREND_COLORS} from '../../shared/trends';
import type {TrendMetric} from '../../shared/types';
const COLORS = TREND_COLORS.slice(0,6);
export interface ChartLine { id: string; name: string; color: string; }
export interface ChartRow { tooltipLabel?: string; label: string; cost: number; tokens: number; requests: number; cacheHitRate?:number|null; speed?:number|null; netSpeed?:number|null; values?: Record<string,number|null>; }
export function TrendChart({data,metric='cost',symbol='',series=[]}:{data:ChartRow[];metric?:TrendMetric;symbol?:string;series?:ChartLine[]}) {
  const rate=metric==='cacheHitRate',speed=metric==='speed' || metric==='netSpeed',observed=rate || speed,metricName=metric==='cost' ? '消费金额' : metric==='tokens' ? 'Tokens' : rate ? '缓存命中率' : metric==='speed' ? '速率' : metric==='netSpeed' ? '净速率' : '请求次数';
  return <div className="trend-chart"><ResponsiveContainer width="100%" height="100%"><ComposedChart data={data} margin={{top:14,right:10,left:-14,bottom:0}}>
    <CartesianGrid stroke="var(--chart-grid)" strokeDasharray="3 6" vertical={false}/>
    <XAxis dataKey="label" axisLine={false} tickLine={false} tick={{fontSize:11,fill:'var(--text-muted)'}} dy={10} minTickGap={25} interval="preserveStartEnd"/>
    <YAxis axisLine={false} tickLine={false} tick={{fontSize:11,fill:'var(--text-muted)'}} domain={rate ? [0,1] : [0,'auto']} tickFormatter={v=>rate ? (v*100).toFixed(0)+'%' : speed ? compact(v)+' t/s' : metric==='cost' ? `${symbol}${v}` : compact(v)} width={speed ? 76 : 64} tickCount={4}/>
    <Tooltip cursor={{stroke:'var(--text-muted)',strokeDasharray:'3 4'}} contentStyle={{background:'var(--panel)',border:'1px solid var(--border)',borderRadius:12,boxShadow:'none',fontSize:12,color:'var(--text)'}} itemStyle={{color:'var(--text)'}} formatter={(v:any,name:any)=>[v==null ? '—' : rate ? (Number(v)*100).toFixed(1)+'%' : speed ? Number(v).toLocaleString('en-US',{maximumFractionDigits:1})+' t/s' : metric==='cost' ? `${symbol}${Number(v).toFixed(3)}` : compact(Number(v)),series.length ? name : metricName]} labelFormatter={(label,payload)=>payload?.[0]?.payload?.tooltipLabel || label} labelStyle={{color:'var(--text-muted)',marginBottom:6}}/>
    {series.length ? series.map(line=><Line key={line.id} name={line.name} type={observed ? 'linear' : 'monotone'} dataKey={(row:ChartRow)=>row.values?.[line.id] ?? (observed ? null : 0)} stroke={line.color} strokeWidth={2} connectNulls={false} dot={observed || data.length===1 ? {r:2} : false} activeDot={{r:4,stroke:'var(--panel)',strokeWidth:2}} isAnimationActive={false}/>) : observed ? <Line name={metricName} type="linear" dataKey={metric} stroke="var(--accent)" strokeWidth={2.5} connectNulls={false} dot={{r:2}} activeDot={{r:4}} isAnimationActive={false}/> : <Area name={metricName} type="monotone" dataKey={metric} stroke="var(--accent)" strokeWidth={2.5} fill="color-mix(in srgb, var(--accent) 14%, var(--panel))" dot={data.length===1 ? {r:4,fill:'var(--accent)'} : false} activeDot={{r:5,fill:'var(--accent)',stroke:'var(--panel)',strokeWidth:3}} isAnimationActive={false}/>}
  </ComposedChart></ResponsiveContainer></div>;
}
interface PointerPosition {x:number;y:number;}
function DonutTooltip({host,pointer,coordinate,name,value,symbol}:{host:RefObject<HTMLDivElement|null>;pointer:PointerPosition|null;coordinate:PointerPosition|undefined;name:string;value:number;symbol:string;}){
  const element=useRef<HTMLDivElement>(null),[position,setPosition]=useState<PointerPosition>({x:8,y:8}),[viewport,setViewport]=useState(0);
  useLayoutEffect(()=>{
    const reposition=()=>setViewport(value=>value+1);
    window.addEventListener('resize',reposition);window.addEventListener('scroll',reposition,true);
    return()=>{window.removeEventListener('resize',reposition);window.removeEventListener('scroll',reposition,true);};
  },[]);
  useLayoutEffect(()=>{
    const chart=host.current?.getBoundingClientRect(),bounds=element.current?.getBoundingClientRect();
    if(!chart || !bounds)return;
    // Recharts anchors a pie tooltip to the sector center. Pointer coordinates follow the cursor;
    // the sector coordinate remains the fallback for keyboard navigation.
    const x=pointer?.x ?? chart.left+(coordinate?.x || 0),y=pointer?.y ?? chart.top+(coordinate?.y || 0);
    const place=(anchor:number,size:number,limit:number)=>Math.max(8,Math.min(anchor+12+size<=limit-8 ? anchor+12 : anchor-size-12,limit-size-8));
    setPosition(current=>{const next={x:place(x,bounds.width,window.innerWidth),y:place(y,bounds.height,window.innerHeight)};return current.x===next.x && current.y===next.y ? current : next;});
  },[host,pointer?.x,pointer?.y,coordinate?.x,coordinate?.y,name,value,symbol,viewport]);
  return <div ref={element} className="donut-tooltip" role="tooltip" style={{position:'fixed',left:position.x,top:position.y,width:'max-content',maxWidth:'min(240px, calc(100vw - 16px))',maxHeight:'calc(100vh - 16px)',boxSizing:'border-box',padding:'10px 13px',background:'var(--panel)',border:'1px solid var(--border)',borderRadius:12,fontSize:12,color:'var(--text)',overflowWrap:'anywhere',overflow:'hidden'}}><strong>{name}</strong><div>{symbol}{value.toFixed(2)}</div></div>;
}
export function ModelDonut({ data, total, symbol }: { data: { name: string; value: number }[]; total: string; symbol: string }) {
  const host=useRef<HTMLDivElement>(null),portal=useInterfaceOverlayTarget(),[pointer,setPointer]=useState<PointerPosition|null>(null),[keyboard,setKeyboard]=useState(false);
  return <><div className="donut-wrap"><div className="donut-chart" ref={host} onPointerMoveCapture={event=>{setPointer({x:event.clientX,y:event.clientY});setKeyboard(false);}} onPointerLeave={()=>{setPointer(null);setKeyboard(false);}} onKeyDownCapture={()=>{setPointer(null);setKeyboard(true);}} onFocusCapture={()=>{setPointer(null);setKeyboard(true);}} onBlurCapture={()=>setKeyboard(false)}><ResponsiveContainer width="100%" height={166}><PieChart margin={{top:0,right:0,bottom:0,left:0}}><Pie cx="50%" cy="50%" data={data} isAnimationActive={false} dataKey="value" innerRadius={59} outerRadius={74} paddingAngle={data.length > 1 ? 1 : 0} minAngle={Math.max(0, Math.min(5, 360 / data.length - 1))} cornerRadius={2} stroke="none" startAngle={90} endAngle={-270}>{data.map((_, i) => <Cell key={i} fill={COLORS[i % COLORS.length]}/>)}</Pie><Tooltip portal={portal || undefined} isAnimationActive={false} wrapperStyle={{position:'fixed',top:0,left:0,zIndex:90,pointerEvents:'none'}} content={({active,payload,coordinate})=>{
    const item=payload?.[0];
    return active && item && (pointer || keyboard) ? <DonutTooltip host={host} pointer={pointer} coordinate={coordinate} name={String(item.name)} value={Number(item.value)} symbol={symbol}/> : null;
  }}/></PieChart></ResponsiveContainer><div className="donut-label"><span>区间总消耗</span><strong>{total}</strong></div></div></div><div className="model-legend">{data.slice(0, 3).map((m, i) => <div key={m.name}><span className="legend-dot" style={{ background: COLORS[i] }}/><span className="legend-name" title={m.name}>{m.name}</span><span>{data.reduce((s, d) => s + d.value, 0) ? Math.round(m.value / data.reduce((s, d) => s + d.value, 0) * 100) : 0}%</span></div>)}</div></>;
}
