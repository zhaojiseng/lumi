export interface PointerPosition {x:number;y:number;}
interface PointerState {pointer:PointerPosition|null;keyboard:boolean;}
interface Frames {request(callback:FrameRequestCallback):number;cancel(id:number):void;}

/** Pointer bursts publish one position per frame; leaving or switching to keyboard revokes queued motion. */
export class ChartPointer {
  private state:PointerState={pointer:null,keyboard:false};
  private next:PointerPosition|null=null;
  private frame:number|null=null;
  private listeners=new Set<()=>void>();
  constructor(private readonly frames:Frames={request:callback=>requestAnimationFrame(callback),cancel:id=>cancelAnimationFrame(id)}) {}
  getState=()=>this.state;
  subscribe=(listener:()=>void)=>{this.listeners.add(listener);return()=>{this.listeners.delete(listener);};};
  private publish(state:PointerState){
    if(state.keyboard===this.state.keyboard && state.pointer?.x===this.state.pointer?.x && state.pointer?.y===this.state.pointer?.y)return;
    this.state=state;this.listeners.forEach(listener=>listener());
  }
  move(pointer:PointerPosition){
    this.next=pointer;
    if(this.frame!==null)return;
    this.frame=this.frames.request(()=>{this.frame=null;const pointer=this.next;this.next=null;this.publish({pointer,keyboard:false});});
  }
  cancel=()=>{if(this.frame!==null)this.frames.cancel(this.frame);this.frame=null;this.next=null;};
  clear(keyboard=false){this.cancel();this.publish({pointer:null,keyboard});}
}
