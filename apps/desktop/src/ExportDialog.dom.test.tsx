// @vitest-environment jsdom
import { act, createElement, useState } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { applyPatch, createCustomPageLayout, type ChemDraftDocument, type TextObject } from "@chemdraft/chem-core";
import { ExportDialog, createDefaultExportDialogState, createDialogExportResult } from "./MainWindow";
import { copyAsScopedDocument, createPhase4Document } from "./documentWorkflow";
import { rasterizeSvgNative, type NativeRasterExportResult } from "./nativeRasterExport";

vi.mock("./window-manager", async (original) => ({
  ...await original<typeof import("./window-manager")>(), isDesktopRuntime: () => true
}));
vi.mock("./documentWorkflow", async (original) => {
  const actual = await original<typeof import("./documentWorkflow")>();
  return { ...actual, copyAsScopedDocument: vi.fn(actual.copyAsScopedDocument) };
});
vi.mock("./nativeRasterExport", () => ({ rasterizeSvgNative: vi.fn() }));
const raster: NativeRasterExportResult = { bytes: new Uint8Array([1]), width: 800, height: 400, warnings: [] };
const mounted: Array<() => Promise<void>> = [];
const createUrl = vi.fn(() => "blob:preview");
beforeEach(() => {
  vi.useFakeTimers();
  vi.clearAllMocks();
  vi.mocked(rasterizeSvgNative).mockReset().mockResolvedValue(raster);
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  // Replace rather than mutate the original URL constructor.
  class PreviewURL extends URL {
    static createObjectURL = createUrl;
    static revokeObjectURL = vi.fn();
  }
  vi.stubGlobal("URL", PreviewURL);
});
afterEach(async () => {
  for (const unmount of mounted.splice(0)) await unmount();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

function landscapeDocument() {
  const document = createPhase4Document();
  return { ...document, pages: [{ ...document.pages[0], width: 1000, height: 500, layout: createCustomPageLayout(1000, 500, "css-px") }] };
}
function tallDocument() {
  const object: TextObject = {
    id: "tall_text", type: "text", x: 50, y: 50, width: 80, height: 1000,
    rotation: 0, text: "Tall drawing", spans: [], style: { fontSize: 12 }
  };
  return applyPatch(createPhase4Document(), { op: "addObject", pageId: "page_001", object });
}
async function mount(document: ChemDraftDocument, format: "png" | "svg" | "pdf" = "png", crop: "page" | "content" = "page") {
  const initial: ReturnType<typeof createDefaultExportDialogState> = { ...createDefaultExportDialogState(document), format, presentation: { ...createDefaultExportDialogState(document).presentation, crop } };
  let selected = initial;
  const submitted = vi.fn();
  function Dialog() {
    const [state, setState] = useState(initial);
    selected = state;
    return createElement(ExportDialog, {
      document, state,
      onPresentationChange: (options) => setState((current) => ({ ...current, presentation: { ...current.presentation, ...options } })),
      onRasterOptionsChange: (options) => setState((current) => ({ ...current, raster: { ...current.raster, ...options } })),
      onFilenameChange: (filename) => setState((current) => ({ ...current, filename })),
      onFormatChange: (format) => setState((current) => ({ ...current, format })),
      onCancel: vi.fn(), onChooseDestination: vi.fn(), onSvgOptionsChange: vi.fn(),
      onPdfOptionsChange: vi.fn(), onCdxmlOptionsChange: vi.fn(),
      onSubmit: (event) => { event.preventDefault(); submitted(); }
    });
  }
  const host = window.document.createElement("div");
  window.document.body.append(host);
  const root = createRoot(host);
  await act(async () => root.render(createElement(Dialog)));
  mounted.push(async () => { await act(async () => root.unmount()); host.remove(); });
  const form = host.querySelector("form")!;
  const preset = [...host.querySelectorAll("select")].find((select) => select.querySelector('option[value="poster"]'))!;
  return {
    host, form, submitted, selected: () => selected,
    preset: async (value: string) => { await act(async () => { preset.value = value; preset.dispatchEvent(new Event("change", { bubbles: true })); }); }
  };
}
async function editInput(host: HTMLElement, label: string, value: string) {
  const input = [...host.querySelectorAll("label")].find((element) => element.textContent?.startsWith(label))!.querySelector("input")!;
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}
async function tick(ms = 250) { await act(async () => { await vi.advanceTimersByTimeAsync(ms); }); }
function svgRoot(source: string) { return new DOMParser().parseFromString(source, "image/svg+xml").documentElement; }

it("debounces the 7200 px poster preset and caps preview rendering without shrinking final export", async () => {
  const document = landscapeDocument();
  const dialog = await mount(document);
  await dialog.preset("poster");
  expect(dialog.selected().presentation.width).toBe(7200);
  await tick(249);
  expect(rasterizeSvgNative).not.toHaveBeenCalled();
  await tick(1);
  expect(rasterizeSvgNative).toHaveBeenCalledTimes(1);
  const preview = svgRoot(vi.mocked(rasterizeSvgNative).mock.calls[0][0]);
  expect(Math.max(Number(preview.getAttribute("width")), Number(preview.getAttribute("height")))).toBe(800);
  await createDialogExportResult(document, dialog.selected());
  const final = svgRoot(vi.mocked(rasterizeSvgNative).mock.calls[1][0]);
  expect(final.getAttribute("width")).toBe("7200");
  expect(final.getAttribute("height")).toBe("3600");
});

it.each(["slide", "poster", "publication"])("submits the real form for %s and after a pixel edit", async (preset) => {
  const dialog = await mount(landscapeDocument());
  await dialog.preset(preset);
  expect(dialog.form.checkValidity()).toBe(true);
  await act(async () => dialog.form.requestSubmit());
  expect(dialog.submitted).toHaveBeenCalledTimes(1);
  await editInput(dialog.host, "Width (px)", "2011");
  expect(dialog.selected().presentation.width).toBe(2011);
  expect(dialog.form.checkValidity()).toBe(true);
  await act(async () => dialog.form.requestSubmit());
  expect(dialog.submitted).toHaveBeenCalledTimes(2);
});

it.each(["Letter page", "tall drawing"])("fits every preset to a portrait %s", async (kind) => {
  const document = kind === "Letter page" ? createPhase4Document() : tallDocument();
  const dialog = await mount(document);
  for (const preset of ["slide", "poster", "publication"]) {
    await dialog.preset(preset);
    expect(dialog.form.checkValidity()).toBe(true);
    expect(dialog.host.querySelector('[role="alert"]')).toBeNull();
    expect((dialog.host.querySelector('button[type="submit"]') as HTMLButtonElement).disabled).toBe(false);
    await act(async () => dialog.form.requestSubmit());
    const result = await createDialogExportResult(document, dialog.selected());
    expect(result.kind).toBe("binary");
    const source = svgRoot(vi.mocked(rasterizeSvgNative).mock.calls.at(-1)![0]);
    expect(Math.max(Number(source.getAttribute("width")), Number(source.getAttribute("height")))).toBeLessThanOrEqual(7200);
  }
  expect(dialog.submitted).toHaveBeenCalledTimes(3);
});

it("shows actionable size and PDF physical-limit errors beside the fields", async () => {
  const dialog = await mount(createPhase4Document());
  await editInput(dialog.host, "Width (px)", "8192");
  expect(dialog.host.querySelector('[role="alert"]')!.textContent).toMatch(/8192.*Reduce/);
  expect((dialog.host.querySelector('button[type="submit"]') as HTMLButtonElement).disabled).toBe(true);
  const pdf = await mount(landscapeDocument(), "pdf");
  await editInput(pdf.host, "Width (px)", "8190");
  await editInput(pdf.host, "DPI", "36");
  expect(pdf.host.querySelector('[role="alert"]')!.textContent).toMatch(/14400.*increase DPI/);
  await expect(createDialogExportResult(landscapeDocument(), pdf.selected())).rejects.toThrow("14400");
});

it("does not recrop after filename or pixel edits and reuses the frame for preview and final export", async () => {
  const document = tallDocument();
  const dialog = await mount(document, "png", "content");
  expect(copyAsScopedDocument).toHaveBeenCalledTimes(1);
  const filename = dialog.host.querySelector<HTMLInputElement>("#chemdraft-export-filename")!;
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(filename, "renamed.png");
    filename.dispatchEvent(new Event("input", { bubbles: true }));
  });
  expect(dialog.selected().filename).toBe("renamed.png");
  await editInput(dialog.host, "Width (px)", "500");
  await tick();
  await createDialogExportResult(document, dialog.selected());
  expect(copyAsScopedDocument).toHaveBeenCalledTimes(1);
});

it("writes DPI-derived physical SVG dimensions while retaining the frame viewBox", async () => {
  const document = landscapeDocument();
  const dialog = await mount(document, "svg");
  await dialog.preset("publication");
  const result = await createDialogExportResult(document, dialog.selected());
  expect(result.kind).toBe("text");
  if (result.kind !== "text") throw new Error("Expected SVG");
  const svg = svgRoot(result.contents);
  expect(parseFloat(svg.getAttribute("width")!)).toBeCloseTo(2008 / 600 * 25.4, 6);
  expect(svg.getAttribute("width")).toMatch(/mm$/);
  expect(parseFloat(svg.getAttribute("height")!)).toBeCloseTo(1004 / 600 * 25.4, 6);
  expect(svg.getAttribute("height")).toMatch(/mm$/);
  expect(svg.getAttribute("viewBox")).toBe("0 0 1000 500");
});

it("ignores an old preview that finishes after the newer preview", async () => {
  let finishOld!: (value: NativeRasterExportResult) => void;
  let finishNew!: (value: NativeRasterExportResult) => void;
  vi.mocked(rasterizeSvgNative)
    .mockImplementationOnce(() => new Promise((resolve) => { finishOld = resolve; }))
    .mockImplementationOnce(() => new Promise((resolve) => { finishNew = resolve; }));
  createUrl.mockReturnValueOnce("blob:new").mockReturnValueOnce("blob:old");
  const dialog = await mount(landscapeDocument());
  await dialog.preset("slide");
  await tick();
  await dialog.preset("poster");
  await tick();
  await act(async () => finishNew(raster));
  expect(dialog.host.querySelector("img")!.getAttribute("src")).toBe("blob:new");
  await act(async () => finishOld(raster));
  expect(dialog.host.querySelector("img")!.getAttribute("src")).toBe("blob:new");
  expect(createUrl).toHaveBeenCalledTimes(1);
});
