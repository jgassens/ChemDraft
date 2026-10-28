// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { applyPatches } from "@chemdraft/chem-core";
import { MainWindow, PageContextMenu } from "./MainWindow";
import { createNativeSingleBondMolecule, createPhase4Document } from "./documentWorkflow";
import { MemoryStorage } from "./testSupport/memoryStorage";
import { DOM_COMMAND_EVENT } from "./window-manager";

vi.mock("./rdkitWasmLoader", () => ({ registerRdkitWasmLoader: vi.fn() }));
vi.mock("@scena/react-ruler", () => ({ default: () => <canvas /> }));
class TestResizeObserver { observe() {} unobserve() {} disconnect() {} }

let container: HTMLDivElement;
let root: Root;
let canvas: HTMLElement;
let focus: ReturnType<typeof vi.spyOn>;

async function pointer(target: Element, options: MouseEventInit & { pointerType?: string; isPrimary?: boolean } = {}, type = "pointerdown") {
  const event = new MouseEvent(type, { bubbles: true, cancelable: true,
    button: 0, buttons: type === "pointerdown" ? 1 : 0, clientX: 500, clientY: 500, ...options });
  Object.defineProperties(event, { pointerId: { value: 1 }, pointerType: { value: options.pointerType ?? "mouse" },
    isPrimary: { value: options.isPrimary ?? true } });
  await act(async () => target.dispatchEvent(event));
  return event;
}

describe.each(["macos", "windows"] as const)("MainWindow unfocused canvas on %s", platform => {
  beforeEach(async () => {
    (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    vi.stubGlobal("localStorage", new MemoryStorage());
    vi.stubGlobal("ResizeObserver", TestResizeObserver);
    vi.stubGlobal("CSS", { escape: (value: string) => value });
    HTMLElement.prototype.setPointerCapture ??= () => {};
    HTMLElement.prototype.releasePointerCapture ??= () => {};
    HTMLElement.prototype.hasPointerCapture ??= () => false;
    container = document.createElement("div"); document.body.append(container); root = createRoot(container);
    let drawing = createPhase4Document("Canvas focus");
    drawing = applyPatches(drawing, [{ op: "addObject", pageId: drawing.pages[0].id,
      object: createNativeSingleBondMolecule(drawing, { x: 100, y: 100 }) }]);
    await act(async () => root.render(<MainWindow initialDocument={drawing} initialActiveToolCommandId="tool.select"
      initialPaletteMode="hidden" initialRulersVisible={false} nativePalette={false} shortcutPlatform={platform} />));
    canvas = container.querySelector<HTMLElement>(".canvas-region")!;
    // jsdom has no layout. Match the offset, border and scrollbar geometry used by #211's tests.
    vi.spyOn(canvas, "getBoundingClientRect").mockReturnValue({ x: 100, y: 100, left: 100, top: 100,
      width: 820, height: 620, right: 920, bottom: 720, toJSON: () => ({}) });
    for (const [key, value] of Object.entries({ clientLeft: 2, clientTop: 2, clientWidth: 800, clientHeight: 600 })) {
      vi.spyOn(canvas, key as "clientLeft" | "clientTop" | "clientWidth" | "clientHeight", "get").mockReturnValue(value);
    }
    focus = vi.spyOn(canvas, "focus");
    expect(document.activeElement).toBe(document.body);
  });
  afterEach(async () => {
    await act(async () => root.unmount()); container.remove(); vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllGlobals();
  });

  it.each([".page", ".canvas-region", "[data-object-id]"])("focuses the canvas once from BODY when pressing %s", async selector => {
    const target = container.querySelector(selector)!;
    expect(target).not.toBeNull();
    const event = await pointer(target);
    expect(document.activeElement).toBe(canvas);
    expect(focus).toHaveBeenCalledExactlyOnceWith({ preventScroll: true });
    if (selector === ".page") expect(event.defaultPrevented).toBe(true);
  });

  it("does not refocus an already focused canvas", async () => {
    canvas.focus(); focus.mockClear();
    await pointer(container.querySelector(".page")!);
    expect(document.activeElement).toBe(canvas);
    expect(focus).not.toHaveBeenCalled();
  });

  it.each(["input", "button"])("keeps focus in a %s on a page press", async tag => {
    const control = document.createElement(tag);
    container.append(control); control.focus();
    await pointer(container.querySelector(".page")!);
    expect(document.activeElement).toBe(control);
    expect(focus).not.toHaveBeenCalled();
  });

  async function openTextEditor() {
    await act(async () => window.dispatchEvent(new CustomEvent(DOM_COMMAND_EVENT, { detail: { commandId: "tool.text" } })));
    const page = container.querySelector(".page")!;
    await pointer(page);
    await pointer(page, {}, "pointerup");
    const editor = container.querySelector<HTMLTextAreaElement>(".text-object-editor")!;
    expect(editor).not.toBeNull();
    expect(document.activeElement).toBe(editor);
    focus.mockClear();
    return editor;
  }

  it("commits the text-object editor and focuses the canvas on an empty canvas press", async () => {
    await openTextEditor();
    await pointer(canvas);
    expect(container.querySelector(".text-object-editor")).toBeNull();
    expect(document.activeElement).toBe(canvas);
    expect(focus).toHaveBeenCalledExactlyOnceWith({ preventScroll: true });
  });

  it("does not take focus from an open context menu or its items", async () => {
    const host = document.createElement("div"); container.append(host);
    const menuRoot = createRoot(host);
    const dismiss = vi.fn();
    try {
      // Keep the menu mounted after the outside press; normal dismissal has its own focus-return behavior.
      await act(async () => menuRoot.render(<PageContextMenu position={{ x: 200, y: 200 }} onInvoke={() => {}} onDismiss={dismiss} />));
      const item = host.querySelector<HTMLButtonElement>('[role="menuitem"]')!;
      expect(document.activeElement).toBe(item);
      await pointer(canvas);
      expect(dismiss).toHaveBeenCalledOnce();
      expect(document.activeElement).toBe(item);
      expect(focus).not.toHaveBeenCalled();
    } finally { await act(async () => menuRoot.unmount()); host.remove(); }
  });

  it.each(["compositionend", "compositioncancel", "input", "keydown", "keyup", "timeout"])("protects composition across editor blur and recovers on %s", async terminal => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const editor = await openTextEditor();
    // Inline editors retry focus at 0, 16 and 80 ms while their native window settles.
    // Finish those retries before deliberately blurring: otherwise a pending retry can
    // refocus this still-mounted editor between the BODY-focus assertions under load.
    await act(async () => vi.advanceTimersByTimeAsync(80));
    editor.addEventListener("compositionstart", event => event.stopPropagation());
    await act(async () => editor.dispatchEvent(new CompositionEvent("compositionstart", { bubbles: true })));
    await act(async () => editor.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, key: "Process", isComposing: true })));
    await pointer(canvas);
    expect(document.activeElement).toBe(editor);
    expect(focus).not.toHaveBeenCalled();
    await act(async () => editor.blur());
    expect(document.activeElement).toBe(document.body);
    await pointer(canvas);
    expect(document.activeElement).toBe(document.body);
    expect(focus).not.toHaveBeenCalled();
    await act(async () => {
      if (terminal === "timeout") return vi.advanceTimersByTimeAsync(10000);
      const event = terminal === "keydown" || terminal === "keyup"
        ? new KeyboardEvent(terminal, { bubbles: true, key: "Shift", isComposing: false })
        : terminal === "input"
          ? new InputEvent(terminal, { bubbles: true, isComposing: false })
          : new CompositionEvent(terminal, { bubbles: true });
      document.body.dispatchEvent(event);
    });
    await pointer(canvas);
    expect(document.activeElement).toBe(canvas);
    expect(focus).toHaveBeenCalledExactlyOnceWith({ preventScroll: true });
  });

  it("protects composition after editor removal until compositioncancel", async () => {
    const host = document.createElement("div"); container.append(host);
    const editorRoot = createRoot(host);
    await act(async () => editorRoot.render(<input autoFocus />));
    const editor = host.querySelector("input")!;
    const blur = vi.fn(); editor.addEventListener("blur", blur);
    await act(async () => editor.dispatchEvent(new CompositionEvent("compositionstart", { bubbles: true })));
    await act(async () => editor.dispatchEvent(new KeyboardEvent("keyup", { bubbles: true, key: "Process", isComposing: true })));
    await act(async () => editorRoot.unmount());
    expect(blur).not.toHaveBeenCalled();
    expect(document.activeElement).toBe(document.body);
    await pointer(canvas);
    expect(document.activeElement).toBe(document.body);
    expect(focus).not.toHaveBeenCalled();
    await act(async () => document.body.dispatchEvent(new CompositionEvent("compositioncancel", { bubbles: true })));
    await pointer(canvas);
    expect(document.activeElement).toBe(canvas);
    expect(focus).toHaveBeenCalledExactlyOnceWith({ preventScroll: true });
    host.remove();
  });

  it.each(["blur", "focusout"])("keeps BODY focus protected after %s until compositionend", async type => {
    await act(async () => {
      document.body.dispatchEvent(new CompositionEvent("compositionstart", { bubbles: true }));
      document.body.dispatchEvent(new FocusEvent(type, { bubbles: true }));
    });
    await pointer(canvas);
    expect(document.activeElement).toBe(document.body);
    expect(focus).not.toHaveBeenCalled();
    await act(async () => document.body.dispatchEvent(new CompositionEvent("compositionend", { bubbles: true })));
    await pointer(canvas);
    expect(document.activeElement).toBe(canvas);
    expect(focus).toHaveBeenCalledExactlyOnceWith({ preventScroll: true });
  });

  it.each(["compositionend", "compositioncancel", "input", "keydown", "keyup"])("recovers on %s without consuming the event", async type => {
    // BODY focus exposes the canvas handoff rather than the separate focused-control guard.
    await act(async () => document.body.dispatchEvent(new CompositionEvent("compositionstart", { bubbles: true })));
    await act(async () => document.body.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, key: "Process", isComposing: true })));
    await pointer(canvas);
    expect(focus).not.toHaveBeenCalled();
    const terminal = type === "keydown" || type === "keyup"
      ? new KeyboardEvent(type, { bubbles: true, cancelable: true, key: "Shift", isComposing: false })
      : type === "input"
        ? new InputEvent(type, { bubbles: true, cancelable: true, isComposing: false })
        : new Event(type, { bubbles: true, cancelable: true });
    const propagated = vi.fn();
    window.addEventListener(type, propagated, { once: true });
    await act(async () => document.body.dispatchEvent(terminal));
    expect(terminal.defaultPrevented).toBe(false);
    expect(propagated).toHaveBeenCalledOnce();
    await pointer(canvas);
    expect(document.activeElement).toBe(canvas);
    expect(focus).toHaveBeenCalledExactlyOnceWith({ preventScroll: true });
  });

  it.each(["compositionstart", "keydown", "keyup"])("expires an orphaned %s after ten seconds of silence", async type => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    await act(async () => {
      document.body.dispatchEvent(new CompositionEvent("compositionstart", { bubbles: true }));
      if (type !== "compositionstart") document.body.dispatchEvent(new KeyboardEvent(type, { bubbles: true, key: "Process", isComposing: true }));
    });
    await act(async () => vi.advanceTimersByTimeAsync(5000));
    await pointer(canvas);
    expect(focus).not.toHaveBeenCalled();
    await act(async () => vi.advanceTimersByTimeAsync(5000));
    await pointer(canvas);
    expect(document.activeElement).toBe(canvas);
    expect(focus).toHaveBeenCalledExactlyOnceWith({ preventScroll: true });
  });

  it.each(["compositionupdate", "input.isComposing", "keydown", "keyup", "focusin"])("keeps an ongoing composition alive on %s", async type => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    await act(async () => document.body.dispatchEvent(new CompositionEvent("compositionstart", { bubbles: true })));
    const activity = type === "keydown" || type === "keyup"
      ? new KeyboardEvent(type, { bubbles: true, cancelable: true, key: "Process", isComposing: true })
      : type.startsWith("input")
        ? new InputEvent("input", { bubbles: true, cancelable: true, isComposing: type === "input.isComposing" })
        : new Event(type, { bubbles: true, cancelable: true });
    // Continuous activity must protect focus even beyond the original idle deadline.
    for (let renewal = 0; renewal < 3; renewal++) {
      await act(async () => vi.advanceTimersByTimeAsync(5000));
      await act(async () => document.body.dispatchEvent(activity));
      await pointer(canvas);
      expect(document.activeElement).toBe(document.body);
      expect(focus).not.toHaveBeenCalled();
      expect(activity.defaultPrevented).toBe(false);
    }
    await act(async () => document.dispatchEvent(new CompositionEvent("compositionend", { bubbles: true })));
    await pointer(canvas);
    expect(document.activeElement).toBe(canvas);
  });

  it.each(["keydown", "keyup"])("observes recent %s.isComposing without consuming it", async type => {
    const key = new KeyboardEvent(type, { bubbles: true, cancelable: true, key: "Process", isComposing: true });
    await act(async () => document.body.dispatchEvent(key));
    expect(key.defaultPrevented).toBe(false);
    await pointer(canvas);
    expect(document.activeElement).toBe(document.body);
    expect(focus).not.toHaveBeenCalled();
    await act(async () => document.dispatchEvent(new CompositionEvent("compositionend", { bubbles: true })));
    await pointer(canvas);
    expect(document.activeElement).toBe(canvas);
  });

  it("does nothing while an aria-modal dialog is present", async () => {
    const dialog = document.createElement("div"); dialog.setAttribute("aria-modal", "true"); container.append(dialog);
    await pointer(container.querySelector(".page")!);
    expect(document.activeElement).toBe(document.body);
    expect(focus).not.toHaveBeenCalled();
  });

  it.each([
    { button: 1 }, { button: 2 }, { button: 2, pointerType: "pen" },
    { pointerType: "pen", isPrimary: false }, { pointerType: "touch", isPrimary: false },
    { clientX: 902 }, { clientY: 702 }, { clientX: 101 }
  ])("ignores special buttons, non-primary gestures, borders and scrollbars: %j", async options => {
    await pointer(canvas, options);
    expect(document.activeElement).toBe(document.body);
    expect(focus).not.toHaveBeenCalled();
  });
});
