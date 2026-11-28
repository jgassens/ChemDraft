// Text box text holds LF line breaks only (docs/plans/textbox-behavior.md): the editor's textarea
// reports CRLF and a lone CR as LF, so every path that writes a text box stores LF.
import { describe, expect, it } from "vitest";
import type { TextObject } from "@chemdraft/chem-core";
import { objectFrameBoundsForPageFit, planNativeTextEditorLayout } from "@chemdraft/layout-engine";
import {
  createPhase4Document, insertNativeTextObject, resizeNativeTextObjectBox, updateNativeTextObjectScript,
  updateNativeTextObjectScriptRange, updateNativeTextObjectStyle, updateNativeTextObjectStyleRange, updateNativeTextObjectText
} from "./documentWorkflow";

/** A document holding one text box stored as given (an older file with CRLF). */
function withStoredText(text: string, spans: TextObject["spans"]) {
  const document = structuredClone(insertNativeTextObject(createPhase4Document("Line breaks"), { x: 100, y: 100 }, "x"));
  const object = document.pages[0]!.objects.find(candidate => candidate.type === "text") as TextObject;
  Object.assign(object, { text, spans });
  const find = (current: typeof document) =>
    current.pages[0]!.objects.find(candidate => candidate.id === object.id) as TextObject;
  return { document, id: object.id, find };
}

describe("text box line breaks", () => {
  it("creates a text box from CRLF or CR text (a Windows clipboard, the CLI) with LF breaks", () => {
    const document = insertNativeTextObject(createPhase4Document("Line breaks"), { x: 100, y: 100 }, "one\r\ntwo\rthree");
    const object = document.pages[0]!.objects.find(candidate => candidate.type === "text") as TextObject;
    expect(object.text).toBe("one\ntwo\nthree");
    expect(object.spans.map(span => span.text).join("")).toBe(object.text);
  });

  it("commits an edit of an older CRLF box with LF breaks, keeping each run's formatting", () => {
    const { document, id, find } = withStoredText("Bold\r\nplain", [
      { text: "Bold\r\n", script: "normal", style: { fontWeight: 700 } },
      { text: "plain", script: "normal", style: {} }
    ]);
    // The textarea reports "Bold\nplain"; the user typed "!" at the end.
    const edited = find(updateNativeTextObjectText(document, id, "Bold\nplain!"));
    expect(edited.text).toBe("Bold\nplain!");
    expect(edited.spans).toEqual([
      { text: "Bold\n", script: "normal", style: { fontWeight: 700 } },
      { text: "plain!", script: "normal", style: {} }
    ]);
    // A CRLF handed to the commit itself (a paste that was not normalized) is stored as LF.
    expect(find(updateNativeTextObjectText(document, id, "Bold\r\nplain\r\nmore")).text).toBe("Bold\nplain\nmore");
  });

  it("formats the editor's range (LF offsets) of an older CRLF box, storing LF", () => {
    const { document, id, find } = withStoredText("ab\r\ncd", [{ text: "ab\r\ncd", script: "normal", style: {} }]);
    // "c" is offset 3 in the textarea's "ab\ncd" (offset 4 in the stored text).
    const bold = find(updateNativeTextObjectStyleRange(document, id, { start: 3, end: 4 }, { fontWeight: 700 }));
    expect(bold.text).toBe("ab\ncd");
    expect(bold.spans).toEqual([
      { text: "ab\n", script: "normal", style: {} },
      { text: "c", script: "normal", style: { fontWeight: 700 } },
      { text: "d", script: "normal", style: {} }
    ]);
    const subscript = find(updateNativeTextObjectScriptRange(document, id, { start: 4, end: 5 }, "subscript"));
    expect(subscript.text).toBe("ab\ncd");
    expect(subscript.spans.map(span => [span.text, span.script])).toEqual([["ab\nc", "normal"], ["d", "subscript"]]);
  });

  it("stores LF when an older CRLF box is formatted as a whole, keeping each run on its characters", () => {
    const { document, id, find } = withStoredText("Bold\r\nplain\rend", [
      { text: "Bold\r\n", script: "normal", style: { fontWeight: 700 } },
      { text: "plain\rend", script: "normal", style: { fontStyle: "italic" } }
    ]);
    const styled = find(updateNativeTextObjectStyle(document, id, { fontSizePx: 18 }));
    expect(styled.text).toBe("Bold\nplain\nend");
    expect(styled.spans).toEqual([
      { text: "Bold\n", script: "normal", style: { fontWeight: 700 } },
      { text: "plain\nend", script: "normal", style: { fontStyle: "italic" } }
    ]);
    // A run that states the changed property still has it cleared, at the LF offsets.
    const cleared = find(updateNativeTextObjectStyle(document, id, { fontWeight: 400 }));
    expect(cleared.text).toBe("Bold\nplain\nend");
    expect(cleared.spans).toEqual([
      { text: "Bold\n", script: "normal", style: {} },
      { text: "plain\nend", script: "normal", style: { fontStyle: "italic" } }
    ]);
    const script = find(updateNativeTextObjectScript(document, id, "superscript"));
    expect(script.text).toBe("Bold\nplain\nend");
    expect(script.spans).toEqual([
      { text: "Bold\n", script: "superscript", style: { fontWeight: 700 } },
      { text: "plain\nend", script: "superscript", style: { fontStyle: "italic" } }
    ]);
    // An older box with no runs at all gets one run over its LF text.
    const plain = withStoredText("a\r\nb", []);
    const plainScript = plain.find(updateNativeTextObjectScript(plain.document, plain.id, "subscript"));
    expect(plainScript.text).toBe("a\nb");
    expect(plainScript.spans).toEqual([{ text: "a\nb", script: "subscript", style: {} }]);
  });
});

/** A one-line box sitting on the bottom edge of the page (insertion clamps it there). */
function atPageBottom(mode: "auto" | "fixed-width", style: Record<string, unknown> = {}) {
  const empty = createPhase4Document("Page bottom");
  const document = structuredClone(insertNativeTextObject(empty, { x: 100, y: empty.pages[0]!.height }, "x", style));
  const object = document.pages[0]!.objects.find(candidate => candidate.type === "text") as TextObject;
  object.style = { ...object.style, textBoxSizingMode: mode };
  if (mode === "fixed-width") object.width = 160;
  const find = (current: typeof document) =>
    current.pages[0]!.objects.find(candidate => candidate.id === object.id) as TextObject;
  return { document, id: object.id, find, pageHeight: empty.pages[0]!.height, original: structuredClone(object) };
}

const lowestDrawnLine = (object: TextObject) => {
  const lines = planNativeTextEditorLayout(object).lines;
  return lines[lines.length - 1]!.bottom;
};

// docs/plans/textbox-behavior.md H2: the stored height is never below the lowest drawn line,
// even when that puts the box past the bottom of the page. The box is not moved.
describe.each(["auto", "fixed-width"] as const)("text box height at the page bottom (%s)", mode => {
  it("keeps the lowest drawn line inside the box: \"a\\nb\" at 20 px and line height 0.5, 24 above the bottom", () => {
    const { document, id, find, pageHeight } = atPageBottom(mode, { fontSizePx: 20 });
    const placed = find(document);
    placed.y = pageHeight - 24;
    placed.style = { ...placed.style, lineHeight: 0.5 };
    const edited = find(updateNativeTextObjectText(document, id, "a\nb"));
    expect(lowestDrawnLine(edited)).toBeGreaterThanOrEqual(34);
    expect(edited.height).toBeGreaterThanOrEqual(lowestDrawnLine(edited));
    expect(edited.y).toBe(pageHeight - 24);
    expect(edited.style.fontSizePx).toBe(20);
  });

  it("grows past the bottom when a typed line pushes it there, and keeps that height while the line count holds", () => {
    const { document, id, find, original } = atPageBottom(mode, { fontSizePx: 16 });
    let current = document;
    let previous: { lines: number; height: number } | undefined;
    for (const text of ["x\n", "x\nm", "x\nmo", "x\nmore", "x\nmore\n", "x\nmore\nend"]) {
      current = updateNativeTextObjectText(current, id, text);
      const edited = find(current);
      const lines = planNativeTextEditorLayout(edited).lines.length;
      expect(edited.height, JSON.stringify(text)).toBeGreaterThanOrEqual(lowestDrawnLine(edited));
      expect(edited.y).toBe(original.y);
      if (previous?.lines === lines) expect(edited.height).toBe(previous.height);
      previous = { lines, height: edited.height };
    }
    expect(find(current).y + find(current).height).toBeGreaterThan(original.y + original.height);
  });

  it("keeps the lowest drawn line inside the box when the whole box is formatted larger", () => {
    const { document, id, find } = atPageBottom(mode, { fontSizePx: 12 });
    const twoLines = updateNativeTextObjectText(document, id, "a\nb");
    const larger = find(updateNativeTextObjectStyle(twoLines, id, { fontSizePx: 30 }));
    expect(larger.height).toBeGreaterThanOrEqual(lowestDrawnLine(larger));
  });
});

it("keeps the lowest drawn line inside a fixed-width box narrowed at the page bottom", () => {
  const { document, id, find } = atPageBottom("fixed-width", { fontSizePx: 16 });
  const long = updateNativeTextObjectText(document, id, "several words that wrap onto more lines");
  const narrowed = find(resizeNativeTextObjectBox(long, id, { width: 60 }));
  expect(planNativeTextEditorLayout(narrowed).lines.length).toBeGreaterThan(1);
  expect(narrowed.height).toBeGreaterThanOrEqual(lowestDrawnLine(narrowed));
});

it.each(["center", "right"] as const)(
  "keeps the lowest drawn line inside a 1° %s-aligned auto-width box growing at the left page edge", textAlign => {
    const document = structuredClone(insertNativeTextObject(createPhase4Document("Rotated"), { x: 10, y: 200 }, "CC",
      { fontSizePx: 40, textAlign }));
    const object = document.pages[0]!.objects[0] as TextObject;
    Object.assign(object, { width: 60, rotation: 1 });
    // The width stops at the left edge with the box's real height; the height is never squashed.
    const grown = updateNativeTextObjectText(document, object.id, "C".repeat(22)).pages[0]!.objects[0] as TextObject;
    expect(grown.width).toBeGreaterThan(60);
    expect(grown.height).toBeGreaterThanOrEqual(lowestDrawnLine(grown));
    expect(objectFrameBoundsForPageFit(grown).x).toBeGreaterThanOrEqual(-1e-8);
  });
