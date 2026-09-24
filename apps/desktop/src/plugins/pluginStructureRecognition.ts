import type { ChemDraftDocument, MoleculeObject } from "@chemdraft/chem-core";
import type {
  PluginProvidedImage,
  PluginRecognitionResult,
  RecognitionWarning
} from "@chemdraft/plugin-api";

import { createNativeMolfileMolecule } from "../documentWorkflow";
import {
  recognitionAgreementLevel,
  recognitionDisagreementWarning,
  rememberRecognitionAgreement
} from "./recognitionAgreement";
import { loadRdkitWithAppLoader } from "./rdkitAppLoader";
import type { StructureRecognitionOutcome } from "./structureRecognitionEngine";

export type RecognitionStructureValidator = (input: {
  format: "molfile-v2000" | "molfile-v3000";
  value: string;
}) => Promise<{ valid: boolean; errors: readonly { code: string; message: string }[]; warnings: readonly { code: string; message: string }[] }>;

const RESERVED_RECOGNITION_OBJECT_IDS = new Set<string>();

/** Validate and turn native MolScribe output into the SDK result a plugin may propose. Molfile parsing
 * and document geometry deliberately reuse the same import path as MOL paste; no recognition-specific
 * chemistry parser exists here. */
export async function preparePluginStructureRecognition(
  outcome: Extract<StructureRecognitionOutcome, { status: "recognized" }>,
  image: PluginProvidedImage,
  document: ChemDraftDocument | undefined,
  validate: RecognitionStructureValidator = validateWithAvailableChemistryAdapter
): Promise<PluginRecognitionResult> {
  if (!document?.pages[0]) {
    return { status: "failed", code: "invalidResult", message: "There is no open page for the recognized structure." };
  }
  const format = outcome.molfile.includes("V3000") ? "molfile-v3000" : "molfile-v2000";
  let validation: Awaited<ReturnType<RecognitionStructureValidator>>;
  try {
    validation = await validate({ format, value: outcome.molfile });
  } catch (error) {
    return {
      status: "failed",
      code: "invalidResult",
      message: `The recognized structure could not be validated: ${messageOf(error)}`
    };
  }
  if (!validation.valid) {
    return {
      status: "failed",
      code: "invalidResult",
      message:
        validation.errors[0]?.message ??
        "The recognized SMILES/MOL is invalid or could not be sanitized, so it was not proposed."
    };
  }

  let object: MoleculeObject;
  try {
    const page = document.pages[0];
    object = createNativeMolfileMolecule(
      document,
      { x: page.width / 2, y: page.height / 2 },
      outcome.molfile,
      format
    );
  } catch (error) {
    return {
      status: "failed",
      code: "invalidResult",
      message: `The recognized SMILES/MOL is invalid or unsanitized: ${messageOf(error)}`
    };
  }

  // What the shared MOL import could not carry into native geometry (radicals, isotopes, unsupported
  // fields) must reach the reviewer rather than vanish into object metadata (AGENTS.md §5.7).
  const importWarnings: RecognitionWarning[] = (object.compatibility?.warnings ?? [])
    .filter((warning) => warning.code !== "clipboard.molfile_imported")
    .map((warning) => ({ code: `import.${warning.code}`, message: warning.message }));
  // The shared MOL import draws atoms with element, position, and charge only. Radicals and isotope
  // labels stay in the stored molfile but are not drawn, so say so before the user accepts.
  if (/^M {2}RAD\b/m.test(outcome.molfile) || /\bRAD=[1-9]/.test(outcome.molfile)) {
    importWarnings.push({
      code: "import.radicals_not_drawn",
      message: "The recognized structure has radicals; they are kept in the structure data but not drawn."
    });
  }
  if (/^M {2}ISO\b/m.test(outcome.molfile) || /\bMASS=\d/.test(outcome.molfile)) {
    importWarnings.push({
      code: "import.isotopes_not_drawn",
      message: "The recognized structure has isotope labels; they are kept in the structure data but not drawn."
    });
  }
  object = recognitionObject(document, object);
  // The engine recognized the image at several sizes. When they disagreed, say so first: MolScribe's
  // confidence alone was measured to be as high on wrong answers as on right ones.
  const agreementWarnings: RecognitionWarning[] =
    recognitionAgreementLevel(outcome.agreement) === "unanimous" ? [] : [recognitionDisagreementWarning(outcome.agreement)];
  rememberRecognitionAgreement(outcome.molfile, outcome.agreement);
  const validationWarnings: RecognitionWarning[] = [
    ...agreementWarnings,
    ...validation.warnings.map((warning) => ({
      code: `validation.${warning.code}`,
      message: warning.message
    })),
    ...importWarnings
  ];
  const sourceImageRef = imageDataUri(image);
  return {
    status: "recognized",
    result: {
      sourceImageRef,
      proposedSmiles: outcome.smiles,
      proposedMolfile: outcome.molfile,
      confidence: outcome.confidence,
      atomConfidence: outcome.atoms.map((atom) => ({ id: String(atom.index), confidence: atom.confidence })),
      bondConfidence: outcome.bonds.map((bond, index) => ({
        id: `${bond.begin}-${bond.end}-${index}`,
        confidence: bond.confidence
      })),
      warnings: validationWarnings,
      proposedPatch: {
        patch: { op: "addObject", pageId: document.pages[0].id, object },
        reason: "Insert the locally recognized structure after review.",
        warnings: validationWarnings,
        requiresUserApproval: true
      },
      engine: outcome.engine,
      elapsedMs: outcome.elapsedMs
    }
  };
}

function recognitionObject(document: ChemDraftDocument, source: MoleculeObject): MoleculeObject {
  const existing = new Set(document.pages.flatMap((page) => page.objects.map((object) => object.id)));
  let sequence = existing.size + 1;
  let id = `mol_ocsr_${String(sequence).padStart(3, "0")}`;
  while (existing.has(id) || RESERVED_RECOGNITION_OBJECT_IDS.has(id)) {
    sequence += 1;
    id = `mol_ocsr_${String(sequence).padStart(3, "0")}`;
  }
  RESERVED_RECOGNITION_OBJECT_IDS.add(id);
  return {
    ...source,
    id,
    style: { ...source.style, source: "molscribe-ocsr" },
    compatibility: {
      ...source.compatibility,
      unknown: source.compatibility?.unknown ?? {},
      warnings: [
        {
          code: "recognition.molscribe_imported",
          message: "Generated by local MolScribe recognition; review the proposed chemistry before insertion."
        },
        ...(source.compatibility?.warnings ?? []).filter((warning) => warning.code !== "clipboard.molfile_imported")
      ]
    }
  };
}

async function validateWithAvailableChemistryAdapter(input: {
  format: "molfile-v2000" | "molfile-v3000";
  value: string;
}) {
  const { createRdkitAdapter } = await loadRdkitWithAppLoader(() => import("@chemdraft/rdkit-adapter/adapter"));
  return createRdkitAdapter().validateStructure(input);
}

function imageDataUri(image: PluginProvidedImage): string {
  let binary = "";
  const chunkSize = 0x8000;
  for (let offset = 0; offset < image.bytes.length; offset += chunkSize) {
    binary += String.fromCharCode(...image.bytes.subarray(offset, offset + chunkSize));
  }
  return `data:${image.mediaType};base64,${btoa(binary)}`;
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
