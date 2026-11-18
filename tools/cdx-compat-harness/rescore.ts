import { rename, rm } from "node:fs/promises";
import { join } from "node:path";
import { describeStructure, SummaryContext } from "./chemistry";
import { results } from "./io";
import { compare, compareSurvival, chemistryVerdict, guardDifferences, missingStoredEvidence, storedRouteLegs, type Summary } from "./model";
import { appendOutput, prepareOutput, writableOutput, writeOutput } from "./safety";

/** No source files or importers: old summaries retain their measured feature values. */
export async function rescore(out: string): Promise<void> {
  await prepareOutput(out);
  const destination = join(out, "private", "results.rescored.jsonl");
  const temporary = join(out, "private", "results.rescored.pending.jsonl");
  await writeOutput(temporary, "");
  try {
    for await (const row of results(out)) {
      if (row.sourceSurvival && row.summary?.survival) row.importComparison = compareSurvival(row.sourceSurvival, row.summary.survival, row.warnings);
      const context = new SummaryContext();
      const identity = new Map<string, Awaited<ReturnType<typeof describeStructure>>["species"]>();
      const enrich = async (summary: Summary) => {
        for (const m of summary.molecules) {
          if (m.species?.version === 2 || !m.strict || m.recovery) continue;
          const key = JSON.stringify(m);
          if (!identity.has(key)) {
            try { identity.set(key, (await describeStructure(m.smiles, undefined, context)).species); }
            catch { identity.set(key, undefined); } // Missing identity evidence never excuses a loss.
          }
          const enriched = identity.get(key);
          m.species = enriched && m.species?.graph ? { ...enriched, graph: m.species.graph } : enriched;
        }
      };
      for (const trip of row.roundTrips) {
        if (trip.verdict === "SKIPPED") continue;
        const completeLegs = storedRouteLegs(row.summary, trip);
        const legs = completeLegs ?? trip.legs?.filter(leg => leg?.before && leg.after) ?? [];
        const historical = guardDifferences(trip.differences);
        const historicalErrors = historical.comparisonInternalErrors;
        trip.differences = []; trip.drawingLoss = []; trip.comparisonInternalErrors = historicalErrors;
        trip.identityPasses = 0; delete trip.chemistryPassReason;
        if (completeLegs) delete trip.undetermined;
        else {
          trip.undetermined = [{ feature: "route-summaries", reason: missingStoredEvidence }];
          trip.reason = "Stored endpoint or intermediate summaries are missing.";
        }
        let incomplete = false;
        for (const leg of legs) {
          await enrich(leg.before); await enrich(leg.after);
          incomplete ||= !!leg.before.summaryErrors?.length || !!leg.after.summaryErrors?.length;
          const comparison = compare(leg.before, leg.after, leg.warnings);
          if (completeLegs) {
            trip.identityPasses += comparison.identityPasses ?? 0;
            if (comparison.chemistryPassReason) trip.chemistryPassReason = comparison.chemistryPassReason;
          }
          trip.differences.push(...comparison.differences);
          if (comparison.undetermined?.length) (trip.undetermined ??= []).push(...comparison.undetermined);
          trip.drawingLoss = [...new Set([...trip.drawingLoss, ...comparison.drawingLoss])];
          trip.comparisonInternalErrors += comparison.comparisonInternalErrors ?? 0;
        }
        const measured = chemistryVerdict(trip.differences, !!trip.undetermined?.length);
        trip.verdict = trip.error || trip.errors?.length || incomplete || (trip.verdict === "ERROR" && measured !== "FAIL") ? "ERROR" : measured;
      }
      await appendOutput(temporary, `${JSON.stringify(row)}\n`);
    }
    await writableOutput(destination);
    await rename(temporary, destination);
  } finally { await rm(temporary, { force: true }); }
}
