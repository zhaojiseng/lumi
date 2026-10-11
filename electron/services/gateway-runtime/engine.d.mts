import type {Engine} from './types.mjs';
export function startEngine(input:{dataDir:string;testBinary:string;timeoutMs?:number}):Promise<Engine>;
