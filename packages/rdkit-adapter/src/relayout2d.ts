import { parseV2000AtomBlock } from "@chemdraft/chemistry-adapter";
import { coordGenWithinSizeGuard, ensureRdkit, type RdkitJsMol, type RdkitMinimalModule } from "./conformer";
import type { RdkitJson } from "./composition";

/** Structural depiction contract, in the molfile's y-UP frame. No host or other engine imports. */
export interface RdkitDepiction2D {
  molfile: string;
  atoms: { element: string; isotope?: number; charge: number; x: number; y: number }[];
  bonds: { from: number; to: number; order: "single" | "double" | "triple" | "aromatic" | "unknown";
    stereo?: "either"; wedge: "wedge" | "hashed" | null }[];
}

export class RdkitRelayoutIdentityError extends Error {
  constructor(reason: string) {
    super(`RDKit 2D re-layout refused: ${reason}`);
    this.name = "RdkitRelayoutIdentityError";
  }
}

const parseOptions = JSON.stringify({ removeHs: false });
const pairKey = (a: number, b: number) => a < b ? `${a}:${b}` : `${b}:${a}`;

function atomIdentity(molecule: RdkitJsMol) {
  if (!molecule.get_json) throw new Error("RDKit 2D re-layout requires atom identity information.");
  const json = JSON.parse(molecule.get_json()) as RdkitJson;
  return json.molecules.flatMap(mol => mol.atoms.map(atom => ({
    element: atom.z ?? json.defaults?.atom?.z ?? 6,
    charge: atom.chg ?? json.defaults?.atom?.chg ?? 0,
    isotope: atom.isotope ?? json.defaults?.atom?.isotope ?? 0,
    radicals: atom.nRad ?? json.defaults?.atom?.nRad ?? 0
  })));
}

function molfileBonds(molfile: string, atomCount: number) {
  const lines = molfile.split(/\r?\n/);
  const count = Number.parseInt(lines[3]?.slice(3, 6), 10);
  if (!Number.isInteger(count) || count < 0) throw new Error("RDKit 2D re-layout requires a valid V2000 bond block.");
  return Array.from({ length: count }, (_, i) => {
    const line = lines[4 + atomCount + i] ?? "";
    const from = Number.parseInt(line.slice(0, 3), 10) - 1;
    const to = Number.parseInt(line.slice(3, 6), 10) - 1;
    const type = Number.parseInt(line.slice(6, 9), 10);
    const stereo = Number.parseInt(line.slice(9, 12), 10);
    if (!Number.isInteger(from) || !Number.isInteger(to) || from < 0 || to < 0 || from >= atomCount || to >= atomCount) {
      throw new Error("RDKit 2D re-layout returned an invalid bond endpoint.");
    }
    return { from, to, type, stereo };
  });
}

/** Identity-preserving alternate to a host's primary layout. RDKit preserves molfile atom order;
 * verify the serialized elements, per-index charge/isotope/radical identity, connectivity and
 * canonical isomeric SMILES as well. Explicit input H atoms are never removed or invented. */
export function relayoutMolfile2DWithRdkit(
  molfile: string, rdkit: RdkitMinimalModule, useCoordGen = true
): RdkitDepiction2D {
  const inputAtoms = parseV2000AtomBlock(molfile);
  if (!inputAtoms || !/V2000/.test(molfile.split(/\r?\n/)[3] ?? "")) {
    throw new Error("RDKit 2D re-layout requires a V2000 molfile.");
  }
  const inputBonds = molfileBonds(molfile, inputAtoms.length);
  const either = new Set(inputBonds.filter(b => b.type === 2 && b.stereo === 3).map(b => pairKey(b.from, b.to)));
  const source = rdkit.get_mol(molfile, parseOptions);
  if (!source) throw new Error("RDKit could not parse the structure for 2D re-layout.");
  try {
    if (!source.get_smiles || !source.set_new_coords || !source.get_molblock) {
      throw new Error("The bundled RDKit engine does not expose identity-checked 2D re-layout.");
    }
    const before = atomIdentity(source);
    if (before.length !== inputAtoms.length) throw new RdkitRelayoutIdentityError("parsing changed the atom count.");
    const identityBefore = source.get_smiles();
    if (useCoordGen && !coordGenWithinSizeGuard(source)) throw new Error("RDKit CoordGen skipped: structure exceeds the size guard.");
    if (!source.set_new_coords(useCoordGen)) throw new Error("RDKit could not generate 2D coordinates for the structure.");
    let output = source.get_molblock();
    const atoms = parseV2000AtomBlock(output);
    if (!atoms || atoms.length !== inputAtoms.length) throw new RdkitRelayoutIdentityError("coordinate generation changed the atom count.");
    const bonds = molfileBonds(output, atoms.length);
    const connectivity = (bs: typeof bonds) => bs.map(b => pairKey(b.from, b.to)).sort().join("|");
    if (connectivity(bonds) !== connectivity(inputBonds)) throw new RdkitRelayoutIdentityError("coordinate generation changed atom connectivity/order.");
    const lines = output.split(/\r?\n/);
    bonds.forEach((bond, i) => {
      if (!either.has(pairKey(bond.from, bond.to))) return;
      if (bond.type !== 2) throw new RdkitRelayoutIdentityError("an open double bond changed order.");
      bond.stereo = 3;
      const index = 4 + atoms.length + i;
      lines[index] = `${lines[index].slice(0, 9)}  3${lines[index].slice(12)}`;
    });
    output = lines.join("\n");
    const readBack = rdkit.get_mol(output, parseOptions);
    if (!readBack) throw new RdkitRelayoutIdentityError("the generated molfile could not be read back.");
    try {
      const after = atomIdentity(readBack);
      const element = (symbol: string) => symbol === "D" || symbol === "T" ? "H" : symbol;
      if (atoms.some((atom, i) => element(atom.element) !== element(inputAtoms[i].element)) ||
          JSON.stringify(before) !== JSON.stringify(after)) {
        throw new RdkitRelayoutIdentityError("atom count, elements, charges, isotopes or atom order changed.");
      }
      if (identityBefore !== readBack.get_smiles?.()) throw new RdkitRelayoutIdentityError("canonical isomeric SMILES changed.");
      return {
        molfile: output,
        // No y reflection here: both adapters return the molfile's y-UP coordinates. The host
        // negates y once on placement, keeping wedges anchored at their original narrow endpoint.
        atoms: atoms.map((atom, i) => ({ element: atom.element, x: atom.x, y: atom.y,
          charge: after[i].charge, ...(after[i].isotope ? { isotope: after[i].isotope } : {}) })),
        bonds: bonds.map(bond => ({ from: bond.from, to: bond.to,
          order: bond.type === 1 ? "single" : bond.type === 2 ? "double" : bond.type === 3 ? "triple" : bond.type === 4 ? "aromatic" : "unknown",
          ...(bond.type === 2 && bond.stereo === 3 ? { stereo: "either" as const } : {}),
          wedge: bond.type === 1 && bond.stereo === 1 ? "wedge" : bond.type === 1 && bond.stereo === 6 ? "hashed" : null }))
      };
    } finally { readBack.delete(); }
  } finally { source.delete(); }
}

/** Load only after the primary fails its quality gate. Each call parses a fresh input: the
 * default depictor never inherits CoordGen's coordinates or any failed candidate's state. */
export async function createRdkit2DRelayouts(): Promise<readonly ((molfile: string) => RdkitDepiction2D)[]> {
  const rdkit = await ensureRdkit();
  return [molfile => relayoutMolfile2DWithRdkit(molfile, rdkit, true),
    molfile => relayoutMolfile2DWithRdkit(molfile, rdkit, false)];
}
