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
import { invoke } from "@tauri-apps/api/core";
import type {
  PluginIsotopeEnvelopeRequest,
  PluginIsotopeEnvelopeResult,
  PluginNameToStructureRequest,
  PluginNameToStructureResult
} from "@chemdraft/plugin-api";
import { ISOTOPE_ENVELOPE_METHOD_ID } from "@chemdraft/rdkit-adapter";

import { analysisClient } from "../analysisClient";

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
    // The engine's own decline: a charged structure, an isotope label it cannot express, an element
    // outside its tables. Pass the reason through verbatim — the plugin shows it to a reader.
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

/** What the Rust side returns; see `src-tauri/src/opsin.rs`. */
interface OpsinStatusReply {
  available: boolean;
  reason?: string | null;
  version: string;
}
interface OpsinConversionReply {
  smiles?: string | null;
  failureReason?: string | null;
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

  const engine = { id: OPSIN_ENGINE_ID, version: status.version };
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
    // The command itself rejected — a name carrying a control character, or the process failing to
    // start. That is still "the engine ran and said no", so it stays a parse failure with its reason.
    return {
      available: true,
      parsed: false,
      reason: error instanceof Error ? error.message : String(error),
      engine
    };
  }
}
