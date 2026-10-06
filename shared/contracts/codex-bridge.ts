/** Thin privileged tunnel to a local `codex app-server` process. Lumi does not interpret the protocol. */
export interface CodexBridgeStatus {installed:boolean;version?:string;state:'starting'|'ready'|'exited';detail?:string;}
export interface CodexBridgeMessage {
  id?:number|string;
  method?:string;
  params?:unknown;
  result?:unknown;
  error?:{code?:number;message?:string;data?:unknown};
}
export interface CodexBridgeCapability {
  /** Process/CLI state only; never starts a turn. */
  status():Promise<CodexBridgeStatus>;
  /** Forward one allowlisted JSON-RPC request (or notification when notify is true) verbatim. */
  send(input:{method:string;params?:unknown;notify?:boolean}):Promise<{result?:unknown;error?:unknown}>;
  /** Write back a JSON-RPC response for a server-initiated request. */
  respond(input:{id:number|string;result?:unknown;error?:unknown}):Promise<void>;
  /** Ask the user for a working directory; only the chosen absolute path is returned. */
  chooseDirectory():Promise<{path:string}|null>;
  /** Every inbound message (notifications and server requests) is forwarded verbatim. */
  subscribe(listener:(message:CodexBridgeMessage)=>void):()=>void;
  close():void;
}
export interface CodexBridgeFactory {
  create():CodexBridgeCapability;
  release(client:CodexBridgeCapability):void;
  close():void;
}
