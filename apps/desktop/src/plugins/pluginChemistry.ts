/**
 * The host side of `chemistry.compute`: chemistry the application computes on a plugin's behalf.
 *
 * The SDK boundary (ADR-0028 §1) stops a plugin importing the core's engines, and the mass-fragment
 * demo showed what that costs when a plugin needs real chemistry — it shipped its own eight-element
 * abundance table and a first-order M/M+1/M+2 estimate, an unsourced second implementation of
 * something the application already does properly. This is the way out that keeps the boundary intact.
 *
 * It runs through the ordinary analysis client rather than instantiating engines here: same worker,
 * same session cache, same engine hashes in the fingerprint. A plugin's envelope and the core Analyze
 * panel's envelope are therefore the same computation, and cannot drift.
 */
import { RESERVED_PLUGIN_OBJECT_IDS } from "./reservedObjectIds";
export { createChemistry3dProviders } from "../chemistry3d/client";
export { RESERVED_PLUGIN_OBJECT_IDS } from "./reservedObjectIds";

import { invoke } from "@tauri-apps/api/core";
import { resolveStructureTemplateName } from "@chemdraft/document-workflow-core";
import { templateMoleculeForSmiles } from "../structureTemplateInsertion";
import type { ChemDraftDocument } from "@chemdraft/chem-core";
import type {
  PluginIsotopeEnvelopeRequest,
  PluginIsotopeEnvelopeResult,
  PluginNameToStructureRequest,
  PluginNameToStructureResult,
  PluginStructureFromSmilesRequest,
  PluginStructureFromSmilesResult
} from "@chemdraft/plugin-api";
import { ISOTOPE_ENVELOPE_METHOD_ID } from "@chemdraft/rdkit-adapter/constants";
import {
  assertMoleculeMatchesSmiles, type InspectChemicalIdentity
} from "@chemdraft/document-workflow-core";
import { createPasteIdentityInspector, SmilesIdentityEngineUnavailableError } from "../smilesPasteIdentity";

import { analysisClient } from "../analysisClient";
import { depictSmilesOffThread } from "../depiction2d/client";
import {
  createSmilesMolecule,
  type PastedStructureDepiction
} from "../documentWorkflow";

/** Its own slot, so a plugin's request never supersedes the Analyze panel's in-flight run. */
const PLUGIN_ENVELOPE_SLOT = "plugin.chemistry.isotope-envelope";

export async function computeIsotopeEnvelopeForPlugin(
  request: PluginIsotopeEnvelopeRequest
): Promise<PluginIsotopeEnvelopeResult> {
  const client = analysisClient();
  if (!client) {
    return { available: false, reason: "The analysis engine is unavailable in this environment." };
  }

  const run = await client.analyze(PLUGIN_ENVELOPE_SLOT, {
    format: request.format,
    value: request.structure,
    methodIds: [ISOTOPE_ENVELOPE_METHOD_ID]
  });

  const result = run.results.find((entry) => entry.methodId === ISOTOPE_ENVELOPE_METHOD_ID);
  if (!result || result.kind !== "distribution") {
    // A run that produced nothing at all — an unparseable structure, or a superseded request. Its
    // reason is on the run, not on a result that does not exist.
    const reason = run.warnings[0]?.message ?? "No isotope envelope was computed for this structure.";
    return { available: false, reason };
  }

  if (result.status !== "ok") {
    // The engine's own decline: an isotope label it cannot express, an element outside its tables.
    // (A charged structure is NOT one of these any more — since envelope contract 2.0.0 it is
    // answered in m/z rather than declined.) Pass the reason through verbatim: the plugin shows it
    // to a reader.
    return {
      available: false,
      reason: result.applicability.reasons[0] ?? "The isotope envelope does not apply to this structure."
    };
  }

  const engine = run.engines.find((entry) => entry.name === "isospec-wasm");
  return {
    available: true,
    peaks: [...result.positions].map((mass, index) => ({
      mass,
      relativeIntensity: result.intensities[index] ?? 0
    })),
    // The unit travels with the numbers. Dropping it here is what let a plugin render a dication's
    // m/z values under a "Mass (Da)" header: the engine had already divided by |charge| and recorded
    // `positionUnit: "thomson"`, and this boundary threw that away while keeping the field name
    // `mass`. The app's own report gets it right by branching on the same field.
    positionUnit: result.positionUnit === "thomson" ? "thomson" : "dalton",
    truncation: {
      policy: result.truncation.policy,
      threshold: result.truncation.threshold,
      ...(result.truncation.coveredProbability === undefined
        ? {}
        : { coveredProbability: result.truncation.coveredProbability })
    },
    engine: { id: engine?.name ?? "isospec-wasm", version: engine?.version ?? "unknown" },
    // Carried across the boundary because the intensities depend on them: which abundance table
    // produced these numbers is not an implementation detail the plugin may drop.
    conventions: [...result.conventions]
  };
}

/**
 * Lay a SMILES out as a document object, through the same engine chain a pasted SMILES takes.
 *
 * RDKit first because it is the readability-first depiction for fused and bridged systems, with
 * OpenChemLib as the complete local fallback — and `createSmilesMolecule` for the object itself, so a
 * structure inserted from a name and the same structure pasted as SMILES are the same object rather
 * than two implementations that drift.
 *
 * The object is returned, not inserted. A plugin uses `applyPatch` for deterministic user-supplied
 * input or `proposePatch` when the result needs review; either path stays undoable in the host.
 */
export async function structureFromSmilesForPlugin(
  request: PluginStructureFromSmilesRequest,
  getActiveDocument: () => ChemDraftDocument | undefined,
  signal?: AbortSignal,
  inspect: InspectChemicalIdentity = createPasteIdentityInspector()
): Promise<PluginStructureFromSmilesResult> {
  const document = getActiveDocument();
  if (!document) {
    return { available: false, reason: "There is no open document to build a structure for." };
  }
  // NOTE for the caller: this function reads the active document, so the host gates it on
  // `document.read` as well as `chemistry.compute`. The returned object carries document-derived
  // information whether or not that is the intent — the minted id encodes the document's object count
  // (`nextObjectId` is `existingIds.size + 1`) and the coordinates encode the page dimensions (the
  // insert point is the page centre). It used to be bound to the runtime's UNGATED document getter
  // rather than the `document.read`-checked one, so a plugin holding only `chemistry.compute` could
  // read both.

  let object: ReturnType<typeof createSmilesMolecule> | undefined;
  try {
    object = await templateMoleculeForSmiles(request.smiles, document,
      pluginInsertPoint(document), RESERVED_PLUGIN_OBJECT_IDS);
  } catch (error) {
    if (signal?.aborted) throw error;
    // An unavailable canonicalizer cannot authorize substitution. Keep the existing depiction
    // engine's fallback and error reporting for non-template input.
  }
  if (object && signal?.aborted) {
    return { available: true, built: false, reason: "2D depiction cancelled." };
  }

  if (!object) {
    let depiction: PastedStructureDepiction;
    let warnings: string[] | undefined;
    try {
      ({ depiction, warnings } = await depictSmilesOffThread(request.smiles, { signal }));
    } catch (error) {
      return { available: true, built: false, reason: structureGenerationFailureReason(request.smiles, error) };
    }

    if (depiction.atoms.length === 0) {
      return { available: true, built: false, reason: "The structure came back with no atoms." };
    }

    const origin = request.origin?.trim();
    // `reservedObjectIds` is what stops two proposals colliding. `nextObjectId` is purely
    // document-derived and deterministic, and this function deliberately does NOT insert — the object
    // waits in the review queue until the user accepts it. So a plugin that builds two structures
    // before either lands got `mol_plugin_001` twice, and accepting the second threw
    // `DocumentPatchError: object "mol_plugin_001" already exists` from `addObject`.
    object = createSmilesMolecule(document, pluginInsertPoint(document), depiction, request.smiles, {
      objectIdPrefix: "mol_plugin",
      reservedObjectIds: RESERVED_PLUGIN_OBJECT_IDS,
      styleSource: "plugin-smiles",
      warningCode: "plugin.smiles_imported",
      // Names the plugin, because "pasted" would be a false account of where this came from.
      warningMessage: [origin
        ? `Generated an editable 2D structure from SMILES supplied by ${origin}.`
        : "Generated an editable 2D structure from SMILES supplied by a plugin.", ...(warnings ?? [])].join(" ")
    }, { openUnspecifiedDoubleBonds: true });
  }

  if (object.type !== "molecule") {
    return { available: true, built: false, reason: "The structure builder did not return a molecule." };
  }
  RESERVED_PLUGIN_OBJECT_IDS.add(object.id);
  try {
    await assertMoleculeMatchesSmiles(object, request.smiles, inspect);
    signal?.throwIfAborted();
  } catch (error) {
    RESERVED_PLUGIN_OBJECT_IDS.delete(object.id);
    if (error instanceof SmilesIdentityEngineUnavailableError) {
      return { available: false, reason: error.message };
    }
    return { available: true, built: false, reason: structureGenerationFailureReason(request.smiles, error) };
  }
  return { available: true, built: true, object };
}

function structureGenerationFailureReason(smiles: string, error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  // OCL's parser exceptions include a Java stack trace. The first line identifies the parse
  // problem; the rest is implementation detail that would overwhelm a plugin's status surface.
  // A chemistry refusal (invented radical or hydrogen) is written for people; keep all of it.
  const isChemistryRefusal = error instanceof Error &&
    (error as { smilesChemistryRefusal?: unknown }).smilesChemistryRefusal === true;
  const specificMessage = isChemistryRefusal
    ? message
    : message.split(/\r\n|\r|\n/, 1)[0].trim();
  return `No 2D structure could be generated for "${smiles}": ${specificMessage || "The depiction engine did not provide a reason."}`;
}

/**
 * Where a plugin's structure lands.
 *
 * The page's centre rather than the caret or the viewport: a plugin has no pointer and no scroll
 * position, and dropping every structure at the origin would stack them on top of each other.
 */
function pluginInsertPoint(document: ChemDraftDocument): { x: number; y: number } {
  const page = document.pages[0];
  return page ? { x: page.width / 2, y: page.height / 2 } : { x: 0, y: 0 };
}

/** What the Rust side returns; see `src-tauri/src/opsin.rs`. */
interface OpsinStatusReply {
  available: boolean;
  reason?: string | null;
  /** Absent when no jar is bundled: there is no engine whose version it would be. */
  version?: string | null;
}
interface OpsinConversionReply {
  smiles?: string | null;
  failureReason?: string | null;
}
/** The rejected shape — `kind` is the distinction this layer used to throw away. */
interface OpsinErrorReply {
  kind?: "invalidName" | "engineFailure";
  message?: string;
}

const OPSIN_ENGINE_ID = "opsin";

/**
 * Name → structure, through the vendored OPSIN engine the host bundles.
 *
 * Unlike the envelope this does not go through the analysis worker: the engine is a Java process the
 * Rust side owns, not a WASM module in the worker, so the Tauri command *is* the boundary.
 *
 * "The engine is missing" and "the engine could not read that name" are kept apart all the way
 * across. They mean different things to a reader — one is a build that cannot do this at all, the
 * other is a name that needs rewriting — and collapsing them into one error string would leave the
 * plugin unable to say which.
 */
export async function nameToStructureForPlugin(
  request: PluginNameToStructureRequest
): Promise<PluginNameToStructureResult> {
  const template = resolveStructureTemplateName(request.name);
  if (template) return { available: true, parsed: true, smiles: template.smiles,
    engine: { id: "chemdraft-templates", version: "builtin" } };
  let status: OpsinStatusReply;
  try {
    status = await invoke<OpsinStatusReply>("opsin_status");
  } catch {
    // No Tauri backend at all — a browser preview, or a test harness.
    return { available: false, reason: "The name-to-structure engine is unavailable in this environment." };
  }

  if (!status.available) {
    return {
      available: false,
      reason: status.reason ?? "The name-to-structure engine is not available in this build."
    };
  }

  // `status.available` is true here, which the Rust side only reports with a jar present — and the
  // version describes that jar. The fallback is for a host that answered `available` without one,
  // which would be a contradiction; "unknown" is the honest word for it rather than a fabricated
  // number.
  const engine = { id: OPSIN_ENGINE_ID, version: status.version ?? "unknown" };
  try {
    const reply = await invoke<OpsinConversionReply>("opsin_name_to_structure", { name: request.name });
    if (reply.smiles) {
      return { available: true, parsed: true, smiles: reply.smiles, engine };
    }
    return {
      available: true,
      parsed: false,
      reason: reply.failureReason ?? `"${request.name}" could not be interpreted as a chemical name.`,
      engine
    };
  } catch (error) {
    // The command rejected, and WHICH rejection it was decides what the user is told. This used to
    // map every one of them to `parsed: false` — so a JVM that could not start, or a 30-second
    // timeout, reported the user's chemical name as unreadable when OPSIN had never run. Rust
    // distinguishes the two; the header of this function promises they are "kept apart all the way
    // across", and this is where that promise was being broken.
    const rejection = error as OpsinErrorReply;
    const message =
      typeof rejection?.message === "string"
        ? rejection.message
        : error instanceof Error
          ? error.message
          : String(error);

    if (rejection?.kind === "invalidName") {
      // Refused before any process started, so it genuinely is about the name.
      return { available: true, parsed: false, reason: message, engine };
    }
    // Everything else is the engine failing, which says nothing at all about the name.
    return { available: false, reason: message };
  }
}
