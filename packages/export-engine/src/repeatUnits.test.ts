import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { openChemDraftPayload } from "@chemdraft/cdx-compat";
import { applyPatch, createEmptyDocument, deserializeDocument, moleculeToMolfileV2000, moleculeToMolfileV3000, serializeDocument, type BracketObject, type MoleculeObject } from "@chemdraft/chem-core";
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
    expect(groups).toEqual([{ objectId: close.id, label: "x-y", atomIds: [molecule.atoms[0].id], connectivity: "ht" }]);
    expect(warnings).toEqual([]);
    const result = write(molecule, { kekuleBondOrders: new Map(), repeatUnitGroups: groups });
    if (format === "V3000") {
      expect(result.contents.replace(/ -\nM  V30 /g, " ")).toContain("SRU 0 ATOMS=(1 1) XBONDS=(1 1) LABEL=x-y CONNECT=HT");
    } else {
      expect(result.contents).toContain("M  SAL   1  1   1");
      expect(result.contents).toContain("M  SBL   1  1   1");
      expect(result.contents).toContain("M  SCN  1   1 HT");
    }
    expect(repeatUnitExportWarnings(document, "SMILES")[0].message).toContain("around 1 atoms");
    expect(document).toEqual(before);
  });

  it.each([
    [undefined, "ht"], ["HeadToTail", "ht"], ["HeadToHead", "hh"], ["EitherUnknown", "eu"]
  ] as const)("preserves imported PolymerRepeatPattern %s in MOL connectivity", (pattern, connectivity) => {
    const { document, molecule, close } = imported("11",
      pattern === undefined ? source : source.replace('SRULabel="x-y"', `SRULabel="x-y" PolymerRepeatPattern="${pattern}"`));
    const before = structuredClone(document);
    const warnings: ExportWarning[] = [];
    const groups = repeatUnitMolfileGroups(document, [molecule], warnings);
    expect(groups).toEqual([{ objectId: close.id, label: "x-y", atomIds: [molecule.atoms[0].id], connectivity }]);
    for (const [format, write] of [["V3000", moleculeToMolfileV3000], ["V2000", moleculeToMolfileV2000]] as const) {
      const contents = write(molecule, { kekuleBondOrders: new Map(), repeatUnitGroups: groups }).contents;
      expect(contents.replace(/ -\nM  V30 /g, " ")).toContain(format === "V3000"
        ? `CONNECT=${connectivity.toUpperCase()}` : `M  SCN  1   1 ${connectivity.toUpperCase()}`);
    }
    expect(warnings).toEqual([]);
    expect(document).toEqual(before);
  });

  it.each(["Unrecognised", ""])("declines unsupported imported PolymerRepeatPattern %j with a specific warning", pattern => {
    const { document, molecule, close } = imported("11",
      source.replace('SRULabel="x-y"', `SRULabel="x-y" PolymerRepeatPattern="${pattern}"`));
    const warnings: ExportWarning[] = [];
    const groups = repeatUnitMolfileGroups(document, [molecule], warnings);
    expect(groups).toEqual([]);
    expect(warnings).toEqual([{
      code: "export.repeat_unit_not_represented", severity: "warning", objectId: close.id,
      message: `MOL cannot represent repeat unit x-y (bracket ${close.id}): its imported PolymerRepeatPattern "${pattern}" has no supported MOL SRU connectivity; only the bare structure is written.`
    }]);
    expect(moleculeToMolfileV3000(molecule, { kekuleBondOrders: new Map(), repeatUnitGroups: groups }).contents).not.toContain("BEGIN SGROUP");
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

  it.each(["sru", "multiple", "unknown"] as const)("skips an imported %s bracket when only an unrelated molecule is exported", usage => {
    const { document, molecule, brackets } = imported();
    for (const bracket of brackets) bracket.bracketUsage = usage;
    const neighbour = { ...molecule, id: "neighbour" };
    document.pages[0].objects.push(neighbour);
    const warnings: ExportWarning[] = [];
    expect(repeatUnitMolfileGroups(document, [neighbour], warnings)).toEqual([]);
    expect(warnings).toEqual([]);
    expect(repeatUnitExportWarnings(document, "SMILES", { molecules: [neighbour] })).toEqual([]);
  });

  it("skips unresolved imported membership whose native references are outside the export selection", () => {
    const { document, molecule } = imported("11 missing");
    const neighbour = { ...molecule, id: "neighbour" };
    document.pages[0].objects.push(neighbour);
    const warnings: ExportWarning[] = [];
    expect(repeatUnitMolfileGroups(document, [neighbour], warnings)).toEqual([]);
    expect(warnings).toEqual([]);
    expect(repeatUnitExportWarnings(document, "SMILES", { molecules: [neighbour] })).toEqual([]);
  });

  it("declines an imported bracket whose member molecules are only partly selected", () => {
    const cdxml = source.replace("</fragment>", '</fragment><fragment id="40"><n id="41" Element="6" p="200 110"/></fragment>');
    const { document, molecule, close } = imported("11 41", cdxml);
    const warnings: ExportWarning[] = [];
    expect(repeatUnitMolfileGroups(document, [molecule], warnings)).toEqual([]);
    expect(warnings).toEqual([expect.objectContaining({ objectId: close.id,
      message: expect.stringContaining("part of its atom membership is outside the export selection") })]);
    expect(repeatUnitExportWarnings(document, "SMILES", { molecules: [molecule] })).toEqual([
      expect.objectContaining({ objectId: close.id, message: expect.stringContaining("around 1 atoms") })
    ]);
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

  it("replaces imported whole-molecule membership with the current native edit, without geometric additions", () => {
    const cdxml = source.replace(/<crossingbond[^>]*\/>/, "")
      .replace("</fragment>", '</fragment><fragment id="40"><n id="41" Element="7" p="500 500"/></fragment>');
    const { document, molecule, brackets, close } = imported("10", cdxml);
    const replacement = document.pages[0].objects.find((object): object is MoleculeObject =>
      object.type === "molecule" && object.id !== molecule.id)!;
    for (const bracket of brackets) bracket.containedObjectIds = [replacement.id];
    const before = structuredClone(document);
    const warnings: ExportWarning[] = [];
    expect(repeatUnitMolfileGroups(document, [molecule, replacement], warnings, { merged: true })).toEqual([
      { objectId: close.id, label: "x-y", atomIds: replacement.atoms.map(atom => `m1_${atom.id}`), connectivity: "ht" }
    ]);
    expect(repeatUnitMolfileGroups(document, [replacement], warnings)).toEqual([
      { objectId: close.id, label: "x-y", atomIds: replacement.atoms.map(atom => atom.id), connectivity: "ht" }
    ]);
    expect(repeatUnitMolfileGroups(document, [molecule], warnings)).toEqual([]);
    expect(warnings).toEqual([]);
    expect(document).toEqual(before);
  });

  it.each([
    [[], "its edited native membership is empty"],
    [["missing"], 'its edited native membership includes missing or non-molecular object "missing"']
  ] as const)("declines invalid native membership edits %j instead of reviving the import", (ids, reason) => {
    const { document, molecule, brackets, close } = imported("10", source.replace(/<crossingbond[^>]*\/>/, ""));
    for (const bracket of brackets) bracket.containedObjectIds = [...ids];
    const warnings: ExportWarning[] = [];
    expect(repeatUnitMolfileGroups(document, [molecule], warnings)).toEqual([]);
    expect(warnings).toEqual([expect.objectContaining({ objectId: close.id, message: expect.stringContaining(reason) })]);
  });

  it("declines inconsistent native edits between paired brackets instead of retaining stale membership", () => {
    const { document, molecule, brackets, close } = imported("10", source.replace(/<crossingbond[^>]*\/>/, ""));
    brackets[0].containedObjectIds = [];
    const warnings: ExportWarning[] = [];
    expect(repeatUnitMolfileGroups(document, [molecule], warnings)).toEqual([]);
    expect(warnings).toEqual([expect.objectContaining({ objectId: close.id,
      message: expect.stringContaining("its edited native membership differs between the paired brackets") })]);
  });

  it("declines native membership edits that conflict with imported atom-level membership", () => {
    const { document, molecule, brackets, close } = imported();
    for (const bracket of brackets) bracket.containedObjectIds = [molecule.id];
    const warnings: ExportWarning[] = [];
    expect(repeatUnitMolfileGroups(document, [molecule], warnings)).toEqual([]);
    expect(warnings).toEqual([expect.objectContaining({ objectId: close.id,
      message: expect.stringContaining("its edited native membership conflicts with imported atom-level BracketedObjectIDs membership") })]);
  });

  it("declines imported membership when its original native membership snapshot is missing", () => {
    const { document, molecule, brackets, close } = imported();
    for (const bracket of brackets) delete bracket.compatibility!.unknown.cdxmlBracketMembership;
    const warnings: ExportWarning[] = [];
    expect(repeatUnitMolfileGroups(document, [molecule], warnings)).toEqual([]);
    expect(warnings).toEqual([expect.objectContaining({ objectId: close.id,
      message: expect.stringContaining("missing import-time membership snapshot") })]);
  });

  it("declines imported atom membership after a member atom is deleted", () => {
    const { document, molecule, close } = imported();
    const deletedId = molecule.atoms[0].id;
    molecule.atoms = molecule.atoms.filter(atom => atom.id !== deletedId);
    molecule.bonds = molecule.bonds.filter(bond => bond.fromAtomId !== deletedId && bond.toAtomId !== deletedId);
    const warnings: ExportWarning[] = [];
    expect(repeatUnitMolfileGroups(document, [molecule], warnings)).toEqual([]);
    expect(warnings).toEqual([expect.objectContaining({ objectId: close.id,
      message: expect.stringContaining('its imported BracketedObjectIDs member "11" does not resolve unambiguously') })]);
  });

  it("preserves unchanged atom-level membership with no imported crossing bonds", () => {
    const { document, molecule, close } = imported("11", source.replace(/<crossingbond[^>]*\/>/, ""));
    const warnings: ExportWarning[] = [];
    expect(repeatUnitMolfileGroups(document, [molecule], warnings)).toEqual([
      { objectId: close.id, label: "x-y", atomIds: [molecule.atoms[0].id], connectivity: "ht" }
    ]);
    expect(warnings).toEqual([]);
  });

  it("declines deleted and redrawn atom and bond ids even though both import maps still contain them", () => {
    const { document, molecule, close } = imported("11", source.replace(/<crossingbond[^>]*\/>/, ""));
    const [member, deleted] = molecule.atoms;
    const [deletedBond] = molecule.bonds;
    const removed = applyPatch(document, { op: "updateObject", objectId: molecule.id,
      changes: { atoms: [member], bonds: [] } });
    // nextIndexedId reuses atom_002 / bond_001 after deletion. Drawing a carbon in the
    // bracket must not inherit the excluded oxygen's import membership by reusing its id.
    const redrawn = applyPatch(removed, { op: "updateObject", objectId: molecule.id,
      changes: { atoms: [member, { id: deleted.id, element: "C", x: member.x + 10, y: member.y, formalCharge: 0 }],
        bonds: [{ id: deletedBond.id, fromAtomId: member.id, toAtomId: deleted.id, order: "single" }] } });
    const reopened = deserializeDocument(serializeDocument(redrawn));
    const current = reopened.pages[0].objects.find((object): object is MoleculeObject => object.type === "molecule")!;
    expect(current.compatibility!.unknown.cdxmlAtomIdsByAtomId).toEqual(molecule.compatibility!.unknown.cdxmlAtomIdsByAtomId);
    expect(current.compatibility!.unknown.cdxmlBondIdsByBondId).toEqual(molecule.compatibility!.unknown.cdxmlBondIdsByBondId);
    const warnings: ExportWarning[] = [];
    const groups = repeatUnitMolfileGroups(reopened, [current], warnings);
    expect(groups).toEqual([]);
    expect(warnings).toEqual([expect.objectContaining({ code: "export.repeat_unit_not_represented", objectId: close.id,
      message: expect.stringContaining(`edited atom "${deleted.id}" with a different element`) })]);
    for (const write of [moleculeToMolfileV2000, moleculeToMolfileV3000]) {
      expect(write(current, { kekuleBondOrders: new Map(), repeatUnitGroups: groups }).contents).not.toMatch(/SRU/);
    }
  });

  it("declines a recycled bond id whose original bond did not touch the member", () => {
    const cdxml = source.replace(/<crossingbond[^>]*\/>/, "")
      .replace('<b id="13" B="11" E="12"', '<n id="14" Element="6" p="160 110"/><b id="13" B="14" E="12"');
    const { document, molecule, close } = imported("11", cdxml);
    const [bond] = molecule.bonds;
    molecule.bonds = [];
    molecule.bonds.push({ id: bond.id, fromAtomId: molecule.atoms[0].id, toAtomId: molecule.atoms[1].id, order: "single" });
    const warnings: ExportWarning[] = [];
    expect(repeatUnitMolfileGroups(document, [molecule], warnings)).toEqual([]);
    expect(warnings).toEqual([expect.objectContaining({ code: "export.repeat_unit_not_represented", objectId: close.id,
      message: expect.stringContaining(`new boundary bond "${bond.id}"`) })]);
  });

  it.each(["member", "non-member", "bond"])("declines an identical %s redrawn with a recycled id but no source provenance", target => {
    const { document, molecule } = imported("11", source.replace(/<crossingbond[^>]*\/>/, ""));
    const [bond] = molecule.bonds;
    let id = bond.id;
    if (target !== "bond") {
      const atom = molecule.atoms[target === "member" ? 0 : 1];
      id = atom.id;
      molecule.atoms = molecule.atoms.filter(candidate => candidate.id !== id);
      molecule.atoms.push({ id, element: atom.element, x: atom.x + 10, y: atom.y, formalCharge: atom.formalCharge });
    }
    molecule.bonds = [];
    molecule.bonds.push({ id: bond.id, fromAtomId: bond.fromAtomId, toAtomId: bond.toAtomId, order: bond.order });
    const warnings: ExportWarning[] = [];
    expect(repeatUnitMolfileGroups(document, [molecule], warnings)).toEqual([]);
    expect(warnings[0]).toMatchObject({ code: "export.repeat_unit_not_represented",
      message: expect.stringContaining(`cannot prove ${target === "bond" ? "bond" : "atom"} "${id}" is the imported original after an edit`) });
  });

  it("declines a recycled member id with a different element even without any bonds", () => {
    const cdxml = source.replace(/<crossingbond[^>]*\/>/, "").replace(/<b id="13"[^>]*\/>/, "");
    const { document, molecule } = imported("11", cdxml);
    const [member] = molecule.atoms;
    molecule.atoms = molecule.atoms.slice(1);
    molecule.atoms.push({ id: member.id, element: "N", x: member.x, y: member.y, formalCharge: 0 });
    const warnings: ExportWarning[] = [];
    expect(repeatUnitMolfileGroups(document, [molecule], warnings)).toEqual([]);
    expect(warnings[0].message).toContain(`edited atom "${member.id}" with a different element`);
  });

  it("declines recycled incident bond ids with different endpoints even when every atom id was imported", () => {
    const cdxml = source.replace(/<crossingbond[^>]*\/>/, "")
      .replace("</fragment>", '<n id="14" Element="8" p="160 110"/></fragment>');
    const { document, molecule } = imported("11", cdxml);
    const [bond] = molecule.bonds;
    molecule.bonds = [];
    molecule.bonds.push({ id: bond.id, fromAtomId: molecule.atoms[0].id, toAtomId: molecule.atoms[2].id, order: "single" });
    const warnings: ExportWarning[] = [];
    expect(repeatUnitMolfileGroups(document, [molecule], warnings)).toEqual([]);
    expect(warnings[0].message).toContain(`edited bond "${bond.id}" with different endpoints`);
  });

  it("declines new bonds between two imported members as well as boundary additions", () => {
    const { document, molecule } = imported("11 12", source.replace(/<crossingbond[^>]*\/>/, "")
      .replace(/<b id="13"[^>]*\/>/, ""));
    molecule.bonds.push({ id: "new", fromAtomId: molecule.atoms[0].id, toAtomId: molecule.atoms[1].id, order: "single" });
    const warnings: ExportWarning[] = [];
    expect(repeatUnitMolfileGroups(document, [molecule], warnings)).toEqual([]);
    expect(warnings[0].message).toContain('new bond "new" touching a member atom');
  });

  it("declines removal of a member's incident bond", () => {
    const { document, molecule } = imported("11", source.replace(/<crossingbond[^>]*\/>/, ""));
    const [bond] = molecule.bonds;
    molecule.bonds = [];
    const warnings: ExportWarning[] = [];
    expect(repeatUnitMolfileGroups(document, [molecule], warnings)).toEqual([]);
    expect(warnings[0].message).toContain(`no longer has incident bond "${bond.id}"`);
  });

  it("preserves moved imported membership and its identity snapshots through a native save", () => {
    const { document, molecule, close } = imported("11", source.replace(/<crossingbond[^>]*\/>/, ""));
    const moved = applyPatch(document, { op: "updateObject", objectId: molecule.id,
      changes: { atoms: molecule.atoms.map(atom => ({ ...atom, x: atom.x + 1000, y: atom.y + 1000 })) } });
    const reopened = deserializeDocument(serializeDocument(moved));
    const current = reopened.pages[0].objects.find((object): object is MoleculeObject => object.type === "molecule")!;
    const warnings: ExportWarning[] = [];
    expect(repeatUnitMolfileGroups(reopened, [current], warnings)).toEqual([
      { objectId: close.id, label: "x-y", atomIds: [molecule.atoms[0].id], connectivity: "ht" }
    ]);
    expect(warnings).toEqual([]);
  });

  it("keeps repeated source membership ids unambiguous", () => {
    const { document, molecule, close } = imported("11 11", source.replace(/<crossingbond[^>]*\/>/, ""));
    const warnings: ExportWarning[] = [];
    expect(repeatUnitMolfileGroups(document, [molecule], warnings)).toEqual([
      { objectId: close.id, label: "x-y", atomIds: [molecule.atoms[0].id], connectivity: "ht" }
    ]);
    expect(warnings).toEqual([]);
  });

  it.each([false, true])("declines legacy atom-level membership without identity data (crossings=%s)", crossings => {
    const { document, molecule, brackets, close } = imported("11", crossings ? source : source.replace(/<crossingbond[^>]*\/>/, ""));
    for (const bracket of brackets) delete bracket.compatibility!.unknown.cdxmlBracketAtomSnapshots;
    const reopened = deserializeDocument(serializeDocument(document));
    const warnings: ExportWarning[] = [];
    expect(repeatUnitMolfileGroups(reopened, [molecule], warnings)).toEqual([]);
    expect(warnings).toEqual([expect.objectContaining({ code: "export.repeat_unit_not_represented", objectId: close.id,
      message: expect.stringContaining("without an import-time atom and incident-bond snapshot") })]);
  });

  it("keeps legacy whole-molecule membership without the new identity data", () => {
    const { document, molecule, brackets, close } = imported("10", source.replace(/<crossingbond[^>]*\/>/, ""));
    for (const bracket of brackets) delete bracket.compatibility!.unknown.cdxmlBracketAtomSnapshots;
    const warnings: ExportWarning[] = [];
    expect(repeatUnitMolfileGroups(deserializeDocument(serializeDocument(document)), [molecule], warnings)).toEqual([
      { objectId: close.id, label: "x-y", atomIds: molecule.atoms.map(atom => atom.id), connectivity: "ht" }
    ]);
    expect(warnings).toEqual([]);
  });

  it.each(["inside", "outside"])("declines a new boundary bond to an atom inserted %s a repeat with no imported crossings", location => {
    const { document, molecule, close } = imported("11", source.replace(/<crossingbond[^>]*\/>/, ""));
    const member = molecule.atoms[0];
    molecule.atoms.push({ ...member, id: "inserted", x: location === "inside" ? member.x + 10 : 1000 });
    molecule.bonds.push({ id: "inserted-bond", fromAtomId: member.id, toAtomId: "inserted", order: "single" });
    const before = structuredClone(document);
    const warnings: ExportWarning[] = [];
    const groups = repeatUnitMolfileGroups(document, [molecule], warnings);
    expect(groups).toEqual([]);
    expect(warnings).toEqual([{
      code: "export.repeat_unit_not_represented", severity: "warning", objectId: close.id,
      message: `MOL cannot represent repeat unit x-y (bracket ${close.id}): its imported atom-level membership has a new boundary bond "inserted-bond" between member and non-member atoms; only the bare structure is written.`
    }]);
    for (const write of [moleculeToMolfileV2000, moleculeToMolfileV3000]) {
      expect(write(molecule, { kekuleBondOrders: new Map(), repeatUnitGroups: groups }).contents).not.toMatch(/SRU/);
    }
    expect(document).toEqual(before);
  });

  it("declines a new member-adjacent atom inside a repeat even when the bond retains its imported id", () => {
    const { document, molecule, close } = imported("11", source.replace(/<crossingbond[^>]*\/>/, ""));
    molecule.atoms.push({ ...molecule.atoms[0], id: "inserted", x: molecule.atoms[0].x + 10 });
    molecule.bonds[0].toAtomId = "inserted";
    const before = structuredClone(document);
    const warnings: ExportWarning[] = [];
    expect(repeatUnitMolfileGroups(document, [molecule], warnings)).toEqual([]);
    expect(warnings).toEqual([{
      code: "export.repeat_unit_not_represented", severity: "warning", objectId: close.id,
      message: `MOL cannot represent repeat unit x-y (bracket ${close.id}): its imported atom-level membership omits new atom "inserted" inside the bracket adjacent to a member atom; only the bare structure is written.`
    }]);
    expect(document).toEqual(before);
  });

  it("preserves imported atom membership spanning two merged molecules", () => {
    const cdxml = source.replace("</fragment>", '</fragment><fragment id="40"><n id="41" Element="7" p="500 500"/></fragment>');
    const { document, molecule, close } = imported("11 41", cdxml);
    const second = document.pages[0].objects.find((object): object is MoleculeObject =>
      object.type === "molecule" && object.id !== molecule.id)!;
    const molecules = [second, molecule];
    const warnings: ExportWarning[] = [];
    const groups = repeatUnitMolfileGroups(document, molecules, warnings, { merged: true });
    expect(groups).toEqual([{ objectId: close.id, label: "x-y",
      atomIds: [`m1_${molecule.atoms[0].id}`, `m0_${second.atoms[0].id}`], connectivity: "ht" }]);
    const merged: MoleculeObject = { ...molecule, id: "merged",
      atoms: molecules.flatMap((member, index) => member.atoms.map(atom => ({ ...atom, id: `m${index}_${atom.id}` }))),
      bonds: molecules.flatMap((member, index) => member.bonds.map(bond => ({ ...bond,
        id: `m${index}_${bond.id}`, fromAtomId: `m${index}_${bond.fromAtomId}`, toAtomId: `m${index}_${bond.toAtomId}` }))) };
    const result = moleculeToMolfileV3000(merged, { kekuleBondOrders: new Map(), repeatUnitGroups: groups });
    expect(result.contents.replace(/ -\nM  V30 /g, " ")).toContain("SRU 0 ATOMS=(2 1 2) XBONDS=(1 1) LABEL=x-y CONNECT=HT");
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

  it("names a crossing bond by its native id when changed endpoints have no imported BondID", () => {
    const { document, molecule, brackets } = imported();
    for (const bracket of brackets) {
      const crossings = bracket.compatibility!.unknown.cdxmlBracketCrossings as { attributes: Record<string, unknown> }[];
      for (const crossing of crossings) delete crossing.attributes.BondID;
    }
    const bond = molecule.bonds[0];
    [bond.fromAtomId, bond.toAtomId] = [bond.toAtomId, bond.fromAtomId];
    const warnings: ExportWarning[] = [];
    expect(repeatUnitMolfileGroups(document, [molecule], warnings)).toEqual([]);
    expect(warnings).toHaveLength(1);
    expect(warnings[0].message).toContain(`imported crossing bond "${bond.id}" no longer has its original endpoints`);
    expect(warnings[0].message).not.toContain("undefined");
  });
});
