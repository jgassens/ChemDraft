/**
 * One method's exception must not cost the other sixty-one.
 *
 * The run loop had no per-method try/catch, so any throw — a WASM abort, a SMARTS the build cannot
 * compile, the `RangeError` a large isotope envelope used to raise out of `Math.max(...peaks)` —
 * abandoned the whole run. A user who drew one structure got nothing rather than sixty-one answers
 * and one honest failure.
 *
 * Its own file because the mock has to be HOISTED: `analysis.ts` reads `jobackNormalBoilingPoint`
 * into a module-level lookup table at import time, so a `vi.spyOn` applied afterwards never
 * intercepts — the table already holds the original binding. `vi.mock` runs before the import graph
 * is evaluated, which is the only way to make the real dispatch call a thrower.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { resetRdkitForTesting } from "./conformer";
import { installRealRdkitModuleLoader } from "./testing";

vi.mock("./joback", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./joback")>();
  return {
    ...actual,
    jobackNormalBoilingPoint: () => {
      throw new Error("simulated engine abort");
    }
  };
});

beforeAll(() => {
  installRealRdkitModuleLoader();
});
afterAll(() => {
  resetRdkitForTesting();
});

describe("per-method exception isolation", () => {
  it("reports the thrower as failed and still answers everything else", async () => {
    const { analyzeStructure } = await import("./analysis");
    const run = await analyzeStructure({
      format: "smiles",
      value: "CCCCCCCC",
      runId: "method-isolation",
      startedAt: "2026-08-09T00:00:00.000Z"
    } as never);

    const thrown = run.results.find((result) => result.methodId === "joback.normal-boiling-point");
    expect(thrown?.status, "the throwing method should be reported, not swallowed").toBe("failed");
    expect(thrown?.applicability.reasons.join(" ")).toMatch(/simulated engine abort/);
    expect(thrown?.warnings.some((entry) => entry.code === "method.threw")).toBe(true);

    // The whole point of the change: the rest of the suite still ran.
    const ok = run.results.filter((result) => result.status === "ok");
    expect(ok.length, "the other methods should be unaffected").toBeGreaterThan(40);
    expect(
      run.results.some((result) => result.methodId === "rdkit.composition" && result.status === "ok")
    ).toBe(true);

    // Tc is NOT affected, and that is correct rather than a gap in the test: `jobackCriticalTemperature`
    // calls the boiling point through a module-local binding, which a module mock does not replace. It
    // makes the point cleanly — the sibling method next door carried on.
    const sibling = run.results.find((result) => result.methodId === "joback.critical-temperature");
    expect(sibling?.status).toBe("ok");
  });
});
