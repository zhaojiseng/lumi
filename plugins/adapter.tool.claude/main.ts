import type {TrustedBuiltinPlugin} from '../../shared/contracts/plugins';
import {claudeAdapterManifest} from './manifest';
import {buildClaude} from './build';
export const claudeAdapterPlugin:TrustedBuiltinPlugin={manifest:claudeAdapterManifest,activate(context){context.provide('toolConfig.build',{build:input=>{if(input.request.tool!=='claude')throw new Error('Claude Code 适配器不接受其他工具配置。');return {config:buildClaude(input.config,input.request,input.baseUrl,input.key)};}});}};
