import type { PluginHost, QueuedProposedPatch } from "@chemdraft/plugin-host";
import type { RecognitionConfidenceTier } from "@chemdraft/plugin-api";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { createPhase4Document } from "../documentWorkflow";
import { proposalReviewItem } from "./PatchReviewTray";
import { preparePluginStructureRecognition } from "./pluginStructureRecognition";
import {
  RECOGNITION_SCALE_DISAGREEMENT_CODE,
  capRecognitionConfidenceTier,
  recognitionAgreementLevel,
  recognitionDisagreementWarning,
  recognitionSingleSizeWarning,
  resetRecognitionAgreementsForTesting
} from "./recognitionAgreement";
import type { StructureRecognitionAgreement } from "./structureRecognitionEngine";

const molfile = [
  "Recognized formaldehyde",
  "  MolScribe",
  "",
  "  2  1  0  0  0  0            999 V2000",
  "   -0.7500    0.0000    0.0000 C   0  0  0  0  0  0  0  0  0  0  0  0",
  "    0.7500    0.0000    0.0000 O   0  0  0  0  0  0  0  0  0  0  0  0",
  "  1  2  2  0  0  0  0",
  "M  END"
].join("\n");

const FIRST_PASS = [800, 900, 1000, 1100, 1200];
const FULL_VOTE = [760, 800, 840, 880, 900, 920, 960, 1000, 1040, 1080, 1100, 1120, 1160, 1200, 1240];
const UNANIMOUS: StructureRecognitionAgreement = { runs: 5, agreeing: 5, invalidRuns: 0, scalesPx: FIRST_PASS };
// A small image (long side ≤ ~379 px) is read at one size only: nothing to compare it with.
const SINGLE: StructureRecognitionAgreement = { runs: 1, agreeing: 1, invalidRuns: 0, scalesPx: [300] };
// The adaptive stop: 4 of the 5 first-pass sizes agreed.
const EARLY_STOP: StructureRecognitionAgreement = { runs: 5, agreeing: 4, invalidRuns: 1, scalesPx: FIRST_PASS };
// Exactly two thirds of a full vote.
const TWO_THIRDS: StructureRecognitionAgreement = { runs: 15, agreeing: 10, invalidRuns: 2, scalesPx: FULL_VOTE };
// A plurality that is not two thirds (the simulated 1x brevetoxin screenshot: mostly unparsable).
const SPLIT: StructureRecognitionAgreement = { runs: 15, agreeing: 3, invalidRuns: 12, scalesPx: FULL_VOTE };

async function prepare(agreement: StructureRecognitionAgreement, structure = molfile) {
  const prepared = await preparePluginStructureRecognition(
    {
      status: "recognized",
      smiles: "C=O",
      molfile: structure,
      confidence: 0.97,
      atoms: [],
      bonds: [],
      agreement,
      elapsedMs: 10,
      engine: { name: "MolScribe", molscribeCommit: "abc123", modelSha256: "a".repeat(64) }
    },
    { mediaType: "image/png", bytes: new Uint8Array([1]), width: 1, height: 1, source: "file" },
    createPhase4Document(),
    vi.fn(async () => ({ valid: true, errors: [], warnings: [] }))
  );
  if (prepared.status !== "recognized") throw new Error("expected a recognized result");
  return prepared.result;
}

/** What the review shows for a proposal a plugin built with the given tier and warnings. */
function reviewed(
  tier: RecognitionConfidenceTier,
  warnings: { code: string; message: string }[] = [],
  structure = molfile
) {
  const host = { getPlugin: () => ({ manifest: { name: "Structure from Image" } }) } as unknown as PluginHost;
  const queued = {
    id: "proposal-1",
    pluginId: "org.chemdraft.ocsr.molscribe",
    proposal: {
      patch: { op: "addObject" },
      reason: "Insert the recognized structure.",
      warnings,
      requiresUserApproval: true,
      recognition: {
        sourceImageRef: "data:image/png;base64,iVBORw==",
        proposedMolfile: structure,
        confidenceTier: tier
      }
    }
  } as unknown as QueuedProposedPatch;
  return proposalReviewItem(host, queued);
}

beforeEach(() => {
  resetRecognitionAgreementsForTesting();
});

describe("recognition agreement levels", () => {
  it("classifies unanimous, two-thirds and split votes over all runs, unparsable ones included", () => {
    expect(recognitionAgreementLevel(UNANIMOUS)).toBe("unanimous");
    // One reading agreeing with itself is no cross-size evidence.
    expect(recognitionAgreementLevel(SINGLE)).toBe("single");
    expect(recognitionAgreementLevel(EARLY_STOP)).toBe("supermajority");
    expect(recognitionAgreementLevel(TWO_THIRDS)).toBe("supermajority");
    expect(recognitionAgreementLevel({ ...TWO_THIRDS, agreeing: 9 })).toBe("split");
    // 2 of 3 is two thirds; a bare majority of a larger vote is not.
    expect(recognitionAgreementLevel({ runs: 3, agreeing: 2, invalidRuns: 0, scalesPx: [760, 800, 840] })).toBe(
      "supermajority"
    );
    expect(recognitionAgreementLevel({ ...TWO_THIRDS, agreeing: 8 })).toBe("split");
    expect(recognitionAgreementLevel(SPLIT)).toBe("split");
    expect(recognitionAgreementLevel({ runs: 2, agreeing: 1, invalidRuns: 1, scalesPx: [450, 800] })).toBe("split");
  });

  it("never leaves a high tier on a result the runs did not all agree on", () => {
    const tiers: RecognitionConfidenceTier[] = ["high", "medium", "low", "missing"];
    expect(tiers.map((tier) => capRecognitionConfidenceTier(tier, "unanimous"))).toEqual(tiers);
    expect(tiers.map((tier) => capRecognitionConfidenceTier(tier, "single"))).toEqual([
      "medium",
      "medium",
      "low",
      "missing"
    ]);
    expect(tiers.map((tier) => capRecognitionConfidenceTier(tier, "supermajority"))).toEqual([
      "medium",
      "medium",
      "low",
      "missing"
    ]);
    expect(tiers.map((tier) => capRecognitionConfidenceTier(tier, "split"))).toEqual(["low", "low", "low", "low"]);
  });

  it("names how many readings agreed", () => {
    expect(recognitionDisagreementWarning(SPLIT)).toEqual({
      code: RECOGNITION_SCALE_DISAGREEMENT_CODE,
      message:
        "Recognition gave different answers at different image sizes; check the structure carefully. " +
        "Only 3 of 15 readings agreed."
    });
    expect(recognitionDisagreementWarning(EARLY_STOP).message).toMatch(/Only 4 of 5 readings agreed\.$/);
  });
});

describe("recognition results carry the disagreement warning", () => {
  it("adds no warning when every size agreed", async () => {
    const result = await prepare(UNANIMOUS);
    expect(result.warnings).toEqual([]);
    expect(result.proposedPatch?.warnings).toEqual([]);
  });

  it.each([
    ["an early stop at 4 of 5", EARLY_STOP],
    ["two thirds", TWO_THIRDS],
    ["a split vote", SPLIT]
  ])("warns first, on the result and on the patch, for %s", async (_label, agreement) => {
    const result = await prepare(agreement);
    const warning = recognitionDisagreementWarning(agreement);
    expect(result.warnings[0]).toEqual(warning);
    expect(result.proposedPatch?.warnings[0]).toEqual(warning);
    expect(warning.message).toContain(`Only ${agreement.agreeing} of ${agreement.runs} readings agreed.`);
  });

  it("warns that a single-size reading could not be checked", async () => {
    const result = await prepare(SINGLE);
    expect(result.warnings[0]).toEqual({
      code: "recognition.single-size",
      message: "This image was too small to check at several sizes; check the structure carefully."
    });
    expect(result.proposedPatch?.warnings[0]).toEqual(recognitionSingleSizeWarning());
  });
});

describe("the host caps the plugin's confidence tier in review", () => {
  it("keeps the plugin's tier for a unanimous recognition", async () => {
    await prepare(UNANIMOUS);
    const item = reviewed("high");
    expect(item.recognition?.confidenceTier).toBe("high");
    expect(item.warnings).toEqual([]);
  });

  it.each([
    ["an early stop at 4 of 5", EARLY_STOP],
    ["two thirds", TWO_THIRDS]
  ])("shows %s as medium at most, with the warning even if the plugin dropped it", async (_label, agreement) => {
    await prepare(agreement);
    const item = reviewed("high");
    expect(item.recognition?.confidenceTier).toBe("medium");
    expect(item.warnings).toEqual([recognitionDisagreementWarning(agreement)]);
    expect(reviewed("low").recognition?.confidenceTier).toBe("low");
  });

  it("shows a single-size reading as medium at most, with its warning even if the plugin dropped it", async () => {
    await prepare(SINGLE);
    const item = reviewed("high");
    expect(item.recognition?.confidenceTier).toBe("medium");
    expect(item.warnings).toEqual([recognitionSingleSizeWarning()]);
    expect(reviewed("high", [recognitionSingleSizeWarning()]).warnings).toEqual([recognitionSingleSizeWarning()]);
  });

  it("shows less than two thirds as low, and does not repeat a warning the plugin passed on", async () => {
    await prepare(SPLIT);
    const passedOn = [
      recognitionDisagreementWarning(SPLIT),
      { code: "recognition.stereochemistry-uncertain", message: "Check stereochemistry." }
    ];
    const item = reviewed("high", passedOn);
    expect(item.recognition?.confidenceTier).toBe("low");
    expect(item.warnings).toEqual(passedOn);
    expect(reviewed("medium").recognition?.confidenceTier).toBe("low");
    expect(reviewed("high").warnings).toEqual([recognitionDisagreementWarning(SPLIT)]);
  });

  it("never shows high unless unanimous over several sizes, for every possible vote of up to 15 runs", async () => {
    for (let runs = 1; runs <= 15; runs += 1) {
      for (let agreeing = 1; agreeing <= runs; agreeing += 1) {
        resetRecognitionAgreementsForTesting();
        await prepare({ runs, agreeing, invalidRuns: runs - agreeing, scalesPx: FULL_VOTE.slice(0, runs) });
        const tier = reviewed("high").recognition?.confidenceTier;
        const expected =
          agreeing === runs && runs > 1 ? "high" : agreeing * 3 >= runs * 2 ? "medium" : "low";
        expect(tier, `${agreeing} of ${runs}`).toBe(expected);
      }
    }
  });

  it("leaves a proposal this host did not recognize as the plugin sent it", async () => {
    await prepare(SPLIT);
    const other = molfile.replace("Recognized formaldehyde", "Some other structure");
    const item = reviewed("high", [], other);
    expect(item.recognition?.confidenceTier).toBe("high");
    expect(item.warnings).toEqual([]);
  });

  it("uses the latest recognition of the same structure", async () => {
    await prepare(SPLIT);
    await prepare(UNANIMOUS);
    expect(reviewed("high").recognition?.confidenceTier).toBe("high");
  });
});
