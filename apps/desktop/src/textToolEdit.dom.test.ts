// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MainWindow } from "./MainWindow";
import { createPhase4Document, insertNativeTextObject } from "./documentWorkflow";
import { MemoryStorage } from "./testSupport/memoryStorage";

vi.mock("./rdkitWasmLoader", () => ({ registerRdkitWasmLoader: vi.fn() }));
vi.mock("@scena/react-ruler", () => ({ default: () => createElement("canvas") }));

describe.each(["macos", "windows"] as const)("Text tool click-away (%s)", platform => {
  let container: HTMLDivElement;
  let root: Root;
  let canvas: HTMLElement;
  let textId: string;
  const captureMethods = ["setPointerCapture", "releasePointerCapture", "hasPointerCapture"] as const;
  let captureDescriptors: Array<PropertyDescriptor | undefined>;
  const editor = () => container.querySelector<HTMLTextAreaElement>(".text-object-editor");
  const status = () => container.querySelector("[data-status-message]")?.textContent;
  const snapshot = () => window.__CHEMDRAFT_AGENT__!.snapshot();

  beforeEach(() => {
    (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    vi.stubGlobal("localStorage", new MemoryStorage());
    vi.stubGlobal("ResizeObserver", class { observe() {} unobserve() {} disconnect() {} });
    vi.stubGlobal("CSS", { escape: (value: string) => value });
    vi.spyOn(document, "hasFocus").mockReturnValue(true);
    captureDescriptors = captureMethods.map(method => Object.getOwnPropertyDescriptor(HTMLElement.prototype, method));
    for (const method of captureMethods) Object.defineProperty(HTMLElement.prototype, method, { configurable: true, value: () => false });
    window.history.replaceState(null, "", "/?agentBridge=1");
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
    captureMethods.forEach((method, index) => {
      const descriptor = captureDescriptors[index];
      if (descriptor) Object.defineProperty(HTMLElement.prototype, method, descriptor);
      else Reflect.deleteProperty(HTMLElement.prototype, method);
    });
    vi.useRealTimers();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    window.history.replaceState(null, "", "/");
    delete window.__CHEMDRAFT_AGENT__;
  });

  async function mouse(target: Element, type: string, x: number, y: number) {
    const event = new MouseEvent(type, { bubbles: true, cancelable: true, button: 0,
      buttons: type.endsWith("down") ? 1 : 0, clientX: x, clientY: y,
      detail: type.startsWith("pointer") ? 0 : 1 });
    Object.defineProperties(event, { pointerId: { value: 1 }, pointerType: { value: "mouse" }, isPrimary: { value: true } });
    await act(async () => { target.dispatchEvent(event); });
    return event;
  }

  async function click(target: HTMLElement | SVGElement, x: number, y: number) {
    const down = await mouse(target, "pointerdown", x, y);
    const mouseDown = await mouse(target, "mousedown", x, y);
    // jsdom/agent events skip browser focus defaults. Reproduce mousedown's focus
    // move (and real blur/focusout) only when pointerdown/mousedown allowed it.
    // A prevented canvas press must arrange its own blur rather than relying on this.
    if (!down.defaultPrevented && !mouseDown.defaultPrevented) {
      await act(async () => {
        if (target === editor()) target.focus();
        else if (canvas.contains(target)) canvas.focus();
        else target.focus();
      });
    }
    await mouse(target, "pointerup", x, y);
    await mouse(target, "mouseup", x, y);
    await mouse(target, "click", x, y);
  }

  async function startEditing() {
    const drawing = insertNativeTextObject(createPhase4Document("Click-away"), { x: 220, y: 200 }, "Conditions");
    textId = drawing.pages[0].objects.find(object => object.type === "text")!.id;
    await act(async () => root.render(createElement(MainWindow, {
      initialDocument: drawing, initialActiveToolCommandId: "tool.text", initialPaletteMode: "hidden",
      initialRulersVisible: false, initialCrosshairsVisible: false, nativePalette: false, shortcutPlatform: platform
    })));
    canvas = container.querySelector<HTMLElement>(".canvas-region")!;
    const rect = { x: 0, y: 0, left: 0, top: 0, right: 792, bottom: 612, width: 792, height: 612, toJSON: () => ({}) };
    for (const element of container.querySelectorAll<HTMLElement>(".page, .canvas-region")) {
      vi.spyOn(element, "getBoundingClientRect").mockReturnValue(rect);
    }
    vi.spyOn(canvas, "clientWidth", "get").mockReturnValue(792);
    vi.spyOn(canvas, "clientHeight", "get").mockReturnValue(612);
    const glyph = container.querySelector<SVGElement>(`[data-page-svg-object-visual="${textId}"] text`)!;
    await click(glyph, 230, 208);
    await act(async () => vi.advanceTimersByTimeAsync(100));
    expect(editor()).not.toBeNull();
    expect(document.activeElement).toBe(editor());
    expect(status()).toBe("Editing text");
    await act(async () => {
      const field = editor()!;
      field.dispatchEvent(new KeyboardEvent("keydown", { key: "U", bubbles: true, cancelable: true }));
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(field, "Updated conditions");
      field.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText", data: "Updated conditions" }));
      field.dispatchEvent(new KeyboardEvent("keyup", { key: "U", bubbles: true }));
    });
  }

  it("saves text, removes the editor and clears Editing text after one complete empty-canvas click", async () => {
    await startEditing();
    const blur = vi.fn();
    editor()!.addEventListener("blur", blur);
    await click(container.querySelector<HTMLElement>(".page")!, 500, 400);
    await act(async () => vi.advanceTimersByTimeAsync(100));
    expect(blur).toHaveBeenCalledTimes(1);
    expect(document.activeElement).toBe(canvas);
    expect(snapshot().document.pages[0].objects.find(object => object.id === textId)).toMatchObject({ text: "Updated conditions" });
    expect(editor()).toBeNull();
    expect(status()).toBe("");
  });

  it.each(["blur", "Escape", "tool switch"])("clears Editing text on %s", async finish => {
    await startEditing();
    await act(async () => {
      if (finish === "blur") editor()!.blur();
      else if (finish === "Escape") {
        editor()!.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }));
      } else await window.__CHEMDRAFT_AGENT__!.command("tool.select");
    });
    await act(async () => vi.advanceTimersByTimeAsync(100));
    expect(editor()).toBeNull();
    expect(snapshot().document.pages[0].objects.find(object => object.id === textId)).toMatchObject({ text: "Updated conditions" });
    expect(status()).not.toContain("Editing text");
    if (finish !== "tool switch") expect(status()).toBe("");
  });
});
