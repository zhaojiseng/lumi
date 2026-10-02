import {useRef} from 'react';
import { ComposedChart, Line, Area, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, PieChart, Pie, Cell } from 'recharts';
import { compact } from '../../shared/utils';
import {useInterfaceOverlayTarget} from '../host/overlay';
import {TREND_COLORS} from '../../shared/trends';
const COLORS = TREND_COLORS.slice(0,6);
export interface ChartLine { id: string; name: string; color: string; }
export interface ChartRow { tooltipLabel?: string; label: string; cost: number; tokens: number; requests: number; cacheHitRate?:number|null; values?: Record<string,number|null>; }
export function TrendChart({data,metric='cost',symbol='',series=[]}:{data:ChartRow[];metric?:'cost'|'tokens'|'requests'|'cacheHitRate';symbol?:string;series?:ChartLine[]}) {
  const rate=metric==='cacheHitRate',metricName=metric==='cost' ? '消费金额' : metric==='tokens' ? 'Tokens' : rate ? '缓存命中率' : '请求次数';
  return <div className="trend-chart"><ResponsiveContainer width="100%" height="100%"><ComposedChart data={data} margin={{top:14,right:10,left:-14,bottom:0}}>
    <CartesianGrid stroke="var(--chart-grid)" strokeDasharray="3 6" vertical={false}/>
    <XAxis dataKey="label" axisLine={false} tickLine={false} tick={{fontSize:11,fill:'var(--text-muted)'}} dy={10} minTickGap={25} interval="preserveStartEnd"/>
    <YAxis axisLine={false} tickLine={false} tick={{fontSize:11,fill:'var(--text-muted)'}} domain={rate ? [0,1] : [0,'auto']} tickFormatter={v=>rate ? (v*100).toFixed(0)+'%' : metric==='cost' ? `${symbol}${v}` : compact(v)} width={64} tickCount={4}/>
    <Tooltip cursor={{stroke:'var(--text-muted)',strokeDasharray:'3 4'}} contentStyle={{background:'var(--panel)',border:'1px solid var(--border)',borderRadius:12,boxShadow:'none',fontSize:12,color:'var(--text)'}} itemStyle={{color:'var(--text)'}} formatter={(v:any,name:any)=>[v==null ? '—' : rate ? (Number(v)*100).toFixed(1)+'%' : metric==='cost' ? `${symbol}${Number(v).toFixed(3)}` : compact(Number(v)),series.length ? name : metricName]} labelFormatter={(label,payload)=>payload?.[0]?.payload?.tooltipLabel || label} labelStyle={{color:'var(--text-muted)',marginBottom:6}}/>
    {series.length ? series.map(line=><Line key={line.id} name={line.name} type={rate ? 'linear' : 'monotone'} dataKey={(row:ChartRow)=>row.values?.[line.id] ?? (rate ? null : 0)} stroke={line.color} strokeWidth={2} connectNulls={false} dot={rate || data.length===1 ? {r:2} : false} activeDot={{r:4,stroke:'var(--panel)',strokeWidth:2}} isAnimationActive={false}/>) : rate ? <Line name={metricName} type="linear" dataKey={metric} stroke="var(--accent)" strokeWidth={2.5} connectNulls={false} dot={{r:2}} activeDot={{r:4}} isAnimationActive={false}/> : <Area name={metricName} type="monotone" dataKey={metric} stroke="var(--accent)" strokeWidth={2.5} fill="color-mix(in srgb, var(--accent) 14%, var(--panel))" dot={data.length===1 ? {r:4,fill:'var(--accent)'} : false} activeDot={{r:5,fill:'var(--accent)',stroke:'var(--panel)',strokeWidth:3}} isAnimationActive={false}/>}
  </ComposedChart></ResponsiveContainer></div>;
}
export function ModelDonut({ data, total, symbol }: { data: { name: string; value: number }[]; total: string; symbol: string }) {
  const host=useRef<HTMLDivElement>(null),portal=useInterfaceOverlayTarget();
  return <><div className="donut-wrap"><div className="donut-chart" ref={host}><ResponsiveContainer width="100%" height={166}><PieChart margin={{top:0,right:0,bottom:0,left:0}}><Pie cx="50%" cy="50%" data={data} isAnimationActive={false} dataKey="value" innerRadius={59} outerRadius={74} paddingAngle={data.length > 1 ? 1 : 0} minAngle={Math.max(0, Math.min(5, 360 / data.length - 1))} cornerRadius={2} stroke="none" startAngle={90} endAngle={-270}>{data.map((_, i) => <Cell key={i} fill={COLORS[i % COLORS.length]}/>)}</Pie><Tooltip portal={portal || undefined} wrapperStyle={{position:'fixed',top:0,left:0,zIndex:90,pointerEvents:'none'}} content={({active,payload,coordinate})=>{
    const rect=host.current?.getBoundingClientRect(),item=payload?.[0];
    if(!active || !rect || !item)return null;
    const left=Math.max(8,Math.min(rect.left+(coordinate?.x || 0)+12,window.innerWidth-252));
    const top=Math.max(8,Math.min(rect.top+(coordinate?.y || 0)+12,window.innerHeight-84));
    return <div className="donut-tooltip" role="tooltip" style={{position:'fixed',left,top,maxWidth:240,padding:'10px 13px',background:'var(--panel)',border:'1px solid var(--border)',borderRadius:12,fontSize:12,color:'var(--text)',overflowWrap:'anywhere'}}><strong>{item.name}</strong><div>{symbol}{Number(item.value).toFixed(2)}</div></div>;
  }}/></PieChart></ResponsiveContainer><div className="donut-label"><span>区间总消耗</span><strong>{total}</strong></div></div></div><div className="model-legend">{data.slice(0, 3).map((m, i) => <div key={m.name}><span className="legend-dot" style={{ background: COLORS[i] }}/><span className="legend-name" title={m.name}>{m.name}</span><span>{data.reduce((s, d) => s + d.value, 0) ? Math.round(m.value / data.reduce((s, d) => s + d.value, 0) * 100) : 0}%</span></div>)}</div></>;
}
