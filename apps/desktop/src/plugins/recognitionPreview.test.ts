import { ProposedDocumentPatchSchema } from "@chemdraft/plugin-api";
import { describe, expect, it, vi } from "vitest";

import { createPhase4Document } from "../documentWorkflow";
import { preparePluginStructureRecognition } from "./pluginStructureRecognition";
import { recognitionStructurePreview } from "./recognitionPreview";

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

const recognition = {
  sourceImageRef: "data:image/png;base64,iVBORw==",
  proposedMolfile: molfile,
  confidenceTier: "high" as const
};

async function proposal() {
  const prepared = await preparePluginStructureRecognition(
    {
      status: "recognized",
      smiles: "C=O",
      molfile,
      confidence: 0.95,
      atoms: [],
      bonds: [],
      elapsedMs: 10,
      engine: { name: "MolScribe", molscribeCommit: "abc123", modelSha256: "a".repeat(64) }
    },
    { mediaType: "image/png", bytes: new Uint8Array([1]), width: 1, height: 1, source: "file" },
    createPhase4Document(),
    vi.fn(async () => ({ valid: true, errors: [], warnings: [] }))
  );
  if (prepared.status !== "recognized" || !prepared.result.proposedPatch) throw new Error("expected a patch");
  return ProposedDocumentPatchSchema.parse({ ...prepared.result.proposedPatch, recognition });
}

describe("recognitionStructurePreview", () => {
  it("draws the proposed molecule with the host exporter, cropped to the molecule", async () => {
    const preview = recognitionStructurePreview(await proposal());
    expect(preview).toMatch(/^data:image\/svg\+xml;charset=utf-8,/);
    const svg = decodeURIComponent(preview!.slice(preview!.indexOf(",") + 1));
    expect(svg).toMatch(/^<svg /);
    expect(svg).toContain(">O<");
    expect(svg).not.toMatch(/viewBox="0 0 /);
  });

  it("draws nothing for proposals that are not recognitions or not a molecule insertion", async () => {
    const recognized = await proposal();
    expect(recognitionStructurePreview({ ...recognized, recognition: undefined })).toBeUndefined();
    expect(
      recognitionStructurePreview({
        ...recognized,
        patch: { op: "removeObject", pageId: "page_001", objectId: "mol_001" } as typeof recognized.patch
      })
    ).toBeUndefined();
  });
});
