// @vitest-environment jsdom
// Picture (and shape) transform handles at and past the page edge, and page-edge limits for
// rotated objects. Real pointer and keyboard events through the mounted MainWindow.
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { applyPatches, createImageGraphicObject, type ChemDraftDocument, type DocumentObject, type GraphicObject } from "@chemdraft/chem-core";
import { MainWindow } from "./MainWindow";
import {
  applyChargeToolAtPoint, applyReactionArrowToolAtPoint, createPhase4Document, insertNativeArtGraphicObject,
  insertNativeBracket, insertNativeTextObject, selectDocumentObjects
} from "./documentWorkflow";
import { saveDirectElectronMarkEditing } from "./electronMarkEditingSettings";
import { getAssistantHistoryPort } from "./assistant/historyPort";
import { setNativePromptProvider } from "./nativePrompt";
import { MemoryStorage } from "./testSupport/memoryStorage";
import { testPng } from "./imageDrop/pngTestImages";
import { DOM_COMMAND_EVENT } from "./window-manager";

vi.mock("./rdkitWasmLoader", () => ({ registerRdkitWasmLoader: vi.fn() }));
vi.mock("@scena/react-ruler", () => ({ default: () => <canvas /> }));
class TestResizeObserver { observe() {} unobserve() {} disconnect() {} }

const appCss = readFileSync(resolve("apps/desktop/src/App.css"), "utf8").replace(/\/\*[\s\S]*?\*\//g, "");

/** The drawn box of a frame turned about its centre (what the page edge must hold). */
function rotatedBox(object: { x: number; y: number; width: number; height: number; rotation: number }) {
  const radians = object.rotation * Math.PI / 180;
  const cos = Math.abs(Math.cos(radians)), sin = Math.abs(Math.sin(radians));
  const width = object.width * cos + object.height * sin, height = object.width * sin + object.height * cos;
  const cx = object.x + object.width / 2, cy = object.y + object.height / 2;
  return { left: cx - width / 2, top: cy - height / 2, right: cx + width / 2, bottom: cy + height / 2 };
}

/** One object of `kind`, alone on the page, flush with its top-left corner and selected. */
function pageEdgeDocument(kind: "charge" | "text" | "reaction-arrow" | "bracket"): ChemDraftDocument {
  const base = createPhase4Document(`${kind} at the page edge`);
  const drawn = kind === "charge" ? applyChargeToolAtPoint(base, { kind: "charge", charge: 1 }, { x: 200, y: 200 })
    : kind === "text" ? insertNativeTextObject(base, { x: 200, y: 200 }, "Edge label")
      : kind === "reaction-arrow" ? applyReactionArrowToolAtPoint(base, { x: 200, y: 200 }, "forward")
        : insertNativeBracket(base, { x: 200, y: 200 }, "square", { x: 320, y: 300 });
  // A bracket pair: keep one half, so the selection shows its own handles, not the group frame.
  const object = drawn.pages[0]!.objects[0]!;
  const page = { ...drawn.pages[0]!, objects: [{ ...object, x: 0, y: 0 }] };
  return selectDocumentObjects({ ...drawn, pages: [page] }, page.id, [object.id]);
}

function pictureDocument(frame: { x: number; y: number; width: number; height: number }): ChemDraftDocument {
  const base = createPhase4Document("Picture handles");
  const page = base.pages[0]!;
  const picture = createImageGraphicObject({ mimeType: "image/png", id: "picture-1", center: { x: 0, y: 0 },
    dataBase64: Buffer.from(testPng({ width: 4, height: 3 })).toString("base64") });
  const placed = { ...picture, ...frame };
  return selectDocumentObjects(applyPatches(base, [{ op: "addObject", pageId: page.id, object: placed }]), page.id, [placed.id]);
}

describe.each(["macos", "windows"] as const)("picture and shape handles (%s)", platform => {
  let root: Root, container: HTMLDivElement, restorePrompt: (() => void) | undefined;
  const current = () => getAssistantHistoryPort().read("initial")!;
  const objectById = (id: string, document = current()) => document.pages[0]!.objects.find(object => object.id === id)!;
  const status = () => container.querySelector('[role="status"]')?.textContent;

  beforeEach(() => {
    (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    vi.stubGlobal("localStorage", new MemoryStorage());
    vi.stubGlobal("ResizeObserver", TestResizeObserver);
    vi.stubGlobal("CSS", { escape: (value: string) => value });
    Element.prototype.setPointerCapture ??= () => {};
    Element.prototype.releasePointerCapture ??= () => {};
    Element.prototype.hasPointerCapture ??= () => false;
    container = document.createElement("div"); document.body.append(container); root = createRoot(container);
  });
  afterEach(async () => {
    await act(async () => root.unmount()); container.remove();
    restorePrompt?.(); restorePrompt = undefined;
    vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllGlobals();
  });

  async function mount(initialDocument: ChemDraftDocument) {
    await act(async () => root.render(<MainWindow initialDocument={initialDocument} initialActiveToolCommandId="tool.select"
      initialPaletteMode="hidden" initialRulersVisible={false} initialCrosshairsVisible={false}
      nativePalette={false} shortcutPlatform={platform} />));
    const { width, height } = initialDocument.pages[0]!;
    const rect = { x: 0, y: 0, left: 0, top: 0, right: width, bottom: height, width, height, toJSON: () => ({}) };
    for (const element of container.querySelectorAll<HTMLElement>(".page, .canvas-region")) {
      vi.spyOn(element, "getBoundingClientRect").mockReturnValue(rect);
    }
    await act(async () => container.querySelector<HTMLElement>(".canvas-region")!.focus());
  }
  async function pointer(target: Element, type: "pointerdown" | "pointermove" | "pointerup", point: { x: number; y: number }) {
    const event = new MouseEvent(type, { bubbles: true, cancelable: true, button: 0, buttons: type === "pointerup" ? 0 : 1,
      detail: 1, clientX: point.x, clientY: point.y });
    Object.defineProperties(event, { isPrimary: { value: true }, pointerId: { value: 7 }, pointerType: { value: "mouse" } });
    await act(async () => target.dispatchEvent(event));
  }
  async function drag(handle: Element, from: { x: number; y: number }, to: { x: number; y: number }) {
    const page = container.querySelector(".page")!;
    await pointer(handle, "pointerdown", from);
    await pointer(page, "pointermove", { x: (from.x + to.x) / 2, y: (from.y + to.y) / 2 });
    await pointer(page, "pointermove", to);
    await pointer(page, "pointerup", to);
    // The page-size question answers asynchronously.
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 0)); });
  }
  async function command(commandId: string) {
    await act(async () => { window.dispatchEvent(new CustomEvent(DOM_COMMAND_EVENT, { detail: { commandId } })); });
  }
  async function key(name: string, shiftKey = false) {
    await act(async () => document.activeElement!.dispatchEvent(
      new KeyboardEvent("keydown", { key: name, shiftKey, bubbles: true, cancelable: true })));
  }
  /** Every corner and the rotate button, drawn outside the page's paint containment. */
  function expectHandlesOutsideClip(objectId: string) {
    const corners = [...container.querySelectorAll<HTMLElement>(`[data-object-controls="${objectId}"] [data-object-resize-corner]`)];
    expect(corners.map(corner => corner.dataset.objectResizeCorner).sort())
      .toEqual(["bottom-left", "bottom-right", "top-left", "top-right"]);
    const rotate = container.querySelector<HTMLElement>(`[data-object-controls="${objectId}"] .object-rotate-handle`);
    for (const handle of [...corners, ...(rotate ? [rotate] : [])]) {
      expect(handle.closest(".page")).toBeNull();
      expect(handle.closest("[data-page-handle-layer]")?.parentElement?.classList.contains("document-board")).toBe(true);
    }
    return Object.fromEntries(corners.map(corner => [corner.dataset.objectResizeCorner!, corner]));
  }

  // Charge marks, text boxes, reaction arrows and brackets draw their handles beside the page too:
  // a handle overhanging the page edge is outside `.page`'s paint clip, and still grabbable.
  it.each(["charge", "text", "reaction-arrow", "bracket"] as const)(
    "keeps a %s's handles outside the page clip at the page edge, and drags the overhanging one", async kind => {
    const prompt = vi.fn(async () => "keep");
    restorePrompt = setNativePromptProvider(prompt);
    // Charge marks show a transform frame only with direct electron-mark editing on.
    if (kind === "charge") saveDirectElectronMarkEditing(true);
    const initial = pageEdgeDocument(kind);
    await mount(initial);
    const before = current();
    const object = before.pages[0]!.objects[0]!;
    expect([object.x, object.y]).toEqual([0, 0]);

    // Exactly one element carries the object's controls: the copy holding the handles, on the board
    // beside the page. The in-page chrome has the same box and no handles.
    const controls = [...container.querySelectorAll<HTMLElement>(`[data-object-controls="${object.id}"]`)];
    expect(controls).toHaveLength(1);
    const [handlesCopy] = controls;
    expect(handlesCopy!.closest(".page")).toBeNull();
    expect(handlesCopy!.closest("[data-page-handle-layer]")?.parentElement?.classList.contains("document-board")).toBe(true);
    const chrome = container.querySelector<HTMLElement>(`[data-object-chrome="${object.id}"]`)!;
    expect(chrome.closest("[data-page-interaction-layer]")).not.toBeNull();
    expect(chrome.hasAttribute("data-object-controls")).toBe(false);
    for (const property of ["left", "top", "width", "height", "transform"] as const) {
      expect(handlesCopy!.style[property]).toBe(chrome.style[property]);
    }
    const handleSelector = kind === "text" ? "[data-text-resize-edge]" : "[data-object-resize-corner]";
    expect(chrome.querySelector(`${handleSelector}, [data-selection-rotate-handle]`)).toBeNull();
    const handles = [...handlesCopy!.querySelectorAll<HTMLElement>(handleSelector)];
    expect(handles.map(handle => handle.dataset.textResizeEdge ?? handle.dataset.objectResizeCorner).sort())
      .toEqual(kind === "text" ? ["bottom", "left", "right", "top"] : ["bottom-left", "bottom-right", "top-left", "top-right"]);
    for (const handle of handles) expect(handle.closest(".page")).toBeNull();

    // The handle that overhangs the page's left (and top) edge still takes the press.
    const grab = handles.find(handle => (handle.dataset.textResizeEdge ?? handle.dataset.objectResizeCorner) ===
      (kind === "text" ? "left" : "top-left"))!;
    const from = { x: 0, y: kind === "text" ? object.height / 2 : 0 };
    await drag(grab, from, kind === "text" ? { x: 20, y: from.y } : { x: -30, y: -30 });
    const after = objectById(object.id);
    if (kind === "text") {
      // The left edge moved in: a narrower box starting further right.
      expect(after.x).toBeGreaterThan(object.x);
      expect(after.width).toBeLessThan(object.width);
    } else {
      // Centre-anchored, as for pictures: larger, and overhanging the page, so the page-size
      // question was asked (Keep Page Size) and the handles are still drawn outside the clip.
      expect(after.width).toBeGreaterThan(object.width);
      expect(after.height).toBeGreaterThan(object.height);
      expect(prompt).toHaveBeenCalledOnce();
      expect(container.querySelector(`[data-object-controls="${object.id}"]`)!.closest("[data-page-handle-layer]")).not.toBeNull();
    }
    await command("edit.undo");
    expect(current().pages).toEqual(before.pages);
  });

  it.each(["enlarge", "keep"] as const)(
    "enlarging a page-filling picture from a corner asks to enlarge the page, keeps handles grabbable, and undoes (%s)", async answer => {
    const prompt = vi.fn(async () => answer);
    restorePrompt = setNativePromptProvider(prompt);
    const initial = pictureDocument({ x: 0, y: 0, width: 792, height: 1056 });
    const { width: pageWidth, height: pageHeight } = initial.pages[0]!;
    await mount(initial);
    const before = current();
    const picture = objectById("picture-1", before);
    const handles = expectHandlesOutsideClip(picture.id);

    // Corner resize scales about the centre, as for shapes and molecules: drag bottom-right out.
    await drag(handles["bottom-right"]!, { x: 792, y: 1056 }, { x: 900, y: 1200 });
    expect(prompt).toHaveBeenCalledOnce();
    const after = current();
    const resized = objectById(picture.id, after);
    expect(resized.width).toBeGreaterThan(picture.width);
    expect(resized.height).toBeGreaterThan(picture.height);
    if (answer === "enlarge") {
      // Grown like a large paste: the picture is shifted onto the page and the page holds it.
      expect(resized.x).toBeGreaterThanOrEqual(-1e-6);
      expect(resized.y).toBeGreaterThanOrEqual(-1e-6);
      expect(after.pages[0]!.width).toBeGreaterThanOrEqual(resized.x + resized.width - 1e-6);
      expect(after.pages[0]!.height).toBeGreaterThanOrEqual(resized.y + resized.height - 1e-6);
      expect(after.pages[0]!.width).toBeGreaterThan(pageWidth);
    } else {
      // Kept the page: the picture overhangs, yet every handle is still drawn outside the clip.
      expect(after.pages[0]!.width).toBe(pageWidth);
      expect(after.pages[0]!.height).toBe(pageHeight);
      expect(resized.x).toBeLessThan(0);
      expect(resized.y).toBeLessThan(0);
    }
    const again = expectHandlesOutsideClip(picture.id);
    // Still grabbable: the top-left handle shrinks it back inside the page with no question.
    const from = { x: Math.max(0, resized.x), y: Math.max(0, resized.y) };
    await drag(again["top-left"]!, from, { x: from.x + 120, y: from.y + 160 });
    expect(prompt).toHaveBeenCalledOnce();
    expect(objectById(picture.id).width).toBeLessThan(resized.width);

    await command("edit.undo");
    expect(current()).toEqual(after);
    await command("edit.undo");
    expect(current().pages).toEqual(before.pages);
    expectHandlesOutsideClip(picture.id);
  });

  it.each([
    { name: "picture", make: () => pictureDocument({ x: 300, y: 300, width: 400, height: 300 }) },
    { name: "rect shape", make: () => {
      const document = insertNativeArtGraphicObject(createPhase4Document("Rotated shape"), { x: 500, y: 450 }, "tool.art.rect");
      const shape = document.pages[0]!.objects.at(-1)!;
      const sized = applyPatches(document, [{ op: "updateObject", objectId: shape.id, changes: { x: 300, y: 300, width: 400, height: 300 } }]);
      return selectDocumentObjects(sized, sized.pages[0]!.id, [shape.id]);
    } }
  ])("after Rotate 90° Clockwise a $name nudges right and down only until its rotated box meets the page edge", async ({ make }) => {
    const initial = make();
    await mount(initial);
    const id = initial.selection.objectIds[0]!;
    await command("layout.rotate90");
    const rotated = objectById(id) as GraphicObject;
    expect(Math.abs(rotated.rotation % 360)).toBe(90);
    const { width: pageWidth, height: pageHeight } = current().pages[0]!;
    for (const [arrow, edge] of [["ArrowRight", "right"], ["ArrowDown", "bottom"]] as const) {
      for (let press = 0; press < 200 && status() !== "Selection is already at the page edge"; press++) await key(arrow, true);
      expect(status()).toBe("Selection is already at the page edge");
      const box = rotatedBox(objectById(id) as DocumentObject & { rotation: number });
      expect(box[edge]).toBeCloseTo(edge === "right" ? pageWidth : pageHeight, 9);
      expect(box[edge]).toBeLessThanOrEqual((edge === "right" ? pageWidth : pageHeight) + 1e-9);
      // The stored (unrotated) frame is NOT what stops it: 400 wide but drawn 300 wide, it passes the
      // right edge; 300 tall but drawn 400 tall, it stops short of the bottom.
      const object = objectById(id);
      if (edge === "right") expect(object.x + object.width).toBeGreaterThan(pageWidth);
      else expect(object.y + object.height).toBeLessThan(pageHeight);
      await key(arrow);
      expect(status()).toBe("Selection is already at the page edge");
      await key("ArrowUp"); await key("ArrowLeft");
    }
    // And back to the top-left: the rotated box stops at 0, not the stored frame.
    for (let press = 0; press < 200 && status() !== "Selection is already at the page edge"; press++) await key("ArrowLeft", true);
    expect(rotatedBox(objectById(id) as DocumentObject & { rotation: number }).left).toBeCloseTo(0, 9);
  });

  it("resizing a rotated picture judges the page edge by its rotated box", async () => {
    const prompt = vi.fn(async () => "keep");
    restorePrompt = setNativePromptProvider(prompt);
    // 300×100 turned 90° about (760, 500): the drawn box (710..810) fits the 816-wide page while the
    // stored frame (610..910) overhangs it.
    const initial = applyPatches(pictureDocument({ x: 610, y: 450, width: 300, height: 100 }),
      [{ op: "updateObject", objectId: "picture-1", changes: { rotation: 90 } }]);
    expect(initial.pages[0]!.width).toBe(816);
    await mount(initial);
    const handles = expectHandlesOutsideClip("picture-1");
    // Shrinking keeps the drawn box on the page: no page-size question.
    const corner = handles["bottom-right"]!;
    await drag(corner, { x: 710, y: 650 }, { x: 730, y: 620 });
    expect(prompt).not.toHaveBeenCalled();
    const shrunk = objectById("picture-1");
    expect(shrunk.width).toBeLessThan(300);
    // Growing the drawn box past the right edge asks. (Another corner: a second press on the same
    // corner opens typed size entry.)
    await drag(expectHandlesOutsideClip("picture-1")["top-left"]!, { x: 720, y: 360 }, { x: 680, y: 300 });
    expect(prompt).toHaveBeenCalledOnce();
    // Keep Page Size: the picture is larger and its drawn box overhangs the right edge.
    expect(objectById("picture-1").width).toBeGreaterThan(shrunk.width);
    expect(rotatedBox(objectById("picture-1") as DocumentObject & { rotation: number }).right).toBeGreaterThan(816);
  });

  it("keeps paint containment on the page, draws handles in an unclipped composited layer, and scrubs around the page", async () => {
    // Content is still clipped at the page edge; the board that carries the pan transform has no
    // paint containment (WKWebView ghost pixels); the handle layer is not paint-contained; frames
    // keep their own compositing layer.
    expect(appCss).toMatch(/\.page\s*{[^}]*contain:\s*paint;/s);
    expect(appCss).not.toMatch(/\.document-board\s*{[^}]*contain:[^;}]*paint/s);
    expect(appCss).toMatch(/\.page-handle-layer\s*{[^}]*pointer-events:\s*none/s);
    expect(appCss).not.toMatch(/\.page-handle-layer\s*{[^}]*contain:/s);
    expect(appCss).toMatch(/\.object-transform-frame\s*{[^}]*will-change:\s*transform/s);

    let frame: FrameRequestCallback | undefined;
    vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => { frame = callback; return 1; });
    vi.stubGlobal("cancelAnimationFrame", () => { frame = undefined; });
    await mount(pictureDocument({ x: 0, y: 0, width: 792, height: 1056 }));
    const page = container.querySelector<HTMLElement>(".page")!;
    const canvas = container.querySelector<HTMLElement>(".canvas-region")!;
    // Selection changes flip both the page and the canvas around it for one frame.
    await key("Escape");
    expect(page.style.getPropertyValue("--cd-bg-page")).toBe("#fffefe");
    expect(canvas.style.getPropertyValue("--cd-bg-canvas")).toBe("#cbd3db");
    await act(async () => frame?.(0));
    expect(page.style.getPropertyValue("--cd-bg-page")).toBe("");
    expect(canvas.style.getPropertyValue("--cd-bg-canvas")).toBe("");
  });
});
