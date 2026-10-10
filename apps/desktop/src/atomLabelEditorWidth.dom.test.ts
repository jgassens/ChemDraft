// @vitest-environment jsdom

// Tester report: hovering an atom and typing "OMe" showed "▯me" (also "OMe", "Cl"). The inline
// label editor was sized in `ch`, the advance of "0", but "O", "M" and "m" are much wider in the
// label fonts, so the input overflowed and scrolled its first glyph out of view. It is now sized from
// the draft measured in the editor's own font.

import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DefaultNativeDrawingStyle, type MoleculeObject } from "@chemdraft/chem-core";
import { MainWindow } from "./MainWindow";
import { atomLabelEditorWidth } from "./atomLabelEditorWidth";
import { createPhase4Document, insertNativeTemplateMolecule, selectDocumentObjects } from "./documentWorkflow";
import { saveKeybindingSettings } from "./keybindingSettings";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

/** Advance widths in em of Arial/Helvetica, the default label font. "0" is what `1ch` measures. */
const ADVANCE_EM: Record<string, number> = {
  "0": 0.556,
  "2": 0.556,
  C: 0.722,
  E: 0.667,
  H: 0.722,
  M: 0.833,
  O: 0.778,
  e: 0.556,
  i: 0.222,
  l: 0.222,
  t: 0.278
};

function textWidthPx(text: string, fontPx: number): number {
  return [...text].reduce((sum, glyph) => sum + (ADVANCE_EM[glyph] ?? 0.6) * fontPx, 0);
}

/**
 * jsdom has no canvas, so the editor's measuring context is this stand-in with real Arial metrics.
 * One instance for the file: the module keeps the first context it gets. Like a real canvas, it
 * ignores a `font` it cannot parse; here, one naming a family that starts with a digit (an
 * unquoted name that is not a CSS identifier).
 */
const measuringContext = {
  currentFont: "10px sans-serif",
  get font(): string {
    return this.currentFont;
  },
  set font(value: string) {
    const families = value.replace(/^.*?[\d.]+px\s+/, "").split(",");
    if (!families.some((family) => /^\s*\d/.test(family))) {
      this.currentFont = value;
    }
  },
  measuredFonts: [] as string[],
  measureText(text: string) {
    this.measuredFonts.push(this.font);
    const fontPx = Number(/([\d.]+)px/.exec(this.font)?.[1]);
    return { width: textWidthPx(text, fontPx) } as TextMetrics;
  }
};

/**
 * Resolve a CSS length the way the webview would, at one page scale. Covers what the editor's
 * width and font size use: px, ch, em, var(--page-scale), calc(), min() and max().
 */
function resolvePx(length: string, pageScale: number, fontPx = 0): number {
  if (!length.trim()) {
    throw new Error("Expected a CSS length; the editor has none set.");
  }
  const expression = length
    .replaceAll("var(--page-scale)", String(pageScale))
    .replace(/(-?[\d.]+)ch\b/g, (_, n: string) => String(Number(n) * ADVANCE_EM["0"]! * fontPx))
    .replace(/(-?[\d.]+)em\b/g, (_, n: string) => String(Number(n) * fontPx))
    .replace(/(-?[\d.]+)px\b/g, "$1")
    .replace(/\b(max|min)\(/g, "Math.$1(")
    .replace(/\bcalc\(/g, "(");
  if (!/^[\d.\s+\-*/(),]*$/.test(expression.replace(/Math\.(max|min)/g, ""))) {
    throw new Error(`Unsupported CSS length in the test resolver: ${length}`);
  }
  return Function(`"use strict"; return (${expression});`)() as number;
}

const pageRect = {
  x: 0,
  y: 0,
  left: 0,
  top: 0,
  right: 792,
  bottom: 612,
  width: 792,
  height: 612,
  toJSON: () => ({})
} as DOMRect;

class TestResizeObserver {
  observe() {}
  unobserve() {}
  disconnect() {}
}

describe("atom label editor width", () => {
  let container: HTMLDivElement;
  let root: Root;
  let originalResizeObserver: typeof ResizeObserver | undefined;

  beforeEach(() => {
    saveKeybindingSettings({ scheme: "chemdraft" });
    originalResizeObserver = globalThis.ResizeObserver;
    globalThis.ResizeObserver = TestResizeObserver as unknown as typeof ResizeObserver;
    HTMLElement.prototype.setPointerCapture = () => {};
    HTMLElement.prototype.releasePointerCapture = () => {};
    HTMLElement.prototype.hasPointerCapture = () => false;
    vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockImplementation(
      () => measuringContext as unknown as CanvasRenderingContext2D
    );
    measuringContext.measuredFonts.length = 0;
    window.history.replaceState(null, "", "/?agentBridge=1");

    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => {
      root.unmount();
    });
    container.remove();
    vi.restoreAllMocks();
    saveKeybindingSettings({ scheme: "chemdraft" });
    window.history.replaceState(null, "", "/");
    delete window.__CHEMDRAFT_AGENT__;
    if (originalResizeObserver) {
      globalThis.ResizeObserver = originalResizeObserver;
    } else {
      Reflect.deleteProperty(globalThis, "ResizeObserver");
    }
  });

  /** Cyclohexane; `editedAtomStyle` adds per-atom label style maps for the atom the edit opens on. */
  async function renderRing(editedAtomStyle: Record<string, unknown> = {}) {
    const withRing = insertNativeTemplateMolecule(createPhase4Document("Label width"), { x: 300, y: 300 }, "cyclohexane");
    const ring = withRing.pages[0].objects[0] as MoleculeObject;
    const atomId = ring.atoms[0]!.id;
    const styled: MoleculeObject = {
      ...ring,
      style: {
        ...ring.style,
        ...Object.fromEntries(Object.entries(editedAtomStyle).map(([key, value]) => [key, { [atomId]: value }]))
      }
    };
    const styledDocument = { ...withRing, pages: [{ ...withRing.pages[0], objects: [styled] }] };
    await act(async () => {
      root.render(createElement(MainWindow, {
        initialActiveToolCommandId: "tool.atom",
        initialCrosshairsVisible: false,
        initialDocument: selectDocumentObjects(styledDocument, styledDocument.pages[0].id, []),
        initialPaletteMode: "hidden",
        initialRulersVisible: false,
        nativePalette: true
      }));
    });
    const page = container.querySelector<HTMLElement>(".page")!;
    page.getBoundingClientRect = () => pageRect;
    const canvasRegion = container.querySelector<HTMLElement>(".canvas-region");
    if (canvasRegion) {
      canvasRegion.getBoundingClientRect = () => pageRect;
    }
    await act(async () => {
      await Promise.resolve();
    });
  }

  function labelEditor(): HTMLInputElement {
    const editor = container.querySelector<HTMLInputElement>('[data-atom-label-editor="true"]');
    if (!editor) {
      throw new Error("Expected the atom label editor.");
    }
    return editor;
  }

  /** Press an atom with the Atom Label tool, which opens the label editor on it. */
  async function startLabelEdit() {
    const ring = window.__CHEMDRAFT_AGENT__!.snapshot().document.pages[0].objects[0] as MoleculeObject;
    const atom = ring.atoms[0]!;
    const wrapper = container.querySelector<HTMLElement>(`[data-object-id="${ring.id}"]`)!;
    await act(async () => {
      const event = new MouseEvent("pointerdown", {
        bubbles: true,
        button: 0,
        buttons: 1,
        cancelable: true,
        clientX: atom.x,
        clientY: atom.y,
        detail: 1
      });
      Object.defineProperties(event, {
        isPrimary: { value: true },
        pointerId: { value: 7 },
        pointerType: { value: "mouse" }
      });
      wrapper.dispatchEvent(event);
    });
    await act(async () => {
      await Promise.resolve();
    });
    labelEditor();
  }

  async function typeIntoEditor(value: string) {
    const editor = labelEditor();
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(editor, value);
      editor.dispatchEvent(new Event("input", { bubbles: true }));
    });
  }

  it("is wider for wide glyphs than for narrow ones of the same count", async () => {
    await renderRing();
    await startLabelEdit();

    await typeIntoEditor("OMe");
    const editor = labelEditor();
    const fontPx = resolvePx(editor.style.fontSize, 1);
    const wideWidth = resolvePx(editor.style.width, 1, fontPx);
    const { left, top } = editor.style;

    await typeIntoEditor("ill");
    const narrowWidth = resolvePx(labelEditor().style.width, 1, fontPx);

    expect(wideWidth).toBeGreaterThan(narrowWidth);
    // Still centred on the atom's label anchor: growing the editor never moves its anchor point.
    expect(labelEditor().style.left).toBe(left);
    expect(labelEditor().style.top).toBe(top);
  });

  it.each([
    ["OMe", 1],
    ["OMe", 2.5],
    ["Cl", 1],
    ["CO2Et", 0.5],
    ["CO2Et", 4],
    ["OCH2CH2OCH2CH2OCH2CH2OCH2CH2OMe", 1]
  ])("leaves room for all of %s and the caret at page scale %s", async (label, pageScale) => {
    await renderRing();
    await startLabelEdit();
    await typeIntoEditor(label);

    const editor = labelEditor();
    const fontPx = resolvePx(editor.style.fontSize, pageScale);
    const borderBoxPx = resolvePx(editor.style.width, pageScale, fontPx);
    // border-box with 1px padding each side; the caret needs at least 1px past the last glyph.
    // The old `${length + 0.6}ch` gave "OMe" 3.6 × 0.556em = 2.0em for 2.17em of text.
    expect(borderBoxPx - 2).toBeGreaterThanOrEqual(textWidthPx(label, fontPx) + 1);
  });

  it("measures in the editor's own font", async () => {
    await renderRing();
    await startLabelEdit();
    await typeIntoEditor("OMe");

    const editor = labelEditor();
    const font = measuringContext.measuredFonts.at(-1);
    expect(font).toBe(
      `${editor.style.fontStyle} ${editor.style.fontWeight} ${resolvePx(editor.style.fontSize, 1)}px ${editor.style.fontFamily}`
    );
  });

  it("measures a bold italic label in bold italic", async () => {
    await renderRing({ atomLabelFontWeights: 700, atomLabelFontStyles: "italic", atomLabelFontSizes: 20 });
    await startLabelEdit();
    await typeIntoEditor("OMe");

    const editor = labelEditor();
    expect(editor.style.fontWeight).toBe("700");
    expect(editor.style.fontStyle).toBe("italic");
    expect(measuringContext.measuredFonts.at(-1)).toBe(`italic 700 20px ${editor.style.fontFamily}`);
  });

  it("falls back to character count when the canvas rejects the label font", () => {
    // style-compat puts an imported family in front of the default stack unquoted; a name that is
    // not a CSS identifier makes the whole shorthand invalid. The canvas would keep its previous
    // font (10px sans-serif when new) and measure the label too narrow.
    const style = { ...DefaultNativeDrawingStyle, atomLabelFontFamily: "3M Sans, Arial, Helvetica, sans-serif" };
    expect(atomLabelEditorWidth("OMe", style)).toBe("3.6ch");
    // A font it accepts is measured again afterwards: the rejected one left no trace.
    expect(atomLabelEditorWidth("OMe", DefaultNativeDrawingStyle)).toMatch(/px \* var\(--page-scale\)/);
  });

  it("leaves an empty draft's inline width as it was", async () => {
    await renderRing();
    await startLabelEdit();
    await typeIntoEditor("");

    expect(labelEditor().getAttribute("data-atom-label-draft-empty")).toBe("true");
    // Unchanged from before this fix. What shows is App.css's min-width (0.75em), which is wider
    // than 1ch in the label fonts; jsdom does not load App.css, so only the inline value is checked.
    expect(labelEditor().style.width).toBe("1ch");
  });
});

describe("atomLabelEditorWidth without a measuring context", () => {
  it("falls back to sizing by character count rather than collapsing", () => {
    const width = atomLabelEditorWidth("OMe", DefaultNativeDrawingStyle, () => undefined);
    const fontPx = DefaultNativeDrawingStyle.atomLabelFontSizePx;
    expect(width).not.toMatch(/NaN|undefined/);
    expect(resolvePx(width, 1, fontPx)).toBeGreaterThan(resolvePx("1ch", 1, fontPx));
  });

  it("leaves an empty draft's inline width as it was, measured or not", () => {
    expect(atomLabelEditorWidth("", DefaultNativeDrawingStyle, () => undefined)).toBe("1ch");
    expect(atomLabelEditorWidth("", DefaultNativeDrawingStyle, () => 0)).toBe("1ch");
  });
});
