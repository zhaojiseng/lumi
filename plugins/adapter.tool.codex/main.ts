import type {TrustedBuiltinPlugin} from '../../shared/contracts/plugins';
import {codexAdapterManifest} from './manifest';
import {buildCodex} from './build';
export const codexAdapterPlugin:TrustedBuiltinPlugin={manifest:codexAdapterManifest,activate(context){context.provide('toolConfig.build',{build:input=>{if(input.request.tool!=='codex')throw new Error('Codex 适配器不接受其他工具配置。');return buildCodex(input.config,input.auth,input.request,input.baseUrl,input.key,input.configDir);}});}};
