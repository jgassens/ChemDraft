import { describe, expect, it } from "vitest";
import { nativeTextObjectBoxHeight } from "@chemdraft/layout-engine";
import { createEmptyDocument, nativeTextStyleFromObjectStyle, textStyleToObjectStyle, type MoleculeObject } from "@chemdraft/chem-core";
import { layoutGrid } from "../src/gridLayout";
import { insertNativeTextObject, nativeTextObjectSizeForText } from "../src/textObjects";

// Headless text (CLI, MCP, assistant, grid, reaction scheme) must get the height the editor
// gives the box on its first edit: one line per paragraph for auto width
// (docs/plans/textbox-behavior.md H1, H3). The editor rounds max(24, box height) to hundredths.
const editorHeight = (text: string, style: Record<string, unknown>) =>
  Math.round(Math.max(24, nativeTextObjectBoxHeight({ text, spans: [], style })) * 100) / 100;
const styleAt = (fontSizePx: number) => textStyleToObjectStyle({ ...nativeTextStyleFromObjectStyle({}), fontSizePx });

describe("headless auto-width text box height", () => {
  // Each of these used to divide its own natural width by itself in floating point, get
  // 1.0000000001 and round up to two lines.
  it.each([
    [15, "Benzene"],
    [13, "Yield Yield"],
    [12, "A A A"],
    [14, "Product 3a Product 3a Product 3a"],
    [16, "Reflux, 2 h Reflux, 2 h Reflux, 2 h"]
  ])("sizes %spx %j as one line", (fontSizePx, text) => {
    const style = styleAt(fontSizePx);
    const oneLine = editorHeight("x", style);
    expect(nativeTextObjectSizeForText(text, style).height).toBe(oneLine);
    expect(nativeTextObjectSizeForText(text, style).height).toBe(editorHeight(text, style));
  });

  it("keeps one line per paragraph when the width is capped", () => {
    const style = styleAt(16);
    const text = "A caption that is much wider than its cap";
    const size = nativeTextObjectSizeForText(text, style, { maxWidth: 60 });
    expect(size.width).toBe(60);
    expect(size.height).toBe(editorHeight("x", style));
    expect(nativeTextObjectSizeForText(`${text}\nsecond`, style, { maxWidth: 60 }).height)
      .toBe(editorHeight("x\ny", style));
  });

  it("is never below the lowest drawn line (H2): a small line height or a large subscript", () => {
    // "a\nb" at 20 px and line height 0.5: the second baseline is at 30 and its descent reaches 34.
    const tight = { ...styleAt(20), lineHeight: 0.5 };
    expect(nativeTextObjectSizeForText("a\nb", tight).height).toBeGreaterThanOrEqual(34);
    expect(nativeTextObjectSizeForText("a\nb", tight).height).toBe(editorHeight("a\nb", tight));
    // A 40 px subscript in 12 px text hangs 0.2 * 28.8 + 0.22 * 40 = 14.56 below the 12 px baseline.
    const spans = [{ text: "H", script: "normal" as const, style: {} }, { text: "2", script: "subscript" as const, style: { fontSizePx: 40 } }];
    expect(nativeTextObjectSizeForText("H2", styleAt(12), { spans }).height).toBeGreaterThanOrEqual(12 + 14.56);
  });

  it("never caps the content height at maxHeight (H2): the box may reach past the page bottom", () => {
    const tight = { ...styleAt(20), lineHeight: 0.5 };
    // 24 units of room left above the bottom of the page, as at y = page.height - 24.
    expect(nativeTextObjectSizeForText("a\nb", tight, { maxHeight: 24 }).height).toBeGreaterThanOrEqual(34);
    const fixedWidth = nativeTextObjectSizeForText("a\nb", tight, { width: 160, maxHeight: 24 });
    expect(fixedWidth.height).toBe(Math.round(Math.max(24, nativeTextObjectBoxHeight({
      text: "a\nb", spans: [], width: 160, style: { ...tight, textBoxSizingMode: "fixed-width" }
    })) * 100) / 100);
    expect(fixedWidth.height).toBeGreaterThan(34);
    // A height the user chose (a fixed-size box) is still kept within the room.
    expect(nativeTextObjectSizeForText("a\nb", tight, { width: 160, height: 80, maxHeight: 50 }).height).toBe(50);
  });

  it("gives a text box inserted near the page edge the editor's height", () => {
    const empty = createEmptyDocument();
    // The page edge caps the width at 80; the SVG still draws one line.
    const document = insertNativeTextObject(empty, { x: empty.pages[0]!.width - 80, y: 40 },
      "Ethyl acetate Ethyl acetate Ethyl acetate", { fontSizePx: 14 });
    const object = document.pages[0]!.objects.find(candidate => candidate.type === "text")!;
    expect(object.type === "text" && object.style.textBoxSizingMode).toBe("auto");
    expect(object.height).toBe(editorHeight("x", object.style));
  });
});

describe("CLI grid document job", () => {
  it("gives a grid label text box the one-line height", () => {
    const molecule: MoleculeObject = {
      id: "source", type: "molecule", x: 0, y: 0, width: 40, height: 20, rotation: 0, style: {},
      structureFormat: "smiles", structure: "c1ccccc1", atoms: [{ id: "a", element: "C", x: 0, y: 0, formalCharge: 0 }],
      bonds: [], superatoms: [], rGroups: []
    };
    const layout = layoutGrid({
      entries: [{ molecule, bounds: { minX: 0, minY: 0, maxX: 40, maxY: 20 }, label: "Benzene" }],
      textStyle: { fontSizePx: 15 }, columns: 1, gutter: 32, anchor: { x: 24, y: 24 }, pageWidth: 800
    });
    const label = layout.labels[0]!;
    expect(label.style.textBoxSizingMode).toBe("auto");
    expect(label.height).toBe(editorHeight("x", label.style));
  });
});
