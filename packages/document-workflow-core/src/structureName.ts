import { type MoleculeObject } from "@chemdraft/chem-core";
import type { ExportWarning } from "@chemdraft/export-engine";

import { moleculeSmiles, type ComputeStructureIdentifiers } from "./moleculeSmiles";

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
   * Returns canonical isomeric SMILES with ordinary H atoms implicit, preserving isotopic H and
   * stereo, for both sides of the name read-back comparison (and drawings without an identifier
   * engine). A null result means the structure could not be canonicalised.
   */
  canonicalize: (structure: string) => Promise<string | null>;
  /** Export identifier engine, including atom-state correspondence when requested. */
  computeStructureIdentifiers?: ComputeStructureIdentifiers;
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

// Audited against moleculeSmiles.ts and chem-core/molfile.ts (V2000):
// - Abbreviation expansion preserves the exact graph; retain its informational warning.
// - Charge separation is emitted only when elements, hydrogens, radicals, isotopes and total
//   charge match; the host still verifies the name by exact canonical-SMILES read-back.
// - Only dashed DISPLAY on a double/triple/aromatic bond is harmless: the chemical order is
//   retained, and dashes here carry no charge, H count, isotope, radical, stereo or fragment data.
// - Dative-to-single, unknown/query or unresolved aromatic orders (with or without literal-atom
//   H-count loss), omitted literal valences (unknown order or sum >14), and dummy/R-group
//   substitutions (including unspellable condensed labels) can change chemistry: decline.
// - moleculeSmiles' dative_bond, bond_order, atom_label and stereo_dropped warnings also decline.
// V2000 warnings share one code and are untyped text, so allow only these complete, reviewed
// display messages. Every other message/code, including future warnings, fails closed.
const exactExportWarningCodes = new Set(["export.smiles_abbreviation_expanded", "export.smiles_charge_separated"]);
const displayOnlyV2000Warnings = new Set([
  "Dashed display on a double bond is not a coordination bond; written to SMILES as double, dashed style not preserved.",
  "Dashed display on a triple bond is not a coordination bond; written to SMILES as triple, dashed style not preserved.",
  "Dashed display on an aromatic bond is not a coordination bond; written to SMILES as single, dashed style not preserved.",
  "Dashed display on an aromatic bond is not a coordination bond; written to SMILES as double, dashed style not preserved.",
  "Dashed display on an aromatic bond is not a coordination bond; written to SMILES as aromatic, dashed style not preserved."
]);

const controlCharacter = /[\u0000-\u001f\u007f-\u009f]/;
const namingSupportedElements = new Set(["C", "H", "D", "T", "N", "O", "S", "P", "F", "Cl", "Br", "I", "B", "Si", "Se"]);

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
      reason: namingDeclineReason(code)
    };
  }

  const kind = raw.tier === "pin_verified"
    ? "preferredIupacName"
    : raw.tier === "systematic_verified"
      ? "systematicName"
      : undefined;
  if (!kind) return notFullyVerified();
  if (raw.opsin !== "verified") return notFullyVerified();
  if (raw.gateOutcome.startsWith("carveout:")) return notFullyVerified();
  if (raw.stereoUnexpressed) return notFullyVerified();
  if (!raw.name || !raw.name.trim() || controlCharacter.test(raw.name)) {
    return notFullyVerified();
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
      reason: "No verified name: the name could not be read back."
    };
  }

  let canonicalDrawn: string | null;
  let canonicalReadBack: string | null;
  try {
    canonicalDrawn = await input.canonicalize(input.drawnCanonicalSmiles);
    canonicalReadBack = await input.canonicalize(read.smiles);
  } catch {
    canonicalDrawn = null;
    canonicalReadBack = null;
  }
  if (!canonicalDrawn || !canonicalReadBack || canonicalReadBack !== canonicalDrawn) {
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
      async (structure, options) => {
        try {
          if (deps.computeStructureIdentifiers) {
            const identifiers = await deps.computeStructureIdentifiers(structure, options);
            if (!identifiers?.smiles) canonicalizationFailed = true;
            return identifiers;
          }
          const smiles = await deps.canonicalize(structure);
          if (!smiles) canonicalizationFailed = true;
          return smiles ? { smiles } : undefined;
        } catch {
          canonicalizationFailed = true;
          return undefined;
        }
      },
      undefined,
      // Identifier-only callers without atom-state evidence must fail closed. The canonicalize-
      // only dependency remains available for callers without an export identifier engine.
      deps.computeStructureIdentifiers ? { requireEngineAtomStates: true } : {}
    );
  } catch {
    return decline("structureNotExact", "The drawing could not be written as exact SMILES.");
  }

  if (inexactExportWarnings(exportWarnings)) {
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
    return decline("notFullyVerified", namingDeclineReason("notFullyVerified"));
  }
  const accepted = acceptOrthonymResult(raw);
  if (!accepted.ok) {
    return decline(accepted.code, namingDeclineReason(accepted.code, molecule), accepted.limitCode);
  }

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

function inexactExportWarnings(warnings: readonly ExportWarning[]): boolean {
  return warnings.some((warning) => !exactExportWarningCodes.has(warning.code) &&
    !(warning.code === "export.smiles_v2000_loss" && displayOnlyV2000Warnings.has(warning.message)));
}

function limitDeclineCode(limitCode: string | null): Extract<StructureNameDeclineCode, "unsupportedElement" | "unnameable" | "engineLimit"> {
  switch (limitCode?.toUpperCase()) {
    case "UNSUPPORTED_ELEMENT": return "unsupportedElement";
    case "UNNAMEABLE": return "unnameable";
    default: return "engineLimit";
  }
}

function namingDeclineReason(code: StructureNameDeclineCode, molecule?: MoleculeObject): string {
  switch (code) {
    case "unsupportedElement": {
      const unsupportedElements = molecule
        ? [...new Set(molecule.atoms.map((atom) => atom.element).filter((element) => !namingSupportedElements.has(element)))]
        : [];
      if (unsupportedElements.length === 0) return "The naming engine does not support this kind of structure.";
      const elementList = unsupportedElements.length ? ` (${unsupportedElements.join(", ")})` : "";
      return `Contains an element the naming engine doesn't support${elementList}.`;
    }
    case "unnameable": return "The naming engine could not name this structure.";
    case "engineLimit": return "This structure is beyond what the naming engine can name.";
    case "notFullyVerified": return "The naming engine could not fully verify a name for this structure.";
    default: return "The naming engine declined this structure.";
  }
}

function notFullyVerified(): { ok: false; code: "notFullyVerified"; reason: string } {
  return { ok: false, code: "notFullyVerified", reason: namingDeclineReason("notFullyVerified") };
}

function decline(code: StructureNameDeclineCode, reason: string, limitCode?: string): StructureNameOutcome {
  return { status: "declined", code, reason, ...(limitCode ? { limitCode } : {}) };
}
