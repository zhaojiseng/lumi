import {z} from 'zod';
import {EXTENSION_PERMISSIONS,EXTENSION_SLOTS,type ExtensionManifest} from './contracts/extensions';
export const extensionId=/^extension\.[a-z][a-z0-9-]{0,39}\.[a-z][a-z0-9-]{0,39}$/;
const localId=z.string().regex(/^[a-z][a-z0-9.-]{0,79}$/);
export function safeExtensionPath(value:string){
  return value.length<=240 && !value.includes('\\') && !value.startsWith('/') && value.split('/').every(part=>/^[a-zA-Z0-9_][a-zA-Z0-9_.-]*$/.test(part) && !part.includes('..') && !part.includes(':'));
}
const file=z.string().refine(safeExtensionPath,'插件文件路径无效。');
const origin=z.string().max(500).refine(value=>{try{const u=new URL(value);return u.protocol==='https:' && !u.username && !u.password && u.origin===value;}catch{return false;}},'网络来源必须是完整 HTTPS origin。');
const schema=z.object({
  kind:z.enum(['feature','interface']).default('feature'),interface:z.object({stylesheet:file.refine(v=>v.endsWith('.css'))}).strict().optional(),
  schemaVersion:z.literal(1),id:z.string().regex(extensionId),name:z.string().trim().min(1).max(80),version:z.string().regex(/^\d+\.\d+\.\d+(?:-[a-zA-Z0-9.-]+)?$/).max(40),
  hostApiVersion:z.literal(1),description:z.string().max(500),author:z.string().trim().min(1).max(100),license:z.string().min(1).max(100),
  permissions:z.array(z.enum(EXTENSION_PERMISSIONS)).max(EXTENSION_PERMISSIONS.length).default([]),networkOrigins:z.array(origin).max(20).default([]),
  switches:z.array(z.object({id:localId,title:z.string().trim().min(1).max(80),defaultEnabled:z.boolean().default(true)}).strict()).max(30).default([]),
  contributions:z.array(z.object({id:localId,slot:z.enum(EXTENSION_SLOTS),title:z.string().trim().min(1).max(80),order:z.number().int().min(0).max(10000).default(100),scope:z.enum(['site','independent']).default('independent'),entry:file.refine(v=>v.endsWith('.html')),switch:localId.optional(),section:z.enum(['workspace','tools','settings']).optional()}).strict()).max(30).default([]),
}).strict();
export function parseExtensionManifest(raw:unknown):ExtensionManifest {
  const manifest=schema.parse(raw);
  if(manifest.kind==='interface'){
    if(!manifest.interface || manifest.permissions.length || manifest.networkOrigins.length || manifest.contributions.length || manifest.switches.length)throw new Error('界面插件必须声明 stylesheet，且不包含功能贡献或数据权限。');
  }else if(manifest.interface || !manifest.contributions.length)throw new Error('功能插件必须声明界面贡献，不能声明全局界面样式。');
  for(const values of [manifest.permissions,manifest.networkOrigins,manifest.switches.map(v=>v.id),manifest.contributions.map(v=>v.id)])if(new Set(values).size!==values.length)throw new Error('插件声明中存在重复 ID、权限或来源。');
  for(const contribution of manifest.contributions)if(contribution.switch && !manifest.switches.some(s=>s.id===contribution.switch))throw new Error('贡献引用了未声明的功能开关。');
  if(manifest.networkOrigins.length && !manifest.permissions.includes('network.read'))throw new Error('网络来源需要 network.read 权限。');
  return manifest;
}
