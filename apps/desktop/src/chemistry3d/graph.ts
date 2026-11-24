import { atomicNumberForElementSymbol, elementSymbolForAtomicNumber } from "@chemdraft/chem-core";
import { PluginHandoffStructureGraphSchema, type Plugin3DModel, type PluginHandoffStructureGraph } from "@chemdraft/plugin-api";
import type { RdkitJsMol, RdkitMinimalModule } from "@chemdraft/rdkit-adapter";
import { aromaticBondIndices, readGraph } from "./model";

export function canonicalGraphSmiles(mol: RdkitJsMol): string {
  const smiles = mol.get_smiles?.();
  if (!smiles) throw new Error("RDKit could not return canonical isomeric SMILES for the graph.");
  return smiles;
}

export function readHandoffStructure(mol: RdkitJsMol): PluginHandoffStructureGraph {
  const json = readGraph(mol);
  const source = json.molecules[0];
  if (!source || json.molecules.length !== 1) throw new Error("RDKit returned no single structure graph.");
  const aromatic = aromaticBondIndices(source);
  const defaults = json.defaults?.atom;
  return PluginHandoffStructureGraphSchema.parse({
    atoms: source.atoms.map((atom, index) => {
      const number = atom.z ?? defaults?.z ?? 6;
      const element = number === 0 ? "*" : elementSymbolForAtomicNumber(number);
      if (!element) throw new Error(`RDKit returned unknown atomic number ${number} at atom ${index + 1}.`);
      const isotope = atom.isotope ?? defaults?.isotope ?? 0;
      return { element, charge: atom.chg ?? defaults?.chg ?? 0, hydrogenCount: atom.impHs ?? defaults?.impHs ?? 0,
        radicalElectrons: atom.nRad ?? defaults?.nRad ?? 0, ...(isotope ? { isotope } : {}),
        ...(atom.stereo === "cw" || atom.stereo === "ccw" ? { stereo: atom.stereo } : {}) };
    }),
    bonds: source.bonds.map((bond, index) => {
      const order = bond.bo ?? json.defaults?.bond?.bo ?? 1;
      if (order !== 1 && order !== 2 && order !== 3) {
        throw new Error(`RDKit returned unsupported order ${order} for bond ${index + 1}.`);
      }
      return { a: bond.atoms[0], b: bond.atoms[1],
        ...(aromatic.has(index) ? { order: "aromatic", kekuleOrder: order } : { order }),
        ...(bond.stereo && bond.stereo !== "unspecified" ? { stereo: bond.stereo } : {}),
        ...(bond.stereo === "cis" || bond.stereo === "trans" ? { stereoAtoms: bond.stereoAtoms } : {}) };
    })
  });
}

/** CommonChem preserves input order, stereo parity and H counts. RDKit sanitizes and assigns
 * aromaticity from the Kekulé orders. Its JSON reader needs assignStereo:false to retain
 * cis/trans reference atoms when there are no coordinates or directional single bonds. */
export function moleculeFromHandoffStructure(rdkit: RdkitMinimalModule, graph: PluginHandoffStructureGraph, context: string): RdkitJsMol {
  const atoms = graph.atoms.map(({ element, charge, isotope, radicalElectrons, hydrogenCount, stereo }, index) => {
    const z = element === "*" ? 0 : atomicNumberForElementSymbol(element);
    if (z === undefined) throw new Error(`${context}: unknown element "${element}" at atom ${index + 1}.`);
    return { z, chg: charge, isotope: isotope ?? 0, nRad: radicalElectrons, impHs: hydrogenCount,
      ...(stereo ? { stereo } : {}) };
  });
  const bonds = graph.bonds.map(({ a, b, order, kekuleOrder, stereo, stereoAtoms }) => ({
    atoms: [a, b], bo: order === "aromatic" ? kekuleOrder : order,
    ...(stereo ? { stereo, stereoAtoms } : {})
  }));
  const input = { rdkitjson: { version: 12 }, defaults: {
    atom: { z: 6, chg: 0, isotope: 0, nRad: 0, impHs: 0, stereo: "unspecified" },
    bond: { bo: 1, stereo: "unspecified" }
  }, molecules: [{ atoms, bonds }] };
  const mol = rdkit.get_mol(JSON.stringify(input), JSON.stringify({ removeHs: false, assignStereo: false }));
  if (!mol) throw new Error(`${context}: RDKit could not sanitize the graph. Check bond orders, charges and hydrogen counts.`);
  try {
    const actual = readHandoffStructure(mol);
    if (actual.atoms.length !== graph.atoms.length || actual.bonds.length !== graph.bonds.length) {
      throw new Error(`${context}: RDKit changed the graph's atom or bond count.`);
    }
    actual.atoms.forEach((atom, index) => {
      const expected = graph.atoms[index]!;
      if (atom.element !== expected.element || atom.charge !== expected.charge || atom.isotope !== expected.isotope ||
          atom.radicalElectrons !== expected.radicalElectrons || atom.hydrogenCount !== expected.hydrogenCount ||
          atom.stereo !== expected.stereo) {
        throw new Error(`${context}: RDKit changed the chemistry of atom ${index + 1} (${expected.element}).`);
      }
    });
    actual.bonds.forEach((bond, index) => {
      const expected = graph.bonds[index]!;
      if (bond.a !== expected.a || bond.b !== expected.b || bond.order !== expected.order ||
          bond.stereo !== expected.stereo || bond.stereoAtoms?.[0] !== expected.stereoAtoms?.[0] ||
          bond.stereoAtoms?.[1] !== expected.stereoAtoms?.[1]) {
        throw new Error(`${context}: RDKit changed the endpoints, order or stereo of bond ${index + 1}.`);
      }
    });
    return mol;
  } catch (error) {
    mol.delete();
    throw error;
  }
}

export function readSignedComponent(rdkit: RdkitMinimalModule, component: Plugin3DModel["components"][number]): RdkitJsMol {
  if (component.graph) return moleculeFromHandoffStructure(rdkit, component.graph, "Signed 3D component");
  const mol = rdkit.get_mol(component.smiles, JSON.stringify({ removeHs: false }));
  if (!mol) throw new Error("RDKit could not read the signed component SMILES.");
  return mol;
}
