import path from 'node:path';
import {parse,stringify} from 'smol-toml';
import type {ConfigRequest} from '../../shared/types';
// Used only to disconnect obsolete Lumi-generated catalogs and restore historical backups.
const LEGACY_CODEX_CATALOG='lumi-model-catalog.json';
function disconnectLegacyCatalog(doc:Record<string,any>,configDir:string) {
  const legacy=path.resolve(configDir,LEGACY_CODEX_CATALOG);
  const matches=(value:unknown)=>{
    if(typeof value!=='string')return false;
    const resolved=path.resolve(configDir,value);
    return process.platform==='win32' ? resolved.toLowerCase()===legacy.toLowerCase() : resolved===legacy;
  };
  if(matches(doc.model_catalog_json))delete doc.model_catalog_json;
  for(const profile of Object.values(doc.profiles || {})){
    if(profile && typeof profile==='object' && matches((profile as any).model_catalog_json))delete (profile as any).model_catalog_json;
  }
}
export function buildCodex(config: string | null, auth: string | null, req: ConfigRequest, baseUrl: string, key: string, configDir?:string) {
  const doc: any = config?.trim() ? parse(config) : {};
  const credentials: any = auth?.trim() ? JSON.parse(auth) : {};
  doc.model = req.model; doc.model_provider = 'custom'; delete doc.model_reasoning_effort;
  doc.model_context_window=req.contextWindow ?? 272000;
  // Enable the CLI feature without selecting the priority request tier.
  // Desktop speed controls additionally require ChatGPT auth and model support.
  // Explicit default also overrides models whose catalog default is Fast.
  doc.service_tier='default';
  doc.features ??= {};
  doc.features.fast_mode=true;
  if(configDir)disconnectLegacyCatalog(doc,configDir);
  const profile=typeof doc.profile==='string' ? doc.profiles?.[doc.profile] : undefined;
  if(profile && typeof profile==='object'){
    profile.model=req.model;profile.model_provider='custom';profile.model_context_window=doc.model_context_window;delete profile.model_reasoning_effort;
    profile.service_tier='default';profile.features ??= {};profile.features.fast_mode=true;
  }
  doc.model_providers ??= {};
  doc.model_providers.custom = { name: 'Lumi · New API', base_url: baseUrl + '/v1', wire_api: 'responses', experimental_bearer_token:key, requires_openai_auth: !!credentials.tokens };
  if(doc.model_providers.lumi?.name==='Lumi · New API' && !Object.values(doc.profiles || {}).some((p:any)=>p.model_provider==='lumi'))delete doc.model_providers.lumi;
  return { config: stringify(doc), auth: JSON.stringify(credentials, null, 2) + '\n' };
}
