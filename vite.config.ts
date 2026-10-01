import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
export default defineConfig({
  base:'./',
  plugins:[react(),{name:'lumi-public-status',configureServer(server) { server.middlewares.use('/_lumi/public-status',async (req,res) => { try { const origin=req.headers.origin;if (origin && origin !== 'http://127.0.0.1:5173') {res.statusCode=403;res.end();return;}const request=new URL(req.url || '/','http://127.0.0.1');const site=new URL(request.searchParams.get('site') || '');if (!['http:','https:'].includes(site.protocol) || site.username || site.password || site.search || site.hash) throw new Error('地址无效');const r=await fetch(site.href.replace(/\/$/,'')+'/api/status',{redirect:'error',signal:AbortSignal.timeout(15000)});res.setHeader('Content-Type','application/json');res.setHeader('Cache-Control','no-store');res.end(await r.text()); } catch {res.statusCode=502;res.end(JSON.stringify({success:false,message:'站点连接失败'}));} }); }}],
  server:{host:'127.0.0.1',port:5173,strictPort:true,watch:{ignored:['**/.cache/**','**/.research/**','**/.test-data/**','**/release/**','**/dist-electron/**','**/docs/preview-*']}},
  build:{outDir:'dist',sourcemap:false,chunkSizeWarningLimit:950},
});
