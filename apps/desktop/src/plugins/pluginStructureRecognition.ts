import type { ChemDraftDocument, MoleculeObject } from "@chemdraft/chem-core";
import { parseMolfileGraph } from "@chemdraft/clipboard-adapter";
import type { PluginProvidedImage, RecognitionWarning } from "@chemdraft/plugin-api";
import type { HostRecognitionOutcome } from "@chemdraft/plugin-host";

import { createNativeMolfileMolecule } from "../documentWorkflow";
import { hostRecognitionConfidenceTier, recognitionAgreementWarning } from "./recognitionAgreement";
import { loadRdkitWithAppLoader } from "./rdkitAppLoader";
import type { StructureRecognitionOutcome } from "./structureRecognitionEngine";

export type RecognitionStructureValidator = (input: {
  format: "molfile-v2000" | "molfile-v3000";
  value: string;
}) => Promise<{ valid: boolean; errors: readonly { code: string; message: string }[]; warnings: readonly { code: string; message: string }[] }>;

const RESERVED_RECOGNITION_OBJECT_IDS = new Set<string>();

/** Validate and turn native MolScribe output into the SDK result a plugin may propose. Molfile parsing
 * and document geometry deliberately reuse the same import path as MOL paste; no recognition-specific
 * chemistry parser exists here. A recognized result also carries `hostReview` — the agreement-capped
 * confidence tier — which the plugin host keeps with the recognition and strips before the plugin sees
 * the result. */
export async function preparePluginStructureRecognition(
  outcome: Extract<StructureRecognitionOutcome, { status: "recognized" }>,
  image: PluginProvidedImage,
  document: ChemDraftDocument | undefined,
  validate: RecognitionStructureValidator = validateWithAvailableChemistryAdapter
): Promise<HostRecognitionOutcome> {
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
  // What the shared MOL import would keep beyond element, position and charge, and this path
  // deliberately does not: radicals and stated hydrogen counts. The proposal is one addObject patch,
  // which cannot carry the radical-dot marks a radical needs to survive commit normalization, and
  // a recognition result's chemistry stays what it was before the importer read them (AGENTS.md
  // section 7); both stay in the stored molfile and the reviewer is told.
  let radicalAtoms: string[] = [];
  let hydrogenCountAtoms: string[] = [];
  try {
    const page = document.pages[0];
    const at = { x: page.width / 2, y: page.height / 2 };
    const graph = parseMolfileGraph(outcome.molfile);
    const named = (atom: { id: string; element: string }) =>
      `atom ${Number(/(\d+)$/.exec(atom.id)?.[1] ?? Number.NaN) || atom.id} (${atom.element})`;
    radicalAtoms = graph.atoms.filter((atom) => atom.markRadicals).map(named);
    const stripped = {
      ...graph,
      atoms: graph.atoms.map(({ markRadicals: _radicals, hydrogenCount: _hydrogens, ...atom }) => atom)
    };
    // The import keeps a stated count only where it differs from the one the atom derives; a
    // trial import tells which of this molfile's counts that is.
    hydrogenCountAtoms = createNativeMolfileMolecule(document, at, outcome.molfile, format, graph).atoms
      .filter((atom) => atom.hydrogenCount !== undefined).map(named);
    object = createNativeMolfileMolecule(document, at, outcome.molfile, format, stripped);
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
  // The proposal draws atoms with element, position, and charge (and isotope) only. Radicals stay
  // in the stored molfile but are not drawn, so say so before the user accepts. The molfile's text
  // is checked as well as the reader's result: an M  RAD line the reader refuses never gets here.
  if (radicalAtoms.length > 0 || /^M {2}RAD\b/m.test(outcome.molfile) || /\bRAD=[1-9]/.test(outcome.molfile)) {
    importWarnings.push({
      code: "import.radicals_not_drawn",
      message: "The recognized structure has radicals" +
        `${radicalAtoms.length > 0 ? ` (${radicalAtoms.join(", ")})` : ""}; they are kept in the structure data but not drawn.`
    });
  }
  if (hydrogenCountAtoms.length > 0) {
    importWarnings.push({
      code: "import.hydrogen_counts_not_drawn",
      message: `The recognized structure states hydrogen counts ChemDraft derives differently (${hydrogenCountAtoms.join(", ")}); ` +
        "they are kept in the structure data but not applied to the drawing."
    });
  }
  if (/^M {2}ISO\b/m.test(outcome.molfile) || /\bMASS=\d/.test(outcome.molfile)) {
    importWarnings.push({
      code: "import.isotopes_not_drawn",
      message: "The recognized structure has isotope labels; they are kept in the structure data but not drawn."
    });
  }
  object = recognitionObject(document, object);
  // The engine recognized the image at several sizes. When they disagreed — or the image was too small
  // to read at more than one — say so first: MolScribe's confidence alone was measured to be as high
  // on wrong answers as on right ones.
  const agreementWarning = recognitionAgreementWarning(outcome.agreement);
  const agreementWarnings: RecognitionWarning[] = agreementWarning ? [agreementWarning] : [];
  // MolScribe may omit a per-atom or per-bond score. A missing score is not a low one, and the SDK
  // schema accepts only real scores, so the points are left out and the reviewer is told (AGENTS.md §8).
  const atomConfidence = confidencePoints(outcome.atoms.map((atom) => [String(atom.index), atom.confidence]));
  const bondConfidence = confidencePoints(
    outcome.bonds.map((bond, index) => [`${bond.begin}-${bond.end}-${index}`, bond.confidence])
  );
  const missingConfidence = atomConfidence.missing + bondConfidence.missing;
  const confidenceWarnings: RecognitionWarning[] =
    missingConfidence > 0
      ? [
          {
            code: "recognition.missing_confidence",
            message: `The recognition engine gave no confidence score for ${missingConfidence} of ${
              outcome.atoms.length + outcome.bonds.length
            } atoms and bonds; check those parts of the structure yourself.`
          }
        ]
      : [];
  const validationWarnings: RecognitionWarning[] = [
    ...agreementWarnings,
    ...confidenceWarnings,
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
      atomConfidence: atomConfidence.points,
      bondConfidence: bondConfidence.points,
      warnings: validationWarnings,
      proposedPatch: {
        patch: { op: "addObject", pageId: document.pages[0].id, object },
        reason: "Insert the locally recognized structure after review.",
        warnings: validationWarnings,
        requiresUserApproval: true
      },
      engine: outcome.engine,
      elapsedMs: outcome.elapsedMs
    },
    hostReview: { confidenceTier: hostRecognitionConfidenceTier(outcome.confidence, outcome.agreement) }
  };
}

function confidencePoints(entries: readonly (readonly [string, number | null])[]): {
  points: { id: string; confidence: number }[];
  missing: number;
} {
  const points: { id: string; confidence: number }[] = [];
  let missing = 0;
  for (const [id, confidence] of entries) {
    if (typeof confidence === "number" && Number.isFinite(confidence)) points.push({ id, confidence });
    else missing += 1;
  }
  return { points, missing };
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
