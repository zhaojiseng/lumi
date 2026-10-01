import {useId,useMemo} from 'react';
import {Cpu} from 'lucide-react';
import codex from '@lobehub/icons-static-svg/icons/codex.svg?raw';
import openai from '@lobehub/icons-static-svg/icons/openai.svg?raw';
import claude from '@lobehub/icons-static-svg/icons/claude.svg?raw';
import google from '@lobehub/icons-static-svg/icons/google-color.svg?raw';
import gemini from '@lobehub/icons-static-svg/icons/gemini-color.svg?raw';
import deepseek from '@lobehub/icons-static-svg/icons/deepseek-color.svg?raw';
import qwen from '@lobehub/icons-static-svg/icons/qwen-color.svg?raw';
import kimi from '@lobehub/icons-static-svg/icons/kimi.svg?raw';
import zhipu from '@lobehub/icons-static-svg/icons/zhipu-color.svg?raw';
import zai from '@lobehub/icons-static-svg/icons/zai.svg?raw';
import minimax from '@lobehub/icons-static-svg/icons/minimax-color.svg?raw';
import doubao from '@lobehub/icons-static-svg/icons/doubao-color.svg?raw';
import grok from '@lobehub/icons-static-svg/icons/grok.svg?raw';
import mistral from '@lobehub/icons-static-svg/icons/mistral-color.svg?raw';
import meta from '@lobehub/icons-static-svg/icons/meta-color.svg?raw';
import hunyuan from '@lobehub/icons-static-svg/icons/hunyuan-color.svg?raw';
import baidu from '@lobehub/icons-static-svg/icons/baidu-color.svg?raw';
import cohere from '@lobehub/icons-static-svg/icons/cohere-color.svg?raw';
import yi from '@lobehub/icons-static-svg/icons/yi-color.svg?raw';
import nvidia from '@lobehub/icons-static-svg/icons/nvidia-color.svg?raw';
import perplexity from '@lobehub/icons-static-svg/icons/perplexity.svg?raw';

// Only these trusted, bundled SVGs are rendered; API text never becomes markup.
const glyphs={codex,openai,anthropic:claude,google,gemini,deepseek,qwen,kimi,zhipu,zai,minimax,doubao,grok,mistral,meta,hunyuan,baidu,cohere,yi,nvidia,perplexity};
type Brand=keyof typeof glyphs;
const normalize=(name:string)=>name.toLowerCase().replace(/[\s._-]/g,'');
const aliases:Readonly<Record<string,Brand>>={
  openai:'openai',chatgpt:'openai',codex:'openai',
  anthropic:'anthropic',claude:'anthropic',claudecode:'anthropic',
  google:'google',googleai:'google',谷歌:'google',gemini:'gemini',
  deepseek:'deepseek',深度求索:'deepseek',
  qwen:'qwen',alibaba:'qwen',alibabacloud:'qwen',aliyun:'qwen',通义千问:'qwen',阿里巴巴:'qwen',阿里云:'qwen',
  moonshot:'kimi',moonshotai:'kimi',kimi:'kimi',月之暗面:'kimi',
  zhipu:'zhipu',zhipuai:'zhipu',chatglm:'zhipu',glm:'zhipu',智谱:'zhipu',智谱ai:'zhipu',zai:'zai',
  minimax:'minimax',海螺:'minimax',稀宇科技:'minimax',
  bytedance:'doubao',doubao:'doubao',豆包:'doubao',字节跳动:'doubao',
  xai:'grok',grok:'grok',mistral:'mistral',mistralai:'mistral',
  meta:'meta',metaai:'meta',llama:'meta',
  tencent:'hunyuan',hunyuan:'hunyuan',腾讯:'hunyuan',腾讯混元:'hunyuan',混元:'hunyuan',
  baidu:'baidu',ernie:'baidu',百度:'baidu',文心一言:'baidu',
  cohere:'cohere',yi:'yi',zeroone:'yi','01ai':'yi',零一万物:'yi',
  nvidia:'nvidia',英伟达:'nvidia',perplexity:'perplexity',
};
const modelFamilies:readonly [RegExp,Brand][]=[
  [/^(?:gpt[-.]|chatgpt[-.]|o[1-9](?:[-.]|$)|codex(?:[-.]|$)|sora(?:[-.]|$)|dall[-_]?e(?:[-.]|$)|text-embedding-|whisper(?:[-.]|$))/i,'openai'],
  [/^claude(?:[-.]|$)/i,'anthropic'],[/^gemini(?:[-.]|$)/i,'gemini'],
  [/^deepseek(?:[-.]|$)/i,'deepseek'],[/^(?:qwen|qwq)(?:[-.\d]|$)/i,'qwen'],
  [/^(?:kimi|moonshot)(?:[-.]|$)/i,'kimi'],[/^(?:glm|chatglm)(?:[-.\d]|$)/i,'zhipu'],
  [/^(?:minimax(?:[-.]|$)|abab\d)/i,'minimax'],[/^doubao(?:[-.]|$)/i,'doubao'],
  [/^grok(?:[-.]|$)/i,'grok'],[/^(?:mistral|mixtral|codestral|pixtral|ministral)(?:[-.]|$)/i,'mistral'],
  [/^llama(?:[-.\d]|$)/i,'meta'],[/^hunyuan(?:[-.]|$)/i,'hunyuan'],
  [/^ernie(?:[-.]|$)/i,'baidu'],[/^command(?:[-.]|$)/i,'cohere'],
  [/^yi(?:[-.]|$)/i,'yi'],[/^(?:sonar|pplx)(?:[-.]|$)/i,'perplexity'],
];
function providerBrand(vendor:string,modelName:string):Brand|undefined {
  const key=normalize(vendor),explicit=Object.hasOwn(aliases,key) ? aliases[key] : undefined;
  if(explicit)return explicit;
  const segments=modelName.split('/');
  if(segments.length>1){const key=normalize(segments[0]),prefix=Object.hasOwn(aliases,key) ? aliases[key] : undefined;if(prefix)return prefix;}
  const model=segments.at(-1) || '';
  return modelFamilies.find(([pattern])=>pattern.test(model))?.[1];
}

export function BrandGlyph({brand,size=20}:{brand:Brand;size?:number}) {
  const scope=useId().replace(/[^a-zA-Z0-9_-]/g,'');
  const markup=useMemo(()=>{
    let svg=glyphs[brand];
    // A card, modal and tool row can show the same gradient icon at once.
    for(const [,id] of svg.matchAll(/\bid="([^"]+)"/g)) {
      const scoped=id+'-'+scope;
      svg=svg.replaceAll('id="'+id+'"','id="'+scoped+'"').replaceAll('url(#'+id+')','url(#'+scoped+')').replaceAll('href="#'+id+'"','href="#'+scoped+'"');
    }
    return svg;
  },[brand,scope]);
  return <span className="lobe-icon" data-lobe-icon={brand} aria-hidden="true" style={{width:size,height:size}} dangerouslySetInnerHTML={{__html:markup}}/>;
}

export function ProviderIcon({vendor='',modelName='',size=18,className='vendor-icon'}:{vendor?:string;modelName?:string;size?:number;className?:string}) {
  const brand=providerBrand(vendor,modelName);
  const label=vendor || modelName || '模型';
  return <span className={className+' brand-icon'} data-brand={brand || 'unknown'} role="img" aria-label={label+' 图标'} title={label}>{brand ? <BrandGlyph brand={brand} size={size}/> : <Cpu size={size} aria-hidden="true"/>}</span>;
}
