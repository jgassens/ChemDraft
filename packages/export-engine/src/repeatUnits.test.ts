import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { openChemDraftPayload } from "@chemdraft/cdx-compat";
import { createEmptyDocument, moleculeToMolfileV2000, moleculeToMolfileV3000, type BracketObject, type MoleculeObject } from "@chemdraft/chem-core";
import { repeatUnitExportWarnings, repeatUnitMolfileGroups } from "./repeatUnits";
import type { ExportWarning } from "./results";

const source = readFileSync(new URL("../../fixtures/cdxml/brackets-native-sru.cdxml", import.meta.url), "utf8");

function imported(ids = "11", cdxml = source) {
  const document = openChemDraftPayload(cdxml.replace('BracketedObjectIDs="10"', `BracketedObjectIDs="${ids}"`)).document!;
  const molecule = document.pages[0].objects.find((object): object is MoleculeObject => object.type === "molecule")!;
  const brackets = document.pages[0].objects.filter((object): object is BracketObject => object.type === "bracket");
  const close = brackets.find(bracket => bracket.side === "close")!;
  return { document, molecule, brackets, close };
}

describe("repeat-unit export membership", () => {
  it.each([
    ["V3000", moleculeToMolfileV3000], ["V2000", moleculeToMolfileV2000]
  ] as const)("uses imported atom membership and crossing bonds in %s instead of bracket geometry", (format, write) => {
    const { document, molecule, close } = imported();
    const before = structuredClone(document);
    const warnings: ExportWarning[] = [];
    const groups = repeatUnitMolfileGroups(document, [molecule], warnings);
    expect(groups).toEqual([{ objectId: close.id, label: "x-y", atomIds: [molecule.atoms[0].id] }]);
    expect(warnings).toEqual([]);
    const result = write(molecule, { kekuleBondOrders: new Map(), repeatUnitGroups: groups });
    if (format === "V3000") {
      expect(result.contents.replace(/ -\nM  V30 /g, " ")).toContain("SRU 0 ATOMS=(1 1) XBONDS=(1 1) LABEL=x-y CONNECT=EU");
    } else {
      expect(result.contents).toContain("M  SAL   1  1   1");
      expect(result.contents).toContain("M  SBL   1  1   1");
    }
    expect(repeatUnitExportWarnings(document, "SMILES")[0].message).toContain("around 1 atoms");
    expect(document).toEqual(before);
  });

  it("uses geometry and derives crossing bonds for a bracket drawn without imported membership", () => {
    const document = createEmptyDocument();
    const molecule: MoleculeObject = { id: "chain", type: "molecule", x: 50, y: 140, width: 180, height: 1,
      rotation: 0, style: {}, structureFormat: "smiles", structure: "CCCC", superatoms: [], rGroups: [],
      atoms: [50, 110, 170, 230].map((x, i) => ({ id: `a${i}`, element: "C", x, y: 140, formalCharge: 0 })),
      bonds: [0, 1, 2].map(i => ({ id: `b${i}`, fromAtomId: `a${i}`, toAtomId: `a${i + 1}`, order: "single" })) };
    const open: BracketObject = { id: "open", type: "bracket", bracketKind: "square", side: "open", pairId: "pair",
      repeatUnit: true, x: 90, y: 100, width: 10, height: 80, rotation: 0, style: {}, containedObjectIds: [] };
    document.pages[0].objects = [molecule, open, { ...open, id: "close", side: "close", x: 180, label: "n" }];
    const warnings: ExportWarning[] = [];
    const groups = repeatUnitMolfileGroups(document, [molecule], warnings);
    expect(groups).toEqual([{ objectId: "close", label: "n", atomIds: ["a1", "a2"] }]);
    const result = moleculeToMolfileV3000(molecule, { kekuleBondOrders: new Map(), repeatUnitGroups: groups });
    expect(result.contents.replace(/ -\nM  V30 /g, " ")).toContain("SRU 0 ATOMS=(2 2 3) XBONDS=(2 1 3) LABEL=n CONNECT=EU");
    expect(warnings).toEqual([]);
  });

  it.each(["missing", "11 missing"])("declines unresolved imported membership %s with a named, specific warning", ids => {
    const { document, molecule, close } = imported(ids);
    const warnings: ExportWarning[] = [];
    const groups = repeatUnitMolfileGroups(document, [molecule], warnings);
    expect(groups).toEqual([]);
    expect(warnings).toEqual([{
      code: "export.repeat_unit_not_represented", severity: "warning", objectId: close.id,
      message: `MOL cannot represent repeat unit x-y (bracket ${close.id}): its imported BracketedObjectIDs member "missing" does not resolve unambiguously to atoms in the export scope; only the bare structure is written.`
    }]);
    expect(moleculeToMolfileV3000(molecule, { kekuleBondOrders: new Map(), repeatUnitGroups: groups }).contents).not.toContain("BEGIN SGROUP");
  });

  it("declines imported atoms omitted from an exported molecule subset", () => {
    const { document, molecule } = imported();
    const warnings: ExportWarning[] = [];
    expect(repeatUnitMolfileGroups(document, [{ ...molecule, atoms: molecule.atoms.slice(1), bonds: [] }], warnings)).toEqual([]);
    expect(warnings).toEqual([expect.objectContaining({
      code: "export.repeat_unit_not_represented", message: expect.stringContaining("part of its atom membership is outside the export scope")
    })]);
  });

  it("declines an imported group without membership instead of guessing from geometry", () => {
    const { document, molecule } = imported("11", source.replace('BracketedObjectIDs="10"', ""));
    const warnings: ExportWarning[] = [];
    expect(repeatUnitMolfileGroups(document, [molecule], warnings)).toEqual([]);
    expect(warnings[0].message).toContain("imported BracketedObjectIDs membership is empty or invalid");
  });

  it("declines source membership whose preserved native mapping is missing", () => {
    const { document, molecule, brackets } = imported();
    for (const bracket of brackets) delete bracket.compatibility!.unknown.cdxmlBracketMembers;
    const warnings: ExportWarning[] = [];
    expect(repeatUnitMolfileGroups(document, [molecule], warnings)).toEqual([]);
    expect(warnings[0].message).toContain('BracketedObjectIDs member "11" does not resolve unambiguously');
  });

  it("does not add geometrically enclosed molecules to imported membership", () => {
    const { document, molecule } = imported();
    const neighbour = { ...molecule, id: "neighbour" };
    document.pages[0].objects.push(neighbour);
    const warnings: ExportWarning[] = [];
    expect(repeatUnitMolfileGroups(document, [neighbour, molecule], warnings, { merged: true,
      expansions: [{ atomId: `m1_${molecule.atoms[0].id}`, atomIds: ["expanded"] }] })[0].atomIds)
      .toEqual([`m1_${molecule.atoms[0].id}`, "expanded"]);
    expect(warnings).toEqual([]);
  });

  it("resolves whole-molecule imported membership without geometric additions", () => {
    const { document, molecule } = imported("10", source.replace(/<crossingbond[^>]*\/>/, ""));
    const neighbour = { ...molecule, id: "neighbour" };
    document.pages[0].objects.push(neighbour);
    const warnings: ExportWarning[] = [];
    expect(repeatUnitMolfileGroups(document, [molecule, neighbour], warnings, { merged: true })[0].atomIds)
      .toEqual(molecule.atoms.map(atom => `m0_${atom.id}`));
    expect(warnings).toEqual([]);
  });

  it.each([
    [source.replace('BondID="13"', 'BondID="missing"'), 'imported crossing bond "missing" does not resolve'],
    [source.replace('InnerAtomID="11"', 'InnerAtomID="12"'), 'imported crossing InnerAtomID "12" does not resolve']
  ])("declines unresolved or contradictory imported crossing data", (cdxml, reason) => {
    const { document, molecule, close } = imported("11", cdxml);
    const warnings: ExportWarning[] = [];
    expect(repeatUnitMolfileGroups(document, [molecule], warnings)).toEqual([]);
    expect(warnings).toEqual([expect.objectContaining({ code: "export.repeat_unit_not_represented", objectId: close.id,
      message: expect.stringContaining(reason) })]);
  });

  it("declines crossing references inconsistent with imported atom membership", () => {
    const { document, molecule } = imported("10");
    const warnings: ExportWarning[] = [];
    expect(repeatUnitMolfileGroups(document, [molecule], warnings)).toEqual([]);
    expect(warnings[0].message).toContain("crossing-bond references do not match the boundary of its atom membership");
  });
});
