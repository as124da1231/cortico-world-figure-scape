// 坐垫用臀部接触点；床用头部锚点。原画1983×793。
export const ART={w:1983,h:793};
export const FURNITURE={door:{box:[53,205,169,386]},fridge:{box:[518,317,129,254]},stool:{box:[451,514,120,94]},table:{box:[315,466,210,135]},coffee:{box:[850,545,248,98]},cover:{box:[1448,464,455,170]}};
export const WALK_FLOOR=.91;
export const POSES={chair:{x:342/1983,seatY:535/793,act:'sit'},board:{x:342/1983,floor:535/793,act:'stand'},fridge:{x:510/1983,floor:533/793,act:'stand'},sofa:{x:826/1983,seatY:522/793,act:'sit'},bed:{x:.815,floor:.69,act:'sleep'}};
export function fridgeSlots(n){return Array.from({length:Math.max(0,Math.min(12,n))},(_,i)=>{const row=Math.floor(i/3),back=i%3===0;return {x:back?.38:i%3===1?.18:.49,y:.12+row*.21+(back?0:.06),w:back?.24:.29,h:back?.15:.17,depth:row*2+(back?0:1),row,back};});}
export function poseFloor(id,config){const p=POSES[id];if(!p)return config.floor;if(p.floor)return p.floor;const scale=config.canvas.h*.27/244;return (p.seatY*config.canvas.h+8*scale)/config.canvas.h;}
export function pixelBox(rect,box){return {left:rect.x+rect.w*box[0]/ART.w,top:rect.y+rect.h*box[1]/ART.h,width:rect.w*box[2]/ART.w,height:rect.h*box[3]/ART.h};}
export function portalBox(W,H,position={x:.02,y:.76},floorY=H-8,petHeight=244*.42){const height=Math.min(Math.max(36,petHeight)/.944,H-18),width=height*960/1640;return {x:Math.max(8,Math.min(W-width-8,position.x*W)),y:Math.max(8,Math.min(H-height-2,floorY-height)),w:width,h:height};}
export function walkFloor(){return WALK_FLOOR;}
export function portalAcrossDisplay(position,to,width,grip=.5){return {...position,x:Math.max(0,Math.min(1,(to.x-width*grip)/to.w))};}
export function bedPose(){return POSES.bed;}
export function targetFloor(h,config){return h.poseFloor??({door:.74,window:.78,record:.76,lamp:.79,board:.79,rug:WALK_FLOOR,center:WALK_FLOOR}[h.id]??config.floor);}
