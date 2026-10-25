import { applyPatch, createEmptyDocument, DocumentObjectSchema, type DocumentPatch } from "@chemdraft/chem-core";
import { describe, expect, it, vi } from "vitest";
import { PluginHost, type PluginPatchApplicationRequest } from "./index";

function fixture() {
  let document = createEmptyDocument();
  const pageId = document.pages[0]!.id;
  const text = (id: string) => DocumentObjectSchema.parse({ id, type:"text",text:id,
    x:0,y:0,width:20,height:10,rotation:0,style:{},spans:[] });
  document = applyPatch(document,{op:"batch",patches:["first","moving","second"].map(id =>
    ({op:"addObject",pageId,object:text(id)}))});
  const before = document;
  const apply = vi.fn((request: PluginPatchApplicationRequest) => {
    document = applyPatch(document,request.patch.patch);
    return {applied:true as const,objectIds:["moving"]};
  });
  // The request tab is authoritative, even if another tab is active.
  const host = new PluginHost({getActiveDocument:() => createEmptyDocument()});
  let release!: () => void;
  host.registerPlugin({id:"org.test.order",name:"Order",version:"0",apiVersion:"^0.1.14",entry:"plugin.js",
    permissions:["document.write"],contributes:{commands:[{id:"plugin.order.run",title:"Order"}]}
  },{commandHandlers:{"plugin.order.run":() => new Promise<void>(resolve => {release=resolve;})}});
  const pending = host.invokeCommand("plugin.order.run");
  const write = (patch: DocumentPatch) => host.applyPatchForPlugin("org.test.order",undefined,{patch,reason:"Order"},
    {objectIds:["moving"],assistantTransactionId:"request",getDocument:() => document,apply});
  return {pageId,before,apply,write,text,document:() => document,finish:async () => {release();await pending;}};
}

describe("assistant page ordering scope",() => {
  it("lets selected objects and earlier insertions pass byte-identical bystanders",async () => {
    const s=fixture();
    try {
      await s.write({op:"batch",patches:[
        {op:"addObject",pageId:s.pageId,object:s.text("inserted")},
        {op:"setObjectOrder",pageId:s.pageId,objectIds:["inserted","first","second","moving"]}
      ]});
      expect(s.document().pages[0]!.objects.map(o=>o.id)).toEqual(["inserted","first","second","moving"]);
      for (const id of ["first","second"]) expect(JSON.stringify(s.document().pages[0]!.objects.find(o=>o.id===id)))
        .toBe(JSON.stringify(s.before.pages[0]!.objects.find(o=>o.id===id)));
    } finally {await s.finish();}
  });
  it.each([
    {name:"unselected content changes",patch:{op:"updateObject",objectId:"first",changes:{text:"changed"}}},
    {name:"unselected relative order changes",patch:{op:"setObjectOrder",pageId:"page_001",objectIds:["second","first","moving"]}}
  ] as const)("refuses the entire batch for $name",async ({patch}) => {
    const s=fixture();
    try {
      await expect(s.write({op:"batch",patches:[
        {op:"moveObject",objectId:"moving",x:50,y:50},
        patch as DocumentPatch
      ]})).rejects.toThrow("first was not selected");
      expect(s.apply).not.toHaveBeenCalled();
      expect(s.document()).toBe(s.before);
    } finally {await s.finish();}
  });
});
