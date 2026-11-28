// A script toggled at a collapsed caret applies to the characters typed there. The insertion's
// offset is known, so the existing runs on both sides must survive even when the typed letter
// repeats its neighbours and a text diff alone would place it somewhere else.
import { describe, expect, it } from "vitest";
import type { TextObject } from "@chemdraft/chem-core";
import { createPhase4Document, insertNativeTextObject, updateNativeTextObjectText } from "./documentWorkflow";

function withRuns(spans: TextObject["spans"]) {
  const document = structuredClone(insertNativeTextObject(createPhase4Document("Typed script"), { x: 100, y: 100 }, "x"));
  const object = document.pages[0]!.objects.find(candidate => candidate.type === "text") as TextObject;
  Object.assign(object, { text: spans.map(span => span.text).join(""), spans });
  const find = (current: typeof document) =>
    current.pages[0]!.objects.find(candidate => candidate.id === object.id) as TextObject;
  return { document, id: object.id, find };
}

describe("typing after a caret-toggled script", () => {
  it("keeps a subscript H when a superscript H is typed before it (HH, first H subscript)", () => {
    const { document, id, find } = withRuns([
      { text: "H", script: "subscript", style: {} },
      { text: "H", script: "normal", style: {} }
    ]);
    const edited = find(updateNativeTextObjectText(document, id, "HHH", undefined,
      { range: { start: 0, end: 1 }, script: "superscript" }));
    expect(edited.text).toBe("HHH");
    expect(edited.spans).toEqual([
      { text: "H", script: "superscript", style: {} },
      { text: "H", script: "subscript", style: {} },
      { text: "H", script: "normal", style: {} }
    ]);
  });

  it("keeps the runs after a caret placed before a run boundary in the middle of the text", () => {
    const { document, id, find } = withRuns([
      { text: "H", script: "normal", style: {} },
      { text: "H", script: "subscript", style: { fontWeight: 700 } },
      { text: "H", script: "normal", style: {} }
    ]);
    const edited = find(updateNativeTextObjectText(document, id, "HHHH", undefined,
      { range: { start: 1, end: 2 }, script: "superscript" }));
    expect(edited.text).toBe("HHHH");
    expect(edited.spans).toEqual([
      { text: "H", script: "normal", style: {} },
      { text: "H", script: "superscript", style: { fontWeight: 700 } },
      { text: "H", script: "subscript", style: { fontWeight: 700 } },
      { text: "H", script: "normal", style: {} }
    ]);
  });

  it("splices several typed characters at the toggled caret", () => {
    const { document, id, find } = withRuns([
      { text: "O", script: "normal", style: {} },
      { text: "2", script: "subscript", style: {} }
    ]);
    const edited = find(updateNativeTextObjectText(document, id, "O22", undefined,
      { range: { start: 1, end: 2 }, script: "superscript" }));
    expect(edited.spans).toEqual([
      { text: "O", script: "normal", style: {} },
      { text: "2", script: "superscript", style: {} },
      { text: "2", script: "subscript", style: {} }
    ]);
  });

  it("falls back to reconciling the runs when the edit is not an insertion at the toggled caret", () => {
    const { document, id, find } = withRuns([
      { text: "H", script: "subscript", style: {} },
      { text: "O", script: "normal", style: {} }
    ]);
    // The range says one character went in at 0, but the text lost one instead.
    const edited = find(updateNativeTextObjectText(document, id, "H", undefined,
      { range: { start: 0, end: 1 }, script: "superscript" }));
    expect(edited.text).toBe("H");
    expect(edited.spans).toEqual([{ text: "H", script: "superscript", style: {} }]);
  });
});
