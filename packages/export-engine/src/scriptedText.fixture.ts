import { applyPatch, createEmptyDocument, type TextObject } from "@chemdraft/chem-core";
import { formulaSpansFromText } from "@chemdraft/document-workflow-core";

/** Shared SVG/PDF/canvas regression input; plain digits are authored script spans, not Unicode. */
export function scriptedTextDocument() {
  let document = createEmptyDocument({ now: "2026-10-29T00:00:00.000Z" });
  const texts: Pick<TextObject, "id" | "text" | "spans">[] = [
    { id: "water", text: "H2O", spans: formulaSpansFromText("H2O") },
    { id: "sulfate", text: "SO42-", spans: formulaSpansFromText("SO42-") },
    { id: "ammonium", text: "NH4+", spans: formulaSpansFromText("NH4+") },
    { id: "isotope", text: "13C", spans: [
      { text: "13", script: "superscript", style: {} },
      { text: "C", script: "normal", style: {} }
    ] },
    { id: "override", text: "H2O", spans: formulaSpansFromText("H2O").map(span =>
      span.script === "subscript" ? { ...span, style: { fontSizePx: 30 } } : span) },
    { id: "multiline", text: "H2O\n\nSO42-\nend", spans: [
      ...formulaSpansFromText("H2O"),
      { text: "\n\n", script: "normal", style: {} },
      ...formulaSpansFromText("SO42-"),
      { text: "\nend", script: "normal", style: {} }
    ] }
  ];
  texts.forEach((text, index) => {
    document = applyPatch(document, { op: "addObject", pageId: "page_001", object: {
      ...text, type: "text", x: 100, y: 100 + index * 80, width: 400, height: 120,
      rotation: 0, style: { fontFamily: "Arial, Helvetica, sans-serif", fontSizePx: 20,
        lineHeight: 1.2, paragraphSpacingPx: 4 }
    } }, { now: "2026-10-29T00:00:00.000Z" });
  });
  return document;
}
