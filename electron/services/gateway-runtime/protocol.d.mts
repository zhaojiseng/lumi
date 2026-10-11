export function strictJson(text:string):any;
export function convertJsonResponse(bytes:Uint8Array,source:string,target:string,model:string):Buffer;
export function conversionError(error:unknown,target:string):unknown;
export function createStreamConverter(source:string,target:string,input?:{model?:string;requestId?:string}):{push(chunk:Uint8Array):Buffer[];finish():Buffer[]};
