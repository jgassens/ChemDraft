import { describe, expect, it } from "vitest";
import { type MoleculeObject, type ChemDraftDocument } from "@chemdraft/chem-core";
import { repeatUnitExportWarnings, repeatUnitMolfileGroups, type ExportWarning } from "@chemdraft/export-engine";
import { copyAsMolfile, createPhase4Document, insertNativeBracket, selectDocumentObjects } from "./documentWorkflow";
import { toggleBracketRepeatUnit } from "./bracketCommands";

function fixture() {
  const molecule: MoleculeObject = { id: "chain", type: "molecule", x: 50, y: 140, width: 180, height: 1,
    rotation: 0, style: {}, structureFormat: "smiles", structure: "CCCC", superatoms: [], rGroups: [],
    atoms: [50, 110, 170, 230].map((x, i) => ({ id: `a${i}`, element: "C", x, y: 140, formalCharge: 0 })),
    bonds: [0, 1, 2].map(i => ({ id: `b${i}`, fromAtomId: `a${i}`, toAtomId: `a${i + 1}`, order: "single" })) };
  const document = createPhase4Document("Partial chain");
  document.pages[0].objects.push(molecule);
  return toggleBracketRepeatUnit(insertNativeBracket(document, { x: 90, y: 100 }, "square", { x: 190, y: 180 }));
}
describe("document repeat-unit export mapping", () => {
  it("finds atoms inside brackets even when the molecule extends outside, and writes crossing bonds", () => {
    const doc = structuredClone(fixture());
    const warnings: string[] = [];
    expect(copyAsMolfile(doc, "v3000", warnings)?.replace(/ -\nM  V30 /g, " "))
      .toContain("SRU 0 ATOMS=(2 2 3) XBONDS=(2 1 3) LABEL=n CONNECT=EU");
    expect(copyAsMolfile(doc, "v2000", warnings)).toContain("M  SBL   1  2   1   3");
    expect(warnings).toEqual([]);
    expect(repeatUnitExportWarnings(doc, "SMILES")[0].message).toContain("around 2 atoms");
  });
  it("warns naming the bracket if explicit membership is unresolved", () => {
    const doc = structuredClone(fixture());
    doc.pages[0].objects.forEach(object => { if (object.type === "bracket") object.containedObjectIds = ["missing"]; });
    const warnings: string[] = [];
    expect(copyAsMolfile(doc, "v3000", warnings)).not.toContain("BEGIN SGROUP");
    expect(warnings).toEqual([expect.stringContaining(`bracket ${doc.selection.objectIds[0]}`)]);
  });
  it("namespaces merged molecule membership and includes expanded atoms", () => {
    const doc = structuredClone(fixture());
    const first = doc.pages[0].objects[0] as MoleculeObject;
    const second = { ...first, id: "second", atoms: first.atoms.map(atom => ({ ...atom, y: 145 })) };
    doc.pages[0].objects.push(second);
    const warnings: ExportWarning[] = [];
    const groups = repeatUnitMolfileGroups(doc, [first, second], warnings, { merged: true,
      expansions: [{ atomId: "m0_a1", atomIds: ["m0_a1", "expanded"] }] });
    expect(groups[0].atomIds).toEqual(["m0_a1", "m0_a2", "m1_a1", "m1_a2", "expanded"]);
    expect(warnings).toEqual([]);
    // Only the molecule is selected; the bracket annotation still applies.
    const selected: ChemDraftDocument = selectDocumentObjects(doc, doc.pages[0].id, [first.id]);
    expect(repeatUnitExportWarnings(selected, "SMILES", { molecules: [first] })).toHaveLength(1);
    const partialWarnings: ExportWarning[] = [];
    expect(repeatUnitMolfileGroups(selected, [first], partialWarnings)).toEqual([]);
    expect(partialWarnings[0].message).toContain("outside the export selection");
  });
});
