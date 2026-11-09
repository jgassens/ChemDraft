import { describe, expect, it } from "vitest";
import * as OCL from "openchemlib";
import {
  createEmptyDocument, moleculeToMolfileV2000, readDocument, serializeDocument,
  snapshotChemicalIdentity, type MoleculeObject
} from "@chemdraft/chem-core";
import { depictSmiles2D } from "./index";

/** Test-only engine oracle: chem-core's reader itself never loads a chemistry engine. */
function chemistry(molecule: MoleculeObject) {
  const molfile = moleculeToMolfileV2000(molecule, { kekuleBondOrders: new Map() }).contents;
  const parsed = OCL.Molecule.fromMolfile(molfile);
  parsed.ensureHelperArrays(OCL.Molecule.cHelperParities);
  return {
    canonicalSmiles: parsed.toIsomericSmiles(),
    formula: parsed.getMolecularFormula().formula,
    charge: Array.from({ length: parsed.getAllAtoms() }, (_, index) => parsed.getAtomCharge(index)).reduce((a, b) => a + b, 0),
    atoms: parsed.getAllAtoms(), bonds: parsed.getAllBonds(),
    stereo: Array.from({ length: parsed.getAllAtoms() }, (_, index) => parsed.getAtomParity(index)),
    graph: snapshotChemicalIdentity(molecule).graph
  };
}

describe("native forward-read chemical identity (real OpenChemLib oracle)", () => {
  it.each(["C[C@H](O)C(=O)[O-]", "F/C=C/C[C@@H](Cl)Br", "CC[NH2+]CC"])("preserves canonical SMILES, formula, charge, stereo and counts for %s", (smiles) => {
    const depiction = depictSmiles2D(smiles);
    const molecule: MoleculeObject = {
      id: "m", type: "molecule", x: 0, y: 0, width: 100, height: 100, rotation: 0, style: {},
      structureFormat: "molfile-v2000", structure: depiction.molfile,
      atoms: depiction.atoms.map((atom, index) => ({ id: `a${index}`, element: atom.element, x: atom.x, y: atom.y, formalCharge: atom.charge })),
      bonds: depiction.bonds.map((bond, index) => ({ id: `b${index}`, fromAtomId: `a${bond.from}`, toAtomId: `a${bond.to}`,
        order: bond.order, ...(bond.stereo ? { stereo: bond.stereo } : {}),
        ...(bond.wedge ? { display: { bondStyle: bond.wedge } } : {}) })),
      superatoms: [], rGroups: []
    };
    const before = chemistry(molecule);
    const document = createEmptyDocument({ now: "2026-11-09T00:00:00.000Z" });
    document.pages[0]!.objects.push(molecule);
    const raw = JSON.parse(serializeDocument(document));
    raw.formatVersion = "1.3.0";
    raw.minAppVersion = "1.3.0";
    raw.pages[0].objects[0].visualDecoration = { color: "blue", layout: { placement: "beyond" } };
    // Put the visual fallback only on a bond that has no stereo marker.
    const cosmeticBond = raw.pages[0].objects[0].bonds.find((bond: { display?: unknown; order: string }) => !bond.display && bond.order === "single");
    expect(cosmeticBond).toBeDefined();
    cosmeticBond.display = { bondStyle: "future-wave" };
    const opened = readDocument(raw);
    expect(chemistry(opened.document.pages[0]!.objects[0] as MoleculeObject)).toEqual(before);
    const saved = JSON.parse(serializeDocument(opened.document));
    expect(saved).toEqual(raw);
    const reopened = readDocument(saved);
    expect(chemistry(reopened.document.pages[0]!.objects[0] as MoleculeObject)).toEqual(before);
  });
});
