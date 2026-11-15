// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MainWindow } from "./MainWindow";
import { createPhase4Document, insertNativeTextObject } from "./documentWorkflow";
import { MemoryStorage } from "./testSupport/memoryStorage";

vi.mock("./rdkitWasmLoader", () => ({ registerRdkitWasmLoader: vi.fn() }));
vi.mock("@scena/react-ruler", () => ({ default: () => <canvas /> }));

describe.each(["macos", "windows"] as const)("Text tool Escape (%s)", platform => {
  let container: HTMLDivElement;
  let root: Root;
  const captureMethods = ["setPointerCapture", "releasePointerCapture", "hasPointerCapture"] as const;
  let captureDescriptors: Array<PropertyDescriptor | undefined>;
  const editor = () => container.querySelector<HTMLTextAreaElement>(".text-object-editor");
  const visuals = (type?: string) => container.querySelectorAll(
    type === "molecule" ? ".molecule-object" : `[data-page-svg-object-visual]${type ? `[data-object-type="${type}"]` : ""}`
  );
  const historyState = () => [
    container.querySelector("main")!.getAttribute("data-can-undo"),
    container.querySelector("main")!.getAttribute("data-can-redo")
  ];

  beforeEach(() => {
    (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    vi.stubGlobal("localStorage", new MemoryStorage());
    vi.stubGlobal("ResizeObserver", class { observe() {} unobserve() {} disconnect() {} });
    vi.stubGlobal("CSS", { escape: (value: string) => value });
    vi.spyOn(document, "hasFocus").mockReturnValue(true);
    captureDescriptors = captureMethods.map(name => Object.getOwnPropertyDescriptor(HTMLElement.prototype, name));
    for (const name of captureMethods) Object.defineProperty(HTMLElement.prototype, name, { configurable: true, value: () => false });
    container = document.createElement("div"); document.body.append(container); root = createRoot(container);
  });

  afterEach(async () => {
    await act(async () => root.unmount()); container.remove();
    captureMethods.forEach((name, index) => {
      const descriptor = captureDescriptors[index];
      if (descriptor) Object.defineProperty(HTMLElement.prototype, name, descriptor);
      else Reflect.deleteProperty(HTMLElement.prototype, name);
    });
    vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllGlobals();
  });

  async function mount(existingText?: string, paletteMode: "hidden" | "floating" = "floating") {
    let drawing = createPhase4Document("Text finish");
    if (existingText !== undefined) drawing = insertNativeTextObject(drawing, { x: 220, y: 200 }, existingText);
    await act(async () => root.render(<MainWindow initialDocument={drawing}
      initialActiveToolCommandId="tool.text" initialPaletteMode={paletteMode} nativePalette={false}
      initialRulersVisible={false} initialCrosshairsVisible={false} shortcutPlatform={platform} />));
    const rect = { x: 0, y: 0, left: 0, top: 0, right: 792, bottom: 612, width: 792, height: 612, toJSON: () => ({}) };
    for (const element of container.querySelectorAll<HTMLElement>(".page, .canvas-region")) {
      vi.spyOn(element, "getBoundingClientRect").mockReturnValue(rect);
    }
    const canvas = container.querySelector<HTMLElement>(".canvas-region")!;
    vi.spyOn(canvas, "clientWidth", "get").mockReturnValue(792);
    vi.spyOn(canvas, "clientHeight", "get").mockReturnValue(612);
  }

  async function click(target: Element, x = 300, y = 300) {
    for (const type of ["pointerdown", "pointerup"]) {
      const event = new MouseEvent(type, { bubbles: true, cancelable: true, button: 0,
        buttons: type === "pointerdown" ? 1 : 0, clientX: x, clientY: y });
      Object.defineProperties(event, { pointerId: { value: 1 }, pointerType: { value: "mouse" }, isPrimary: { value: true } });
      await act(async () => target.dispatchEvent(event));
      // jsdom omits pointerdown's native focus default; perform the allowed blur explicitly.
      if (type === "pointerdown" && !event.defaultPrevented && document.activeElement === editor() && target !== editor()) {
        await act(async () => editor()?.blur());
      }
    }
    await act(async () => vi.advanceTimersByTimeAsync(100));
  }

  async function typeText(value: string) {
    expect(editor()).not.toBeNull();
    expect(document.activeElement).toBe(editor());
    await act(async () => {
      editor()!.dispatchEvent(new KeyboardEvent("keydown", { key: value[0], bubbles: true, cancelable: true }));
      // jsdom does not insert characters for keyboard defaults. Use the native value setter
      // and input event so React receives the same change as a browser text edit.
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(editor(), value);
      editor()!.dispatchEvent(new Event("input", { bubbles: true }));
    });
  }

  async function escape() {
    await act(async () => editor()!.dispatchEvent(new KeyboardEvent("keydown", {
      key: "Escape", bubbles: true, cancelable: true
    })));
    await act(async () => vi.advanceTimersByTimeAsync(100));
    expect(editor()).toBeNull();
  }

  async function historyKey(redo = false) {
    const canvas = container.querySelector<HTMLElement>(".canvas-region")!;
    await act(async () => canvas.focus());
    await act(async () => canvas.dispatchEvent(new KeyboardEvent("keydown", {
      key: redo && platform === "windows" ? "y" : "z",
      metaKey: platform === "macos", ctrlKey: platform === "windows",
      shiftKey: redo && platform === "macos", bubbles: true, cancelable: true
    })));
  }

  it.each(["n", "N", "Cl", "Paragraph\nwith a newline"])("finishes a new '%s' box on Esc as text in one undo entry", async value => {
    await mount();
    expect(historyState()).toEqual(["false", "false"]);
    await click(container.querySelector(".page")!);
    await typeText(value);
    await escape();
    expect(visuals("molecule")).toHaveLength(0);
    expect(visuals("text")).toHaveLength(1);
    expect(visuals("text")[0].textContent).toBe(value.replaceAll("\n", ""));
    expect(historyState()).toEqual(["true", "false"]);
    await historyKey();
    expect(visuals("text")).toHaveLength(0);
    expect(visuals("molecule")).toHaveLength(0);
    expect(historyState()).toEqual(["false", "true"]);
    await historyKey(true);
    expect(visuals("text")).toHaveLength(1);
    expect(visuals("text")[0].textContent).toBe(value.replaceAll("\n", ""));
    expect(visuals("molecule")).toHaveLength(0);
    expect(historyState()).toEqual(["true", "false"]);
    // A later click-away must not convert a box already finished by Escape.
    await act(async () => container.querySelector<HTMLButtonElement>('button[data-command-id="tool.select"]')!.click());
    await click(container.querySelector(".page")!, 500, 400);
    expect(visuals("text")).toHaveLength(1);
    expect(visuals("molecule")).toHaveLength(0);
  });

  it.each(["n", "N", "Cl"])("commits '%s' by clicking away with exact element capitalization", async value => {
    await mount();
    await click(container.querySelector(".page")!);
    await typeText(value);
    await click(container.querySelector(".page")!, 500, 400);
    expect(editor()).toBeNull();
    if (value === "n") {
      expect(visuals("molecule")).toHaveLength(0);
      expect(visuals("text")).toHaveLength(1);
      expect(visuals("text")[0].textContent).toBe("n");
    } else {
      expect(visuals("text")).toHaveLength(0);
      expect(visuals("molecule")).toHaveLength(1);
      expect(container.querySelector(".molecule-object")!.getAttribute("data-structure")).toBe(`[${value}]`);
      expect(container.querySelector(".molecule-object")!.getAttribute("data-atom-count")).toBe("1");
    }
    expect(historyState()[0]).toBe("true");
  });

  it.each(["n", "N", "Changed\ncaption"])("commits an existing caption edited to '%s' on Esc in one undo entry", async value => {
    await mount("Original\ncaption");
    const original = visuals("text")[0].innerHTML;
    await click(visuals("text")[0].querySelector("text")!, 230, 208);
    await typeText(value);
    await escape();
    expect(visuals("molecule")).toHaveLength(0);
    expect(visuals("text")).toHaveLength(1);
    expect(visuals("text")[0].textContent).toBe(value.replaceAll("\n", ""));
    expect(historyState()).toEqual(["true", "false"]);
    await historyKey();
    expect(visuals("text")[0].innerHTML).toBe(original);
    expect(historyState()).toEqual(["false", "true"]);
    await historyKey(true);
    expect(visuals("text")[0].textContent).toBe(value.replaceAll("\n", ""));
    expect(visuals("molecule")).toHaveLength(0);
    await historyKey();
    await act(async () => container.querySelector<HTMLButtonElement>('button[data-command-id="tool.select"]')!.click());
    await click(container.querySelector(".page")!, 500, 400);
    // A late finish cannot resurrect the completed session's undo snapshot.
    expect(historyState()).toEqual(["false", "true"]);
  });
});
