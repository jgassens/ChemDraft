import { type MoleculeObject } from "@chemdraft/chem-core";
import type { ExportWarning } from "@chemdraft/export-engine";

import { moleculeSmiles } from "./moleculeSmiles";

export type StructureNameKind = "preferredIupacName" | "systematicName";

export type StructureNameDeclineCode =
  | "noVerifiedName"
  | "notFullyVerified"
  | "unsupportedElement"
  | "unnameable"
  | "engineLimit"
  | "structureNotExact"
  | "tooLarge";

export type StructureNameWarningCode = "stereoLimitedEvidence" | "abbreviationExpanded";

export interface OrthonymRawResult {
  name: string | null;
  tier: string;
  isPin: boolean;
  opsin: string;
  gateOutcome: string;
  limitCode: string | null;
  stereoUnexpressed: boolean;
  source: string;
}

/** All chemistry services are supplied by the desktop (or, later, a headless caller). */
export interface StructureNameDeps {
  /**
   * Returns canonical isomeric SMILES for either the molfile produced from a drawing or SMILES
   * read back from a name. A null result means the structure could not be canonicalised.
   */
  canonicalize: (structure: string) => Promise<string | null>;
  name: (canonicalSmiles: string) => Promise<OrthonymRawResult>;
  readName: (name: string) => Promise<{ smiles: string | null; failureReason?: string }>;
}

export type StructureNameOutcome =
  | {
    status: "named";
    name: string;
    kind: StructureNameKind;
    warnings: readonly { code: StructureNameWarningCode; message: string }[];
  }
  | {
    status: "declined";
    code: StructureNameDeclineCode;
    reason: string;
    limitCode?: string;
  };

const approximationWarningCodes = new Set([
  "export.smiles_dative_bond",
  "export.smiles_bond_order",
  "export.smiles_atom_label"
]);

const controlCharacter = /[\u0000-\u001f\u007f-\u009f]/;

/** Applies the metadata gates independently of the naming engine. */
export function acceptOrthonymResult(raw: OrthonymRawResult):
  | { ok: true; kind: StructureNameKind }
  | { ok: false; code: StructureNameDeclineCode; limitCode?: string; reason: string } {
  if (raw.tier === "abstain") {
    const code = limitDeclineCode(raw.limitCode);
    return {
      ok: false,
      code,
      ...(raw.limitCode ? { limitCode: raw.limitCode } : {}),
      reason: raw.limitCode
        ? `The naming engine declined this structure (${raw.limitCode}).`
        : "The naming engine declined this structure."
    };
  }

  const kind = raw.tier === "pin_verified"
    ? "preferredIupacName"
    : raw.tier === "systematic_verified"
      ? "systematicName"
      : undefined;
  if (!kind) return notFullyVerified("The naming engine did not return a fully verified name.");
  if (raw.opsin !== "verified") return notFullyVerified("The naming engine did not verify the name with OPSIN.");
  if (raw.gateOutcome.startsWith("carveout:")) return notFullyVerified("The naming engine accepted the name through a carveout.");
  if (raw.stereoUnexpressed) return notFullyVerified("The naming engine could not express all stereochemistry.");
  if (!raw.name || !raw.name.trim() || controlCharacter.test(raw.name)) {
    return notFullyVerified("The naming engine did not return a usable verified name.");
  }
  return { ok: true, kind };
}

/** Reads a produced name back and compares canonical isomeric SMILES, never InChIKeys. */
export async function verifyNameRoundTrip(input: {
  drawnCanonicalSmiles: string;
  name: string;
  readName: (name: string) => Promise<{ smiles: string | null; failureReason?: string }>;
  canonicalize: (smiles: string) => Promise<string | null>;
}): Promise<{ verified: true } | { verified: false; reason: string }> {
  let read;
  try {
    read = await input.readName(input.name);
  } catch {
    return { verified: false, reason: "No verified name: the name could not be read back." };
  }
  if (!read.smiles) {
    return {
      verified: false,
      reason: read.failureReason ?? "No verified name: the name could not be read back."
    };
  }

  let canonicalReadBack: string | null;
  try {
    canonicalReadBack = await input.canonicalize(read.smiles);
  } catch {
    canonicalReadBack = null;
  }
  if (canonicalReadBack !== input.drawnCanonicalSmiles) {
    return { verified: false, reason: "No verified name: the name did not read back as exactly this structure." };
  }
  return { verified: true };
}

/**
 * Names one drawn molecule only after the host canonicaliser proves that both directions preserve
 * its exact structure. `moleculeSmiles` supplies the same loss warnings used by SMILES export.
 */
export async function nameStructure(deps: StructureNameDeps, molecule: MoleculeObject): Promise<StructureNameOutcome> {
  if (molecule.atoms.filter((atom) => !["H", "D", "T"].includes(atom.element)).length > 500) {
    return decline("tooLarge", "The structure exceeds the 500-heavy-atom naming limit.");
  }

  const exportWarnings: ExportWarning[] = [];
  let canonicalizationFailed = false;
  let drawnCanonicalSmiles: string;
  try {
    drawnCanonicalSmiles = await moleculeSmiles(
      molecule,
      0,
      exportWarnings,
      async (structure) => {
        try {
          const smiles = await deps.canonicalize(structure);
          if (!smiles) canonicalizationFailed = true;
          return smiles ? { smiles } : undefined;
        } catch {
          canonicalizationFailed = true;
          return undefined;
        }
      }
    );
  } catch {
    return decline("structureNotExact", "The drawing could not be written as exact SMILES.");
  }

  if (approximationWarnings(exportWarnings)) {
    return decline("structureNotExact", "The drawing cannot be represented exactly as SMILES.");
  }
  if (canonicalizationFailed) {
    return decline("structureNotExact", "The drawing could not be canonicalized as exact SMILES.");
  }
  if (drawnCanonicalSmiles.length > 5_000) {
    return decline("tooLarge", "The structure exceeds the 5000-character naming limit.");
  }

  let raw: OrthonymRawResult;
  try {
    raw = await deps.name(drawnCanonicalSmiles);
  } catch {
    return decline("notFullyVerified", "The naming engine did not return a fully verified name.");
  }
  const accepted = acceptOrthonymResult(raw);
  if (!accepted.ok) return decline(accepted.code, accepted.reason, accepted.limitCode);

  const roundTrip = await verifyNameRoundTrip({
    drawnCanonicalSmiles,
    name: raw.name!,
    readName: deps.readName,
    canonicalize: deps.canonicalize
  });
  if (!roundTrip.verified) return decline("noVerifiedName", roundTrip.reason);

  const warnings: { code: StructureNameWarningCode; message: string }[] = [];
  if (exportWarnings.some((warning) => warning.code === "export.smiles_abbreviation_expanded")) {
    warnings.push({
      code: "abbreviationExpanded",
      message: "An abbreviation was expanded to name the exact structure."
    });
  }
  // Canonical isomeric SMILES spells tetrahedral and double-bond stereo with @, /, or \\.
  if (/[@/\\]/.test(drawnCanonicalSmiles)) {
    warnings.push({
      code: "stereoLimitedEvidence",
      message: "Stereochemical naming has limited validation evidence."
    });
  }
  return { status: "named", name: raw.name!, kind: accepted.kind, warnings };
}

function approximationWarnings(warnings: readonly ExportWarning[]): boolean {
  return warnings.some((warning) => approximationWarningCodes.has(warning.code));
}

function limitDeclineCode(limitCode: string | null): Extract<StructureNameDeclineCode, "unsupportedElement" | "unnameable" | "engineLimit"> {
  switch (limitCode?.toUpperCase()) {
    case "UNSUPPORTED_ELEMENT": return "unsupportedElement";
    case "UNNAMEABLE": return "unnameable";
    default: return "engineLimit";
  }
}

function notFullyVerified(reason: string): { ok: false; code: "notFullyVerified"; reason: string } {
  return { ok: false, code: "notFullyVerified", reason };
}

function decline(code: StructureNameDeclineCode, reason: string, limitCode?: string): StructureNameOutcome {
  return { status: "declined", code, reason, ...(limitCode ? { limitCode } : {}) };
}
