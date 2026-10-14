import {createHash} from 'node:crypto';
import path from 'node:path';
import {build,type Plugin as EsbuildPlugin} from 'esbuild';
import type {Plugin as VitePlugin} from 'vite';

const scriptFile='appearance-preview-script.ts';
type PreviewRuntime={source:string;hash:string};

/** Bundle only host code, then authorize those exact bytes in both CSPs. */
export async function appearancePreviewRuntime(root=process.cwd()):Promise<PreviewRuntime>{
  const result=await build({entryPoints:[path.join(root,'src/host/appearance-preview-runtime.ts')],bundle:true,write:false,format:'iife',platform:'browser',target:'chrome144',minify:true});
  const source=result.outputFiles[0].text.replace(/<\/script/gi,'<\\/script');
  return {source,hash:createHash('sha256').update(source).digest('base64')};
}

export function appearancePreviewEsbuildPlugin(root=process.cwd()):EsbuildPlugin{
  root=path.resolve(root);
  return {name:'lumi-appearance-preview',setup(builder){
    let runtime:Promise<PreviewRuntime>|undefined;
    builder.onLoad({filter:/[/\\]appearance-preview-script\.ts$/},async args=>{
      if(path.normalize(args.path)!==path.join(root,'src/host',scriptFile))return;
      runtime ??=appearancePreviewRuntime(root);
      return {contents:'export default '+JSON.stringify(await runtime),loader:'js'};
    });
  }};
}

export function appearancePreviewVitePlugin(root=process.cwd()):VitePlugin{
  root=path.resolve(root);
  let runtime:Promise<PreviewRuntime>|undefined;
  const current=()=>runtime ??=appearancePreviewRuntime(root);
  return {name:'lumi-appearance-preview',
    async load(id){if(path.normalize(id)===path.join(root,'src/host',scriptFile))return 'export default '+JSON.stringify(await current());},
    async transformIndexHtml(html,context){
      if(path.basename(context.filename)!=='index.html')return html;
      const {hash}=await current();
      // srcdoc inherits the parent policy. Permit the same fixed host script,
      // without allowing inline plugin code or another network script origin.
      if(!html.includes("script-src 'self';"))throw new Error('外观预览构建缺少宿主 script-src CSP 接线。');
      return html.replace("script-src 'self';",`script-src 'self' 'sha256-${hash}';`);
    },
    configureServer(server){
      server.watcher.on('change',file=>{
        file=path.normalize(file);
        if(!['appearance-preview-runtime.ts','glass-refraction.ts'].some(name=>file===path.join(root,'src/host',name)))return;
        runtime=undefined;
        const module=server.moduleGraph.getModuleById(path.join(root,'src/host',scriptFile).replaceAll('\\','/'));if(module)server.moduleGraph.invalidateModule(module);
        server.ws.send({type:'full-reload'});
      });
    },
  };
}
