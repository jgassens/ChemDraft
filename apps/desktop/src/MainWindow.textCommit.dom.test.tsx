// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { applyPatches } from "@chemdraft/chem-core";
import { MainWindow } from "./MainWindow";
import { createNativeSingleBondMolecule, createPhase4Document, insertNativeTextObject } from "./documentWorkflow";
import { MemoryStorage } from "./testSupport/memoryStorage";

vi.mock("./rdkitWasmLoader", () => ({ registerRdkitWasmLoader: vi.fn() }));
vi.mock("@scena/react-ruler", () => ({ default: () => <canvas /> }));
class TestResizeObserver { observe() {} unobserve() {} disconnect() {} }

describe.each(["macos", "windows"] as const)("text commit click (%s)", platform => {
  let container: HTMLDivElement;
  let root: Root;
  let canvas: HTMLElement;
  let textId: string;
  const snapshot = () => window.__CHEMDRAFT_AGENT__!.snapshot();
  const editor = () => container.querySelector<HTMLTextAreaElement>(".text-object-editor");

  beforeEach(() => {
    (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    vi.stubGlobal("localStorage", new MemoryStorage());
    vi.stubGlobal("ResizeObserver", TestResizeObserver);
    vi.stubGlobal("CSS", { escape: (value: string) => value });
    vi.spyOn(document, "hasFocus").mockReturnValue(true);
    HTMLElement.prototype.setPointerCapture ??= () => {};
    HTMLElement.prototype.releasePointerCapture ??= () => {};
    HTMLElement.prototype.hasPointerCapture ??= () => false;
    window.history.replaceState(null, "", "/?agentBridge=1");
    container = document.createElement("div"); document.body.append(container); root = createRoot(container);
  });

  afterEach(async () => {
    await act(async () => root.unmount()); container.remove();
    vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllGlobals();
    window.history.replaceState(null, "", "/"); delete window.__CHEMDRAFT_AGENT__;
  });

  async function pointer(target: Element, type: string, x = 500, y = 400) {
    const event = new MouseEvent(type, { bubbles: true, cancelable: true, button: 0,
      buttons: type === "pointerdown" ? 1 : 0, clientX: x, clientY: y });
    Object.defineProperties(event, { pointerId: { value: 1 }, pointerType: { value: "mouse" }, isPrimary: { value: true } });
    await act(async () => target.dispatchEvent(event));
    // Synthetic pointer events lack browser focus defaults. Emulate blur only when allowed.
    if (type === "pointerdown" && !event.defaultPrevented && document.activeElement === editor() && target !== editor()) {
      await act(async () => editor()?.blur());
    }
    return event;
  }

  async function mount(tool: string, paletteMode: "hidden" | "floating" = "hidden") {
    let drawing = createPhase4Document("Commit click");
    drawing = applyPatches(drawing, [{ op: "addObject", pageId: drawing.pages[0].id,
      object: createNativeSingleBondMolecule(drawing, { x: 100, y: 100 }) }]);
    drawing = insertNativeTextObject(drawing, { x: 220, y: 200 }, "Conditions");
    textId = drawing.pages[0].objects.find(object => object.type === "text")!.id;
    await act(async () => root.render(<MainWindow initialDocument={drawing} initialActiveToolCommandId={tool}
      initialPaletteMode={paletteMode} initialRulersVisible={false} initialCrosshairsVisible={false}
      nativePalette={false} shortcutPlatform={platform} />));
    canvas = container.querySelector<HTMLElement>(".canvas-region")!;
    const rect = { x: 0, y: 0, left: 0, top: 0, right: 792, bottom: 612, width: 792, height: 612, toJSON: () => ({}) };
    for (const element of container.querySelectorAll<HTMLElement>(".page, .canvas-region")) {
      vi.spyOn(element, "getBoundingClientRect").mockReturnValue(rect);
    }
    vi.spyOn(canvas, "clientWidth", "get").mockReturnValue(792);
    vi.spyOn(canvas, "clientHeight", "get").mockReturnValue(612);
    // Text is a temporary tool: the editor opens and the previous drawing tool resumes.
    await act(async () => { await window.__CHEMDRAFT_AGENT__!.command("tool.text"); });
    const glyph = container.querySelector(`[data-page-svg-object-visual="${textId}"] text`)!;
    await pointer(glyph, "pointerdown", 230, 208);
    await pointer(glyph, "pointerup", 230, 208);
    expect(editor()).not.toBeNull();
    expect(snapshot().activeToolCommandId).toBe(tool);
    await act(async () => vi.advanceTimersByTimeAsync(100));
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(editor(), "Updated conditions");
      editor()!.dispatchEvent(new Event("input", { bubbles: true }));
    });
    expect(document.activeElement).toBe(editor());
  }

  it.each([
    ["tool.bond", "empty"], ["tool.select", "empty"], ["tool.bond", "atom"], ["tool.select", "atom"]
  ])("consumes %s commit on %s and lets the next click act normally", async (tool, destination) => {
    await mount(tool);
    const before = snapshot().document;
    const moleculeObjects = (document: typeof before) => document.pages[0].objects.filter(object => object.type === "molecule");
    const totalAtoms = (document: typeof before) => moleculeObjects(document).reduce((total, object) => total + (object.atoms?.length ?? 0), 0);
    const totalBonds = (document: typeof before) => moleculeObjects(document).reduce((total, object) => total + (object.bonds?.length ?? 0), 0);
    const target = () => destination === "atom"
      ? container.querySelector("[data-atom-id]")! : container.querySelector(".page")!;
    const molecule = before.pages[0].objects.find(object => object.type === "molecule")!;
    const atom = molecule.atoms![0];
    const x = destination === "atom" ? atom.x : 500;
    const y = destination === "atom" ? atom.y : 400;
    await pointer(target(), "pointerdown", x, y);
    await pointer(target(), "pointerup", x, y);
    expect(editor()).toBeNull();
    expect(snapshot().document.pages[0].objects.find(object => object.id === textId)).toMatchObject({ text: "Updated conditions" });
    // Compare complete molecule payloads: neither new bonds nor atom/bond edits are allowed.
    expect(snapshot().document.pages[0].objects).toEqual(before.pages[0].objects);
    expect(snapshot().document.selection).toEqual(before.selection);
    expect(snapshot().selectedNativeMoleculePart).toBeUndefined();
    expect(document.activeElement).toBe(canvas);
    await pointer(target(), "pointerdown", x, y);
    await pointer(target(), "pointerup", x, y);
    const afterNextClick = snapshot().document;
    if (tool === "tool.bond" && destination === "empty") {
      expect(totalBonds(afterNextClick)).toBe(totalBonds(before) + 1);
      expect(totalAtoms(afterNextClick)).toBe(totalAtoms(before) + 2);
    } else if (tool === "tool.bond" && destination === "atom") {
      expect(totalBonds(afterNextClick)).toBe(totalBonds(before) + 1);
      expect(totalAtoms(afterNextClick)).toBe(totalAtoms(before) + 1);
      expect(moleculeObjects(afterNextClick).map(object => object.id)).toEqual([molecule.id]);
      const extended = moleculeObjects(afterNextClick)[0]!;
      const addedBonds = extended.bonds!.filter(bond => !molecule.bonds!.some(previous => previous.id === bond.id));
      const addedAtoms = extended.atoms!.filter(candidate => !molecule.atoms!.some(previous => previous.id === candidate.id));
      expect(addedBonds).toHaveLength(1);
      expect(addedAtoms).toHaveLength(1);
      expect([addedBonds[0]!.fromAtomId, addedBonds[0]!.toAtomId]).toEqual(expect.arrayContaining([atom.id, addedAtoms[0]!.id]));
    } else if (tool === "tool.select" && destination === "empty") {
      expect(afterNextClick.selection.objectIds).toEqual([]);
    } else if (tool === "tool.select" && destination === "atom") {
      expect(afterNextClick.selection.objectIds).toEqual([molecule.id]);
      // A plain Select click on an atom selects that atom part of the molecule.
      expect(snapshot().selectedNativeMoleculePart).toEqual({ objectId: molecule.id, kind: "atom", atomId: atom.id });
    }
  });

  it.each(["left", "right", "top", "bottom"])("keeps editing through a %s text resize", async edge => {
    await mount("tool.bond");
    const textarea = editor()!;
    const before = snapshot().document.pages[0].objects.find(object => object.id === textId)!;
    const handle = container.querySelector(`[data-object-id="${textId}"] [data-text-resize-edge="${edge}"]`)!;
    const page = container.querySelector(".page")!;
    const horizontal = edge === "left" || edge === "right";
    const x = before.x + (edge === "left" ? 0 : before.width);
    const y = before.y + (edge === "top" ? 0 : before.height);
    const dx = horizontal ? (edge === "left" ? -40 : 40) : 0;
    const dy = horizontal ? 0 : (edge === "top" ? -40 : 40);
    await pointer(handle, "pointerdown", x, y);
    expect(editor()).toBe(textarea);
    expect(document.activeElement).toBe(textarea);
    expect(snapshot().document.pages[0].objects.find(object => object.id === textId)).toEqual(before);
    await pointer(page, "pointermove", x + dx, y + dy);
    expect(editor()).toBe(textarea);
    const resized = snapshot().document.pages[0].objects.find(object => object.id === textId)!;
    expect(horizontal ? resized.width : resized.height).toBe((horizontal ? before.width : before.height) + 40);
    await pointer(page, "pointerup", x + dx, y + dy);
    expect(editor()).toBe(textarea);
    expect(document.activeElement).toBe(textarea);
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(textarea, "Editing after resize");
      textarea.dispatchEvent(new Event("input", { bubbles: true }));
    });
    expect(editor()).toBe(textarea);
    expect(snapshot().document.pages[0].objects.find(object => object.id === textId)).toMatchObject({ text: "Editing after resize" });
  });

  it("leaves pointer presses inside the textarea available for text selection", async () => {
    await mount("tool.bond");
    const textarea = editor()!;
    const event = await pointer(textarea, "pointerdown", 230, 208);
    await pointer(textarea, "pointerup", 230, 208);
    expect(event.defaultPrevented).toBe(false);
    expect(editor()).toBe(textarea);
    expect(document.activeElement).toBe(textarea);
  });

  it.each(["composition", "composing-key"])("protects %s from a canvas commit press", async source => {
    await mount("tool.bond");
    const textarea = editor()!;
    const before = snapshot().document;
    await act(async () => textarea.dispatchEvent(source === "composition"
      ? new CompositionEvent("compositionstart", { bubbles: true })
      : new KeyboardEvent("keydown", { key: "Process", isComposing: true, bubbles: true })));
    for (const target of [container.querySelector(".page")!, container.querySelector("[data-atom-id]")!]) {
      const event = await pointer(target, "pointerdown");
      await pointer(target, "pointerup");
      expect(event.defaultPrevented).toBe(true);
      expect(editor()).toBe(textarea);
      expect(document.activeElement).toBe(textarea);
      expect(snapshot().document).toEqual(before);
    }
    await act(async () => textarea.dispatchEvent(new CompositionEvent("compositionend", { bubbles: true })));
    await pointer(container.querySelector(".page")!, "pointerdown");
    await pointer(container.querySelector(".page")!, "pointerup");
    expect(editor()).toBeNull();
    expect(snapshot().document).toEqual(before);
    expect(document.activeElement).toBe(canvas);
  });

  it("keeps Enter as a textarea newline and Escape as finish, without swallowing the next press", async () => {
    await mount("tool.bond");
    const textarea = editor()!;
    const enter = new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true });
    await act(async () => textarea.dispatchEvent(enter));
    expect(enter.defaultPrevented).toBe(false);
    expect(editor()).toBe(textarea);
    const escape = new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true });
    await act(async () => textarea.dispatchEvent(escape));
    expect(escape.defaultPrevented).toBe(true);
    expect(editor()).toBeNull();
    expect(snapshot().document.pages[0].objects.find(object => object.id === textId)).toMatchObject({ text: "Updated conditions" });
    const objects = snapshot().document.pages[0].objects;
    await pointer(container.querySelector(".page")!, "pointerdown");
    await pointer(container.querySelector(".page")!, "pointerup");
    expect(snapshot().document.pages[0].objects).toHaveLength(objects.length + 1);
  });

  it.each(["Tab", "pointer"])("commits through %s to a toolbar button and still runs its command", async entry => {
    await mount("tool.bond", "floating");
    const button = container.querySelector<HTMLButtonElement>('button[data-command-id="tool.select"]')!;
    expect(button).not.toBeNull();
    if (entry === "Tab") {
      const tab = new KeyboardEvent("keydown", { key: "Tab", bubbles: true, cancelable: true });
      await act(async () => editor()!.dispatchEvent(tab));
      expect(tab.defaultPrevented).toBe(false);
      // jsdom has no native Tab traversal; moving focus performs the real blur commit.
      await act(async () => button.focus());
    } else {
      expect((await pointer(button, "pointerdown")).defaultPrevented).toBe(false);
      await act(async () => button.focus());
    }
    await pointer(button, "pointerup");
    await act(async () => button.click());
    expect(editor()).toBeNull();
    expect(snapshot().activeToolCommandId).toBe("tool.select");
    expect(snapshot().document.pages[0].objects.find(object => object.id === textId)).toMatchObject({ text: "Updated conditions" });
  });
});
