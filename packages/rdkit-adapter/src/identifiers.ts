/**
 * Structure identifiers for Copy As: canonical SMILES, InChI, and InChI Key, straight from the
 * engine. One parse per request; every value is RDKit's own (never re-derived here), per the
 * one-interpretation-engine rule in AGENTS.md §8.
 */
import { ensureRdkit, type RdkitMinimalModule } from "./conformer";

export interface StructureIdentifiers {
  smiles?: string;
  inchi?: string;
  inchiKey?: string;
}

interface IdentifierCapableMol {
  get_smiles?(): string;
  get_inchi?(): string;
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
export async function computeStructureIdentifiers(molblock: string): Promise<StructureIdentifiers | undefined> {
  const module = (await ensureRdkit()) as IdentifierCapableModule;
  const molecule = module.get_mol(molblock) as IdentifierCapableMol | null;
  if (!molecule) {
    return undefined;
  }

  try {
    const identifiers: StructureIdentifiers = {};
    if (typeof molecule.get_smiles === "function") {
      const smiles = molecule.get_smiles();
      if (smiles) {
        identifiers.smiles = smiles;
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
