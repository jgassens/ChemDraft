// @vitest-environment jsdom

import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createImageGraphicObject, MAX_IMAGE_OBJECT_BYTES, type ChemDraftDocument } from "@chemdraft/chem-core";
import { inspectClipboardPayload, type ClipboardReadPayload } from "@chemdraft/clipboard-adapter";
import { documentDrawingDefaults } from "@chemdraft/document-workflow-core";
import { MainWindow, selectionInSelectionRect, selectionInSelectionPolygon } from "./MainWindow";
import * as clipboard from "./clipboard";
import * as smilesPaste from "./smilesListPaste";
import * as smilesIdentity from "./smilesPasteIdentity";
import * as windowManager from "./window-manager";
import { createPhase4Document } from "./documentWorkflow";
import { pictureSvg } from "./testSupport/imageFixture";

const picturePngBase64 = "iVBORw0KGgoAAAANSUhEUgAAAJAAAABICAYAAAAZK3z6AAAA80lEQVR4nO3OsQkAMBDEsNt/6c8OaYzBhXptu0v+4YG44YG44YG44YG44YG44YG44YG44YG44YG44YG44YG44YG44YG44YG44YG44YG44YG44YG44YG44YG44YG44YG44YG44YG44YG44YG44YG44YG44YG44YG44YG44YG44YG44YG44YG44YG44YG44YG44YG44YG44YG44YG44YG44YG44YG44YG44YG44YG44YG44YG44YG44YG44YG44YG44YG44YG44YG44YG44YG44YG44YG44YG44YG44YG44YG44YG44YG44YG44YG44YG44YGYPTnRs7EzXJbBAAAAAElFTkSuQmCC";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const pageRect = { x: 0, y: 0, left: 0, top: 0, right: 792, bottom: 612, width: 792, height: 612, toJSON: () => ({}) } as DOMRect;
const nativeImage: ClipboardReadPayload = {
  types: ["image/png"], textItems: [], imageItems: [{
    type: "image/png", bytesBase64: picturePngBase64, pixelWidth: 144, pixelHeight: 72,
    pixelsPerMeter: { x: 11811, y: 11811 }
  }]
};

// Transparent PNGs with matching IHDR dimensions; only the first carries pHYs (5669 px/m).
const sizeCases = [
  { name: "144-dpi PNG", pixelWidth: 288, pixelHeight: 144, width: 192, height: 96,
    bytesBase64: "iVBORw0KGgoAAAANSUhEUgAAASAAAACQCAYAAACoPrZBAAAACXBIWXMAABYlAAAWJQFJUiTwAAAAuElEQVR42u3BMQEAAADCoPVPbQ0PoAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAACAFwOIrgABLLiMAwAAAABJRU5ErkJggg==" },
  { name: "no-DPI DIB converted to PNG", pixelWidth: 288, pixelHeight: 144, width: 288, height: 144,
    bytesBase64: "iVBORw0KGgoAAAANSUhEUgAAASAAAACQCAYAAACoPrZBAAAAuElEQVR42u3BMQEAAADCoPVPbQ0PoAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAACAFwOIrgABLLiMAwAAAABJRU5ErkJggg==" },
  { name: "no-DPI screen capture", pixelWidth: 600, pixelHeight: 300, width: 600, height: 300,
    bytesBase64: "iVBORw0KGgoAAAANSUhEUgAAAlgAAAEsCAYAAAAfPc2WAAAC0ElEQVR42u3BAQ0AAADCoPdPbQ8HFAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAADwbP5CAAExinjxAAAAAElFTkSuQmCC" }
];

describe("picture paste and canvas", () => {
  let container: HTMLDivElement;
  let root: Root;
  const captureMethods = {
    setPointerCapture: Element.prototype.setPointerCapture,
    releasePointerCapture: Element.prototype.releasePointerCapture,
    hasPointerCapture: Element.prototype.hasPointerCapture
  };

  beforeEach(() => {
    vi.stubGlobal("ResizeObserver", class { observe() {} unobserve() {} disconnect() {} });
    vi.stubGlobal("Image", class { src = ""; async decode() {} });
    Element.prototype.setPointerCapture = () => {};
    Element.prototype.releasePointerCapture = () => {};
    Element.prototype.hasPointerCapture = () => false;
    window.history.replaceState(null, "", "/?agentBridge=1");
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    window.history.replaceState(null, "", "/");
    delete window.__CHEMDRAFT_AGENT__;
    Object.assign(Element.prototype, captureMethods);
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  async function render(initialDocument = createPhase4Document("Pictures")) {
    await act(async () => root.render(createElement(MainWindow, {
      initialDocument, initialActiveToolCommandId: "tool.select", initialCrosshairsVisible: false,
      initialPaletteMode: "hidden", initialRulersVisible: false, nativePalette: true
    })));
    page().getBoundingClientRect = () => pageRect;
    const canvas = container.querySelector<HTMLElement>(".canvas-region")!;
    canvas.getBoundingClientRect = () => pageRect;
    Object.defineProperties(canvas, { clientWidth: { value: 792 }, clientHeight: { value: 612 } });
  }

  const page = () => container.querySelector<HTMLElement>(".page")!;
  const bridge = () => window.__CHEMDRAFT_AGENT__!;
  const snapshot = () => bridge().snapshot().document;
  const canUndo = () => container.querySelector('[data-can-undo="true"]') !== null;
  async function command(id: string) { await act(async () => { await bridge().command(id); }); }

  function deferred<T>() {
    let resolve!: (value: T) => void;
    let reject!: (reason: unknown) => void;
    const promise = new Promise<T>((resolvePromise, rejectPromise) => {
      resolve = resolvePromise;
      reject = rejectPromise;
    });
    return { promise, resolve, reject };
  }

  function pointer(target: EventTarget, type: string, x: number, y: number, shiftKey = false) {
    const event = new MouseEvent(type, { bubbles: true, cancelable: true, button: 0,
      buttons: type === "pointerup" ? 0 : 1, clientX: x, clientY: y, shiftKey });
    Object.defineProperties(event, { pointerId: { value: 1 }, pointerType: { value: "mouse" }, isPrimary: { value: true } });
    target.dispatchEvent(event);
  }

  async function pasteFiles(files: File[]) {
    const event = new Event("paste", { bubbles: true, cancelable: true });
    Object.defineProperty(event, "clipboardData", { value: { types: ["Files"], files, getData: () => "" } });
    await act(async () => {
      window.dispatchEvent(event);
      await new Promise(resolve => setTimeout(resolve, 30));
    });
    expect(event.defaultPrevented).toBe(true);
  }

  it("inserts a native picture at physical size at the viewport centre, selected, as one Paste Picture undo", async () => {
    await render();
    vi.spyOn(clipboard, "readClipboardPayload").mockResolvedValue(nativeImage);
    await command("clipboard.paste");
    const document = snapshot();
    const image = document.pages[0]!.objects.find(object => object.type === "graphic")!;
    const width = 144 / (11811 * 0.0254) * 96;
    expect(image).toMatchObject({ graphicKind: "image", width, height: width / 2 });
    expect(image.x + image.width / 2).toBeCloseTo(396);
    expect(image.y + image.height / 2).toBeCloseTo(306);
    expect(document.selection.objectIds).toEqual([image.id]);
    expect(container.querySelector(".graphic-glyph-image")?.getAttribute("href")).toBe(`data:image/png;base64,${picturePngBase64}`);
    await command("edit.undo");
    expect(container.querySelector('[role="status"]')?.textContent).toBe("Undid Paste Picture");
    expect(snapshot().pages[0]!.objects).toHaveLength(0);
    expect(canUndo()).toBe(false);
    await command("edit.redo");
    expect(container.querySelector('[role="status"]')?.textContent).toBe("Redid Paste Picture");
    expect(snapshot().pages[0]!.objects).toEqual(document.pages[0]!.objects);
  });

  it.each(sizeCases.flatMap(picture => [22, 34].map(bondLengthPx => ({ ...picture, bondLengthPx }))))(
    "centres $name at its physical size with bond length $bondLengthPx, despite a previous pointer position",
    async ({ bytesBase64, pixelWidth, pixelHeight, width, height, bondLengthPx }) => {
      const drawing = createPhase4Document("True picture size");
      drawing.styles.drawing = { ...documentDrawingDefaults(drawing).drawing, bondLengthPx };
      await render(drawing);
      if (bondLengthPx === 34) await command("view.zoomIn");
      page().getBoundingClientRect = () => ({ ...pageRect, left: 21, top: -115 });
      const canvas = container.querySelector<HTMLElement>(".canvas-region")!;
      canvas.getBoundingClientRect = () => ({ ...pageRect, left: 32, top: 80 });
      await act(async () => pointer(page(), "pointermove", 30, 100));
      const { scale } = bridge().snapshot().viewport as { scale: number };
      const centre = { x: 407 / scale, y: 501 / scale };
      vi.spyOn(clipboard, "readClipboardPayload").mockResolvedValue({
        types: ["image/png"], textItems: [], imageItems: [{ type: "image/png", bytesBase64, pixelWidth, pixelHeight }]
      });
      await command("clipboard.paste");
      const image = snapshot().pages[0]!.objects[0]!;
      expect(image).toMatchObject({ type: "graphic", graphicKind: "image" });
      // pHYs is integer pixels/m, so the 144-dpi frame differs by less than 0.01 unit.
      expect(image.width).toBeCloseTo(width, 1);
      expect(image.height).toBeCloseTo(height, 1);
      if (width === pixelWidth) expect([image.width, image.height]).toEqual([width, height]);
      expect(Math.abs(image.x + image.width / 2 - centre.x)).toBeLessThan(0.5);
      expect(Math.abs(image.y + image.height / 2 - centre.y)).toBeLessThan(0.5);
      expect(image.x).toBeCloseTo(centre.x - width / 2, 1);
      expect(image.y).toBeCloseTo(centre.y - height / 2, 1);
      expect(image.x).toBeGreaterThan(0);
    }
  );

  it("shows the specific refused-image message without changing document, selection or undo", async () => {
    const drawing = createPhase4Document("Refused Picture");
    const picture = createImageGraphicObject({ id: "existing", mimeType: "image/png", dataBase64: picturePngBase64, center: { x: 200, y: 200 } });
    drawing.pages[0]!.objects = [picture];
    drawing.selection.objectIds = [picture.id];
    await render(drawing);
    const before = snapshot();
    const reason = "PNG is 26.0 MB; the limit is 25 MB.";
    vi.spyOn(clipboard, "readClipboardPayload").mockResolvedValue({ types: ["image/png"], textItems: [],
      skippedImageItems: [{ type: "image/png", byteLength: 26 * 1024 * 1024, reason }] });
    await command("clipboard.paste");
    expect(container.querySelector('[role="status"]')?.textContent).toBe(`Couldn't paste the picture: ${reason}`);
    expect(snapshot()).toEqual(before);
    expect(canUndo()).toBe(false);
  });

  it.each(["image/png", "image/svg+xml"])("reads %s files in the DOM fallback as base64 and pastes them", async type => {
    await render();
    const bytes = type === "image/png" ? Uint8Array.from(atob(picturePngBase64), char => char.charCodeAt(0)) : pictureSvg;
    await pasteFiles([new File([bytes], "picture", { type })]);
    const image = snapshot().pages[0]!.objects.find(object => object.type === "graphic")!;
    expect(image).toMatchObject({ graphicKind: "image", data: { image: { mimeType: type,
      dataBase64: type === "image/png" ? picturePngBase64 : btoa(pictureSvg) } } });
    expect(image.width).toBe(144);
    expect(image.height).toBe(72);
    expect(snapshot().selection.objectIds).toEqual([image.id]);
    await command("edit.undo");
    expect(canUndo()).toBe(false);
  });

  it("refuses oversized DOM image files before reading them, with the shared limit message", async () => {
    await render();
    const file = new File([], "large.png", { type: "image/png" });
    Object.defineProperty(file, "size", { value: MAX_IMAGE_OBJECT_BYTES + 1024 * 1024 });
    const read = vi.spyOn(FileReader.prototype, "readAsDataURL");
    const payload = await clipboard.clipboardPayloadFromDataTransfer({ types: ["Files"], files: [file], getData: () => "" } as unknown as DataTransfer);
    expect(inspectClipboardPayload(payload)).toMatchObject({ kind: "image-refused", message: "Couldn't paste the picture: PNG is 26.0 MB; the limit is 25 MB." });
    expect(read).not.toHaveBeenCalled();
    await pasteFiles([file]);
    expect(snapshot().pages[0]!.objects).toHaveLength(0);
    expect(canUndo()).toBe(false);
  });

  it("refuses a framed PNG when the browser cannot decode it", async () => {
    await render();
    const bytes = Uint8Array.from(atob(picturePngBase64), char => char.charCodeAt(0));
    bytes[24] = 3; // Illegal PNG bit depth, while chunk framing remains intact.
    const file = new File([bytes], "bad.png", { type: "image/png" });
    const transfer = { types: ["Files"], files: [file], getData: () => "" } as unknown as DataTransfer;
    const decoder = vi.fn().mockRejectedValue(new Error("decode failed"));
    const payload = await clipboard.clipboardPayloadFromDataTransfer(transfer, decoder);
    expect(decoder).toHaveBeenCalledOnce();
    expect(inspectClipboardPayload(payload)).toMatchObject({ kind: "image-refused",
      message: "Couldn't paste the picture: the image data could not be decoded." });
    vi.stubGlobal("Image", class { src = ""; async decode() { throw new Error("decode failed"); } });
    await pasteFiles([file]);
    expect(container.querySelector('[role="status"]')?.textContent).toBe("Couldn't paste the picture: the image data could not be decoded.");
    expect(snapshot().pages[0]!.objects).toHaveLength(0);
    expect(canUndo()).toBe(false);
  });

  it.each(["PNG", "PNG PNG", "CCO CCN"])("pastes the fallback picture when %s yields no structures", async text => {
    await render();
    vi.spyOn(clipboard, "readClipboardPayload").mockResolvedValue({ ...nativeImage,
      types: ["text/plain", "image/png"], textItems: [{ type: "text/plain", text }] });
    vi.spyOn(smilesIdentity, "verifySmilesPasteInput").mockResolvedValue(undefined);
    vi.spyOn(smilesPaste, "depictSmilesForPaste").mockResolvedValue(undefined);
    vi.spyOn(smilesPaste, "depictSmilesListForPaste").mockReturnValue(Promise.resolve(undefined));
    await command("clipboard.paste");
    expect(snapshot().pages[0]!.objects).toHaveLength(1);
    expect(snapshot().pages[0]!.objects[0]).toMatchObject({ type: "graphic", graphicKind: "image" });
    await command("edit.undo");
    expect(container.querySelector('[role="status"]')?.textContent).toBe("Undid Paste Picture");
    expect(snapshot().pages[0]!.objects).toHaveLength(0);
    expect(canUndo()).toBe(false);
  });

  it.each(["none", "unparseable", "error"])("pastes CCO CCN before a later PNG flavor (earlier candidate: %s)", async earlierFailure => {
    await render();
    vi.spyOn(clipboard, "readClipboardPayload").mockResolvedValue({ ...nativeImage,
      types: ["image/png", "text/plain", "public.utf8-plain-text", "public.text"],
      textItems: [
        ...(earlierFailure !== "none" ? [{ type: "public.text", text: "PNG" }] : []),
        { type: "text/plain", text: "CCO CCN" }, { type: "public.utf8-plain-text", text: "PNG" }
      ] });
    const single = vi.spyOn(smilesPaste, "depictSmilesForPaste").mockResolvedValue(undefined);
    if (earlierFailure === "error") single.mockRejectedValue(new Error("Could not draw this token"));
    vi.spyOn(smilesIdentity, "verifySmilesPasteInput").mockResolvedValue(undefined);
    const entries = ["CCO", "CCN"].map(smiles => ({ smiles, depiction: {
      atoms: [...smiles].map((element, index) => ({ element, x: index * 1.5, y: 0, charge: 0 })),
      bonds: [{ from: 0, to: 1, order: "single" as const, wedge: null },
        { from: 1, to: 2, order: "single" as const, wedge: null }]
    } }));
    const list = vi.spyOn(smilesPaste, "depictSmilesListForPaste").mockResolvedValue({
      entries, skipped: 0, skippedItems: [], failures: []
    });
    vi.spyOn(smilesIdentity, "verifySmilesGridEntries").mockResolvedValue({ entries, failures: [] });
    await command("clipboard.paste");
    expect(list).toHaveBeenCalledOnce();
    expect(list.mock.calls[0]![0]).toBe("CCO CCN");
    expect(single).toHaveBeenCalledTimes(earlierFailure !== "none" ? 1 : 0);
    const pasted = snapshot();
    const objects = pasted.pages[0]!.objects;
    expect(objects).toHaveLength(2);
    expect(objects.map(object => object.type === "molecule" ? object.atoms.map(atom => atom.element).join("") : object.type))
      .toEqual(["CCO", "CCN"]);
    expect(pasted.selection.objectIds).toEqual(objects.map(object => object.id));
    await command("edit.undo");
    expect(container.querySelector('[role="status"]')?.textContent).toBe("Undid Paste SMILES list");
    expect(snapshot().pages[0]!.objects).toHaveLength(0);
    expect(canUndo()).toBe(false);
    await command("edit.redo");
    expect(snapshot().pages[0]!.objects).toEqual(objects);
    expect(list).toHaveBeenCalledOnce();
    expect(single).toHaveBeenCalledTimes(earlierFailure !== "none" ? 1 : 0);
  });

  it("tries a later single SMILES after a list fails, without committing the failed attempt", async () => {
    await render();
    vi.spyOn(clipboard, "readClipboardPayload").mockResolvedValue({ ...nativeImage,
      types: ["image/png", "text/plain", "public.utf8-plain-text"], textItems: [
        { type: "text/plain", text: "PNG PNG" }, { type: "public.utf8-plain-text", text: "CCO" }
      ] });
    const list = vi.spyOn(smilesPaste, "depictSmilesListForPaste").mockRejectedValue(
      new smilesPaste.SmilesListPasteError([{ input: "PNG", error: "Could not draw this token" }]));
    vi.spyOn(smilesIdentity, "verifySmilesPasteInput").mockResolvedValue(undefined);
    vi.spyOn(smilesIdentity, "verifySmilesPaste").mockResolvedValue(undefined);
    const single = vi.spyOn(smilesPaste, "depictSmilesForPaste").mockResolvedValue({ stereoCount: 0, depiction: {
      atoms: ["C", "C", "O"].map((element, index) => ({ element, x: index * 1.5, y: 0, charge: 0 })),
      bonds: [{ from: 0, to: 1, order: "single", wedge: null }, { from: 1, to: 2, order: "single", wedge: null }]
    } });
    await command("clipboard.paste");
    expect(list).toHaveBeenCalledOnce();
    expect(single).toHaveBeenCalledOnce();
    const objects = snapshot().pages[0]!.objects;
    expect(objects).toHaveLength(1);
    expect(objects[0]).toMatchObject({ type: "molecule", atoms: [
      { element: "C" }, { element: "C" }, { element: "O" }
    ] });
    expect(snapshot().selection.objectIds).toEqual([objects[0]!.id]);
    await command("edit.undo");
    expect(container.querySelector('[role="status"]')?.textContent).toBe("Undid Paste SMILES");
    expect(snapshot().pages[0]!.objects).toHaveLength(0);
    expect(canUndo()).toBe(false);
  });

  it("inserts a single SMILES into the current document after an edit during verification, without trying another candidate or picture", async () => {
    await render();
    vi.spyOn(clipboard, "readClipboardPayload").mockResolvedValue({ ...nativeImage,
      types: ["image/png", "text/plain", "public.utf8-plain-text"], textItems: [
        { type: "text/plain", text: "CCO" }, { type: "public.utf8-plain-text", text: "CCN" }
      ] });
    vi.spyOn(smilesIdentity, "verifySmilesPasteInput").mockResolvedValue(undefined);
    const single = vi.spyOn(smilesPaste, "depictSmilesForPaste").mockResolvedValue({ stereoCount: 0, depiction: {
      atoms: ["C", "C", "O"].map((element, index) => ({ element, x: index * 1.5, y: 0, charge: 0 })),
      bonds: [{ from: 0, to: 1, order: "single", wedge: null }, { from: 1, to: 2, order: "single", wedge: null }]
    } });
    const verification = deferred<void>();
    const verify = vi.spyOn(smilesIdentity, "verifySmilesPaste").mockReturnValue(verification.promise);
    await command("clipboard.paste");
    expect(verify).toHaveBeenCalledOnce();

    await command("tool.bond");
    await act(async () => {
      pointer(page(), "pointerdown", 200, 200);
      pointer(page(), "pointerup", 200, 200);
    });
    const edited = snapshot();
    expect(edited.pages[0]!.objects).toHaveLength(1);
    await act(async () => {
      verification.resolve();
      await verification.promise;
    });
    await vi.waitFor(async () => {
      await act(async () => { await Promise.resolve(); });
      expect(container.querySelector('[role="status"]')?.textContent).toContain("Pasted SMILES structure");
    });

    const pasted = snapshot();
    expect(single).toHaveBeenCalledOnce();
    expect(pasted.pages[0]!.objects).toHaveLength(2);
    expect(pasted.pages[0]!.objects[0]).toEqual(edited.pages[0]!.objects[0]);
    expect(pasted.pages[0]!.objects[1]).toMatchObject({ type: "molecule", atoms: [
      { element: "C" }, { element: "C" }, { element: "O" }
    ] });
    expect(pasted.selection.objectIds).toEqual([pasted.pages[0]!.objects[1]!.id]);
    await command("edit.undo");
    expect(container.querySelector('[role="status"]')?.textContent).toBe("Undid Paste SMILES");
    expect(snapshot().pages[0]!.objects).toEqual(edited.pages[0]!.objects);
    await command("edit.undo");
    expect(snapshot().pages[0]!.objects).toHaveLength(0);
    expect(canUndo()).toBe(false);
  });

  it.each(["resolve", "reject"])("stops after a document edit during list verification (%s), without another candidate or picture undo", async completion => {
    await render();
    vi.spyOn(clipboard, "readClipboardPayload").mockResolvedValue({ ...nativeImage,
      types: ["image/png", "text/plain", "public.utf8-plain-text"], textItems: [
        { type: "text/plain", text: "CCO CCN" }, { type: "public.utf8-plain-text", text: "CCO" }
      ] });
    const entries = ["CCO", "CCN"].map(smiles => ({ smiles, depiction: {
      atoms: [...smiles].map((element, index) => ({ element, x: index * 1.5, y: 0, charge: 0 })),
      bonds: [{ from: 0, to: 1, order: "single" as const, wedge: null },
        { from: 1, to: 2, order: "single" as const, wedge: null }]
    } }));
    const list = vi.spyOn(smilesPaste, "depictSmilesListForPaste").mockResolvedValue({
      entries, skipped: 0, skippedItems: [], failures: []
    });
    const verification = deferred<Awaited<ReturnType<typeof smilesIdentity.verifySmilesGridEntries>>>();
    const verify = vi.spyOn(smilesIdentity, "verifySmilesGridEntries").mockReturnValue(verification.promise);
    const single = vi.spyOn(smilesPaste, "depictSmilesForPaste").mockResolvedValue(undefined);
    await command("clipboard.paste");
    expect(verify).toHaveBeenCalledOnce();
    expect(canUndo()).toBe(false);

    await command("tool.bond");
    await act(async () => {
      pointer(page(), "pointerdown", 200, 200);
      pointer(page(), "pointerup", 200, 200);
    });
    const edited = snapshot();
    expect(edited.pages[0]!.objects).toHaveLength(1);
    expect(canUndo()).toBe(true);
    await act(async () => {
      if (completion === "resolve") verification.resolve({ entries, failures: [] });
      else verification.reject(new Error("Verification interrupted"));
      await verification.promise.catch(() => {});
    });

    expect(snapshot()).toEqual(edited);
    expect(container.querySelector('[role="status"]')?.textContent).toBe(
      "No SMILES structures were pasted; 1 item failed: The document changed while preparing SMILES paste; paste again.");
    expect(list).toHaveBeenCalledOnce();
    expect(single).not.toHaveBeenCalled();
    await command("edit.undo");
    expect(snapshot().pages[0]!.objects).toHaveLength(0);
    expect(canUndo()).toBe(false);
  });

  it.each([false, true])("stops after a document edit while PNG PNG parsing yields no structures (later candidate: %s)", async laterCandidate => {
    await render();
    vi.spyOn(clipboard, "readClipboardPayload").mockResolvedValue({ ...nativeImage,
      types: ["image/png", "text/plain", ...(laterCandidate ? ["public.utf8-plain-text"] : [])],
      textItems: [{ type: "text/plain", text: "PNG PNG" },
        ...(laterCandidate ? [{ type: "public.utf8-plain-text", text: "CCO" }] : [])]
    });
    const parsing = deferred<Awaited<ReturnType<typeof smilesPaste.depictSmilesListForPaste>>>();
    const list = vi.spyOn(smilesPaste, "depictSmilesListForPaste").mockReturnValue(parsing.promise);
    vi.spyOn(smilesIdentity, "verifySmilesPasteInput").mockResolvedValue(undefined);
    const single = vi.spyOn(smilesPaste, "depictSmilesForPaste").mockResolvedValue(undefined);
    const verify = vi.spyOn(smilesIdentity, "verifySmilesGridEntries");
    await command("clipboard.paste");
    expect(list).toHaveBeenCalledOnce();
    expect(list.mock.calls[0]![0]).toBe("PNG PNG");
    expect(canUndo()).toBe(false);

    await command("tool.bond");
    await act(async () => {
      pointer(page(), "pointerdown", 200, 200);
      pointer(page(), "pointerup", 200, 200);
    });
    const edited = snapshot();
    expect(edited.pages[0]!.objects).toHaveLength(1);
    await act(async () => {
      parsing.resolve(undefined);
      await parsing.promise;
    });

    expect(snapshot()).toEqual(edited);
    expect(container.querySelector('[role="status"]')?.textContent).toBe(
      "No SMILES structures were pasted; 1 item failed: The document changed while preparing SMILES paste; paste again.");
    expect(single).not.toHaveBeenCalled();
    expect(verify).not.toHaveBeenCalled();
    await command("edit.undo");
    expect(snapshot().pages[0]!.objects).toHaveLength(0);
    expect(canUndo()).toBe(false);
  });

  it("pastes F/C=C/F without a picture when quit during input verification is cancelled before depiction finishes", async () => {
    let requestQuit!: (id: number) => Promise<void>;
    vi.spyOn(windowManager, "isDesktopRuntime").mockReturnValue(true);
    vi.spyOn(windowManager, "listenForQuitPromptRequest").mockImplementation(async handler => {
      requestQuit = handler;
      return () => {};
    });
    vi.spyOn(windowManager, "prepareQuitPrompt").mockResolvedValue(true);
    vi.spyOn(windowManager, "reportQuitPromptShowing").mockResolvedValue(true);
    const cancelQuit = vi.spyOn(windowManager, "cancelQuit").mockResolvedValue(true);
    await render();
    await command("tool.bond");
    await act(async () => {
      pointer(page(), "pointerdown", 200, 200);
      pointer(page(), "pointerup", 200, 200);
    });
    const before = snapshot();
    const parsed = await smilesPaste.depictSmilesForPaste("F/C=C/F");
    expect(parsed).toBeDefined();
    vi.spyOn(clipboard, "readClipboardPayload").mockResolvedValue({
      types: ["text/plain"], textItems: [{ type: "text/plain", text: "F/C=C/F" }]
    });
    const verification = deferred<void>();
    const verifyInput = vi.spyOn(smilesIdentity, "verifySmilesPasteInput").mockReturnValue(verification.promise);
    vi.spyOn(smilesIdentity, "verifySmilesPaste").mockResolvedValue(undefined);
    const depiction = deferred<Awaited<ReturnType<typeof smilesPaste.depictSmilesForPaste>>>();
    const single = vi.spyOn(smilesPaste, "depictSmilesForPaste").mockReturnValue(depiction.promise);
    await command("clipboard.paste");
    expect(verifyInput).toHaveBeenCalledOnce();
    expect(single).not.toHaveBeenCalled();
    await act(async () => { await requestQuit(1); });
    const prompt = container.querySelector('[aria-labelledby="quit-prompt-title"]');
    expect(prompt).not.toBeNull();
    await act(async () => {
      verification.resolve();
      await verification.promise;
    });
    expect(single).toHaveBeenCalledOnce();
    expect(single.mock.calls[0]![0]).toBe("F/C=C/F");
    await act(async () => {
      Array.from(prompt!.querySelectorAll("button")).find(button => button.textContent === "Cancel")!.click();
    });
    expect(cancelQuit).toHaveBeenCalledWith(1);
    expect(container.querySelector('[aria-labelledby="quit-prompt-title"]')).toBeNull();
    await act(async () => {
      depiction.resolve(parsed);
      await depiction.promise;
    });
    await vi.waitFor(async () => {
      await act(async () => { await Promise.resolve(); });
      expect(container.querySelector('[role="status"]')?.textContent).toContain("Pasted SMILES structure");
    });
    const pasted = snapshot();
    expect(pasted.pages[0]!.objects).toHaveLength(2);
    expect(pasted.pages[0]!.objects[1]).toMatchObject({ type: "molecule", atoms: [
      { element: "F" }, { element: "C" }, { element: "C" }, { element: "F" }
    ] });
    expect(pasted.selection.objectIds).toEqual([pasted.pages[0]!.objects[1]!.id]);
    await command("edit.undo");
    expect(container.querySelector('[role="status"]')?.textContent).toBe("Undid Paste SMILES");
    expect(snapshot().pages[0]!.objects).toEqual(before.pages[0]!.objects);
    await command("edit.undo");
    expect(snapshot().pages[0]!.objects).toHaveLength(0);
    expect(canUndo()).toBe(false);
  }, 20_000);

  it.each(["depiction", "verification"])("never commits an aborted single SMILES pending %s or falls back to its picture", async pendingStage => {
    await render();
    const read = vi.spyOn(clipboard, "readClipboardPayload").mockResolvedValue({ ...nativeImage,
      types: ["image/png", "text/plain", "public.utf8-plain-text"], textItems: [
        { type: "text/plain", text: "CCO" }, { type: "public.utf8-plain-text", text: "CCN" }
      ] });
    vi.spyOn(smilesIdentity, "verifySmilesPasteInput").mockResolvedValue(undefined);
    const parsed = { stereoCount: 0, depiction: {
      atoms: ["C", "C", "O"].map((element, index) => ({ element, x: index * 1.5, y: 0, charge: 0 })),
      bonds: [{ from: 0, to: 1, order: "single" as const, wedge: null },
        { from: 1, to: 2, order: "single" as const, wedge: null }]
    } };
    const depiction = deferred<Awaited<ReturnType<typeof smilesPaste.depictSmilesForPaste>>>();
    const verification = deferred<void>();
    const single = vi.spyOn(smilesPaste, "depictSmilesForPaste").mockReturnValue(
      pendingStage === "depiction" ? depiction.promise : Promise.resolve(parsed));
    const verify = vi.spyOn(smilesIdentity, "verifySmilesPaste").mockReturnValue(
      pendingStage === "verification" ? verification.promise : Promise.resolve());
    await command("clipboard.paste");
    expect(single).toHaveBeenCalledOnce();
    expect(verify).toHaveBeenCalledTimes(pendingStage === "verification" ? 1 : 0);
    const signal = single.mock.calls[0]![1]!.signal!;
    expect(signal.aborted).toBe(false);
    expect(canUndo()).toBe(false);

    read.mockResolvedValue(nativeImage);
    await command("clipboard.paste");
    expect(signal.aborted).toBe(true);
    const newerPaste = snapshot();
    expect(newerPaste.pages[0]!.objects).toHaveLength(1);
    const newerStatus = container.querySelector('[role="status"]')?.textContent;
    await act(async () => {
      depiction.resolve(parsed);
      verification.resolve();
      await Promise.all([depiction.promise, verification.promise]);
    });

    expect(single).toHaveBeenCalledOnce();
    expect(snapshot()).toEqual(newerPaste);
    expect(container.querySelector('[role="status"]')?.textContent).toBe(newerStatus);
    await command("edit.undo");
    expect(container.querySelector('[role="status"]')?.textContent).toBe("Undid Paste Picture");
    expect(snapshot().pages[0]!.objects).toHaveLength(0);
    expect(canUndo()).toBe(false);
  });

  it("renders and hits the image frame, moves and resizes through existing handles with one undo each", async () => {
    const document: ChemDraftDocument = createPhase4Document("Image Frame");
    const image = createImageGraphicObject({ id: "picture", mimeType: "image/svg+xml", dataBase64: btoa(pictureSvg), center: { x: 250, y: 220 } });
    document.pages[0]!.objects = [image];
    await render(document);
    const glyph = container.querySelector(".graphic-glyph-image")!;
    expect(glyph.getAttribute("width")).toBe(String(image.width));
    expect(glyph.getAttribute("height")).toBe(String(image.height));
    expect(glyph.getAttribute("pointer-events")).toBe("all");
    const viewport = glyph.closest("svg")!.parentElement!.closest("svg")!;
    expect(viewport.getAttribute("x")).toBe(String(image.x));
    expect(viewport.getAttribute("y")).toBe(String(image.y));
    expect(selectionInSelectionRect([image], { x: image.x - 1, y: image.y - 1 },
      { x: image.x + image.width + 1, y: image.y + image.height + 1 }).objectIds).toEqual([image.id]);
    expect(selectionInSelectionPolygon([image], [
      { x: image.x - 1, y: image.y - 1 }, { x: image.x + image.width + 1, y: image.y - 1 },
      { x: image.x + image.width + 1, y: image.y + image.height + 1 }, { x: image.x - 1, y: image.y + image.height + 1 }
    ]).objectIds).toEqual([image.id]);
    await act(async () => { pointer(glyph, "pointerdown", image.x + 5, image.y + 5); pointer(page(), "pointerup", image.x + 5, image.y + 5); });
    expect(snapshot().selection.objectIds).toEqual([image.id]);
    const selected = snapshot().pages[0]!.objects[0]!;
    await act(async () => pointer(glyph, "pointerdown", 250, 220));
    await act(async () => pointer(page(), "pointermove", 280, 240));
    await act(async () => pointer(page(), "pointerup", 280, 240));
    expect(snapshot().pages[0]!.objects[0]).toMatchObject({ x: selected.x + 30, y: selected.y + 20, data: image.data });
    await command("edit.undo");
    expect(snapshot().pages[0]!.objects[0]).toEqual(selected);
    expect(canUndo()).toBe(false);
    const handle = container.querySelector('[data-object-resize-corner="bottom-right"]')!;
    expect(handle).not.toBeNull();
    const center = { x: selected.x + selected.width / 2, y: selected.y + selected.height / 2 };
    await act(async () => pointer(handle, "pointerdown", center.x + selected.width / 2, center.y + selected.height / 2));
    await act(async () => pointer(page(), "pointermove", center.x + selected.width, center.y + selected.height * 1.5));
    await act(async () => pointer(page(), "pointerup", center.x + selected.width, center.y + selected.height * 1.5));
    const resized = snapshot().pages[0]!.objects[0]!;
    expect(resized.width).toBeGreaterThan(selected.width);
    expect(resized.width / resized.height).toBeCloseTo(selected.width / selected.height);
    expect(resized).toMatchObject({ data: image.data });
    await command("edit.undo");
    expect(snapshot().pages[0]!.objects[0]).toEqual(selected);
    expect(canUndo()).toBe(false);
  });
});
