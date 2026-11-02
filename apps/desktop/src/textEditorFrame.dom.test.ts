// @vitest-environment jsdom
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { TextObject } from "@chemdraft/chem-core";
import { MainWindow } from "./MainWindow";
import { createPhase4Document, insertNativeTextObject } from "./documentWorkflow";
import { MemoryStorage } from "./testSupport/memoryStorage";
import { DOM_COMMAND_EVENT } from "./window-manager";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

it("drives the editor border and preview inset from the geometry constant", () => {
  const css = readFileSync(resolve("apps/desktop/src/App.css"), "utf8");
  expect(css.match(/^\.text-object-editor\s*\{([^}]+)\}/m)?.[1])
    .toContain("border: var(--text-object-editor-border, 1px) solid");
  expect(css.match(/^\.text-object-editor\s*\{([^}]+)\}/m)?.[1])
    .toContain("min-height: 0");
  expect(css.match(/^\.text-object-edit-preview\s*\{([^}]+)\}/m)?.[1])
    .toContain("inset: var(--text-object-editor-border, 1px)");
});

describe.each(["macos", "windows"] as const)("text editor frame (%s)", platform => {
  let container: HTMLDivElement;
  let root: Root;
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    vi.stubGlobal("localStorage", new MemoryStorage());
    vi.stubGlobal("ResizeObserver", class { observe() {} unobserve() {} disconnect() {} });
    vi.spyOn(document, "hasFocus").mockReturnValue(true);
    window.history.replaceState(null, "", "/?agentBridge=1");
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
  });
  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    vi.useRealTimers();
    window.history.replaceState(null, "", "/");
    delete window.__CHEMDRAFT_AGENT__;
  });

  const cases = ([1, 2] as const).flatMap(scale =>
    (["left", "center", "right"] as const).flatMap(textAlign =>
      (["auto", "fixed-width", "fixed-size"] as const).flatMap(mode =>
        [0, 30].map(rotation => ({ scale, textAlign, mode, rotation, growing: false }))
      ).concat([{ scale, textAlign, mode: "auto", rotation: 30, growing: true }])
    ));

  it.each(cases)("aligns $textAlign $mode rotation=$rotation scale=$scale growth=$growing", async ({ scale, textAlign, mode, rotation, growing }) => {
    const drawing = structuredClone(insertNativeTextObject(createPhase4Document("Editor frame"),
      { x: 200, y: 160 }, "CCCCCCCCC", { fontSizePx: 18, textAlign, textBoxSizingMode: mode }));
    const object = drawing.pages[0].objects[0] as TextObject;
    object.width = growing ? 106.44 : 180;
    object.height = mode === "fixed-size" ? 20 : 40;
    object.rotation = rotation;
    const original = structuredClone(object);
    await act(async () => root.render(createElement(MainWindow, {
      initialDocument: drawing, initialPaletteMode: "hidden", nativePalette: true,
      initialRulersVisible: false, initialCrosshairsVisible: false, shortcutPlatform: platform
    })));
    if (scale === 2) {
      // The wheel zoom uses exp(-deltaY * .002); this input doubles the page scale.
      await act(async () => {
        container.querySelector(".canvas-region")!.dispatchEvent(new WheelEvent("wheel", {
          bubbles: true, cancelable: true, ctrlKey: true, deltaY: -Math.log(2) / 0.002
        }));
      });
    }
    expect(Number(container.querySelector<HTMLElement>(".page-stage")!.style.getPropertyValue("--page-scale")))
      .toBeCloseTo(scale, 10);
    const glyph = container.querySelector(`[data-page-svg-object-visual="${object.id}"] text`)!;
    await act(async () => glyph.dispatchEvent(new MouseEvent("dblclick", { bubbles: true, cancelable: true, detail: 2 })));
    await act(async () => vi.advanceTimersByTimeAsync(100));
    const editor = container.querySelector<HTMLTextAreaElement>(".text-object-editor")!;
    expect(editor).not.toBeNull();
    const frame = editor.closest<HTMLElement>(".document-object-chrome")!;
    const border = 1; // CSS pixels, independent of zoom and the production geometry.
    const left = parseFloat(frame.style.left), top = parseFloat(frame.style.top);
    const width = parseFloat(frame.style.width), height = parseFloat(frame.style.height);
    const [ox, oy] = frame.style.transformOrigin.split(" ").map(parseFloat);
    const anchor = textAlign === "left" ? 0 : textAlign === "center" ? 0.5 : 1;
    // Nine Cs: 9 * .723 * 18 = 117.126 page units, independent font metrics.
    const growth = growing ? (117.126 + 0.5) * scale + 4 - object.width * scale : 0;
    expect(width - 2 * border).toBeCloseTo(object.width * scale + growth, 8);
    expect(frame.style.getPropertyValue("--text-object-editor-border")).toBe(`${border}px`);
    expect(height - 2 * border).toBeCloseTo(object.height * scale, 8);
    expect(left + border).toBeCloseTo(object.x * scale - anchor * growth, 8);
    expect(left + border + anchor * (width - 2 * border))
      .toBeCloseTo((object.x + anchor * object.width) * scale, 8);
    if (textAlign === "right") expect(left + width - border).toBeCloseTo((object.x + object.width) * scale, 8);
    expect(top + border).toBeCloseTo(object.y * scale, 8);
    expect(left + ox).toBeCloseTo((object.x + object.width / 2) * scale, 8);
    expect(top + oy).toBeCloseTo((object.y + object.height / 2) * scale, 8);
    expect(frame.style.transform).toBe(rotation ? `rotate(${rotation}deg)` : "");
    const saved = () => window.__CHEMDRAFT_AGENT__!.snapshot().document.pages[0].objects.find(item => item.id === object.id);
    expect(saved()).toEqual(original);
    await act(async () => editor.blur());
    expect(container.querySelector(".text-object-editor")).toBeNull();
    expect(saved()).toEqual(original);
    for (const commandId of ["edit.undo", "edit.redo"]) {
      await act(async () => window.dispatchEvent(new CustomEvent(DOM_COMMAND_EVENT, { detail: { commandId } })));
      expect(saved()).toEqual(original);
    }
  });
});
