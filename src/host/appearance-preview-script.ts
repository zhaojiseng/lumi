/** Vite and the host's esbuild adapter replace this module with a bundle of
 * appearance-preview-runtime.ts and its SHA-256. Plain source consumers keep
 * the static, script-free preview; no plugin code can supply this value. */
const runtime:undefined|{source:string;hash:string}=undefined;
export default runtime;
