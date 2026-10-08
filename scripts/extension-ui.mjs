import {readFile} from 'node:fs/promises';
import path from 'node:path';
import {build} from 'esbuild';
/** Bundle the host-owned algorithm in each isolated SDK document. */
export async function extensionSdkRuntime(root=process.cwd()) {
  const result=await build({entryPoints:[path.join(root,'src/host/extension-sdk-runtime.ts')],bundle:true,write:false,format:'iife',globalName:'LumiGlassRuntime',platform:'browser',target:'chrome144'});
  return result.outputFiles[0].text+'\n'+await readFile(path.join(root,'public/lumi-extension-sdk.js'),'utf8');
}
/** Export the same primitives used by the main window, without a second theme. */
export async function extensionUiCss(root=process.cwd()) {
  const files=['theme-tokens.css','styles.css','workbench.css','select.css','theme.css','filters-tools-motion.css','platform-logs.css','components/segmented-switch.css','host/extension-ui.css'];
  return (await Promise.all(files.map(file=>readFile(path.join(root,'src',file),'utf8')))).join('\n');
}
