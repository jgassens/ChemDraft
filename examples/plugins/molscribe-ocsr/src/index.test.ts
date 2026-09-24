import {
  RecognizedStructureResultSchema,
  validatePluginManifest,
  type PluginImageRequestResult,
  type PluginPanelReport,
  type PluginRecognitionResult
} from "@chemdraft/plugin-api";
import { PluginHost } from "@chemdraft/plugin-host";
import { describe, expect, it, vi } from "vitest";

import {
  createMolScribeOcsrCommandHandler,
  molscribeOcsrCommandId,
  molscribeOcsrManifest,
  molscribeOcsrPanelId,
  recognitionConfidenceTier,
  recognitionReviewWarnings
} from "./index";

const image = {
  mediaType: "image/png" as const,
  bytes: new Uint8Array([137, 80, 78, 71]),
  width: 640,
  height: 480,
  source: "screenRegion" as const
};

const mockRecognitionFixture = RecognizedStructureResultSchema.parse({
  sourceImageRef: "data:image/png;base64,iVBORw==",
  proposedSmiles: "[C@H+](F)Cl",
  proposedMolfile: [
    "fixture",
    "  ChemDraft",
    "",
    "  2  1  0  0  0  0            999 V2000",
    "    0.0000    0.0000    0.0000 C   0  0  0  0  0  0  0  0  0  0  0  0",
    "    1.0000    0.0000    0.0000 F   0  0  0  0  0  0  0  0  0  0  0  0",
    "  1  2  1  1  0  0  0",
    "M  CHG  1   1   1",
    "M  STY  1   1 SUP",
    "M  END"
  ].join("\n"),
  confidence: 0.42,
  atomConfidence: [{ id: "0", confidence: 0.4 }],
  bondConfidence: [{ id: "0-1-0", confidence: 0.35 }],
  warnings: [],
  proposedPatch: {
    patch: { op: "addObject", pageId: "page_001", object: { id: "mol_ocsr_001" } },
    reason: "Recognized structure",
    requiresUserApproval: true
  },
  engine: { name: "MolScribe", molscribeCommit: "abc123", modelSha256: "d".repeat(64) },
  elapsedMs: 125
});

describe("molscribeOcsrManifest", () => {
  it("targets API 0.1.6 with proposal-only local inference permissions", () => {
    expect(validatePluginManifest(molscribeOcsrManifest)).toMatchObject({ ok: true, errors: [] });
    expect(molscribeOcsrManifest.apiVersion).toBe("^0.1.6");
    expect(molscribeOcsrManifest.permissions).toEqual([
      "image.read",
      "ml.inference",
      "model.load",
      "native.execute",
      "document.proposePatch",
      "ui.menu",
      "ui.panel"
    ]);
    expect(molscribeOcsrManifest.permissions).not.toContain("document.write");
    expect(molscribeOcsrManifest.permissions).not.toContain("model.download");
  });
});

function createHost(recognition: PluginRecognitionResult, reports: PluginPanelReport[] = []) {
  const requestImage = vi.fn(async (): Promise<PluginImageRequestResult> => ({ status: "provided", image }));
  const recognizeStructure = vi.fn(async () => recognition);
  const host = new PluginHost({
    requestImage,
    recognizeStructure,
    showPanelReport: (_pluginId, panelId, report) => {
      expect(panelId).toBe(molscribeOcsrPanelId);
      reports.push(report);
    }
  });
  host.registerPlugin(molscribeOcsrManifest, {
    commandHandlers: { [molscribeOcsrCommandId]: createMolScribeOcsrCommandHandler() }
  });
  return { host, requestImage, recognizeStructure };
}

describe("createMolScribeOcsrCommandHandler", () => {
  it("recognizes the same image and queues a proposal with source, tier, provenance, and applicable warnings", async () => {
    const { host, requestImage, recognizeStructure } = createHost({
      status: "recognized",
      result: mockRecognitionFixture
    });

    await expect(host.invokeCommand(molscribeOcsrCommandId)).resolves.toMatchObject({ status: "recognized" });
    expect(requestImage).toHaveBeenCalledOnce();
    expect(recognizeStructure).toHaveBeenCalledWith(
      expect.objectContaining({ id: molscribeOcsrManifest.id }),
      expect.objectContaining({ width: 640, height: 480, bytes: expect.any(Uint8Array) }),
      expect.any(AbortSignal)
    );
    const [proposal] = host.listProposedPatches("pending");
    expect(proposal.proposal.recognition).toMatchObject({
      sourceImageRef: "data:image/png;base64,iVBORw==",
      proposedSmiles: "[C@H+](F)Cl",
      confidenceTier: "low",
      elapsedMs: 125
    });
    expect(proposal.proposal.warnings.map((warning) => warning.code)).toEqual(
      expect.arrayContaining([
        "recognition.low-confidence",
        "recognition.stereochemistry-uncertain",
        "recognition.charge-radical-uncertain",
        "recognition.abbreviation-superatom-uncertain"
      ])
    );
  });

  it("reports invalid or unsanitized output and never proposes it", async () => {
    const reports: PluginPanelReport[] = [];
    const { host } = createHost(
      { status: "failed", code: "invalidResult", message: "The molfile could not be sanitized." },
      reports
    );
    await expect(host.invokeCommand(molscribeOcsrCommandId)).resolves.toMatchObject({
      status: "failed",
      code: "invalidResult"
    });
    expect(host.listProposedPatches()).toEqual([]);
    expect((reports[0].sections[0] as { body: string }).body).toContain("could not be sanitized");
  });

  it("reports where to install when the user declines or cancels the engine install", async () => {
    const reports: PluginPanelReport[] = [];
    const { host } = createHost({ status: "engineNotInstalled" }, reports);
    await expect(host.invokeCommand(molscribeOcsrCommandId)).resolves.toEqual({ status: "engineNotInstalled" });
    expect(reports[0].sections).toEqual([
      { kind: "text", body: "Recognition needs the local engine. Install it in Add or Remove Plugins." }
    ]);
    expect(host.listProposedPatches()).toEqual([]);
  });

  it("is silent when image acquisition is cancelled", async () => {
    const showPanelReport = vi.fn();
    const host = new PluginHost({ requestImage: async () => ({ status: "cancelled" }), showPanelReport });
    host.registerPlugin(molscribeOcsrManifest, {
      commandHandlers: { [molscribeOcsrCommandId]: createMolScribeOcsrCommandHandler() }
    });

    await expect(host.invokeCommand(molscribeOcsrCommandId)).resolves.toEqual({ status: "cancelled" });
    expect(showPanelReport).not.toHaveBeenCalled();
    expect(host.listProposedPatches()).toEqual([]);
  });
});

describe("recognitionReviewWarnings", () => {
  it("flags missing overall and per-item confidence without inventing a percentage", () => {
    const warnings = recognitionReviewWarnings({
      ...mockRecognitionFixture,
      confidence: null,
      atomConfidence: [],
      bondConfidence: []
    });
    expect(warnings.map((warning) => warning.code)).toContain("recognition.missing-confidence");
    expect(warnings.map((warning) => warning.message).join(" ")).not.toMatch(/\d+%/);
  });
});

const plainMolfile = [
  "ethanol",
  "  RDKit          2D",
  "",
  "  3  2  0  0  0  0  0  0  0  0999 V2000",
  "    0.0000    0.0000    0.0000 C   0  0  0  0  0  0  0  0  0  0  0  0",
  "    1.2990    0.7500    0.0000 C   0  0  0  0  0  0  0  0  0  0  0  0",
  "    2.5981    0.0000    0.0000 O   0  0  0  0  0  0  0  0  0  0  0  0",
  "  1  2  1  0",
  "  2  3  1  0",
  "M  END"
].join("\n");

function fixture(overrides: Partial<ReturnType<typeof RecognizedStructureResultSchema.parse>> = {}) {
  return RecognizedStructureResultSchema.parse({
    sourceImageRef: "data:image/png;base64,iVBORw==",
    proposedSmiles: "CCO",
    proposedMolfile: plainMolfile,
    confidence: 0.95,
    atomConfidence: [
      { id: "0", confidence: 0.97 },
      { id: "1", confidence: 0.96 },
      { id: "2", confidence: 0.95 }
    ],
    bondConfidence: [
      { id: "0-1-0", confidence: 0.98 },
      { id: "1-2-1", confidence: 0.97 }
    ],
    warnings: [],
    ...overrides
  });
}

const codes = (result: ReturnType<typeof fixture>) => recognitionReviewWarnings(result).map((warning) => warning.code);

describe("recognitionReviewWarnings per fixture", () => {
  it("adds no uncertainty warning to a confident, plain structure", () => {
    expect(codes(fixture())).toEqual([]);
  });

  it("flags stereochemistry from SMILES, V2000 wedges, atom parity, and V3000 CFG", () => {
    expect(codes(fixture({ proposedSmiles: "C[C@H](F)Cl" }))).toEqual(["recognition.stereochemistry-uncertain"]);
    expect(codes(fixture({ proposedSmiles: "F/C=C/F" }))).toEqual(["recognition.stereochemistry-uncertain"]);
    expect(codes(fixture({ proposedMolfile: plainMolfile.replace("  1  2  1  0", "  1  2  1  6") }))).toEqual([
      "recognition.stereochemistry-uncertain"
    ]);
    expect(
      codes(
        fixture({
          proposedMolfile: plainMolfile.replace(
            "    1.2990    0.7500    0.0000 C   0  0  0",
            "    1.2990    0.7500    0.0000 C   0  0  1"
          )
        })
      )
    ).toEqual(["recognition.stereochemistry-uncertain"]);
    expect(codes(fixture({ proposedMolfile: "x\n\n\n  0  0  0     0  0            999 V3000\nM  V30 1 1 1 2 CFG=1\nM  END" }))).toEqual([
      "recognition.stereochemistry-uncertain"
    ]);
  });

  it("flags charges and radicals from SMILES, M CHG/RAD, the atom charge field, and V3000", () => {
    expect(codes(fixture({ proposedSmiles: "C[NH3+]" }))).toEqual(["recognition.charge-radical-uncertain"]);
    expect(codes(fixture({ proposedMolfile: plainMolfile.replace("M  END", "M  RAD  1   2   2\nM  END") }))).toEqual([
      "recognition.charge-radical-uncertain"
    ]);
    expect(
      codes(
        fixture({
          proposedMolfile: plainMolfile.replace(
            "    2.5981    0.0000    0.0000 O   0  0",
            "    2.5981    0.0000    0.0000 O   0  5"
          )
        })
      )
    ).toEqual(["recognition.charge-radical-uncertain"]);
    expect(codes(fixture({ proposedMolfile: "x\n\n\nM  V30 3 O 2.5 0 0 0 CHG=-1\nM  END" }))).toEqual([
      "recognition.charge-radical-uncertain"
    ]);
  });

  it("flags abbreviations and superatoms from SMILES labels, aliases, and SUP groups", () => {
    expect(codes(fixture({ proposedSmiles: "*CCO" }))).toEqual(["recognition.abbreviation-superatom-uncertain"]);
    expect(codes(fixture({ proposedSmiles: "[Ph]CO" }))).toEqual(["recognition.abbreviation-superatom-uncertain"]);
    expect(
      codes(fixture({ proposedMolfile: plainMolfile.replace("M  END", "A    1\nOMe\nM  END") }))
    ).toEqual(["recognition.abbreviation-superatom-uncertain"]);
    expect(
      codes(fixture({ proposedMolfile: plainMolfile.replace("M  END", "M  STY  1   1 SUP\nM  END") }))
    ).toEqual(["recognition.abbreviation-superatom-uncertain"]);
  });

  it("flags low overall confidence and low per-atom or per-bond confidence", () => {
    expect(codes(fixture({ confidence: 0.5 }))).toEqual(["recognition.low-confidence"]);
    const perItem = recognitionReviewWarnings(
      fixture({ bondConfidence: [{ id: "0-1-0", confidence: 0.98 }, { id: "1-2-1", confidence: 0.3 }] })
    );
    expect(perItem.map((warning) => warning.code)).toEqual(["recognition.low-confidence"]);
    expect(perItem[0]!.message).toContain("0 atoms and 1 bond");
  });

  it("flags missing confidence, but not an absent bond list for a single atom", () => {
    expect(codes(fixture({ confidence: null }))).toEqual(["recognition.missing-confidence"]);
    expect(codes(fixture({ atomConfidence: [] }))).toEqual(["recognition.missing-confidence"]);
    expect(codes(fixture({ bondConfidence: [] }))).toEqual(["recognition.missing-confidence"]);
    expect(
      codes(fixture({ proposedSmiles: "C", atomConfidence: [{ id: "0", confidence: 0.99 }], bondConfidence: [] }))
    ).toEqual([]);
  });

  it("maps scores to documented tiers without a percentage", () => {
    expect(recognitionConfidenceTier(0.85)).toBe("high");
    expect(recognitionConfidenceTier(0.84)).toBe("medium");
    expect(recognitionConfidenceTier(0.65)).toBe("medium");
    expect(recognitionConfidenceTier(0.64)).toBe("low");
    expect(recognitionConfidenceTier(null)).toBe("missing");
  });
});
