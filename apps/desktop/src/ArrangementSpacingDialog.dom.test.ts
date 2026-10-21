// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { describe, expect, it, vi } from "vitest";
import { applyPatches, type TextObject } from "@chemdraft/chem-core";
import { exportDocumentToSvg } from "@chemdraft/export-engine";
import { ArrangementSpacingDialog, frameArrangementSpacingPreviewSvg } from "./ArrangementSpacingDialog";
import { createPhase4Document, createNativeSingleBondMolecule, selectDocumentObjects, arrangeSelectedDocumentObjects, adjustArrangementSpacing, setDocumentCustomPageSize } from "./documentWorkflow";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
describe("spacing preview selected page", () => {
  it("frames exports regardless of root attribute order or extra attributes", () => {
    const preview = frameArrangementSpacingPreviewSvg('<svg data-export="preview" viewBox="0 0 200 100" xmlns="http://www.w3.org/2000/svg" height="100" preserveAspectRatio="xMidYMid" width="200"><path /></svg>', 200, 100);
    expect(preview).toBe('<svg data-export="preview" viewBox="-5 -5 210 110" xmlns="http://www.w3.org/2000/svg" height="110" preserveAspectRatio="xMidYMid" width="210">\n<rect x="-5" y="-5" width="210" height="110" fill="#e5e7eb" /><path /><rect data-arrangement-page-boundary="true" x="0" y="0" width="200" height="100" fill="none" stroke="#64748b" stroke-width="1" vector-effect="non-scaling-stroke" />\n</svg>');
  });
  it("keeps the current export framing unchanged", () => {
    const source = createPhase4Document("Current export");
    const page = source.pages[0], padding = Math.max(page.width, page.height) * 0.025;
    const width = page.width + padding * 2, height = page.height + padding * 2;
    const exported = exportDocumentToSvg(source, { includePageGuides: false, includeWarnings: false }).contents;
    const expected = exported
      .replace(/width="[^"]+" height="[^"]+" viewBox="[^"]+"/, `width="${width}" height="${height}" viewBox="${-padding} ${-padding} ${width} ${height}"`)
      .replace(/(<svg\b[^>]*>)/, `$1\n<rect x="${-padding}" y="${-padding}" width="${width}" height="${height}" fill="#e5e7eb" />`)
      .replace("</svg>", `<rect data-arrangement-page-boundary="true" x="0" y="0" width="${page.width}" height="${page.height}" fill="none" stroke="#64748b" stroke-width="1" vector-effect="non-scaling-stroke" />\n</svg>`);
    expect(frameArrangementSpacingPreviewSvg(exported, page.width, page.height)).toBe(expected);
  });
  it("lets the slider reach valid expansion beyond an initially overlapping selection", async () => {
    let source = setDocumentCustomPageSize(createPhase4Document("Overlap"), { width: 1, height: 11, unit: "inch" });
    const objects: TextObject[] = [8.5, 47.5].map((x, i) => ({ id: `caption-${i}`, type: "text", text: "Caption", spans: [],
      x, y: 100, width: 40, height: 20, rotation: 0, style: {} }));
    source = applyPatches(source, objects.map(object => ({ op: "addObject" as const, pageId: source.pages[0].id, object })));
    source = selectDocumentObjects(source, source.pages[0].id, objects.map(object => object.id));
    const before = JSON.stringify(source);
    const container = document.createElement("div");document.body.append(container);
    const root = createRoot(container), save = vi.fn();
    try {
      await act(async () => root.render(createElement(ArrangementSpacingDialog, { document: source, onSave: save, onCancel: vi.fn() })));
      const slider = container.querySelector<HTMLInputElement>('input[type="range"]')!;
      expect(slider.min).toBe("100");expect(slider.max).toBe("143");
      const setPercent = async (percent: number) => act(async () => {
        Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(slider, String(percent));
        slider.dispatchEvent(new Event("input", { bubbles: true }));
      });
      await setPercent(125);
      expect(container.textContent).toContain("The compounds need more space");
      expect(container.querySelector<HTMLButtonElement>('button[type="submit"]')!.disabled).toBe(true);
      await setPercent(135);
      expect(container.querySelector("img")).not.toBeNull();
      expect(container.querySelector<HTMLButtonElement>('button[type="submit"]')!.disabled).toBe(false);
      expect(JSON.stringify(source)).toBe(before);
      await act(async () => container.querySelector("form")!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })));
      expect(save).toHaveBeenCalledWith(1.35);
      expect(adjustArrangementSpacing(source, 1.35).ok).toBe(true);
    } finally { await act(async () => root.unmount());container.remove(); }
  });
  it("exports page two, keeps page one untouched, and saves spacing on page two", async () => {
    let source = createPhase4Document("Two pages");
    const note: TextObject = {id:"first-page-note",type:"text",text:"PAGE ONE ONLY",spans:[],x:10,y:10,width:140,height:20,rotation:0,style:{}};
    source = applyPatches(source, [{op:"addObject",pageId:source.pages[0].id,object:note}]);
    const first = source.pages[0];
    source = {...source,pages:[first,{...first,id:"second",objects:[]}]};
    for (let i=0;i<3;i++) source=applyPatches(source,[{op:"addObject",pageId:"second",object:createNativeSingleBondMolecule(source,{x:180+i*100,y:260})}]);
    const secondNote={...note,id:"second-page-note",text:"PAGE TWO ONLY",x:200,y:300};
    source=applyPatches(source,[{op:"addObject",pageId:"second",object:secondNote}]);
    source=selectDocumentObjects(source,"second",source.pages[1].objects.filter(o=>o.type==="molecule").map(o=>o.id));
    source=arrangeSelectedDocumentObjects(source,"circle",{gap:100}).document;
    const container=document.createElement("div");document.body.append(container);const root=createRoot(container),save=vi.fn();
    try {
      await act(async()=>root.render(createElement(ArrangementSpacingDialog,{document:source,onSave:save,onCancel:vi.fn()})));
      const svg=decodeURIComponent(container.querySelector<HTMLImageElement>("img")!.src.split(",").slice(1).join(","));
      expect(svg).toContain("PAGE TWO ONLY");expect(svg).not.toContain("PAGE ONE ONLY");
      const preview = new DOMParser().parseFromString(svg, "image/svg+xml");
      const boundary = preview.querySelector('[data-arrangement-page-boundary]')!;
      expect(boundary).not.toBeNull();
      expect(["x", "y", "width", "height"].map(key => Number(boundary.getAttribute(key))))
        .toEqual([0, 0, source.pages[1].width, source.pages[1].height]);
      const frame = preview.documentElement.getAttribute("viewBox")!;
      const [x, y, width, height] = frame.split(" ").map(Number);
      expect(x).toBeLessThan(0);expect(y).toBeLessThan(0);
      expect(x + width).toBeGreaterThan(source.pages[1].width);
      expect(y + height).toBeGreaterThan(source.pages[1].height);
      expect(container.textContent).toContain("Spacing stops at the page edge or 150%");
      const slider=container.querySelector<HTMLInputElement>('input[type="range"]')!;
      const value=Math.ceil((Number(slider.min)+100)/2);
      await act(async()=>{Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,"value")!.set!.call(slider,String(value));slider.dispatchEvent(new Event("input",{bubbles:true}));});
      const changedSvg=decodeURIComponent(container.querySelector<HTMLImageElement>("img")!.src.split(",").slice(1).join(","));
      const changedPreview=new DOMParser().parseFromString(changedSvg,"image/svg+xml");
      expect(changedSvg).not.toBe(svg);
      expect(changedPreview.documentElement.getAttribute("viewBox")).toBe(frame);
      expect(changedPreview.querySelector('[data-arrangement-page-boundary]')!.outerHTML).toBe(boundary.outerHTML);
      await act(async()=>container.querySelector("form")!.dispatchEvent(new Event("submit",{bubbles:true,cancelable:true})));
      expect(save).toHaveBeenCalledWith(value/100);
      const result=adjustArrangementSpacing(source,save.mock.calls[0][0]);expect(result.ok).toBe(true);
      expect(result.document.pages[0]).toEqual(first);expect(result.document.pages[1]).not.toEqual(source.pages[1]);
      expect(result.document.selection).toEqual(source.selection);
    } finally {await act(async()=>root.unmount());container.remove();}
  });
});
