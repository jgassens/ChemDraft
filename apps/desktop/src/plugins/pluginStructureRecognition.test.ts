import { describe, expect, it, vi } from "vitest";

import { createPhase4Document } from "../documentWorkflow";
import { preparePluginStructureRecognition } from "./pluginStructureRecognition";
import type { StructureRecognitionOutcome } from "./structureRecognitionEngine";

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

const outcome: Extract<StructureRecognitionOutcome, { status: "recognized" }> = {
  status: "recognized",
  smiles: "C=O",
  molfile,
  confidence: 0.91,
  atoms: [
    { index: 0, symbol: "C", x: -0.75, y: 0, confidence: 0.9 },
    { index: 1, symbol: "O", x: 0.75, y: 0, confidence: 0.92 }
  ],
  bonds: [{ begin: 0, end: 1, bondType: "double", confidence: 0.89 }],
  agreement: { runs: 5, agreeing: 5, invalidRuns: 0, scalesPx: [800, 900, 1000, 1100, 1200] },
  elapsedMs: 80,
  engine: { name: "MolScribe", molscribeCommit: "abc123", modelSha256: "a".repeat(64) }
};

const image = {
  mediaType: "image/png" as const,
  bytes: new Uint8Array([137, 80, 78, 71]),
  width: 120,
  height: 80,
  source: "file" as const,
  fileName: "structure.png"
};

describe("preparePluginStructureRecognition", () => {
  it("reuses native MOL import to build an editable proposal at the page center", async () => {
    const document = createPhase4Document();
    const validate = vi.fn(async () => ({ valid: true, errors: [], warnings: [] }));

    const prepared = await preparePluginStructureRecognition(outcome, image, document, validate);

    expect(validate).toHaveBeenCalledWith({ format: "molfile-v2000", value: molfile });
    expect(prepared.status).toBe("recognized");
    if (prepared.status !== "recognized") throw new Error("expected recognized result");
    expect(prepared.result.sourceImageRef).toBe("data:image/png;base64,iVBORw==");
    expect(prepared.result.proposedPatch?.patch).toMatchObject({
      op: "addObject",
      pageId: document.pages[0]!.id,
      object: {
        type: "molecule",
        structure: molfile,
        structureFormat: "molfile-v2000",
        style: { source: "molscribe-ocsr" }
      }
    });
  });

  it("tells the reviewer about radicals and isotope labels the native drawing cannot show", async () => {
    const validate = vi.fn(async () => ({ valid: true, errors: [], warnings: [] }));
    const labelled = { ...outcome, molfile: molfile.replace("M  END", "M  RAD  1   1   2\nM  ISO  1   2  18\nM  END") };

    const prepared = await preparePluginStructureRecognition(labelled, image, createPhase4Document(), validate);

    if (prepared.status !== "recognized") throw new Error("expected recognized result");
    expect(prepared.result.proposedPatch?.warnings.map((warning) => warning.code)).toEqual([
      "import.radicals_not_drawn",
      "import.isotopes_not_drawn"
    ]);
  });

  it("reports invalid chemistry and never constructs a proposal", async () => {
    const validate = vi.fn(async () => ({
      valid: false,
      errors: [{ code: "sanitize", message: "The recognized molfile could not be sanitized." }],
      warnings: []
    }));

    const prepared = await preparePluginStructureRecognition(outcome, image, createPhase4Document(), validate);

    expect(prepared).toEqual({
      status: "failed",
      code: "invalidResult",
      message: "The recognized molfile could not be sanitized."
    });
  });
});
