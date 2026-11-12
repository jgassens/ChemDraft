// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import { SketchStylePreset, type NativeDrawingStyle } from "@chemdraft/chem-core";
import { atomLabelRunAdvance } from "@chemdraft/layout-engine";
import { canvasFontFallback, loadCanvasHandwritingFont, useCanvasHandwritingFont } from "./canvasHandwritingFont";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
afterEach(() => vi.restoreAllMocks());

function Probe({ style }: { style: NativeDrawingStyle }) {
  const available = useCanvasHandwritingFont(style);
  return createElement("svg", {}, createElement("text", { fontFamily: available.atomLabelFontFamily,
    "data-width": atomLabelRunAdvance({ text: "OH", script: "normal" }, available) }, "OH"));
}

it.each([false, true])("uses sans metrics while loading and redraws only on successful load (failure=%s)", async failure => {
  let finish!: (faces: FontFace[]) => void;
  let fail!: (error: Error) => void;
  const fonts = { load: vi.fn(() => new Promise<FontFace[]>((resolve, reject) => { finish = resolve; fail = reject; })),
    check: vi.fn(() => true) } as unknown as FontFaceSet;
  Object.defineProperty(document, "fonts", { configurable: true, get: () => fonts });
  const container = document.createElement("div"), root = createRoot(container);
  const original = structuredClone(SketchStylePreset.drawing);
  const sans = canvasFontFallback(original);
  const width = (style: NativeDrawingStyle) => String(atomLabelRunAdvance({ text: "OH", script: "normal" }, style));
  try {
    await act(async () => root.render(createElement(Probe, { style: original })));
    expect(container.querySelector("text")!.getAttribute("font-family")).toBe("Arial, Helvetica, sans-serif");
    expect(container.querySelector("text")!.getAttribute("data-width")).toBe(width(sans));
    await act(async () => { if (failure) fail(new Error("Bundled font unavailable")); else finish([{} as FontFace]); });
    const expected = failure ? sans : original;
    expect(container.querySelector("text")!.getAttribute("font-family")).toBe(expected.atomLabelFontFamily);
    expect(container.querySelector("text")!.getAttribute("data-width")).toBe(width(expected));
    expect(original).toEqual(SketchStylePreset.drawing);
    expect(fonts.load).toHaveBeenCalledTimes(1);
  } finally { await act(async () => root.unmount()); }
});

it("treats an empty font load as failure and coalesces requests", async () => {
  const fonts = { load: vi.fn(async () => []), check: vi.fn(() => true) } as unknown as FontFaceSet;
  expect(await Promise.all([loadCanvasHandwritingFont(fonts), loadCanvasHandwritingFont(fonts)])).toEqual([false, false]);
  expect(fonts.load).toHaveBeenCalledTimes(1);
});
