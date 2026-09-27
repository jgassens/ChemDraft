import { PluginHost } from "@chemdraft/plugin-host";
import type { PluginProvidedImage, RecognitionConfidenceTier, RecognitionWarning } from "@chemdraft/plugin-api";
import { describe, expect, it, vi } from "vitest";

import { createPhase4Document } from "../documentWorkflow";
import { proposalReviewItem } from "./PatchReviewTray";
import { preparePluginStructureRecognition } from "./pluginStructureRecognition";
import {
  RECOGNITION_SCALE_DISAGREEMENT_CODE,
  capRecognitionConfidenceTier,
  hostRecognitionConfidenceTier,
  recognitionAgreementLevel,
  recognitionDisagreementWarning,
  recognitionSingleSizeWarning
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

const image: PluginProvidedImage = { mediaType: "image/png", bytes: new Uint8Array([1]), width: 1, height: 1, source: "file" };
/** The host's own preview of `image`: its one byte, base64-encoded. */
const HOST_PREVIEW = "data:image/png;base64,AQ==";

async function prepareOutcome(agreement: StructureRecognitionAgreement, confidence = 0.97) {
  const prepared = await preparePluginStructureRecognition(
    {
      status: "recognized",
      smiles: "C=O",
      molfile,
      confidence,
      atoms: [],
      bonds: [],
      agreement,
      elapsedMs: 10,
      engine: { name: "MolScribe", molscribeCommit: "abc123", modelSha256: "a".repeat(64) }
    },
    image,
    createPhase4Document(),
    vi.fn(async () => ({ valid: true, errors: [], warnings: [] }))
  );
  if (prepared.status !== "recognized") throw new Error("expected a recognized result");
  return prepared;
}

async function prepare(agreement: StructureRecognitionAgreement) {
  return (await prepareOutcome(agreement)).result;
}

/**
 * What the review shows when the host recognized the image with `agreement` and a plugin — the
 * published MolScribe plugin's shape, without `document.read` — proposed the result claiming `tier`,
 * passing `warnings`, and echoing `structure` as the molfile and a preview of its own choosing.
 */
async function reviewed(
  agreement: StructureRecognitionAgreement,
  tier: RecognitionConfidenceTier,
  warnings: RecognitionWarning[] = [],
  structure = molfile
) {
  const outcome = await prepareOutcome(agreement);
  const host = new PluginHost({
    now: () => "2026-09-27T00:00:00.000Z",
    requestImage: async () => ({ status: "provided", image }),
    recognizeStructure: async () => outcome
  });
  host.registerPlugin(
    {
      id: "org.chemdraft.ocsr.molscribe",
      name: "Structure from Image",
      version: "0.1.0",
      apiVersion: "^0.1.6",
      entry: "dist/plugin.js",
      permissions: ["image.read", "ml.inference", "model.load", "native.execute", "document.proposePatch"],
      contributes: { commands: [{ id: "plugin.molscribeOcsr.recognizeImage", title: "Recognize" }] }
    },
    {
      commandHandlers: {
        "plugin.molscribeOcsr.recognizeImage": async (context) => {
          const acquired = await context.images!.requestImage({ title: "Choose" });
          if (acquired.status !== "provided") throw new Error("no image");
          const result = await context.recognition!.recognizeStructure(acquired.image);
          if (result.status !== "recognized") throw new Error("not recognized");
          await context.documents.proposePatch({
            ...result.result.proposedPatch!,
            reason: `Insert the recognized structure (${tier} confidence).`,
            warnings,
            recognition: {
              sourceImageRef: "data:image/png;base64,iVBORw==",
              proposedSmiles: "CCO",
              proposedMolfile: structure,
              confidenceTier: tier
            }
          });
        }
      }
    }
  );
  await host.invokeCommand("plugin.molscribeOcsr.recognizeImage");
  const [queued] = host.listProposedPatches("pending");
  return proposalReviewItem(host, queued!);
}

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

describe("the host's tier: the score's tier, capped by agreement", () => {
  it("is carried on the recognized result for the plugin host to keep, never chosen by the plugin", async () => {
    expect((await prepareOutcome(UNANIMOUS)).hostReview).toEqual({ confidenceTier: "high" });
    expect((await prepareOutcome(SPLIT)).hostReview).toEqual({ confidenceTier: "low" });
    expect((await prepareOutcome(TWO_THIRDS, 0.7)).hostReview).toEqual({ confidenceTier: "medium" });
    expect((await prepareOutcome(UNANIMOUS, 0.3)).hostReview).toEqual({ confidenceTier: "low" });
  });

  it("maps a missing score to missing, and caps it only on a split vote", () => {
    expect(hostRecognitionConfidenceTier(null, UNANIMOUS)).toBe("missing");
    expect(hostRecognitionConfidenceTier(null, SPLIT)).toBe("low");
    expect(hostRecognitionConfidenceTier(0.85, UNANIMOUS)).toBe("high");
    expect(hostRecognitionConfidenceTier(0.84, UNANIMOUS)).toBe("medium");
    expect(hostRecognitionConfidenceTier(0.9, SINGLE)).toBe("medium");
  });
});

describe("the review shows the host's tier and warnings whatever the plugin claims", () => {
  it("keeps high for a unanimous recognition", async () => {
    const item = await reviewed(UNANIMOUS, "high");
    expect(item.recognition?.confidenceTier).toBe("high");
    expect(item.warnings).toEqual([]);
  });

  it.each([
    ["an early stop at 4 of 5", EARLY_STOP],
    ["two thirds", TWO_THIRDS]
  ])("shows %s as medium, with the warning even if the plugin dropped it", async (_label, agreement) => {
    const item = await reviewed(agreement, "high");
    expect(item.recognition?.confidenceTier).toBe("medium");
    expect(item.warnings).toEqual([recognitionDisagreementWarning(agreement)]);
    // The plugin's claim does not move the tier either way.
    expect((await reviewed(agreement, "low")).recognition?.confidenceTier).toBe("medium");
  });

  it("shows a single-size reading as medium, with its warning even if the plugin dropped it", async () => {
    const item = await reviewed(SINGLE, "high");
    expect(item.recognition?.confidenceTier).toBe("medium");
    expect(item.warnings).toEqual([recognitionSingleSizeWarning()]);
    expect((await reviewed(SINGLE, "high", [recognitionSingleSizeWarning()])).warnings).toEqual([
      recognitionSingleSizeWarning()
    ]);
  });

  it("shows a split vote as low, and does not repeat a warning the plugin passed on", async () => {
    const passedOn = [
      recognitionDisagreementWarning(SPLIT),
      { code: "recognition.stereochemistry-uncertain", message: "Check stereochemistry." }
    ];
    const item = await reviewed(SPLIT, "high", passedOn);
    expect(item.recognition?.confidenceTier).toBe("low");
    expect(item.warnings).toEqual(passedOn);
    expect((await reviewed(SPLIT, "medium")).recognition?.confidenceTier).toBe("low");
    // A plugin passing warnings: [] cannot hide the host's.
    expect((await reviewed(SPLIT, "high", [])).warnings).toEqual([recognitionDisagreementWarning(SPLIT)]);
  });

  it("ignores the plugin's preview, SMILES and reason", async () => {
    const item = await reviewed(SPLIT, "high");
    expect(item.recognition?.sourceImageRef).toBe(HOST_PREVIEW);
    expect(item.recognition?.proposedSmiles).toBe("C=O");
    expect(item.reason).toBe("Insert the locally recognized structure after review.");
  });

  it.each([
    ["trimmed", molfile.trim()],
    ["re-line-ended", molfile.replace(/\n/g, "\r\n")],
    ["padded", `\n${molfile}\n\n`],
    ["a different structure", molfile.replace("Recognized formaldehyde", "Some other structure")]
  ])("keeps the cap when the plugin echoes the molfile %s", async (_label, structure) => {
    const item = await reviewed(SPLIT, "high", [], structure);
    expect(item.recognition?.confidenceTier).toBe("low");
    expect(item.recognition?.proposedMolfile).toBe(molfile);
    expect(item.warnings).toEqual([recognitionDisagreementWarning(SPLIT)]);
  });

  it("never shows high unless unanimous over several sizes, for every possible vote of up to 15 runs", async () => {
    for (let runs = 1; runs <= 15; runs += 1) {
      for (let agreeing = 1; agreeing <= runs; agreeing += 1) {
        const agreement = { runs, agreeing, invalidRuns: runs - agreeing, scalesPx: FULL_VOTE.slice(0, runs) };
        const tier = (await reviewed(agreement, "high")).recognition?.confidenceTier;
        const expected =
          agreeing === runs && runs > 1 ? "high" : agreeing * 3 >= runs * 2 ? "medium" : "low";
        expect(tier, `${agreeing} of ${runs}`).toBe(expected);
      }
    }
  });

  it("keeps each recognition's own record: a later unanimous reading does not lift an earlier split one", async () => {
    const earlier = reviewed(SPLIT, "high");
    await reviewed(UNANIMOUS, "high");
    expect((await earlier).recognition?.confidenceTier).toBe("low");
  });
});
