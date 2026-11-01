import { elementSymbolForAtomicNumber } from "@chemdraft/chem-core";
import { Plugin3DModelSchema, type Plugin3DModel } from "@chemdraft/plugin-api";
import type { RdkitJsMol, RdkitJson } from "@chemdraft/rdkit-adapter";

/** Read RDKit's sanitized graph, never infer valence, hydrogens or aromaticity here. */
export function readGraph(mol: RdkitJsMol): RdkitJson {
  const jsonMol = mol as RdkitJsMol & { get_json(): string };
  return JSON.parse(jsonMol.get_json()) as RdkitJson;
}

export function appendComponent(model: Plugin3DModel, mol: RdkitJsMol, smiles: string, coords: number[], added: number[]): void {
  const json = readGraph(mol);
  const graph = json.molecules[0];
  if (!graph || json.molecules.length !== 1) throw new Error("3D embedding returned an invalid molecular graph.");
  const defaults = json.defaults?.atom ?? {};
  const start = model.atoms.length;
  const component = model.components.length;
  const generated = new Set(added);
  graph.atoms.forEach((atom, i) => {
    const element = elementSymbolForAtomicNumber(atom.z ?? defaults.z ?? 6);
    if (!element) throw new Error(`Component ${component + 1}: 3D chemistry cannot represent a query or dummy atom.`);
    const isotope = atom.isotope ?? defaults.isotope ?? 0;
    const radical = atom.nRad ?? defaults.nRad ?? 0;
    model.atoms.push({ element, charge: atom.chg ?? defaults.chg ?? 0, component, addedHydrogen: generated.has(i),
      ...(isotope ? { isotope } : {}), ...(radical ? { radical } : {}) });
  });
  graph.bonds.forEach(bond => {
    const order = bond.bo ?? json.defaults?.bond?.bo ?? 1;
    if (order !== 1 && order !== 2 && order !== 3 && order !== 1.5) {
      throw new Error(`Component ${component + 1}: 3D chemistry cannot preserve bond order ${order}.`);
    }
    model.bonds.push({ a: start + bond.atoms[0], b: start + bond.atoms[1], order: order === 1.5 ? "aromatic" : order });
  });
  if (coords.length !== graph.atoms.length * 3 || !coords.every(Number.isFinite)) {
    throw new Error(`Component ${component + 1}: RDKit returned invalid 3D coordinates.`);
  }
  model.coords.push(...coords);
  model.components.push({ smiles, atomStart: start, atomCount: graph.atoms.length });
  Plugin3DModelSchema.parse(model);
}

/** A graph/coordinate serializer, not a depiction. V3000 avoids the explicit-H V2000 count limit.
 * Bond stereo is derived from the actual 3D geometry by RDKit, then checked on flatten read-back. */
export function modelMolblock(model: Plugin3DModel, componentIndex?: number): string {
  const component = componentIndex === undefined ? undefined : model.components[componentIndex];
  const start = component?.atomStart ?? 0;
  const count = component?.atomCount ?? model.atoms.length;
  const atoms = model.atoms.slice(start, start + count);
  const bonds = model.bonds.filter(bond => bond.a >= start && bond.a < start + count && bond.b >= start && bond.b < start + count);
  return ["ChemDraft plugin 3D", "     RDKit          3D", "", "  0  0  0     0  0            999 V3000",
    "M  V30 BEGIN CTAB", `M  V30 COUNTS ${atoms.length} ${bonds.length} 0 0 0`, "M  V30 BEGIN ATOM",
    ...atoms.map((atom, i) => {
      const n = (start + i) * 3;
      // V3000 RAD uses MDL spin multiplicity; unsupported radical counts are refused.
      if (atom.radical && atom.radical > 2) throw new Error("3D chemistry cannot preserve more than two radical electrons on an atom.");
      return `M  V30 ${i + 1} ${atom.element} ${model.coords[n]} ${model.coords[n + 1]} ${model.coords[n + 2]} 0` +
        (atom.charge ? ` CHG=${atom.charge}` : "") + (atom.isotope ? ` MASS=${atom.isotope}` : "") +
        (atom.radical ? ` RAD=${atom.radical === 1 ? 2 : 3}` : "");
    }),
    "M  V30 END ATOM", "M  V30 BEGIN BOND",
    ...bonds.map((bond, i) => `M  V30 ${i + 1} ${bond.order === "aromatic" ? 4 : bond.order} ${bond.a - start + 1} ${bond.b - start + 1}`),
    "M  V30 END BOND", "M  V30 END CTAB", "M  END"].join("\n");
}

export const INTER_COMPONENT_CLASH_A = 2.2;

/** Pure TS: run after token validation on the host, before worker startup/queueing,
 * and again at the worker boundary for direct internal callers. */
export function assertFlattenContacts(model: Plugin3DModel): void {
  const contact = closestHeavyContactPair(model);
  if (contact && contact.distance < INTER_COMPONENT_CLASH_A) {
    throw new Error(`flatten3d refused a clashing model: closest inter-component heavy-atom contact is ${heavyContactDescription(model, contact)}; below 2.2 A. Retry with another arrangement.`);
  }
}

export function closestHeavyContactPair(model: Plugin3DModel): { distance: number; a: number; b: number } | undefined {
  let closest = Infinity;
  let pair: { distance: number; a: number; b: number } | undefined;
  model.atoms.forEach((a, i) => {
    if (a.element === "H") return;
    for (let j = i + 1; j < model.atoms.length; j++) {
      const b = model.atoms[j];
      if (b.element === "H" || a.component === b.component) continue;
      const distance = Math.hypot(model.coords[i * 3] - model.coords[j * 3],
        model.coords[i * 3 + 1] - model.coords[j * 3 + 1], model.coords[i * 3 + 2] - model.coords[j * 3 + 2]);
      if (distance < closest) { closest = distance; pair = { distance, a: i, b: j }; }
    }
  });
  return pair;
}

/** Global model atom indices and component numbers in messages are one-based. */
export function heavyContactDescription(model: Plugin3DModel, pair: { distance: number; a: number; b: number }): string {
  const atom = (i: number) => `${model.atoms[i].element} atom ${i + 1} (component ${model.atoms[i].component + 1})`;
  return `${pair.distance.toFixed(3)} A between ${atom(pair.a)} and ${atom(pair.b)}`;
}

export function closestHeavyContact(model: Plugin3DModel): number | undefined {
  return closestHeavyContactPair(model)?.distance;
}
