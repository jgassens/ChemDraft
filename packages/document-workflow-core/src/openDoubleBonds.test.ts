// The purity boundary scans src imports as production dependencies.
import { describe, expect, it } from "../../../node_modules/vitest";
import { createEmptyDocument, type MoleculeObject } from "@chemdraft/chem-core";
import { parseMolfileGraph } from "@chemdraft/clipboard-adapter";
import { createSmilesMolecule, insertSmilesMolecule, pastedStructureDepictionFromMolfile } from "./molecule";

const source = `
  ChemDraft

  4  3  0  0  0  0  0  0  0  0999 V2000
    0.0000    0.0000    0.0000 C   0  0  0  0  0  0  0  0  0  0  0  0
    1.5000    1.0000    0.0000 C   0  0  0  0  0  0  0  0  0  0  0  0
    3.0000    0.0000    0.0000 C   0  0  0  0  0  0  0  0  0  0  0  0
    4.5000    1.0000    0.0000 C   0  0  0  0  0  0  0  0  0  0  0  0
  1  2  1  0  0  0  0
  2  3  2  3  0  0  0
  3  4  1  0  0  0  0
M  END`;

describe.each([undefined, false, true])("SMILES native/storage agreement (open: %s)", (openUnspecifiedDoubleBonds) => {
  it.each(["create", "insert"])("%s keeps explicit flags and CTfile markers together", (path) => {
    const document = createEmptyDocument();
    const depiction = pastedStructureDepictionFromMolfile(source);
    expect(depiction.bonds[1]!.stereo).toBe("either");
    const options = { openUnspecifiedDoubleBonds };
    const molecule = (path === "create"
      ? createSmilesMolecule(document, { x: 150, y: 150 }, depiction, "CC=CC", undefined, options)
      : insertSmilesMolecule(document, { x: 150, y: 150 }, depiction, "CC=CC", options).pages[0]!.objects[0]) as MoleculeObject;
    const expected = openUnspecifiedDoubleBonds ? "either" : undefined;
    expect(molecule.bonds.map((bond) => bond.stereo)).toEqual([undefined, expected, undefined]);
    expect(parseMolfileGraph(molecule.structure).bonds.map((bond) => bond.stereo)).toEqual([undefined, expected, undefined]);
    expect(molecule.structure).toContain(`  2  3  2  ${openUnspecifiedDoubleBonds ? 3 : 0}`);
  });
});
