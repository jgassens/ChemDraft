import { describe, expect, it } from "vitest";
import { applyPatch, bracketChemistryWarnings, createEmptyDocument, moleculeToMolfileV2000, moleculeToMolfileV3000,
  parseDocument, type BracketObject, type MoleculeObject } from "@chemdraft/chem-core";
import type { ExportWarning } from "@chemdraft/export-engine";
import { nativeSingleBondGraphMetadata } from "./atoms";
import { moleculeSmiles } from "./moleculeSmiles";

function bracketed(usage: "sru" | "multiple" | "unknown" | undefined) {
  const document = createEmptyDocument();
  const molecule: MoleculeObject = { id: "m", type: "molecule", x: 50, y: 50, width: 20, height: 20, rotation: 0, style: {},
    structure: "", structureFormat: "unknown", atoms: [{ id: "a", element: "C", x: 0, y: 0, formalCharge: 0 }], bonds: [], superatoms: [], rGroups: [] };
  molecule.chemistry = nativeSingleBondGraphMetadata(molecule.atoms, molecule.bonds);
  const open: BracketObject = { id: "open", type: "bracket", x: 30, y: 30, width: 10, height: 60, rotation: 0, style: {},
    bracketKind: "square", side: "open", pairId: "p", bracketUsage: usage, containedObjectIds: [molecule.id],
    ...(usage === "multiple" ? { repeatCount: 3 } : usage === undefined ? { repeatUnit: true } : {}) };
  document.pages[0].objects = [molecule, open, { ...open, id: "close", x: 80, side: "close", label: "x-y" }];
  return parseDocument(document);
}

describe("bracket-aware chemistry", () => {
  it.each(["sru", "multiple", "unknown", undefined] as const)("labels formula, both masses, SMILES and MOL as one copy for %s", async usage => {
    const document = bracketed(usage);
    const molecule = document.pages[0].objects.find(object => object.type === "molecule")!;
    const description = usage === "multiple" ? "multiple group x3" : usage === "unknown" ? "unknown usage" : "repeat unit x-y";
    expect(molecule.chemistry).toMatchObject({ formula: "CH4", exactMass: expect.any(Number), averageMass: expect.any(Number),
      warnings: [expect.objectContaining({ code: "chemistry.bracket_multiplier", message: expect.stringContaining(description) })] });
    expect(bracketChemistryWarnings(document, molecule)).toHaveLength(1);
    const warnings: ExportWarning[] = [];
    expect(await moleculeSmiles(molecule, 0, warnings, undefined)).toBe("C");
    expect(warnings.some(warning => warning.message.includes(description))).toBe(true);
    for (const writer of [moleculeToMolfileV2000, moleculeToMolfileV3000]) {
      expect(writer(molecule, { kekuleBondOrders: new Map() }).warnings.some(message => message.includes(description))).toBe(true);
      const fresh = { ...molecule, chemistry: undefined };
      expect(writer(fresh, { kekuleBondOrders: new Map(), document }).warnings.some(message => message.includes(description))).toBe(true);
    }
    const plain = applyPatch(document, { op: "removeObject", objectId: "close" });
    expect(plain.pages[0].objects.find(object => object.type === "molecule")!.chemistry!.warnings).toEqual([]);
  });

  it.each(["multiple", "sru"] as const)("appends %s warnings alongside literal-label warnings on every MOL export", usage => {
    const document = bracketed(usage);
    const original = document.pages[0].objects.find(object => object.type === "molecule")!;
    const molecule = { ...original, atoms: [{ ...original.atoms[0], element: "SO3", labelLiteral: true }] };
    const description = usage === "multiple" ? "multiple group x3" : "repeat unit x-y";
    for (const writer of [moleculeToMolfileV2000, moleculeToMolfileV3000]) {
      for (const context of [{}, { document }]) {
        const warnings = ["Existing export warning."];
        const options = { ...context, kekuleBondOrders: new Map<string, number>(), warnings };
        const result = writer(molecule, options);
        expect(result.warnings).toHaveLength(2);
        expect(result.warnings).toEqual(expect.arrayContaining([
          expect.stringContaining(description), expect.stringContaining("SO3")
        ]));
        expect(warnings).toEqual(["Existing export warning.", ...result.warnings]);
        expect(writer(molecule, options).warnings).toEqual(result.warnings);
        expect(warnings).toEqual(["Existing export warning.", ...result.warnings, ...result.warnings]);
      }
    }
  });

  it("keeps generic pairs and unrelated molecules quiet", () => {
    const document = bracketed("multiple");
    const molecule = document.pages[0].objects.find(object => object.type === "molecule")!;
    const outside = { ...molecule, id: "outside", x: 300, y: 300 };
    document.pages[0].objects.push(outside);
    expect(bracketChemistryWarnings(document, outside)).toEqual([]);
    const generic = parseDocument({ ...document, pages: [{ ...document.pages[0], objects: document.pages[0].objects.map(object =>
      object.type === "bracket" ? { ...object, bracketUsage: "generic", repeatCount: undefined } : object) }] });
    expect(generic.pages[0].objects.find(object => object.type === "molecule")!.chemistry!.warnings).toEqual([]);
  });
});
