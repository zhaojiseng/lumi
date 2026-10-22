/** Pure displacement geometry; independent of DOM and filter lifecycle. */
export function glassDisplacement(width:number,height:number,radius:number,maxSize=384,lens=false,surface=false){
  const scale=Math.min(1,maxSize/Math.max(width,height));
  const w=Math.max(2,Math.round(width*scale)),h=Math.max(2,Math.round(height*scale));
  const data=new Uint8ClampedArray(w*h*4),r=Math.min(Math.max(0,radius),width/2,height/2);
  const bevel=Math.min(surface ? 64 : 18,width/4,height/4);
  const distance=(x:number,y:number)=>{
    const qx=Math.abs(x-width/2)-(width/2-r),qy=Math.abs(y-height/2)-(height/2-r);
    return Math.hypot(Math.max(qx,0),Math.max(qy,0))+Math.min(Math.max(qx,qy),0)-r;
  };
  for(let y=0;y<h;y++)for(let x=0;x<w;x++){
    const px=(x+.5)*width/w,py=(y+.5)*height/h,d=distance(px,py);
    // Flat center; curved bevel. Direction is the local inward surface normal.
    const amount=d<=0 ? Math.max(0,1+d/bevel)**2 : 0;
    // Flat centers and pixels outside the outline do not use a normal.
    // Retain the exact bevel samples, including the selection lens formula.
    let nx=0,ny=0,len=1;
    if(amount>0){nx=distance(px+.5,py)-distance(px-.5,py);ny=distance(px,py+.5)-distance(px,py-.5);len=Math.hypot(nx,ny)||1;}
    const i=(y*w+x)*4;
    // A selection lens also samples slightly toward its center, magnifying the
    // labels painted beneath it. Other surfaces retain their flat center.
    const focalRadius=Math.min(width,height)/2;
    const lx=lens && d<=0 ? Math.max(-.65,Math.min(.65,.16*(px-width/2)/focalRadius))*(1-amount) : 0;
    const ly=lens && d<=0 ? Math.max(-.65,Math.min(.65,.16*(py-height/2)/focalRadius))*(1-amount) : 0;
    data[i]=128-127*(nx/len*amount+lx);data[i+1]=128-127*(ny/len*amount+ly);data[i+2]=0;data[i+3]=255;
  }
  return {width:w,height:h,data};
}
