// @vitest-environment jsdom
import { act, createElement, useState } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { applyPatch, createCustomPageLayout, type ChemDraftDocument, type TextObject } from "@chemdraft/chem-core";
import { createDefaultExportDialogState, createDialogExportResult, createDialogExportPreview, exportDialogFrame } from "./MainWindow";
import { ExportForm } from "./dialogs/ExportForm";
import { defaultExportPresentation } from "./dialogs/exportPresentation";
import type { ExportDialogState } from "./dialogs/exportOptions";
import { copyAsScopedDocument, createPhase4Document, exportPhase4Pdf, exportPhase4Svg } from "./documentWorkflow";
import { rasterizeSvgNative, type NativeRasterExportResult } from "./nativeRasterExport";

vi.mock("./window-manager", async (original) => ({
  ...await original<typeof import("./window-manager")>(), isDesktopRuntime: () => true
}));
vi.mock("./documentWorkflow", async (original) => {
  const actual = await original<typeof import("./documentWorkflow")>();
  return { ...actual, copyAsScopedDocument: vi.fn(actual.copyAsScopedDocument), exportPhase4Pdf: vi.fn(actual.exportPhase4Pdf) };
});
vi.mock("./nativeRasterExport", () => ({ rasterizeSvgNative: vi.fn() }));
const raster: NativeRasterExportResult = { bytes: new Uint8Array([1]), width: 800, height: 400, warnings: [] };
const mounted: Array<() => Promise<void>> = [];
const createUrl = vi.fn(() => "blob:preview");
beforeEach(() => {
  vi.useFakeTimers();
  vi.clearAllMocks();
  createUrl.mockReset().mockReturnValue("blob:preview");
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
async function mount(document: ChemDraftDocument, format: "png" | "svg" | "pdf" | "bmp" | "gif" | "tiff" = "png", crop: "page" | "content" = "page") {
  const frame = exportDialogFrame(document);
  const initial: ExportDialogState & { presentation: NonNullable<ExportDialogState["presentation"]> } = { ...createDefaultExportDialogState(document), format, presentation: { ...defaultExportPresentation(frame.page), crop } };
  let selected = initial;
  const submitted = vi.fn();
  let changeBusy!: (busy: boolean) => void;
  function Dialog() {
    const [state, setState] = useState<ExportDialogState>(initial);
    selected = state as typeof initial;
    changeBusy = busy => setState(current => ({ ...current, busy }));
    return createElement(ExportForm, {
      state, frame, renderPreview: (options) => createDialogExportPreview(document, options),
      onChange: setState, onCancel: vi.fn(), onChooseDestination: vi.fn(),
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
    host, form, frame, submitted, selected: () => selected,
    busy: async (busy: boolean) => { await act(async () => changeBusy(busy)); },
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
  await expect(createDialogExportResult(landscapeDocument(), { ...pdf.selected(), presentation: { ...pdf.selected().presentation, width: 8190, dpi: 36 } })).rejects.toThrow("14400");
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
  expect(parseFloat(svg.getAttribute("width")!)).toBeCloseTo(2008 / 600 * 25.4, 4);
  expect(svg.getAttribute("width")).toMatch(/mm$/);
  expect(parseFloat(svg.getAttribute("height")!)).toBeCloseTo(1004 / 600 * 25.4, 4);
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
  const newestPreview = dialog.host.querySelector("img")!.getAttribute("src");
  expect(newestPreview).toMatch(/^data:image/);
  await act(async () => finishOld(raster));
  expect(dialog.host.querySelector("img")!.getAttribute("src")).toBe(newestPreview);

});


it("submits on Enter from the filename field exactly once, but not when invalid or composing", async () => {
  const dialog = await mount(landscapeDocument());
  const filename = dialog.host.querySelector("#chemdraft-export-filename")!;
  await act(async () => filename.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true })));
  expect(dialog.submitted).toHaveBeenCalledTimes(1);
  await act(async () => filename.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", isComposing: true, bubbles: true, cancelable: true })));
  expect(dialog.submitted).toHaveBeenCalledTimes(1);
  await editInput(dialog.host, "Width (px)", "9000");
  await act(async () => filename.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true })));
  expect(dialog.submitted).toHaveBeenCalledTimes(1);
});

it("allows a blank width and reports the entered out-of-range size without clamping the hint", async () => {
  const dialog = await mount(landscapeDocument());
  await editInput(dialog.host, "Width (px)", "");
  const width = [...dialog.host.querySelectorAll("label")].find((label) => label.textContent?.startsWith("Width (px)"))!.querySelector("input")!;
  expect(width.value).toBe("");
  expect((dialog.host.querySelector('button[type="submit"]') as HTMLButtonElement).disabled).toBe(true);
  await editInput(dialog.host, "Width (px)", "1000");
  expect(width.value).toBe("1000");
  await editInput(dialog.host, "Width (px)", "9000");
  expect(dialog.host.textContent).toContain("9000");
  expect(dialog.host.textContent).not.toContain("8192 ? 4096");
});

it("unlinks pixel and physical dimensions, exports both requested sides and still caps previews", async () => {
  const document = landscapeDocument();
  const dialog = await mount(document);
  await dialog.preset("poster");
  await act(async () => dialog.host.querySelector<HTMLInputElement>('input[type="checkbox"]')!.click());
  await editInput(dialog.host, "Height (px)", "6000");
  await editInput(dialog.host, "Width (px)", "3000");
  expect(dialog.selected().presentation).toMatchObject({ width: 3000, height: 6000, linked: false, preset: "custom" });
  expect(dialog.form.checkValidity()).toBe(true);
  await tick();
  const preview = svgRoot(vi.mocked(rasterizeSvgNative).mock.calls.at(-1)![0]);
  expect(preview.getAttribute("width")).toBe("400");
  expect(preview.getAttribute("height")).toBe("800");
  await createDialogExportResult(document, dialog.selected());
  const final = svgRoot(vi.mocked(rasterizeSvgNative).mock.calls.at(-1)![0]);
  expect(final.getAttribute("width")).toBe("3000");
  expect(final.getAttribute("height")).toBe("6000");
  await editInput(dialog.host, "Physical height", "254");
  expect(dialog.selected().presentation).toMatchObject({ width: 3000, height: 3000 });
  await act(async () => dialog.host.querySelector<HTMLInputElement>('input[type="checkbox"]')!.click());
  expect(dialog.selected().presentation.linked).toBe(true);
  expect([...dialog.host.querySelectorAll("label")].find((l) => l.textContent?.startsWith("Height (px)"))!.querySelector("input")!.value).toBe("1500");
});

it("applies keyboard preset navigation only on commit and resets to Custom after manual edits", async () => {
  const dialog = await mount(landscapeDocument());
  const select = dialog.host.querySelector<HTMLSelectElement>('[aria-label="Size preset"]')!;
  const original = dialog.selected().presentation.width;
  await act(async () => {
    select.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true }));
    select.value = "slide";
    select.dispatchEvent(new Event("change", { bubbles: true }));
  });
  expect(dialog.selected().presentation.width).toBe(original);
  await act(async () => { select.value = "poster"; select.dispatchEvent(new Event("change", { bubbles: true })); });
  expect(dialog.selected().presentation.width).toBe(original);
  await act(async () => select.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true })));
  expect(dialog.selected().presentation.width).toBe(7200);
  expect(dialog.submitted).not.toHaveBeenCalled();
  await editInput(dialog.host, "Width (px)", "2000");
  expect(select.value).toBe("custom");
});

it("displays export errors inside the dialog", async () => {
  const dialog = await mount(landscapeDocument());
  // Renderer failures are surfaced beside the live preview.
  vi.mocked(rasterizeSvgNative).mockRejectedValueOnce(new Error("renderer refused"));
  await tick();
  expect(dialog.host.textContent).toContain("renderer refused");
});


it("keeps a single PDF preview object in the tab order without external navigation", async () => {
  vi.mocked(exportPhase4Pdf).mockResolvedValueOnce({ format: "pdf", kind: "binary", bytes: new Uint8Array([1]), mimeType: "application/pdf", extension: "pdf", warnings: [] });
  const dialog = await mount(landscapeDocument(), "pdf");
  await tick();
  expect(dialog.host.querySelector("object")!.tabIndex).toBe(0);
  expect(dialog.host.querySelector("a")).toBeNull();
});


it("rejects fractional and out-of-range linked height without rounding it into a valid value", async () => {
  const dialog = await mount(landscapeDocument());
  await editInput(dialog.host, "Height (px)", "1.5");
  expect([...dialog.host.querySelectorAll("label")].find(label => label.textContent?.startsWith("Height (px)"))!.querySelector("input")!.value).toBe("1.5");
  expect(dialog.selected().presentation.height).toBeUndefined();
  expect((dialog.host.querySelector('button[type="submit"]') as HTMLButtonElement).disabled).toBe(true);
  await editInput(dialog.host, "Height (px)", "8192.4");
  expect([...dialog.host.querySelectorAll("label")].find(label => label.textContent?.startsWith("Height (px)"))!.querySelector("input")!.value).toBe("8192.4");
  expect(dialog.selected().presentation.height).toBeUndefined();
  expect((dialog.host.querySelector('button[type="submit"]') as HTMLButtonElement).disabled).toBe(true);
  await editInput(dialog.host, "Width (px)", "1000");
  expect(dialog.selected().presentation.height).toBeUndefined();
  expect((dialog.host.querySelector('button[type="submit"]') as HTMLButtonElement).disabled).toBe(false);
});

it("preserves physical-size textual drafts through sequential typing", async () => {
  const dialog = await mount(landscapeDocument());
  await dialog.preset("poster");
  const input = [...dialog.host.querySelectorAll("label")].find((l) => l.textContent?.startsWith("Physical width"))!.querySelector("input")!;
  for (const text of ["", "8", "85", "85.", "85.0", "85.01"]) {
    await editInput(dialog.host, "Physical width", text);
    expect(input.value).toBe(text);
  }
  expect(dialog.selected().presentation.width).toBe(1004);
  await act(async () => { input.focus(); input.blur(); });
  expect(input.value).toBe("85.01");
});

it("cancels a pending keyboard preset on Escape and commits it on blur", async () => {
  const dialog = await mount(landscapeDocument());
  const select = dialog.host.querySelector<HTMLSelectElement>('[aria-label="Size preset"]')!;
  const width = dialog.selected().presentation.width;
  const navigate = async () => { await act(async () => {
    select.focus();
    select.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true }));
    select.value = "poster"; select.dispatchEvent(new Event("change", { bubbles: true }));
  }); };
  await navigate();
  await act(async () => select.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true })));
  expect(select.value).toBe("custom");
  expect(dialog.selected().presentation.width).toBe(width);
  await navigate();
  await act(async () => select.blur());
  expect(dialog.selected().presentation.width).toBe(7200);
});


it("recomputes a linked height override when crop changes the frame ratio", async () => {
  const dialog = await mount(tallDocument());
  await editInput(dialog.host, "Height (px)", "600");
  const width = dialog.selected().presentation.width;
  const crop = [...dialog.host.querySelectorAll("select")].find((select) => select.querySelector('option[value="content"]'))!;
  await act(async () => { crop.value = "content"; crop.dispatchEvent(new Event("change", { bubbles: true })); });
  expect(dialog.selected().presentation.height).toBeUndefined();
  const frame = copyAsScopedDocument({ ...tallDocument(), selection: { objectIds: [] } });
  const expected = Math.round(width * frame.pages[0].height / frame.pages[0].width);
  const height = [...dialog.host.querySelectorAll("label")].find((l) => l.textContent?.startsWith("Height (px)"))!.querySelector("input")!;
  expect(Number(height.value)).toBe(expected);
});

it.each(["bmp", "gif", "tiff"] as const)("previews %s as browser-decodable PNG but keeps final format", async format => {
  const document = landscapeDocument();
  const dialog = await mount(document, format);
  await tick();
  expect(dialog.host.querySelector("img")!.getAttribute("src")).toMatch(/^data:image\/png;base64,/);
  expect(vi.mocked(rasterizeSvgNative).mock.calls[0][1]).toBe("png");
  await createDialogExportResult(document, dialog.selected());
  expect(vi.mocked(rasterizeSvgNative).mock.calls.at(-1)![1]).toBe(format);
});

it("does not rerender previews when only the filename changes", async () => {
  const dialog = await mount(landscapeDocument());
  await tick();
  expect(rasterizeSvgNative).toHaveBeenCalledTimes(1);
  const filename = dialog.host.querySelector<HTMLInputElement>("#chemdraft-export-filename")!;
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(filename, "Renamed.png");
    filename.dispatchEvent(new Event("input", { bubbles: true }));
  });
  await tick();
  expect(rasterizeSvgNative).toHaveBeenCalledTimes(1);
});

it("keeps blank and invalid numeric drafts local and skips their previews", async () => {
  const dialog = await mount(landscapeDocument());
  await tick();
  const original = dialog.selected().presentation.width;
  for (const value of ["", "9000", "1.5"]) {
    await editInput(dialog.host, "Width (px)", value);
    expect(dialog.selected().presentation.width).toBe(original);
    expect((dialog.host.querySelector('button[type="submit"]') as HTMLButtonElement).disabled).toBe(true);
    await tick();
  }
  expect(rasterizeSvgNative).toHaveBeenCalledTimes(1);
  await editInput(dialog.host, "Width (px)", "1000");
  await tick();
  expect(rasterizeSvgNative).toHaveBeenCalledTimes(2);
});

it("refreshes a changed document revision with the same frame dimensions without resetting edits", async () => {
  const dialog = await mount(landscapeDocument());
  await dialog.preset("poster");
  await tick();
  expect(rasterizeSvgNative).toHaveBeenCalledTimes(1);
  dialog.frame.revision = 1;
  const filename = dialog.host.querySelector<HTMLInputElement>("#chemdraft-export-filename")!;
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(filename, "Keep this.png");
    filename.dispatchEvent(new Event("input", { bubbles: true }));
  });
  await tick();
  expect(rasterizeSvgNative).toHaveBeenCalledTimes(2);
  expect(dialog.selected().filename).toBe("Keep this.png");
  expect(dialog.selected().presentation.preset).toBe("poster");
  expect(dialog.selected().presentation.width).toBe(7200);
});

it("caches frames per document identity and changes revision for an immutable edit at the same dimensions", () => {
  const document = landscapeDocument();
  const original = exportDialogFrame(document);
  expect(exportDialogFrame(document)).toBe(original);
  const edited = { ...document, title: "Edited drawing" };
  const next = exportDialogFrame(edited);
  expect(next.page).toEqual(original.page);
  expect(next.content).toEqual(original.content);
  expect(next.revision).not.toBe(original.revision);
  expect(exportDialogFrame(edited)).toBe(next);
});

it("preserves default SVG export bytes for an unsized custom page taller than 8192 pixels", async () => {
  const document = landscapeDocument();
  const page = { ...document.pages[0], width: 1000, height: 10000, layout: createCustomPageLayout(1000, 10000, "css-px") };
  const tall = { ...document, pages: [page] };
  const state = { ...createDefaultExportDialogState(tall), format: "svg" as const };
  expect(state.presentation).toBeUndefined();
  const result = await createDialogExportResult(tall, state);
  expect(result.kind === "text" && result.contents).toBe(exportPhase4Svg(tall, state.svg).contents);
});

it("restarts a pending preview after a destination picker busy cycle", async () => {
  let finishOld!: (result: NativeRasterExportResult) => void;
  vi.mocked(rasterizeSvgNative).mockImplementationOnce(() => new Promise(resolve => { finishOld = resolve; }));
  const dialog = await mount(landscapeDocument());
  await tick();
  expect(rasterizeSvgNative).toHaveBeenCalledTimes(1);
  await dialog.busy(true);
  await tick();
  expect(rasterizeSvgNative).toHaveBeenCalledTimes(1);
  await dialog.busy(false);
  await tick();
  expect(rasterizeSvgNative).toHaveBeenCalledTimes(2);
  const source = dialog.host.querySelector("img")!.getAttribute("src");
  await act(async () => finishOld({ ...raster, bytes: new Uint8Array([2]) }));
  expect(dialog.host.querySelector("img")!.getAttribute("src")).toBe(source);
});
