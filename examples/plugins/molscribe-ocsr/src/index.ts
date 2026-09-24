import type {
  PluginCommandHandler,
  PluginManifest,
  PluginPanelReport,
  PluginRecognitionResult,
  RecognitionConfidenceTier,
  RecognitionWarning,
  RecognizedStructureResult
} from "@chemdraft/plugin-api";

export const molscribeOcsrCommandId = "plugin.molscribeOcsr.recognizeImage";
export const molscribeOcsrPanelId = "panel.molscribeOcsr.review";
export const molscribeOcsrRecognizerId = "recognizer.molscribeOcsr.image";

export const molscribeOcsrManifest: PluginManifest = {
  id: "org.chemdraft.ocsr.molscribe",
  name: "MolScribe OCSR",
  version: "0.0.0",
  apiVersion: "^0.1.6",
  description: "Local image-to-structure recognition with host-managed MolScribe and review before insertion.",
  entry: "dist/plugin.js",
  permissions: [
    "image.read",
    "ml.inference",
    "model.load",
    "native.execute",
    "document.proposePatch",
    "ui.menu",
    "ui.panel"
  ],
  contributes: {
    commands: [
      {
        id: molscribeOcsrCommandId,
        title: "Recognize Structure from Image",
        category: "Tools",
        description: "Recognize a chemical structure from an image using the local MolScribe engine.",
        requiredPermissions: [
          "image.read",
          "ml.inference",
          "model.load",
          "native.execute",
          "document.proposePatch",
          "ui.panel"
        ],
        enabled: true
      }
    ],
    menus: [
      {
        id: "menu.molscribeOcsr.recognizeImage",
        title: "Recognize Structure from Image",
        commandId: molscribeOcsrCommandId,
        location: "analyze",
        requiredPermissions: ["ui.menu"]
      }
    ],
    panels: [
      {
        id: molscribeOcsrPanelId,
        title: "MolScribe OCSR",
        commandId: molscribeOcsrCommandId,
        requiredPermissions: ["ui.panel"]
      }
    ],
    toolbarButtons: [],
    toolsets: [],
    inspectors: [],
    templates: [],
    importers: [],
    exporters: [],
    analyzers: [],
    transformers: [],
    recognizers: [
      {
        id: molscribeOcsrRecognizerId,
        title: "MolScribe OCSR Image Recognizer",
        input: "selected-image",
        commandId: molscribeOcsrCommandId,
        requiredPermissions: ["image.read", "ml.inference", "model.load", "native.execute"]
      }
    ]
  }
};

/**
 * Review-tier thresholds on MolScribe's own confidence score. The score is the model's product of
 * per-token probabilities, not a calibrated probability of being right, so it is shown only as a tier
 * (never as a percentage). The cut points are review guidance: at or above `high` the structure is
 * usually right but still needs a look; below `medium` expect at least one wrong atom or bond.
 */
export const RECOGNITION_CONFIDENCE_THRESHOLDS = { high: 0.85, medium: 0.65 } as const;

/** Confidence is an honest review tier, not a claimed calibrated probability. */
export function recognitionConfidenceTier(confidence: number | null): RecognitionConfidenceTier {
  if (confidence === null) return "missing";
  if (confidence >= RECOGNITION_CONFIDENCE_THRESHOLDS.high) return "high";
  if (confidence >= RECOGNITION_CONFIDENCE_THRESHOLDS.medium) return "medium";
  return "low";
}

// Line shapes, not a molfile parser: each test asks one yes/no question of the text the engine
// returned. The host has already parsed and validated the structure before it reached the plugin.
const V2000_ATOM_LINE =
  /^\s*-?\d+\.\d+\s+-?\d+\.\d+\s+-?\d+\.\d+\s+(\S+)\s+(-?\d+)\s+(-?\d+)\s+(-?\d+)/;
const V2000_BOND_LINE = /^\s*\d+\s+\d+\s+\d+\s+(\d+)(?:\s|$)/;
const ABBREVIATION_LABELS =
  "R\\d*|R#|Ar|X|Ph|Me|Et|n?Pr|i-?Pr|n?Bu|t-?Bu|i-?Bu|s-?Bu|Ac|Bn|Bz|Boc|Cbz|Fmoc|Ts|Ms|Tf|TMS|TBS|TBDMS|TIPS|OMe|OEt|OAc|CO2Me|CO2Et|CF3|NO2";
const SMILES_ABBREVIATION = new RegExp(`\\*|\\[(?:${ABBREVIATION_LABELS})\\]`);
const MOLFILE_ABBREVIATION_SYMBOL = new RegExp(`^(?:${ABBREVIATION_LABELS}|A|Q|\\*)$`);

interface MolfileSignals {
  stereo: boolean;
  chargeOrRadical: boolean;
  abbreviation: boolean;
}

function molfileSignals(molfile: string): MolfileSignals {
  const signals: MolfileSignals = { stereo: false, chargeOrRadical: false, abbreviation: false };
  // The first three lines are the free-text header block; never read them as chemistry.
  for (const line of molfile.split(/\r?\n/).slice(3)) {
    if (/V2000|V3000/.test(line)) continue;
    if (/^M\s+(CHG|RAD)\b/.test(line) || /\b(CHG|RAD)=-?[1-9]/.test(line)) signals.chargeOrRadical = true;
    if (/\bCFG=[1-3]\b/.test(line)) signals.stereo = true;
    if (/^M\s+STY\b.*\bSUP\b/.test(line) || /^M\s+ALS\b/.test(line) || /^A\s+\d+/.test(line)) {
      signals.abbreviation = true;
    }
    if (/^M\s+V30\b/.test(line)) {
      if (/\bTYPE=SUP\b|\bSUP\b/.test(line)) signals.abbreviation = true;
      const v3000Atom = /^M\s+V30\s+\d+\s+(\S+)\s+-?\d/.exec(line);
      if (v3000Atom && MOLFILE_ABBREVIATION_SYMBOL.test(v3000Atom[1]!)) signals.abbreviation = true;
      continue;
    }
    const atom = V2000_ATOM_LINE.exec(line);
    if (atom) {
      if (MOLFILE_ABBREVIATION_SYMBOL.test(atom[1]!)) signals.abbreviation = true;
      if (atom[3] !== "0") signals.chargeOrRadical = true; // charge field; 4 is a doublet radical
      if (atom[4] !== "0") signals.stereo = true; // atom parity
      continue;
    }
    const bond = V2000_BOND_LINE.exec(line);
    if (bond && bond[1] !== "0") signals.stereo = true; // wedge 1, either 4, hash 6, cis/trans-either 3
  }
  return signals;
}

/** Warnings are derived from the returned chemistry, never invented fixture claims. */
export function recognitionReviewWarnings(result: RecognizedStructureResult): RecognitionWarning[] {
  const warnings = [...result.warnings];
  const add = (code: string, message: string): void => {
    if (!warnings.some((warning) => warning.code === code)) warnings.push({ code, message });
  };
  const tier = recognitionConfidenceTier(result.confidence);
  const lowAtoms = result.atomConfidence.filter(
    (point) => point.confidence < RECOGNITION_CONFIDENCE_THRESHOLDS.medium
  ).length;
  const lowBonds = result.bondConfidence.filter(
    (point) => point.confidence < RECOGNITION_CONFIDENCE_THRESHOLDS.medium
  ).length;
  if (tier === "low") {
    add("recognition.low-confidence", "Recognition confidence is low; inspect every atom and bond before insertion.");
  } else if (lowAtoms + lowBonds > 0) {
    add(
      "recognition.low-confidence",
      `${count(lowAtoms, "atom")} and ${count(lowBonds, "bond")} were recognized with low confidence; inspect them before insertion.`
    );
  }
  // A single atom has no bonds, so an empty bond list is only missing data when there are several atoms.
  if (tier === "missing" || result.atomConfidence.length === 0 || (result.atomConfidence.length > 1 && result.bondConfidence.length === 0)) {
    add("recognition.missing-confidence", "Confidence data is missing for some or all of the recognized structure.");
  }

  const smiles = result.proposedSmiles ?? "";
  const signals = molfileSignals(result.proposedMolfile ?? "");
  if (signals.stereo || /[@/\\]/.test(smiles)) {
    add("recognition.stereochemistry-uncertain", "Stereochemistry was recognized from the image and must be reviewed.");
  }
  if (signals.chargeOrRadical || /\[[^\]]*[+-][^\]]*\]/.test(smiles)) {
    add("recognition.charge-radical-uncertain", "Charges or radicals were recognized from the image and must be reviewed.");
  }
  if (signals.abbreviation || SMILES_ABBREVIATION.test(smiles)) {
    add(
      "recognition.abbreviation-superatom-uncertain",
      "An abbreviation or superatom may be present; confirm that it was interpreted correctly."
    );
  }
  return warnings;
}

function count(value: number, noun: string): string {
  return `${value} ${noun}${value === 1 ? "" : "s"}`;
}

export function createMolScribeOcsrCommandHandler(): PluginCommandHandler<
  PluginRecognitionResult | { status: "cancelled" | "unavailable" }
> {
  return async (context) => {
    for (const permission of [
      "image.read",
      "ml.inference",
      "model.load",
      "native.execute",
      "document.proposePatch",
      "ui.panel"
    ] as const) {
      context.requirePermission(permission);
    }
    const imageResult = await context.images!.requestImage({
      title: "Recognize Structure from Image"
    });

    if (imageResult.status === "cancelled") return imageResult;
    if (imageResult.status === "unavailable") {
      await showMessage(context, `Image input is unavailable: ${imageResult.reason}`);
      return imageResult;
    }

    const recognition = await context.recognition!.recognizeStructure(imageResult.image);
    if (recognition.status === "engineNotInstalled") {
      await showMessage(context, "Recognition needs the local engine. Install it in Add or Remove Plugins.");
      return recognition;
    }
    if (recognition.status === "failed") {
      await showMessage(context, `Recognition failed: ${recognition.message}`);
      return recognition;
    }

    const result = recognition.result;
    if (!result.proposedMolfile || !result.proposedPatch) {
      await showMessage(
        context,
        "Recognition failed: the returned SMILES/MOL was invalid or unsanitized, so no insertion was proposed."
      );
      return {
        status: "failed",
        code: "invalidResult",
        message: "The returned SMILES/MOL was invalid or unsanitized."
      };
    }

    const confidenceTier = recognitionConfidenceTier(result.confidence);
    const warnings = recognitionReviewWarnings(result);
    await context.documents.proposePatch({
      ...result.proposedPatch,
      reason: `Insert the locally recognized structure (${confidenceTier} confidence) after review.`,
      warnings,
      requiresUserApproval: true,
      recognition: {
        sourceImageRef: result.sourceImageRef,
        proposedSmiles: result.proposedSmiles,
        proposedMolfile: result.proposedMolfile,
        confidenceTier,
        engine: result.engine,
        elapsedMs: result.elapsedMs
      }
    });
    return recognition;
  };
}

async function showMessage(context: Parameters<PluginCommandHandler>[0], body: string): Promise<void> {
  const report: PluginPanelReport = {
    title: "MolScribe OCSR",
    sections: [{ kind: "text", body }]
  };
  await context.panels?.showReport(molscribeOcsrPanelId, report);
}
