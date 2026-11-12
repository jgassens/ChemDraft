import { applyPatches, createEmptyDocument, type BracketObject, type MoleculeObject, type TextObject } from "@chemdraft/chem-core";
import { expect, it } from "vitest";
import { exportDocumentToCdxml, exportDocumentToCdx, importCdx } from "./index";
import { exportDocumentToCdxml as exportEngineCdxml } from "@chemdraft/export-engine";

function warningDocument(side: "left" | "right") {
  const base = createEmptyDocument({ title: "Export warning formats" });
  const text: TextObject = {
    id: "styled_text", type: "text", x: 100, y: 120, width: 120, height: 24, rotation: 0,
    style: { fontWeight: 700 }, text: "visible CDXML", spans: []
  };
  const molecule: MoleculeObject = {
    id: "molecule", type: "molecule", x: 100, y: 180, width: 60, height: 30, rotation: 0, style: {},
    structureFormat: "smiles", structure: "", superatoms: [], rGroups: [],
    atoms: [
      { id: "label", element: "SCN", x: side === "left" ? 100 : 160, y: 180, formalCharge: 0, labelLiteral: true, labelBondSide: { side, atomId: "carbon" } },
      { id: "carbon", element: "C", x: 130, y: 180, formalCharge: 0 }
    ],
    bonds: [{ id: "bond", fromAtomId: "label", toAtomId: "carbon", order: "single" }]
  };
  const open: BracketObject = {
    id: "open", type: "bracket", bracketKind: "square", side: "open", pairId: "pair",
    x: 90, y: 160, width: 16, height: 64, rotation: 0, style: {}, containedObjectIds: [molecule.id, text.id]
  };
  const close: BracketObject = { ...open, id: "close", side: "close", x: 180 };
  return applyPatches(base, [text, molecule, open, close].map(object => ({ op: "addObject" as const, pageId: base.pages[0]!.id, object })));
}

it.each(["left", "right"] as const)("names the exported format in every visible-layer warning (label recorded on %s)", side => {
  const document = warningDocument(side);
  for (const embedNativePayload of [false, true]) {
    const xml = exportDocumentToCdxml(document, { embedNativePayload });
    const cdx = exportDocumentToCdx(document, { embedNativePayload });
    for (const code of ["cdxml.text_format_native_only", "cdxml.label_bond_side_turned", "cdxml.bracket_membership_payload_only"]) {
      const xmlWarning = xml.warnings.find(warning => warning.code === code);
      const cdxWarning = cdx.warnings.find(warning => warning.code === code);
      expect(xmlWarning, code).toBeDefined();
      expect(cdxWarning, code).toBeDefined();
      expect(xmlWarning!.message).toContain("visible CDXML");
      expect(cdxWarning!.message).toContain("visible CDX ");
      expect(cdxWarning!.message).not.toContain("visible CDXML");
      expect(cdxWarning).toEqual({ ...xmlWarning, message: xmlWarning!.message.replace("visible CDXML", "visible CDX") });
    }
    expect(cdx.warnings.find(warning => warning.code === "cdxml.text_format_native_only")!.message.includes("preserved only in the embedded")).toBe(embedNativePayload);
    const textFormatWarning = xml.warnings.find(warning => warning.code === "cdxml.text_format_native_only")!;
    expect(textFormatWarning.message).toContain("keeps per-character (run) colors, bold/italic and subscript/superscript");
    expect(textFormatWarning.message).toContain("but not formatting applied to the whole text box (font, size, bold, italic, alignment, spacing)");
    const xmlLabelWarning = xml.warnings.find(warning => warning.code === "cdxml.label_bond_side_turned")!;
    const cdxLabelWarning = cdx.warnings.find(warning => warning.code === "cdxml.label_bond_side_turned")!;
    expect(xmlLabelWarning.message.includes("embedded document")).toBe(embedNativePayload);
    expect(cdxLabelWarning.message.includes("embedded document")).toBe(embedNativePayload);
    // Format labels belong to the diagnostics; authored text is never rewritten.
    expect(importCdx(cdx.bytes).document!.pages[0]!.objects.find(object => object.type === "text")).toMatchObject({ text: "visible CDXML" });
  }
  expect(exportEngineCdxml(document).warnings.find(warning => warning.code === "cdxml.text_format_native_only")!.message).toContain("visible CDXML");
});
