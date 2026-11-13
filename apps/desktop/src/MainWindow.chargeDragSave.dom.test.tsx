// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { applyPatch } from "@chemdraft/chem-core";
import { openChemDraftPayload } from "@chemdraft/cdx-compat";
import { setReactionArrowConditions } from "@chemdraft/document-workflow-core";
import { MainWindow } from "./MainWindow";
import { createNativeArtLineGraphicObject, nativeChargeMarkCenter } from "./documentWorkflow";
import { dropMark, dropMolecule, electronMarkDropFixture } from "./testSupport/electronMarkDropFixture";
import { MemoryStorage } from "./testSupport/memoryStorage";

const native = vi.hoisted(() => ({ writeFile: vi.fn<(path: string, contents: string) => Promise<void>>() }));
vi.mock("./rdkitWasmLoader", () => ({ registerRdkitWasmLoader: vi.fn() }));
vi.mock("@scena/react-ruler", () => ({ default: () => <canvas /> }));
vi.mock("./window-manager", async original => ({
  ...await original<typeof import("./window-manager")>(),
  isDesktopRuntime: () => true,
  loadDocumentSession: async () => undefined,
  saveDocumentSession: async () => {},
  loadToolsetLayoutState: async () => undefined,
  listToolsetWindowStates: async () => [],
  setToolbarsMenu: async () => {}
}));
vi.mock("@tauri-apps/plugin-dialog", () => ({ save: async () => "/tmp/charge-drag.chemdraft" }));
vi.mock("@tauri-apps/plugin-fs", async original => ({
  ...await original<typeof import("@tauri-apps/plugin-fs")>(), writeTextFile: native.writeFile
}));

describe.each(["macos", "windows"] as const)("charge drag Save (%s)", platform => {
  let container: HTMLDivElement, root: Root;
  const snapshot = () => window.__CHEMDRAFT_AGENT__!.snapshot();
  const savedWrites = () => native.writeFile.mock.calls.filter(([path]) => path === "/tmp/charge-drag.chemdraft");
  beforeEach(() => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    vi.stubGlobal("localStorage", new MemoryStorage());
    vi.stubGlobal("ResizeObserver", class { observe() {} unobserve() {} disconnect() {} });
    vi.stubGlobal("CSS", { escape: (value: string) => value });
    vi.spyOn(window, "focus").mockImplementation(() => {});
    for (const method of ["setPointerCapture", "releasePointerCapture", "hasPointerCapture"]) {
      Object.defineProperty(Element.prototype, method, { configurable: true, value: () => false });
    }
    native.writeFile.mockReset().mockResolvedValue();
    window.history.replaceState(null, "", "/?agentBridge=1");
    container = document.createElement("div"); document.body.append(container); root = createRoot(container);
  });
  afterEach(async () => {
    await act(async () => root.unmount()); container.remove();
    vi.restoreAllMocks(); vi.unstubAllGlobals();
    for (const method of ["setPointerCapture", "releasePointerCapture", "hasPointerCapture"]) Reflect.deleteProperty(Element.prototype, method);
    window.history.replaceState(null, "", "/"); delete window.__CHEMDRAFT_AGENT__;
  });
  async function key(key: string) {
    await act(async () => window.dispatchEvent(new KeyboardEvent("keydown", {
      key, bubbles: true, cancelable: true,
      metaKey: key === "s" && platform === "macos", ctrlKey: key === "s" && platform === "windows"
    })));
  }
  async function pointer(target: Element, type: string, point: { x: number; y: number }) {
    // jsdom has no PointerEvent constructor; dispatch pointer events with the real React handlers.
    const event = new MouseEvent(type, { bubbles: true, cancelable: true, button: 0,
      buttons: type === "pointerup" || type === "pointercancel" ? 0 : 1, clientX: point.x, clientY: point.y });
    Object.defineProperties(event, { pointerId: { value: 7 }, isPrimary: { value: true }, pointerType: { value: "mouse" } });
    await act(async () => target.dispatchEvent(event));
  }
  describe.each(["Escape", "pointercancel", "pointerup", "Escape during save"] as const)("%s", ending => {
    it.each([false, true])("saves pre-drag chemistry and finishes consistently (conditions: %s)", async withConditions => {
      let drawing = electronMarkDropFixture().document;
      if (withConditions) {
        const arrow = createNativeArtLineGraphicObject(drawing, { x: 100, y: 400 }, { x: 340, y: 400 }, "tool.art.reactionArrow")!;
        drawing = applyPatch(drawing, { op: "addObject", pageId: drawing.pages[0].id, object: arrow });
        drawing = setReactionArrowConditions(drawing, arrow.id, { side: "above", spans: [{ text: "THF", script: "normal" }] });
      }
      await act(async () => root.render(<MainWindow initialDocument={drawing} initialActiveToolCommandId="tool.select"
        initialPaletteMode="hidden" initialCrosshairsVisible={false} initialRulersVisible={false} nativePalette shortcutPlatform={platform} />));
      container.querySelector<HTMLElement>(".page")!.getBoundingClientRect = () => ({ x: 0, y: 0, left: 0, top: 0,
        right: 792, bottom: 612, width: 792, height: 612, toJSON: () => ({}) });
      await key("s");
      expect(savedWrites()).toHaveLength(1);
      expect(snapshot().file.dirty).toBe(false);
      native.writeFile.mockClear();
      const mark = dropMark(snapshot().document);
      const target = container.querySelector(`[data-page-svg-object-visual="${mark.id}"] circle`)!;
      expect(target).not.toBeNull();
      await pointer(target, "pointerdown", nativeChargeMarkCenter(mark));
      const before = snapshot().document;
      expect(dropMolecule(before).atoms[7].formalCharge).toBe(1);
      await pointer(target, "pointermove", { x: 600, y: 500 });
      expect.soft(dropMolecule(snapshot().document).atoms[7].formalCharge, "preview must keep live formal charge").toBe(1);
      expect.soft(dropMark(snapshot().document), "preview must keep live charge association and position").toEqual(mark);
      expect(snapshot().file.dirty, "preview alone does not dirty the document").toBe(false);
      let finishWrite: (() => void) | undefined;
      if (ending === "Escape during save") native.writeFile.mockImplementationOnce(() => new Promise(resolve => { finishWrite = resolve; }));
      await key("s");
      expect(savedWrites()).toHaveLength(1);
      const saved = openChemDraftPayload(savedWrites()[0][1]).document!;
      expect.soft(dropMolecule(saved).atoms[7].formalCharge, "Save while dragging must preserve +1").toBe(1);
      expect.soft(dropMark(saved), "Save must write the pre-drag mark").toEqual(mark);
      if (ending.startsWith("Escape")) await key("Escape");
      else await pointer(container.querySelector(`[data-page-svg-object-visual="${mark.id}"] circle`)!, ending, { x: 600, y: 500 });
      if (finishWrite) await act(async () => finishWrite!());
      if (ending === "pointerup") {
        expect(dropMark(snapshot().document).anchor).toEqual(mark.anchor);
        expect(dropMark(snapshot().document).x).not.toBe(mark.x);
      } else expect(snapshot().document).toEqual(before);
      expect(snapshot().file.dirty, "only a committed move after Save is dirty").toBe(ending === "pointerup");
      expect.soft(dropMolecule(saved), "clean restored canvas must match saved chemistry").toEqual(dropMolecule(snapshot().document));
      expect(container.querySelector("main")?.getAttribute("data-can-undo")).toBe(ending === "pointerup" ? "true" : "false");
    });
  });
});
