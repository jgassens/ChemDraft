/**
 * Leakage-free accuracy benchmark against a raw NMReDATA export (ADR-0026).
 *
 *   npx tsx examples/plugins/nmr-predictor/scripts/run-benchmark.ts <input.sd> \
 *     [--hold-out-per-mille 20] [--seed 1] [--min-observations 5] [--statistic median] [--json out.json]
 *
 * Protocol: split the corpus by structure identity (OCL idcode — duplicate records of a compound
 * always land together), build the reference database from the TRAIN side only with the production
 * prune, then score every held-out assignment through the production lookup path. Nothing is tuned
 * against the held-out set. For a ~280 MB corpus run with NODE_OPTIONS=--max-old-space-size=6144.
 */
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";

import { aggregateBenchmark, evaluateHeldOut, splitCorpusByStructure } from "../src/providers/ocl/benchmark";
import { buildNmrDatabase } from "../src/providers/ocl/buildDatabase";
import { parseNmredataRecords } from "../src/providers/ocl/nmredata";

function flagValue(args: string[], flag: string): string | undefined {
  const index = args.indexOf(flag);
  if (index < 0) return undefined;
  const [, value] = args.splice(index, 2);
  return value;
}

const args = process.argv.slice(2);
const holdOutPerMille = Number(flagValue(args, "--hold-out-per-mille") ?? 20);
const seed = Number(flagValue(args, "--seed") ?? 1);
const minObservations = Number(flagValue(args, "--min-observations") ?? 5);
const statistic = (flagValue(args, "--statistic") ?? "median") as "median" | "mean";
const jsonOut = flagValue(args, "--json");
const [input] = args;
if (!input || !Number.isInteger(holdOutPerMille) || holdOutPerMille < 1 || holdOutPerMille > 500) {
  console.error(
    "usage: run-benchmark <input.sd> [--hold-out-per-mille 1..500] [--seed N] [--min-observations N] [--statistic median|mean] [--json out.json]"
  );
  process.exit(1);
}

const rawBytes = readFileSync(input);
const inputSha256 = createHash("sha256").update(rawBytes).digest("hex");
console.log(`corpus sha256=${inputSha256} bytes=${rawBytes.byteLength}`);

const records = parseNmredataRecords(rawBytes.toString("utf8").replace(/\r\n?/g, "\n"));
console.log(`usable records=${records.length}`);

const split = splitCorpusByStructure(records, { holdOutPerMille, seed });
console.log(
  `split: train=${split.train.length} heldOut=${split.heldOut.length} unparseable(kept in train)=${split.unparseable} seed=${seed} perMille=${holdOutPerMille}`
);

const database = buildNmrDatabase(split.train.map((record) => record.raw).join("\n$$$$\n"), {
  minObservations,
  provenance: {
    name: "benchmark train split",
    version: `seed ${seed}, hold-out ${holdOutPerMille}/1000`,
    source: input,
    license: "nmrshiftdb2 Database License (ODbL-derived)",
    attribution: "Shift data © nmrshiftdb2 contributors.",
    note: "Train-only database for the leakage-free benchmark; never shipped.",
    inputSha256,
    inputBytes: rawBytes.byteLength
  }
});
console.log(
  `train database: entries=${database.provenance.entryCount} (raw ${database.provenance.rawEntryCount ?? database.provenance.entryCount}) structures=${database.provenance.structureCount}`
);

const rows = evaluateHeldOut(database, split.heldOut, { statistic });
const summary = aggregateBenchmark(rows);

for (const [nucleus, stats] of Object.entries(summary)) {
  console.log(`\n## ${nucleus} — ${stats.structures} structures, ${stats.assigned} assigned shifts`);
  console.log(
    `coverage ${(stats.coverage * 100).toFixed(1)}% (${stats.matched}/${stats.assigned}) · MAE ${stats.hose.mae} · median |Δ| ${stats.hose.medianAe} · P90 ${stats.hose.p90Ae} ppm`
  );
  for (const [tier, tierStats] of Object.entries(stats.byTier)) {
    console.log(
      `  ${tier.padEnd(6)} n=${String(tierStats.count).padStart(6)} MAE ${tierStats.mae} · median ${tierStats.medianAe} · P90 ${tierStats.p90Ae}`
    );
  }
  const comparison = stats.incrementComparison;
  if (comparison) {
    console.log(
      `  increment comparison (both defined, n=${comparison.count}): HOSE MAE ${comparison.hose.mae} vs increment MAE ${comparison.increment.mae}`
    );
    if (comparison.lowTier) {
      console.log(
        `    low-tier subset (n=${comparison.lowTier.count}): HOSE MAE ${comparison.lowTier.hose.mae} vs increment MAE ${comparison.lowTier.increment.mae}`
      );
    }
  }
}

if (jsonOut) {
  writeFileSync(
    jsonOut,
    `${JSON.stringify(
      {
        protocol: {
          inputSha256,
          inputBytes: rawBytes.byteLength,
          holdOutPerMille,
          seed,
          minObservations,
          statistic,
          usableRecords: records.length,
          train: split.train.length,
          heldOut: split.heldOut.length,
          unparseable: split.unparseable,
          trainDatabaseEntries: database.provenance.entryCount
        },
        summary
      },
      null,
      2
    )}\n`
  );
  console.log(`\nwrote ${jsonOut}`);
}
