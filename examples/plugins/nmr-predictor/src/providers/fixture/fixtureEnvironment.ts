import type * as OCL from "openchemlib";

/**
 * Deterministic atom-centered environment code via a breadth-first walk to `spheres` depth. Each
 * sphere contributes a sorted, bracketed list of newly-reached atom descriptors
 * (`<bondOrder><element><aromatic?><hCount>`). This is a *fixture signature*, not a validated HOSE
 * code — which is exactly why the prediction method is labeled "fixture-fragment". Two atoms with the
 * same code are treated as equivalent, so symmetric atoms collapse into one resonance.
 */

const ELEMENT_SYMBOLS: Readonly<Record<number, string>> = {
  1: "H",
  6: "C",
  7: "N",
  8: "O",
  9: "F",
  15: "P",
  16: "S",
  17: "Cl",
  35: "Br",
  53: "I"
};

/** Heteroatoms whose attached hydrogens are treated as labile/exchangeable for ¹H prediction. */
const LABILE_HYDROGEN_HOSTS = new Set([7, 8, 16]); // N, O, S

export function elementSymbol(atomicNumber: number): string {
  return ELEMENT_SYMBOLS[atomicNumber] ?? `Z${atomicNumber}`;
}

export interface AtomEnvironment {
  atomIndex: number;
  atomicNumber: number;
  element: string;
  aromatic: boolean;
  charge: number;
  hydrogenCount: number;
  environmentCode: string;
}

export function describeAtomEnvironment(molecule: OCL.Molecule, atom: number, spheres = 2): AtomEnvironment {
  const atomicNumber = molecule.getAtomicNo(atom);
  const aromatic = molecule.isAromaticAtom(atom);
  const charge = molecule.getAtomCharge(atom);
  const hydrogenCount = molecule.getAllHydrogens(atom);

  const visited = new Set<number>([atom]);
  let frontier = [atom];
  const sphereStrings: string[] = [];

  for (let depth = 1; depth <= spheres; depth += 1) {
    const nextFrontier: number[] = [];
    const descriptors: string[] = [];
    for (const current of frontier) {
      const connections = molecule.getConnAtoms(current);
      for (let index = 0; index < connections; index += 1) {
        const neighbor = molecule.getConnAtom(current, index);
        if (visited.has(neighbor)) {
          continue;
        }
        visited.add(neighbor);
        nextFrontier.push(neighbor);
        const bond = molecule.getConnBond(current, index);
        const order = molecule.isAromaticBond(bond) ? "~" : String(molecule.getConnBondOrder(current, index));
        const neighborAromatic = molecule.isAromaticAtom(neighbor) ? "a" : "";
        descriptors.push(
          `${order}${elementSymbol(molecule.getAtomicNo(neighbor))}${neighborAromatic}h${molecule.getAllHydrogens(neighbor)}`
        );
      }
    }
    descriptors.sort();
    sphereStrings.push(`(${descriptors.join(",")})`);
    frontier = nextFrontier;
  }

  const environmentCode = `${elementSymbol(atomicNumber)}${aromatic ? "a" : ""}q${charge}h${hydrogenCount}${sphereStrings.join("")}`;
  return { atomIndex: atom, atomicNumber, element: elementSymbol(atomicNumber), aromatic, charge, hydrogenCount, environmentCode };
}

/** Carbon atoms, in index order, each with its environment code — the ¹³C prediction targets. */
export function collectCarbonEnvironments(molecule: OCL.Molecule, spheres = 2): AtomEnvironment[] {
  const environments: AtomEnvironment[] = [];
  for (let atom = 0; atom < molecule.getAllAtoms(); atom += 1) {
    if (molecule.getAtomicNo(atom) === 6) {
      environments.push(describeAtomEnvironment(molecule, atom, spheres));
    }
  }
  return environments;
}

export interface ProtonEnvironment extends AtomEnvironment {
  /** Number of hydrogens on the host atom that this environment represents. */
  protonCount: number;
  /** Environment code namespaced for ¹H so it never collides with a ¹³C code. */
  protonCode: string;
  labile: boolean;
}

/**
 * Proton-bearing heavy atoms (protons are implicit in OCL), each yielding a ¹H environment keyed on
 * the host atom. Labile heteroatom protons (O/N/S–H) are flagged so the provider can omit them under
 * `ignoreLabileHydrogens`.
 */
export function collectProtonEnvironments(molecule: OCL.Molecule, spheres = 2): ProtonEnvironment[] {
  const environments: ProtonEnvironment[] = [];
  for (let atom = 0; atom < molecule.getAllAtoms(); atom += 1) {
    const protonCount = molecule.getAllHydrogens(atom);
    if (protonCount === 0) {
      continue;
    }
    const base = describeAtomEnvironment(molecule, atom, spheres);
    environments.push({
      ...base,
      protonCount,
      protonCode: `1H@${base.environmentCode}`,
      labile: LABILE_HYDROGEN_HOSTS.has(base.atomicNumber)
    });
  }
  return environments;
}
