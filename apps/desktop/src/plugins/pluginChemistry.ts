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
import type { PluginIsotopeEnvelopeRequest, PluginIsotopeEnvelopeResult } from "@chemdraft/plugin-api";
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
