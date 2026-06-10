/**
 * OpenChemLib 3D conformer adapter (Phase 2 — the v1 engine behind the spin tool).
 *
 * Implements the engine-neutral `ConformerGenerator3D` contract from
 * `@chemdraft/chemistry-adapter` using OpenChemLib's `ConformerGenerator` +
 * `ForceFieldMMFF94`. Designed to be **lazy-loaded** (`import("@chemdraft/ocl-adapter")`
 * on first spin) so OCL's ~2.3 MB (1.0 MB JS + 1.3 MB torsion resources) never
 * touches app startup.
 *
 * Atom-identity discipline (verified against the live engine):
 *   1. Parse the molfile -> an OCL `Molecule` (OCL perceives drawn wedge stereo).
 *   2. Tag every parsed atom with `setAtomMapNo(i, i+1)` BEFORE handoff.
 *   3. Copy the molecule (`copyMolecule`) — `getOneConformerAsMolecule` mutates its
 *      argument IN PLACE (saturates with H, writes 3D coords), so the conformer runs
 *      on the copy and the parsed reference is never disturbed.
 *   4. Generate the conformer, optionally MMFF94-minimise.
 *   5. Rebuild the original<->engine atom map via `getAtomMapNo` (generated H carry
 *      mapNo 0) and read `getAtomX/Y/Z` into `coords3dByOriginalAtom`.
 *
 * OCL `ConformerGenerator` requires static torsion resources to be registered once
 * before use (`Resources.register*`); `init()` handles this for Node and browser.
 */

import * as OCL from "openchemlib";
import type {
  ConformerGenerator3D,
  ConformerInput,
  Generate3DConformerOptions,
  Generate3DConformerResult,
  ChemistryWarning
} from "@chemdraft/chemistry-adapter";

let resourcesRegistered = false;
let resourcesUrlOverride: string | undefined;

/** OpenChemLib version string (from the package's own constant when present). */
function oclVersion(): string {
  const v = (OCL as unknown as { version?: string }).version;
  return typeof v === "string" ? v : "unknown";
}

/**
 * Browser/Tauri bundles MUST call this before the first conformer generation.
 * `registerFromUrl()` with no argument fetches `resources.json` relative to the
 * OCL module's URL — which, in a bundled Vite app, is a hashed chunk and 404s.
 * The Vite recipe (see the Phase 4 spec in docs/architecture/3d-spin-flatten.md):
 *
 *   import oclResourcesUrl from "openchemlib/dist/resources.json?url";
 *   setOclResourcesUrl(oclResourcesUrl);
 *
 * No-op concern in Node: the Node path reads the file from disk and ignores this.
 */
export function setOclResourcesUrl(url: string): void {
  resourcesUrlOverride = url;
}

/**
 * Register OCL's static torsion resources exactly once. In Node the bundled
 * `resources.json` is read synchronously from disk; in a browser/Tauri bundle the
 * URL set via `setOclResourcesUrl` is fetched (falling back to OCL's
 * module-relative default, which only works unbundled).
 */
export async function ensureOclResources(): Promise<void> {
  if (resourcesRegistered) return;
  const Resources = (OCL as unknown as {
    Resources?: {
      registerFromNodejs?: () => void;
      registerFromUrl?: (url?: string) => Promise<void>;
    };
  }).Resources;
  if (!Resources) {
    resourcesRegistered = true; // nothing to register in this build
    return;
  }
  const nodeVersion = (globalThis as { process?: { versions?: { node?: string } } }).process?.versions
    ?.node;
  const isNode = typeof nodeVersion === "string";
  if (isNode && Resources.registerFromNodejs) {
    Resources.registerFromNodejs();
  } else if (Resources.registerFromUrl) {
    await Resources.registerFromUrl(resourcesUrlOverride);
  }
  resourcesRegistered = true;
}

type OclMolecule = InstanceType<typeof OCL.Molecule>;

// ---------------------------------------------------------------------------
// 2D depiction utility (SMILES -> laid-out 2D structure with wedges + molfile)
// ---------------------------------------------------------------------------

export type DepictionBondOrder = "single" | "double" | "triple" | "aromatic" | "unknown";

export interface DepictionAtom2D {
  element: string;
  x: number;
  y: number;
  charge: number;
}

export interface DepictionBond2D {
  from: number;
  to: number;
  order: DepictionBondOrder;
  /** Drawn stereo at the bond's narrow end (`from`): wedge (up), hashed (down), or none. */
  wedge: "wedge" | "hashed" | null;
}

export interface Depiction2D {
  molfile: string;
  atoms: DepictionAtom2D[];
  bonds: DepictionBond2D[];
}

function depictionOrder(order: number): DepictionBondOrder {
  switch (order) {
    case 1:
      return "single";
    case 2:
      return "double";
    case 3:
      return "triple";
    default:
      return "single";
  }
}

/**
 * Lay out a SMILES into a 2D depiction with wedge/hash stereo bonds derived from
 * its parities, returning both a structured form (atom order preserved) and the
 * corresponding molfile. Atom indices in `bonds` and the molfile match the `atoms`
 * array, so coordinates returned by `generate3DConformer(molfile)` align 1:1.
 */
export function depictSmiles2D(smiles: string): Depiction2D {
  const mol: OclMolecule = OCL.Molecule.fromSmiles(smiles);
  mol.inventCoordinates();
  mol.ensureHelperArrays(OCL.Molecule.cHelperParities);

  const up = OCL.Molecule.cBondTypeUp;
  const down = OCL.Molecule.cBondTypeDown;

  const atoms: DepictionAtom2D[] = [];
  for (let i = 0; i < mol.getAllAtoms(); i++) {
    atoms.push({
      element: mol.getAtomLabel(i),
      x: mol.getAtomX(i),
      // OCL's 2D layout is screen-oriented (y grows DOWN); its molfile writer flips
      // y to the chemistry-standard y-up. We emit y-up too so the depiction's
      // perceived chirality matches the molfile / 3D conformer (verified via the
      // RDKit oracle — without this flip the wedge reads as the mirror enantiomer).
      y: -mol.getAtomY(i),
      charge: mol.getAtomCharge(i)
    });
  }

  const bonds: DepictionBond2D[] = [];
  for (let b = 0; b < mol.getAllBonds(); b++) {
    const type = mol.getBondType(b);
    bonds.push({
      from: mol.getBondAtom(0, b),
      to: mol.getBondAtom(1, b),
      order: depictionOrder(mol.getBondOrder(b)),
      wedge: type === up ? "wedge" : type === down ? "hashed" : null
    });
  }

  return { molfile: mol.toMolfile(), atoms, bonds };
}

function countExplicitHydrogens(mol: OclMolecule): number {
  let count = 0;
  for (let i = 0; i < mol.getAllAtoms(); i++) {
    if (mol.getAtomicNo(i) === 1) count += 1;
  }
  return count;
}

export const oclConformerGenerator: ConformerGenerator3D = {
  engineName: "openchemlib",
  canGenerate3DConformer: true,

  async init(): Promise<void> {
    await ensureOclResources();
  },

  async generate3DConformer(
    input: ConformerInput,
    options: Generate3DConformerOptions = {}
  ): Promise<Generate3DConformerResult> {
    await ensureOclResources();

    const warnings: ChemistryWarning[] = [];
    const unsupportedFeatures: ChemistryWarning[] = [];
    const seed = options.seed ?? 42;
    const optimize = options.optimize ?? "auto";

    const parsed: OclMolecule = OCL.Molecule.fromMolfile(input.molfile);
    const originalAtomCount = parsed.getAllAtoms();
    const explicitInputHydrogens = countExplicitHydrogens(parsed);

    if (typeof input.originalAtomCount === "number" && input.originalAtomCount !== originalAtomCount) {
      warnings.push({
        code: "ocl.atom-count-mismatch",
        message: `Parsed ${originalAtomCount} atoms but caller expected ${input.originalAtomCount}.`,
        severity: "warning"
      });
    }

    // Tag every original atom so it survives H-saturation and any reordering.
    for (let i = 0; i < originalAtomCount; i++) parsed.setAtomMapNo(i, i + 1, false);

    // Work on a copy — the conformer generator mutates its argument in place.
    const work: OclMolecule = new OCL.Molecule(0, 0);
    parsed.copyMolecule(work);

    const generator = new OCL.ConformerGenerator(seed);
    const conformer = generator.getOneConformerAsMolecule(work);

    if (!conformer) {
      return {
        mapping: {
          coords3dByOriginalAtom: new Float64Array(originalAtomCount * 3),
          originalToEngineAtom: new Array(originalAtomCount).fill(-1),
          engineToOriginalAtom: [],
          generatedHydrogenEngineAtoms: []
        },
        originalAtomCount,
        generatedAtomCount: 0,
        hydrogens: { added: false, explicitInputHydrogensPreserved: explicitInputHydrogens > 0 },
        engine: { name: "openchemlib", version: oclVersion(), parameters: { seed, optimize } },
        embed: { status: "failed", failureReason: "ConformerGenerator returned no collision-free conformer" },
        unsupportedFeatures,
        warnings
      };
    }

    // Optional force-field refinement.
    let forceField: Generate3DConformerResult["forceField"];
    if (optimize === "none") {
      forceField = { name: "none", status: "not-run" };
    } else {
      try {
        const ff = new OCL.ForceFieldMMFF94(conformer, OCL.ForceFieldMMFF94.MMFF94, {});
        const rc = ff.minimise();
        forceField = {
          name: "MMFF94",
          status: rc === 0 ? "converged" : "not-converged",
          returnCode: rc,
          energy: typeof ff.getTotalEnergy === "function" ? ff.getTotalEnergy() : undefined
        };
      } catch (error) {
        forceField = { name: "MMFF94", status: "setup-failed" };
        warnings.push({
          code: "ocl.forcefield-unavailable",
          message: `MMFF94 setup failed: ${(error as Error).message}`,
          severity: "warning"
        });
      }
    }

    // Rebuild the atom mapping from map numbers.
    const engineAtomCount = conformer.getAllAtoms();
    const coords3dByOriginalAtom = new Float64Array(originalAtomCount * 3);
    const originalToEngineAtom = new Array<number>(originalAtomCount).fill(-1);
    const engineToOriginalAtom = new Array<number>(engineAtomCount).fill(-1);
    const generatedHydrogenEngineAtoms: number[] = [];

    for (let engineIdx = 0; engineIdx < engineAtomCount; engineIdx++) {
      const mapNo = conformer.getAtomMapNo(engineIdx);
      if (mapNo > 0) {
        const originalIdx = mapNo - 1;
        originalToEngineAtom[originalIdx] = engineIdx;
        engineToOriginalAtom[engineIdx] = originalIdx;
        coords3dByOriginalAtom[originalIdx * 3] = conformer.getAtomX(engineIdx);
        coords3dByOriginalAtom[originalIdx * 3 + 1] = conformer.getAtomY(engineIdx);
        coords3dByOriginalAtom[originalIdx * 3 + 2] = conformer.getAtomZ(engineIdx);
      } else {
        generatedHydrogenEngineAtoms.push(engineIdx);
      }
    }

    const unmapped = originalToEngineAtom.filter((engineIdx) => engineIdx === -1).length;
    if (unmapped > 0) {
      warnings.push({
        code: "ocl.unmapped-original-atoms",
        message: `${unmapped} original atom(s) could not be located in the conformer by map number.`,
        severity: "error"
      });
    }

    return {
      mapping: {
        coords3dByOriginalAtom,
        originalToEngineAtom,
        engineToOriginalAtom,
        generatedHydrogenEngineAtoms
      },
      originalAtomCount,
      generatedAtomCount: generatedHydrogenEngineAtoms.length,
      hydrogens: {
        added: generatedHydrogenEngineAtoms.length > 0,
        explicitInputHydrogensPreserved: explicitInputHydrogens > 0
      },
      engine: { name: "openchemlib", version: oclVersion(), parameters: { seed, optimize } },
      embed: { status: "ok" },
      forceField,
      unsupportedFeatures,
      warnings
    };
  }
};
