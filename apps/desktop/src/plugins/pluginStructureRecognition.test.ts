import type { MoleculeObject } from "@chemdraft/chem-core";
import { PluginRecognitionResultSchema } from "@chemdraft/plugin-api";
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

  it("omits missing atom and bond scores instead of rejecting the result, and says they are missing", async () => {
    const validate = vi.fn(async () => ({ valid: true, errors: [], warnings: [] }));
    const partial: typeof outcome = {
      ...outcome,
      confidence: null,
      atoms: [
        { index: 0, symbol: "C", x: null, y: null, confidence: null },
        { index: 1, symbol: "O", x: 0.75, y: 0, confidence: 0.92 }
      ],
      bonds: [{ begin: 0, end: 1, bondType: "double", confidence: null }]
    };

    const prepared = await preparePluginStructureRecognition(partial, image, createPhase4Document(), validate);

    if (prepared.status !== "recognized") throw new Error("expected recognized result");
    // The SDK's own schema is what the host parses the result with, after keeping `hostReview` for
    // itself; it must accept the rest.
    const { hostReview, ...pluginFacing } = prepared;
    expect(hostReview).toEqual({ confidenceTier: "missing" });
    expect(PluginRecognitionResultSchema.safeParse(pluginFacing).success).toBe(true);
    expect(prepared.result.atomConfidence).toEqual([{ id: "1", confidence: 0.92 }]);
    expect(prepared.result.bondConfidence).toEqual([]);
    const missing = prepared.result.warnings.find((warning) => warning.code === "recognition.missing_confidence");
    expect(missing?.message).toContain("2 of 3");
    expect(prepared.result.proposedPatch?.warnings).toContainEqual(missing);
  });

  it("adds no missing-confidence warning when every atom and bond is scored", async () => {
    const validate = vi.fn(async () => ({ valid: true, errors: [], warnings: [] }));
    const prepared = await preparePluginStructureRecognition(outcome, image, createPhase4Document(), validate);
    if (prepared.status !== "recognized") throw new Error("expected recognized result");
    expect(prepared.result.warnings.map((warning) => warning.code)).not.toContain("recognition.missing_confidence");
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

  // The proposal is one addObject patch, which cannot carry radical-dot marks, so a radical or a stated
  // hydrogen count the shared MOL import now reads is deliberately not applied here: the drawn
  // chemistry is what it was before, and the reviewer is told (AGENTS.md section 7).
  describe("radicals and stated hydrogen counts in a recognized molfile", () => {
    const atomLine = (x: number, symbol: string, extra: { charge?: number; valence?: number } = {}) =>
      `${x.toFixed(4).padStart(10)}${(0).toFixed(4).padStart(10)}${(0).toFixed(4).padStart(10)} ${symbol.padEnd(3)} 0` +
      `${String(extra.charge ?? 0).padStart(3)}  0  0  0${String(extra.valence ?? 0).padStart(3)}  0  0  0  0  0  0`;
    const build = (second: { charge?: number; valence?: number }, props: string[] = []) => [
      "Recognized ethanol-like", "  MolScribe", "", "  2  1  0  0  0  0            999 V2000",
      atomLine(-0.75, "C"), atomLine(0.75, "O", second), "  1  2  1  0  0  0  0", ...props, "M  END"
    ].join("\n");
    const recognize = async (text: string) => {
      const validate = vi.fn(async () => ({ valid: true, errors: [], warnings: [] }));
      const prepared = await preparePluginStructureRecognition({ ...outcome, molfile: text }, image, createPhase4Document(), validate);
      if (prepared.status !== "recognized") throw new Error("expected recognized result");
      const patch = prepared.result.proposedPatch!;
      return { object: (patch.patch as unknown as { object: MoleculeObject }).object, warnings: patch.warnings };
    };

    it.each([
      ["V2000 charge code 4", build({ charge: 4 })],
      ["M  RAD", build({}, ["M  RAD  1   2   2"])]
    ])("%s: the proposal is drawn closed-shell as before, with a warning that names the atom", async (_name, text) => {
      const plain = await recognize(build({}));
      const { object, warnings } = await recognize(text);
      expect(object.atoms.every((atom) => atom.markRadicals === undefined && atom.hydrogenCount === undefined)).toBe(true);
      expect(object.chemistry).toEqual(plain.object.chemistry);
      expect(object.structure).toBe(text);
      expect(warnings.map((warning) => warning.code)).toEqual(["import.radicals_not_drawn"]);
      expect(warnings[0]!.message).toMatch(/atom 2 \(O\)/);
    });

    it("a stated count that differs from the derived one is not applied to the drawing, and is named", async () => {
      const plain = await recognize(build({}));
      const { object, warnings } = await recognize(build({ valence: 1 }));
      expect(object.atoms.every((atom) => atom.hydrogenCount === undefined)).toBe(true);
      expect(object.chemistry).toEqual(plain.object.chemistry);
      expect(warnings.map((warning) => warning.code)).toEqual(["import.hydrogen_counts_not_drawn"]);
      expect(warnings[0]!.message).toMatch(/atom 2 \(O\)/);
    });

    it("says nothing about a stated count that agrees with the derived one", async () => {
      const { warnings } = await recognize(build({ valence: 2 }));
      expect(warnings).toEqual([]);
    });
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
