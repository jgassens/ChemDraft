// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { applyPatches } from "@chemdraft/chem-core";
import { MainWindow } from "./MainWindow";
import { createNativeSingleBondMolecule, createPhase4Document, insertNativeTextObject } from "./documentWorkflow";
import { forceDocumentHistoryCommandId } from "./editHistoryRouting";
import { MemoryStorage } from "./testSupport/memoryStorage";
import { DOM_COMMAND_EVENT } from "./window-manager";

vi.mock("./rdkitWasmLoader", () => ({ registerRdkitWasmLoader: vi.fn() }));
vi.mock("@scena/react-ruler", () => ({ default: () => <canvas /> }));
class TestResizeObserver { observe() {} unobserve() {} disconnect() {} }

describe.each(["macos", "windows"] as const)("panel shortcuts with a retained document editor (%s)", platform => {
  let container: HTMLDivElement;
  let root: Root;
  let textId: string;
  const textHistory = vi.fn(() => true);
  const snapshot = () => window.__CHEMDRAFT_AGENT__!.snapshot();
  const objects = () => snapshot().document.pages[0]!.objects;
  const editor = () => container.querySelector<HTMLTextAreaElement>(".text-object-editor");

  beforeEach(async () => {
    (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    vi.stubGlobal("localStorage", new MemoryStorage());
    vi.stubGlobal("ResizeObserver", TestResizeObserver);
    vi.stubGlobal("CSS", { escape: (value: string) => value });
    vi.spyOn(document, "hasFocus").mockReturnValue(true);
    textHistory.mockClear();
    Object.defineProperty(document, "execCommand", { configurable: true, value: textHistory });
    HTMLElement.prototype.setPointerCapture ??= () => {};
    HTMLElement.prototype.releasePointerCapture ??= () => {};
    HTMLElement.prototype.hasPointerCapture ??= () => false;
    window.history.replaceState(null, "", "/?agentBridge=1");
    container = document.createElement("div"); document.body.append(container); root = createRoot(container);
    let drawing = createPhase4Document("Panel shortcuts");
    drawing = applyPatches(drawing, [{ op: "addObject", pageId: drawing.pages[0]!.id,
      object: createNativeSingleBondMolecule(drawing, { x: 100, y: 100 }) }]);
    drawing = insertNativeTextObject(drawing, { x: 220, y: 200 }, "Conditions");
    textId = drawing.pages[0]!.objects.find(object => object.type === "text")!.id;
    await act(async () => root.render(<MainWindow initialDocument={drawing} initialActiveToolCommandId="tool.select"
      initialPaletteMode="hidden" initialRulersVisible={false} initialCrosshairsVisible={false}
      nativePalette={false} shortcutPlatform={platform} />));
    const rect = { x: 0, y: 0, left: 0, top: 0, right: 792, bottom: 612, width: 792, height: 612, toJSON: () => ({}) };
    for (const element of container.querySelectorAll<HTMLElement>(".page, .canvas-region")) {
      vi.spyOn(element, "getBoundingClientRect").mockReturnValue(rect);
    }
    const canvas = container.querySelector<HTMLElement>(".canvas-region")!;
    vi.spyOn(canvas, "clientWidth", "get").mockReturnValue(792);
    vi.spyOn(canvas, "clientHeight", "get").mockReturnValue(612);
  });

  afterEach(async () => {
    await act(async () => root.unmount()); container.remove();
    Reflect.deleteProperty(document, "execCommand");
    vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllGlobals();
    window.history.replaceState(null, "", "/"); delete window.__CHEMDRAFT_AGENT__;
  });

  async function command(commandId: string) {
    await act(async () => {
      window.dispatchEvent(new CustomEvent(DOM_COMMAND_EVENT, { detail: { commandId } }));
    });
  }

  async function pasteNote() {
    const event = new Event("paste", { bubbles: true, cancelable: true });
    Object.defineProperty(event, "clipboardData", {
      value: { types: ["text/plain"], getData: () => "History note" }
    });
    await act(async () => window.dispatchEvent(event));
  }

  async function retainEditor() {
    await command("tool.text");
    const glyph = container.querySelector(`[data-page-svg-object-visual="${textId}"] text`)!;
    for (const type of ["pointerdown", "pointerup"]) {
      const event = new MouseEvent(type, { bubbles: true, cancelable: true, button: 0,
        buttons: type === "pointerdown" ? 1 : 0, clientX: 230, clientY: 208 });
      Object.defineProperties(event, { pointerId: { value: 1 }, pointerType: { value: "mouse" }, isPrimary: { value: true } });
      await act(async () => glyph.dispatchEvent(event));
    }
    await act(async () => vi.advanceTimersByTimeAsync(100));
    expect(editor()).not.toBeNull();
    expect(document.activeElement).toBe(editor());
    // A different native window can be key while this webview retains its activeElement.
    vi.mocked(document.hasFocus).mockReturnValue(false);
  }

  it("forwards Undo to drawing history while ordinary Undo still belongs to the editor", async () => {
    const before = objects();
    await pasteNote();
    const after = objects();
    expect(after).toHaveLength(before.length + 1);
    await retainEditor();
    await command("edit.undo");
    expect(textHistory).toHaveBeenCalledExactlyOnceWith("undo");
    expect(objects()).toEqual(after);
    expect(document.activeElement).toBe(editor());
    textHistory.mockClear();
    await command(forceDocumentHistoryCommandId("edit.undo"));
    expect(objects()).toEqual(before);
    expect(textHistory).not.toHaveBeenCalled();
    expect(editor()).toBeNull();
  });

  it("forwards Redo to drawing history while ordinary Redo still belongs to the editor", async () => {
    const before = objects();
    await pasteNote();
    const after = objects();
    await command(forceDocumentHistoryCommandId("edit.undo"));
    expect(objects()).toEqual(before);
    await retainEditor();
    await command("edit.redo");
    expect(textHistory).toHaveBeenCalledExactlyOnceWith("redo");
    expect(objects()).toEqual(before);
    expect(document.activeElement).toBe(editor());
    textHistory.mockClear();
    await command(forceDocumentHistoryCommandId("edit.redo"));
    expect(objects()).toEqual(after);
    expect(textHistory).not.toHaveBeenCalled();
    expect(editor()).toBeNull();
  });

  it("forwards Select All to drawing objects while ordinary Select All stays in the editor", async () => {
    await retainEditor();
    const field = editor()!;
    const selectText = vi.spyOn(field, "select");
    await command("edit.selectAll");
    expect(selectText).toHaveBeenCalledOnce();
    expect(snapshot().selection.objectIds).toEqual([textId]);
    field.setSelectionRange(1, 3);
    selectText.mockClear();
    const before = objects();
    await command(forceDocumentHistoryCommandId("edit.selectAll"));
    expect(snapshot().selection.objectIds).toEqual(before.map(object => object.id));
    expect(objects()).toEqual(before);
    expect(selectText).not.toHaveBeenCalled();
    expect(editor()).toBeNull();
  });
});
