import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { openChemDraftPayload } from "@chemdraft/cdx-compat";
import { type MoleculeObject, type ChemDraftDocument } from "@chemdraft/chem-core";
import { repeatUnitExportWarnings, repeatUnitMolfileGroups, type ExportWarning } from "@chemdraft/export-engine";
import { applySingleBondToolAtPoint, copyAsMolfile, createPhase4Document, insertNativeBracket, selectDocumentObjects } from "./documentWorkflow";
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
  it.each(["v2000", "v3000"] as const)("keeps the one-copy note without a molecule id when an imported SRU is written to %s", flavor => {
    const source = readFileSync(new URL("../../../packages/fixtures/cdxml/brackets-native-sru.cdxml", import.meta.url), "utf8")
      .replace(/<crossingbond[^>]*\/>/, "").replace('SRULabel="x-y"', 'SRULabel="n"');
    const document = openChemDraftPayload(source).document!;
    const molecule = document.pages[0].objects.find(object => object.type === "molecule")!;
    const warnings: string[] = [];
    expect(copyAsMolfile(document, flavor, warnings)).toContain("SRU");
    expect(warnings).toEqual([
      "A molecule is inside a repeat unit n; polymer formula not computed; values and molecular graph exports are for one drawn copy only."
    ]);
    expect(warnings.join(" ")).not.toContain(molecule.id);
  });

  it.each(["missing snapshot", "new atom", "deleted atom"])("omits the stale polymer note after declining an imported SRU: %s", edit => {
    const source = readFileSync(new URL("../../../packages/fixtures/cdxml/brackets-native-sru.cdxml", import.meta.url), "utf8")
      .replace(/<crossingbond[^>]*\/>/, "").replace('SRULabel="x-y"', 'SRULabel="n"');
    const document = openChemDraftPayload(source).document!;
    const molecule = document.pages[0].objects.find(object => object.type === "molecule")!;
    if (edit === "missing snapshot") {
      for (const object of document.pages[0].objects) {
        if (object.type === "bracket") delete object.compatibility!.unknown.cdxmlBracketAtomSnapshots;
      }
    } else if (edit === "new atom") {
      molecule.atoms.push({ ...molecule.atoms[0], id: "new-atom", x: 150 });
    } else {
      molecule.atoms.pop();
      molecule.bonds = [];
    }
    for (const flavor of ["v2000", "v3000"] as const) {
      const warnings: string[] = [];
      expect(copyAsMolfile(document, flavor, warnings)).not.toContain("SRU");
      expect(warnings).toHaveLength(1);
      expect(warnings[0]).toContain("only the bare structure is written");
      expect(warnings.join(" ")).not.toContain("polymer formula not computed");
      expect(warnings.join(" ")).not.toContain("inside a repeat unit");
      expect(warnings.join(" ")).not.toContain(molecule.id);
    }
  });

  it.each(["v2000", "v3000"] as const)("drops cached one-copy notes as well as live notes for a declined SRU in %s", flavor => {
    // Command results are frozen undo snapshots; clone before simulating an edit.
    const document = structuredClone(toggleBracketRepeatUnit(insertNativeBracket(
      applySingleBondToolAtPoint(createPhase4Document("Cached SRU context"), { x: 140, y: 140 }),
      { x: 100, y: 100 }, "square", { x: 260, y: 200 })));
    const molecule = document.pages[0].objects.find(object => object.type === "molecule")!;
    expect(molecule.chemistry?.warnings).toContainEqual(expect.objectContaining({ code: "chemistry.bracket_multiplier" }));
    for (const object of document.pages[0].objects) {
      if (object.type === "bracket") object.containedObjectIds.push("missing");
    }
    const before = structuredClone(document);
    const warnings: string[] = [];
    expect(copyAsMolfile(document, flavor, warnings)).not.toContain("SRU");
    expect(warnings).toEqual([expect.stringContaining("its membership includes missing or non-molecular objects")]);
    expect(document).toEqual(before);
  });

  it.each(["multiple", "unknown"] as const)("keeps the %s one-copy note without cached chemistry", usage => {
    const document = structuredClone(fixture());
    const molecule = document.pages[0].objects.find(object => object.type === "molecule")!;
    expect(molecule.chemistry).toBeUndefined();
    for (const object of document.pages[0].objects) {
      if (object.type !== "bracket") continue;
      object.bracketUsage = usage;
      object.repeatUnit = false;
      object.repeatCount = usage === "multiple" ? 3 : undefined;
      object.containedObjectIds = [molecule.id];
    }
    const description = usage === "multiple" ? "a multiple group x3" : "a bracket group with unknown usage";
    for (const flavor of ["v2000", "v3000"] as const) {
      const warnings: string[] = [];
      expect(copyAsMolfile(document, flavor, warnings)).not.toContain("SRU");
      expect(warnings).toEqual([
        expect.stringContaining("cannot be represented as an SRU"),
        `A molecule is inside ${description}; values and molecular graph exports are for one drawn copy only.`
      ]);
      expect(warnings.join(" ")).not.toContain(molecule.id);
    }
  });

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
    const close = doc.pages[0].objects.find(object => object.type === "bracket" && object.side === "close")!;
    const warnings: string[] = [];
    expect(copyAsMolfile(doc, "v3000", warnings)).not.toContain("BEGIN SGROUP");
    expect(warnings).toEqual([
      `MOL cannot represent repeat unit n (bracket ${close.id}): its membership includes missing or non-molecular objects; only the bare structure is written.`
    ]);
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
