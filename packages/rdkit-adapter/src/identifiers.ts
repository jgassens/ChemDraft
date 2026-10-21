/**
 * Structure identifiers for Copy As: canonical SMILES, InChI, and InChI Key, straight from the
 * engine. Export verification optionally reparses the returned SMILES; every value is RDKit's
 * own (never re-derived here), per the
 * one-interpretation-engine rule in AGENTS.md §8 Analysis and prediction claims.
 */
import { ensureRdkit, type RdkitMinimalModule } from "./conformer";
import { elementSymbol, type RdkitJson } from "./composition";

export interface StructureIdentifiers {
  smiles?: string;
  inchi?: string;
  inchiKey?: string;
  /** Reparsed states in SMILES output order; empty when requested but unverified. */
  smilesAtomStates?: SmilesAtomState[];
  /** Output index → input CTAB index, supplied by RDKit's SMILES writer. */
  smilesAtomOrder?: number[];
}

interface IdentifierCapableMol {
  get_smiles?(): string;
  get_inchi?(): string;
  get_json?(): string;
  get_prop?(name: string): string;
  delete(): void;
}

interface IdentifierCapableModule extends RdkitMinimalModule {
  get_inchikey_for_inchi?(inchi: string): string;
}

/**
 * Parse a molblock and read the identifiers the loaded engine build supports. Returns undefined
 * when the engine cannot parse the structure at all; individual fields are absent when the
 * artifact lacks the binding (probed by value, not presence — an old artifact simply omits them).
 */
export async function computeStructureIdentifiers(
  molblock: string,
  options: { includeAtomStates?: boolean } = {}
): Promise<StructureIdentifiers | undefined> {
  const module = (await ensureRdkit()) as IdentifierCapableModule;
  const molecule = (options.includeAtomStates
    ? module.get_mol(molblock, JSON.stringify({ removeHs: false }))
    : module.get_mol(molblock)) as IdentifierCapableMol | null;
  if (!molecule) {
    return undefined;
  }

  try {
    const identifiers: StructureIdentifiers = {};
    if (typeof molecule.get_smiles === "function") {
      const smiles = molecule.get_smiles();
      if (smiles) {
        identifiers.smiles = smiles;
        if (options.includeAtomStates) {
          // Distinguish failed verification from identifier-only callers without a parser.
          identifiers.smilesAtomStates = [];
          try {
            // get_smiles sets this property to the exact traversal it just emitted. Retaining
            // explicit H above keeps these indices aligned with the input CTAB atom block.
            const value = molecule.get_prop?.("_smilesAtomOutputOrder");
            const order: unknown = value ? JSON.parse(value) : undefined;
            const states = await computeSmilesAtomStates(smiles);
            if (states && Array.isArray(order) && order.length === states.length &&
                order.every((index: unknown) => Number.isInteger(index) && Number(index) >= 0) &&
                new Set(order).size === order.length) {
              identifiers.smilesAtomStates = states;
              identifiers.smilesAtomOrder = order as number[];
            }
          } catch {
            // Keep the SMILES, but leave explicit evidence that its atom states are unverified.
          }
        }
      }
    }
    if (typeof molecule.get_inchi === "function") {
      const inchi = molecule.get_inchi();
      if (inchi) {
        identifiers.inchi = inchi;
        if (typeof module.get_inchikey_for_inchi === "function") {
          const inchiKey = module.get_inchikey_for_inchi(inchi);
          if (inchiKey) {
            identifiers.inchiKey = inchiKey;
          }
        }
      }
    }
    return identifiers;
  } finally {
    molecule.delete();
  }
}

/** RDKit's sanitized state; hydrogenCount includes bracket/implicit H and bonded H atoms. */
export interface SmilesAtomState {
  element: string;
  formalCharge: number;
  isotope: number;
  nRad: number;
  hydrogenCount: number;
}

/**
 * Read atoms in SMILES token order without canonicalizing or removing explicit hydrogen atoms.
 * Uses the registered, cached engine; importing this module does not initialize RDKit.
 * An absent/empty JSON binding is an unavailable capability, never a zero-valued atom state.
 */
export async function computeSmilesAtomStates(smiles: string): Promise<SmilesAtomState[] | undefined> {
  const module = await ensureRdkit();
  const molecule = module.get_mol(smiles, JSON.stringify({ removeHs: false })) as IdentifierCapableMol | null;
  if (!molecule) return undefined;
  try {
    if (typeof molecule.get_json !== "function") return undefined;
    const value = molecule.get_json();
    if (!value) return undefined;
    const json = JSON.parse(value) as RdkitJson;
    const graph = json.molecules?.[0];
    const defaults = json.defaults?.atom;
    // Required CommonChem defaults, not a parallel set of chemistry defaults.
    if (!graph || !defaults || ["z", "chg", "isotope", "nRad", "impHs"].some(
      (key) => !Number.isInteger(defaults[key as keyof typeof defaults])
    )) return undefined;
    const atoms = graph.atoms.map((atom) => ({ ...defaults, ...atom }));
    const bondedHydrogens = new Array<number>(atoms.length).fill(0);
    for (const { atoms: [a, b] } of graph.bonds ?? []) {
      if (atoms[b]?.z === 1) bondedHydrogens[a]! += 1;
      if (atoms[a]?.z === 1) bondedHydrogens[b]! += 1;
    }
    return atoms.map((atom, index) => ({
      element: elementSymbol(atom.z!), formalCharge: atom.chg!, isotope: atom.isotope!,
      nRad: atom.nRad!, hydrogenCount: atom.impHs! + bondedHydrogens[index]!
    }));
  } finally {
    molecule.delete();
  }
}
