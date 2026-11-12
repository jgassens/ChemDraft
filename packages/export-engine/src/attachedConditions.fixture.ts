import { createEmptyDocument, applyPatches, type TextObject, type ArrowObject } from "@chemdraft/chem-core";
import { reactionConditionsFrame, nativeTextObjectLineMetrics } from "@chemdraft/layout-engine";
export function attachedConditionsDocument() {
  const document=createEmptyDocument({title:"Formatted conditions",now:"2026-05-29T00:00:00.000Z"});
  const arrow:ArrowObject={id:"arrow",type:"reaction-arrow",arrowKind:"forward",x:100,y:240,width:400,height:0,
    rotation:0,style:{},start:{kind:"point",point:{x:100,y:240}},end:{kind:"point",point:{x:500,y:240}},labels:[]};
  const text:TextObject={id:"conditions",type:"text",x:100,y:120,width:400,height:64,rotation:0,
    style:{fontSizePx:16,textAlign:"center"},text:"H2O\nZn2+",spans:[
      {text:"H",script:"normal",style:{}},{text:"2",script:"subscript",style:{}},
      {text:"O\nZn",script:"normal",style:{}},{text:"2+",script:"superscript",style:{}}]};
  text.height=nativeTextObjectLineMetrics(text).height;
  text.arrowAttachment={kind:"conditions",parentObjectId:arrow.id,side:"above",placement:"manual",
    frame:reactionConditionsFrame(document.pages[0],arrow)!,offset:{x:0,y:240-text.y-text.height/2}};
  return applyPatches(document,[{op:"addObject",pageId:document.pages[0].id,object:arrow},
    {op:"addObject",pageId:document.pages[0].id,object:text}]);
}
