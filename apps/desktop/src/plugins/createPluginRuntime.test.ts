import type { PluginSelectionSnapshot } from "@chemdraft/plugin-api";
import { describe, expect, it, vi } from "vitest";

import { createPhase4Document } from "../documentWorkflow";
import { RECOGNITION_FIXTURE_COMMAND_ID, recognitionFixtureDescriptor } from "../testSupport/recognitionFixturePlugin";
import { createPluginRuntime } from "./createPluginRuntime";
import { ImageSourceRegistry } from "./ImageSourceProvider";
import { proposalReviewItem } from "./PatchReviewTray";
import { recognitionDisagreementWarning } from "./recognitionAgreement";
import type {
  StructureRecognitionAgreement,
  StructureRecognitionEngine,
  StructureRecognitionEngineStatus,
  StructureRecognitionOutcome
} from "./structureRecognitionEngine";

const emptySelection: PluginSelectionSnapshot = { objectIds: [], molecules: [] };

const molfile = [
  "Recognized carbon monoxide",
  "  MolScribe",
  "",
  "  2  1  0  0  0  0            999 V2000",
  "   -0.7500    0.0000    0.0000 C   0  0  0  0  0  0  0  0  0  0  0  0",
  "    0.7500    0.0000    0.0000 O   0  0  0  0  0  0  0  0  0  0  0  0",
  "  1  2  2  0  0  0  0",
  "M  END"
].join("\n");

const SPLIT: StructureRecognitionAgreement = {
  runs: 15,
  agreeing: 3,
  invalidRuns: 12,
  scalesPx: [760, 800, 840, 880, 900, 920, 960, 1000, 1040, 1080, 1100, 1120, 1160, 1200, 1240]
};

function installedEngine(outcome: StructureRecognitionOutcome): StructureRecognitionEngine {
  const status: StructureRecognitionEngineStatus = { state: "installed", requiredDiskBytes: 0, freeDiskBytes: 0 };
  return {
    status: vi.fn(async () => status),
    install: vi.fn(async () => status),
    cancelInstall: vi.fn(async () => undefined),
    uninstall: vi.fn(async () => status),
    recognizeImage: vi.fn(async () => outcome)
  };
}

describe("createPluginRuntime recognition review", () => {
  it("carries the host's agreement-capped tier from the engine to the review, whatever the plugin claims", async () => {
    const document = createPhase4Document();
    const runtime = createPluginRuntime({
      getActiveDocument: () => document,
      getSelection: () => emptySelection,
      now: () => "2026-09-27T00:00:00.000Z",
      structureRecognitionEngine: installedEngine({
        status: "recognized",
        smiles: "C=O",
        molfile,
        confidence: 0.97,
        atoms: [
          { index: 0, symbol: "C", x: -0.75, y: 0, confidence: 0.9 },
          { index: 1, symbol: "O", x: 0.75, y: 0, confidence: 0.92 }
        ],
        bonds: [{ begin: 0, end: 1, bondType: "double", confidence: 0.89 }],
        agreement: SPLIT,
        elapsedMs: 80,
        engine: { name: "MolScribe", molscribeCommit: "abc123", modelSha256: "a".repeat(64) }
      }),
      recognitionStructureValidator: async () => ({ valid: true, errors: [], warnings: [] }),
      imageSourceRegistry: new ImageSourceRegistry([
        {
          id: "file",
          label: "File",
          isAvailable: async () => true,
          acquire: async () => ({
            mediaType: "image/png",
            bytes: new Uint8Array([1, 2, 3]),
            width: 320,
            height: 200,
            source: "file",
            fileName: "split.png"
          })
        }
      ])
    });
    // The fixture recognizer claims "high" and passes on only the warnings it was handed.
    const fixture = recognitionFixtureDescriptor();
    runtime.registerPlugin(fixture.manifest, fixture.options);

    const invocation = runtime.host.invokeCommand(RECOGNITION_FIXTURE_COMMAND_ID);
    await vi.waitFor(() => expect(runtime.images.getOpenRequest()).toBeDefined());
    await runtime.images.acquire(runtime.images.getOpenRequest()!.id, "file");
    const outcome = await invocation;
    // The plugin never sees the host's review facts.
    expect(JSON.stringify(outcome)).not.toContain("hostReview");

    const [queued] = runtime.host.listProposedPatches("pending");
    const item = proposalReviewItem(runtime.host, queued!);
    expect(item.recognition).toMatchObject({
      confidenceTier: "low",
      sourceImageRef: "data:image/png;base64,AQID",
      proposedSmiles: "C=O",
      proposedMolfile: molfile
    });
    expect(item.warnings[0]).toEqual(recognitionDisagreementWarning(SPLIT));
  });
});
