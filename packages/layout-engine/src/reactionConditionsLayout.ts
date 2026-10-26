import type { ArrowAttachmentFrame, DocumentObject, DocumentPage, TextObject } from "@chemdraft/chem-core";
import { artObstacleIntersectsBounds, graphicArrowInkObstacles, type NativeArtObstacle } from "@chemdraft/art-engine";
import { moleculeOutlineForArrangement, textVisualBoundsForArrangement } from "./index";
import { arrowAttachmentFrame, arrowAttachmentPoint, reactionConditionsFrame } from "./arrowAttachments";

/** Ink obstacles, rather than the empty bounding rectangle around a curved arrow. */
function conditionsObstacles(page: DocumentPage, labelId: string): NativeArtObstacle[] {
  return page.objects.flatMap((object): NativeArtObstacle[] => {
    if(object.id===labelId || object.type==='group') return [];
    if(object.type==='molecule') return [{outline:moleculeOutlineForArrangement(object)}];
    if(object.type==='text') return [textVisualBoundsForArrangement(object)];
    const frame=arrowAttachmentFrame(page,object);
    if(frame && object.type==='graphic') return graphicArrowInkObstacles(object);
    if(frame && object.type==='reaction-arrow') return [{outline:[
      {x:frame.origin.x-frame.tangent.x*(frame.length??0)/2,y:frame.origin.y-frame.tangent.y*(frame.length??0)/2},
      {x:frame.origin.x+frame.tangent.x*(frame.length??0)/2,y:frame.origin.y+frame.tangent.y*(frame.length??0)/2}]}];
    return [{x:object.x,y:object.y,width:object.width,height:object.height}];
  });
}

/** Keep a horizontal, centered text block on the requested side. Prefer the shaft midpoint,
 * then small tangent shifts and greater clearance to avoid molecules, arrowheads and branches. */
export function reactionConditionsPlacement(page: DocumentPage, arrow: DocumentObject, label: TextObject,
  side: "above"|"below"): { offset: {x:number;y:number}; frame: ArrowAttachmentFrame } | undefined {
  const frame=reactionConditionsFrame(page,arrow);if(!frame)return undefined;
  const sign=side==='above'?1:-1;
  const extent=Math.abs(frame.normal.x)*label.width/2+Math.abs(frame.normal.y)*label.height/2;
  const obstacles=conditionsObstacles(page,label.id);
  const length=frame.length??100, step=Math.min(36,Math.max(12,length*0.12));
  const shifts=[0,-step,step,-2*step,2*step];
  let best: {offset:{x:number;y:number};score:number}|undefined;
  for(let distance=0;distance<=180;distance+=12) for(const x of shifts) {
    const offset={x,y:sign*(extent+12+distance)},center=arrowAttachmentPoint(frame,offset);
    const box={x:center.x-label.width/2,y:center.y-label.height/2,width:label.width,height:label.height};
    if(box.x<6||box.y<6||box.x+box.width>page.width-6||box.y+box.height>page.height-6)continue;
    const collisions=obstacles.reduce((n,shape)=>n+Number(artObstacleIntersectsBounds(shape,box,8)),0);
    const score=collisions*100000+distance*distance+Math.abs(x)*Math.abs(x)*1.3;
    if(!best || score<best.score)best={offset,score};
  }
  return best && best.score < 100000 ? {frame,offset:best.offset}:undefined;
}
