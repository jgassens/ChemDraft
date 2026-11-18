// SPDX-License-Identifier: Apache-2.0
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

test("the accepted chunk counts use the run's starting energy", () => {
  const report = readFileSync(new URL("./benchmarks/fire-vs-hybrid.md", import.meta.url), "utf8");
  const { cases, totals } = JSON.parse(
    readFileSync(new URL("./benchmarks/fire-vs-hybrid.json", import.meta.url), "utf8"));
  assert.match(report, /accepted chunk above the run's starting energy/);
  assert.match(report, /accepted chunk \/ final above run start/);

  const starts = cases.flatMap((entry) => entry.starts);
  for (const regime of ["release", "tail"]) {
    for (const method of ["fire", "hybrid"]) {
      let count = 0;
      for (const start of starts) {
        const run = start[regime][method];
        const peak = run.maxAcceptedChunkEnergyKjMol;
        const initial = start.initialEnergyKjMol;
        const aboveRunStart = peak !== null && initial !== null && peak > initial;
        assert.equal(run.acceptedChunkEverAboveRunStart, aboveRunStart);
        count += Number(aboveRunStart);
      }
      assert.equal(totals[regime].stats[method].acceptedChunkAboveRunStart, count);
    }
  }
});
