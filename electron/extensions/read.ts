export type ExtensionReadMethod='workbench.read'|'usage.read'|'codex.usage.read';
export interface ExtensionReadHandlers {
  workbench(input:{force?:boolean}):Promise<unknown>;
  usage(input:{force?:boolean}):Promise<unknown>;
  codexUsage(input:{force?:boolean}):Promise<unknown>;
}
/**
 * Explicit dispatch for the presentation reads the extension host forwards.
 * An unknown method must fail loudly instead of silently answering with
 * workbench data.
 */
export async function extensionRead(method:ExtensionReadMethod,input:{force?:boolean},handlers:ExtensionReadHandlers):Promise<unknown> {
  switch(method){
    case 'workbench.read':return handlers.workbench(input);
    case 'usage.read':return handlers.usage(input);
    case 'codex.usage.read':return handlers.codexUsage(input);
    default:throw new Error(`扩展读取接口不支持：${method}`);
  }
}
