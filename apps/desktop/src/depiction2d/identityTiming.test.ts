// PowerShell:
// $env:CHEMDRAFT_IDENTITY_TIMING=1; pnpm exec vitest run --maxWorkers 1 apps/desktop/src/depiction2d/identityTiming.test.ts
// macOS:
// CHEMDRAFT_IDENTITY_TIMING=1 pnpm exec vitest run --maxWorkers 1 apps/desktop/src/depiction2d/identityTiming.test.ts
import os from "node:os";
import { afterAll, describe, expect, it } from "vitest";
import { createEmptyDocument } from "@chemdraft/chem-core";
import {
  assertMoleculeMatchesSmiles, ChemicalIdentityMismatchError, createSmilesMolecule
} from "@chemdraft/document-workflow-core";
import { depictSmilesForPaste } from "../smilesListPaste";
import { createPasteIdentityInspector } from "../smilesPasteIdentity";
import { inspectStructureOffThread } from "./identityClient";
import { IDENTITY_VERIFICATION_BUDGET_MS } from "./identityWorkerClient";

const TBS = "O[Si](C)(C)C(C)(C)C";
const deadlineMs = IDENTITY_VERIFICATION_BUDGET_MS + 2_000;
type Outcome = "accepted" | "refused" | "timed out";

describe.skipIf(process.env.CHEMDRAFT_IDENTITY_TIMING !== "1")("identity worker timing", () => {
  const rows: { case: string; n: number; outcome: Outcome; ms: number }[] = [];

  afterAll(() => {
    console.log([
      "| Case | TBS arms | Outcome | ms |",
      "| --- | ---: | --- | ---: |",
      ...rows.map(row => `| ${row.case} | ${row.n} | ${row.outcome} | ${row.ms} |`)
    ].join("\n"));
  });

  for (const n of [5, 6, 7]) {
    for (const scenario of ["d", "r"]) {
      it(`(${scenario}) with ${n} TBS arms finishes within the budget plus 2 s`, async () => {
        const unspecified = Array.from({ length: n }, () => `C(${TBS})`).join("");
        const specified = Array.from({ length: n }, (_, i) =>
          `[C${i % 2 ? "@@" : "@"}H](${TBS})`).join("");
        const input = `C[C@H](N)${unspecified}C`;
        const drawn = `C[C${scenario === "d" ? "@" : "@@"}H](N)${specified}C`;
        const parsed = await depictSmilesForPaste(drawn);
        if (!parsed) throw new Error("Timing fixture could not be depicted.");
        const molecule = createSmilesMolecule(createEmptyDocument(), { x: 200, y: 200 },
          parsed.depiction, drawn);
        if (molecule.type !== "molecule") throw new Error("Timing fixture produced no molecule.");

        // Warm up again after a timeout has terminated the worker. Startup has its own budget.
        const warmup = await inspectStructureOffThread("smiles", "C");
        if (!warmup.valid) throw new Error(warmup.reason);
        const controller = new AbortController();
        const inspect = createPasteIdentityInspector(inspectStructureOffThread, controller.signal);
        const watchdog = setTimeout(() => controller.abort(), deadlineMs);
        const start = performance.now();
        let outcome: Outcome;
        try {
          // Includes source inspection, native stereo-perception molfile writing and output inspection.
          await assertMoleculeMatchesSmiles(molecule, input, inspect);
          outcome = "accepted";
        } catch (error) {
          if (error instanceof Error && error.name === "IdentityVerificationTimeoutError") {
            outcome = "timed out";
          } else if (error instanceof ChemicalIdentityMismatchError) {
            outcome = "refused";
          } else throw error;
        } finally { clearTimeout(watchdog); }
        const elapsed = performance.now() - start;
        const row = { case: scenario, n, outcome, ms: Math.round(elapsed) };
        rows.push(row);
        console.log(JSON.stringify({ platform: process.platform, arch: process.arch,
          cpus: os.cpus().length, ...row }));
        expect(["accepted", "refused", "timed out"]).toContain(outcome);
        expect(elapsed).toBeLessThanOrEqual(deadlineMs);
      }, 90_000);
    }
  }
});
