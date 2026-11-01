import { readFileSync } from "node:fs";
import { beforeAll, describe, expect, it } from "vitest";
import {
  createEmptyDocument, deserializeDocument, serializeDocument, moleculeToMolfileV2000, moleculeToMolfileV3000,
  type MoleculeObject
} from "../../chem-core/src/index";
import { parseMolfileGraph } from "../../clipboard-adapter/src/index";
import { openChemDraftPayload, exportDocumentToCdxml } from "../../cdx-compat/src/index";
import { depictSmiles2D, relayoutMolfile2D, perceiveStereoCentersFromMolfile } from "../../ocl-adapter/src/index";
import {
  createSmilesMolecule, insertSmilesMolecule, pastedStructureDepictionFromMolfile,
  expandNativeMoleculeLabelGroups, moleculeSmiles, stereoPerceptionMolfile
} from "../../document-workflow-core/src/index";
import { ensureRdkit, generateSmiles2DMolfile, type RdkitMinimalModule } from "../../rdkit-adapter/src/conformer";
import { installRealRdkitModuleLoader } from "../../rdkit-adapter/src/testing";
import { compositionFromRdkitJson } from "../../rdkit-adapter/src/composition";
import { computeStructureIdentifiers } from "../../rdkit-adapter/src/identifiers";
import { perceiveDoubleBondStereo } from "../../chemdraft-cli/src/commands/stereo";
import cases from "../open-double-bonds/cases.json";

const read = (name: string) => readFileSync(new URL(`../open-double-bonds/${name}`, import.meta.url), "utf8");
const options = { fromDocFrame: true, kekuleBondOrders: new Map<string, number>() };
const native = (name: string) => deserializeDocument(read(`${name}.json`)).pages[0]!.objects[0] as MoleculeObject;
const molfile = (molecule: MoleculeObject) => moleculeToMolfileV2000(molecule, options).contents;
const eitherIndices = (bonds: readonly { stereo?: string }[]) => bonds.flatMap((b, i) => b.stereo === "either" ? [i] : []);
let rdkit: RdkitMinimalModule;
beforeAll(async () => { installRealRdkitModuleLoader(); rdkit = await ensureRdkit(); });

function chemistry(structure: string) {
  const parsed = rdkit.get_mol(structure, JSON.stringify({ removeHs: false }));
  if (!parsed) throw new Error("RDKit refused fixture");
  try {
    const json = JSON.parse(parsed.get_json!());
    const graph = json.molecules[0];
    const c = compositionFromRdkitJson(json);
    return { canonical: parsed.get_smiles!(), formula: c.formula, charge: c.formalCharge,
      atomCount: c.atomCount, bondCount: c.bondCount,
      tetrahedral: graph.atoms.map((a: { stereo?: string }) => a.stereo ?? "unspecified"),
      doubleStereo: graph.bonds.filter((b: { bo?: number }) => b.bo === 2)
        .map((b: { stereo?: string }) => b.stereo ?? "unspecified") };
  } finally { parsed.delete(); }
}

function expectChemistry(structure: string, entry: typeof cases[number]) {
  const actual = chemistry(structure);
  expect(actual).toMatchObject({ canonical: entry.canonical, formula: entry.formula, charge: entry.charge,
    atomCount: entry.atomCount, bondCount: entry.bondCount, tetrahedral: entry.stereo });
  expect(actual.doubleStereo.filter((stereo: string) => stereo === "either")).toHaveLength(entry.eitherBondIndices.length);
  return actual;
}

function expectMolCoordinates(structure: string, molecule: MoleculeObject) {
  const graph = parseMolfileGraph(structure);
  expect(eitherIndices(graph.bonds)).toEqual(eitherIndices(molecule.bonds));
  graph.atoms.forEach((a, i) => {
    expect(a.x).toBeCloseTo(molecule.atoms[i]!.x, 3);
    expect(a.y).toBeCloseTo(-molecule.atoms[i]!.y, 3);
  });
}

describe.each(cases)("$id interchange", (entry) => {
  it("retains native flags and structure across load/save, with unchanged atom coordinates", () => {
    const doc = deserializeDocument(read(`${entry.id}.json`));
    expect(deserializeDocument(serializeDocument(doc))).toEqual(doc);
    const molecule = native(entry.id);
    expect(eitherIndices(molecule.bonds)).toEqual(entry.eitherBondIndices);
    expectChemistry(molecule.structure, entry);
    expectMolCoordinates(molecule.structure, molecule);
    expectChemistry(stereoPerceptionMolfile(molecule), entry);
  });

  for (const format of ["v2000", "v3000"] as const) {
    it(`preserves all chemistry, explicit either state, counts and coordinates through ${format}`, () => {
      const molecule = native(entry.id);
      const source = read(`${entry.id}.${format}.mol`);
      const expected = expectChemistry(source, entry);
      expectMolCoordinates(source, molecule);
      const graph = parseMolfileGraph(source);
      const rebuilt: MoleculeObject = { ...molecule,
        atoms: graph.atoms.map((a) => ({ ...a, y: -a.y })),
        bonds: graph.bonds.map(({ bondStyle, ...b }) => ({ ...b, ...(bondStyle ? { display: { bondStyle } } : {}) })) };
      const output = format === "v2000" ? molfile(rebuilt) : moleculeToMolfileV3000(rebuilt, options).contents;
      expect(chemistry(output)).toEqual(expected);
      expectMolCoordinates(output, molecule);
    });
  }

  it("exercises visible CDXML with every native payload tag removed", () => {
    const source = read(`${entry.id}.cdxml`);
    expect(source).not.toMatch(/<objecttag\b[^>]*Name="org\.chemdraft\//);
    const imported = openChemDraftPayload(source);
    expect(imported.source).toBe("external-cdxml");
    const molecule = imported.document!.pages[0]!.objects[0] as MoleculeObject;
    const reference = native(entry.id);
    expect(eitherIndices(molecule.bonds)).toEqual([]);
    expect(molecule.atoms).toHaveLength(entry.atomCount);
    expect(molecule.bonds).toHaveLength(entry.bondCount);
    const actual = chemistry(molfile(molecule));
    const expected = expectChemistry(molfile(reference), entry);
    expect(actual).toMatchObject({ formula: entry.formula, charge: entry.charge,
      atomCount: entry.atomCount, bondCount: entry.bondCount });
    entry.stereo.forEach((stereo, i) => {
      if (stereo !== "unspecified") expect(actual.tetrahedral[i]).toBe(stereo);
    });
    let doubleIndex = 0;
    reference.bonds.forEach((bond, i) => {
      if (bond.order !== "double") return;
      if (entry.eitherBondIndices.includes(i)) {
        expect(molecule.bonds[i]!.order).toBe("double");
        expect(molecule.bonds[i]!.stereo).not.toBe("either");
      } else if (expected.doubleStereo[doubleIndex] !== "unspecified") {
        expect(actual.doubleStereo[doubleIndex]).toBe(expected.doubleStereo[doubleIndex]);
      }
      doubleIndex++;
    });
    molecule.atoms.forEach((a, i) => {
      expect(a.x).toBeCloseTo(reference.atoms[i]!.x, 3);
      expect(a.y).toBeCloseTo(reference.atoms[i]!.y, 3);
    });
  });

  it("preserves either bonds in the native CDXML payload and warns for each bond", () => {
    const document = deserializeDocument(read(`${entry.id}.json`));
    const molecule = native(entry.id);
    const exported = exportDocumentToCdxml(document);
    const warnings = exported.warnings.filter((warning) => warning.code === "cdxml.open_double_bond_native_only");
    expect(warnings.map((warning) => warning.message)).toEqual(entry.eitherBondIndices.map((i) =>
      `E/Z-unspecified double bond ${molecule.bonds[i]!.id} is kept for ChemDraft only; other apps will see a plain double bond.`));
    const roundtrip = openChemDraftPayload(exported.contents).document!.pages[0]!.objects[0] as MoleculeObject;
    expect(eitherIndices(roundtrip.bonds)).toEqual(entry.eitherBondIndices);
  });

  it("OCL relayout keeps open bonds and every specified stereocentre", () => {
    const layout = relayoutMolfile2D(read(`${entry.id}.v2000.mol`));
    expectChemistry(layout.molfile, entry);
    expect(eitherIndices(layout.bonds)).toEqual(entry.eitherBondIndices);
    const graph = parseMolfileGraph(layout.molfile);
    expect(eitherIndices(graph.bonds)).toEqual(entry.eitherBondIndices);
    layout.atoms.forEach((a, i) => {
      expect(a.x).toBeCloseTo(graph.atoms[i]!.x, 3);
      expect(a.y).toBeCloseTo(graph.atoms[i]!.y, 3);
    });
  });

  it("OCL perceives either in V2000 and V3000 without assigning E/Z or an open tetrahedral center", async () => {
    const v2 = read(`${entry.id}.v2000.mol`);
    const v3 = read(`${entry.id}.v3000.mol`);
    const bonds = await perceiveDoubleBondStereo(v2);
    expect(await perceiveDoubleBondStereo(v3)).toEqual(bonds);
    expect(bonds.filter((bond) => bond.descriptor === "unspecified")).toHaveLength(entry.eitherBondIndices.length);
    expect(bonds.filter((bond) => bond.descriptor === "unspecified").map((bond) => bond.bondIndex))
      .toEqual(entry.eitherBondIndices);
    expect(perceiveStereoCentersFromMolfile(v3)).toEqual(perceiveStereoCentersFromMolfile(v2));
  });
});

it("reads every record of a mixed V2000/V3000 SDF without leaking flags between records", () => {
  const records = read("mixed-records.sdf").trimEnd().split(/\$\$\$\$\r?\n?/).filter((s) => s.trim());
  expect(records).toHaveLength(cases.length * 2);
  records.forEach((record, i) => {
    const entry = cases[Math.floor(i / 2)]!;
    expectChemistry(record, entry);
    expectMolCoordinates(record, native(entry.id));
  });
});

it("decodes CTfile either codes only on double bonds", () => {
  for (const [name, from, to] of [["open.v2000.mol", "  2  3  2  3", "  2  3  1  4"],
    ["open.v3000.mol", "2 2 2 3 CFG=2", "2 1 2 3 CFG=2"]]) {
    const graph = parseMolfileGraph(read(name!).replace(from!, to!));
    expect(eitherIndices(graph.bonds)).toEqual([]);
  }
});

it("an open-only alkene writes CTfile either markers without asserting a chiral molecule", () => {
  const v2 = molfile(native("open"));
  const counts = v2.split("\n").find((line) => line.includes("V2000"))!;
  expect(Number(counts.slice(12, 15))).toBe(0);
  expect(v2).toContain("  2  3  2  3");
  const v3 = moleculeToMolfileV3000(native("open"), options).contents;
  expect(v3).toContain("M  V30 COUNTS 4 3 0 0 0");
  expect(v3).toContain("M  V30 2 2 2 3 CFG=2");
});

it("CDXML Wavy is order-sensitive and does not turn a single bond into an open double", () => {
  const source = read("open.cdxml").replace('Order="2"', 'Order="1" Display="Wavy"');
  const result = openChemDraftPayload(source);
  const mol = result.document!.pages[0]!.objects[0] as MoleculeObject;
  expect(eitherIndices(mol.bonds)).toEqual([]);
  expect(result.warnings.some((w) => w.code === "cdxml.bond_display_unsupported")).toBe(true);
});

it("SMILES-to-native is geometry-defined by default and explicitly opts into perceived open bonds", async () => {
  for (const smiles of ["CC=CC", "CC=O", "CC=C(C)C", "C1CC=CCC1", "C/C=C/C", "C/C=C\\C", "CC=CC/C=C/C"]) {
    const generated = await generateSmiles2DMolfile(smiles, { standardOnly: true });
    const depiction = pastedStructureDepictionFromMolfile(generated);
    const doc = createEmptyDocument({ now: "2026-10-27T00:00:00.000Z" });
    const defaultMol = createSmilesMolecule(doc, { x: 150, y: 150 }, depiction, smiles) as MoleculeObject;
    expect(eitherIndices(defaultMol.bonds)).toEqual([]);
    const opened = insertSmilesMolecule(doc, { x: 150, y: 150 }, depiction, smiles, { openUnspecifiedDoubleBonds: true });
    const molecule = opened.pages[0]!.objects[0] as MoleculeObject;
    expect(molecule.atoms).toEqual(defaultMol.atoms);
    const expectedOpen = smiles === "CC=CC" || smiles === "CC=CC/C=C/C" ? 1 : 0;
    expect(eitherIndices(molecule.bonds)).toHaveLength(expectedOpen);
    const perceived = await generateSmiles2DMolfile(smiles, { standardOnly: true, openUnspecifiedDoubleBonds: true });
    expect(eitherIndices(parseMolfileGraph(perceived).bonds)).toHaveLength(expectedOpen);
    expect(chemistry(molecule.structure).canonical).toBe(chemistry(smiles).canonical);
    if (smiles === "CC=CC") expect(chemistry(defaultMol.structure).canonical).toBe("C/C=C/C");
    const ocl = depictSmiles2D(smiles, { openUnspecifiedDoubleBonds: true });
    expect(eitherIndices(ocl.bonds)).toHaveLength(expectedOpen);
    expect(eitherIndices(depictSmiles2D(smiles).bonds)).toEqual([]);
  }
});

it("an explicit either remains unassigned after changing geometry that otherwise determines E/Z", () => {
  const mol = native("open");
  const changed = { ...mol, atoms: mol.atoms.map((atom, i) => i === 3
    ? { ...atom, x: mol.atoms[2]!.x, y: mol.atoms[2]!.y + 28 } : atom) };
  expectChemistry(molfile(changed), cases[0]!);
  expectMolCoordinates(molfile(changed), changed);
  expect(chemistry(molfile({ ...changed, bonds: changed.bonds.map(({ stereo: _stereo, ...b }) => b) })).canonical)
    .not.toBe(cases[0]!.canonical);
});

it.each(cases)("RDKit's opt-in SMILES perception preserves every stereo unit and atom index in $id", async (entry) => {
  const generated = await generateSmiles2DMolfile(read(`${entry.id}.smi`).trim(), {
    standardOnly: true, openUnspecifiedDoubleBonds: true
  });
  expectChemistry(generated, entry);
  const depiction = pastedStructureDepictionFromMolfile(generated);
  expect(eitherIndices(depiction.bonds)).toEqual(entry.eitherBondIndices);
  const built = createSmilesMolecule(createEmptyDocument(), { x: 150, y: 150 }, depiction,
    entry.smiles, undefined, { openUnspecifiedDoubleBonds: true }) as MoleculeObject;
  expectChemistry(built.structure, entry);
  expectMolCoordinates(built.structure, built);
});

it("label expansion and SMILES export retain open and specified stereo without trusting stale SMILES", async () => {
  const mol = native("mixed-diene");
  const expanded = expandNativeMoleculeLabelGroups({ ...mol, atoms: mol.atoms.map((a, i) => i === 0 ? { ...a, element: "Me" } : a) });
  expect(eitherIndices(expanded.molecule.bonds)).toEqual([1]);
  expect(chemistry(molfile(expanded.molecule))).toEqual(chemistry(molfile(mol)));
  const stale = { ...mol, structureFormat: "smiles" as const, structure: "C/C=C/CC/C=C/C" };
  const warnings: Parameters<typeof moleculeSmiles>[2] = [];
  expect(await moleculeSmiles(stale, 0, warnings, computeStructureIdentifiers)).toBe("CC=CC/C=C/C");
  const fallbackWarnings: Parameters<typeof moleculeSmiles>[2] = [];
  expect(await moleculeSmiles(stale, 0, fallbackWarnings, undefined)).toBe("CC=CCC=CC");
});

it("CLI reports explicit either double bonds as unspecified, preserving specified E and Z", async () => {
  expect(await perceiveDoubleBondStereo(read("open.v2000.mol"))).toEqual([{ bondIndex: 1, descriptor: "unspecified" }]);
  expect(await perceiveDoubleBondStereo(read("e.v2000.mol"))).toEqual([{ bondIndex: 1, descriptor: "E" }]);
  expect(await perceiveDoubleBondStereo(read("z.v2000.mol"))).toEqual([{ bondIndex: 1, descriptor: "Z" }]);
});
