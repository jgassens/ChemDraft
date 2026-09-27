import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createRdkitAdapter, resetRdkitForTesting } from "@chemdraft/rdkit-adapter";

import { createPhase4Document } from "../documentWorkflow";
import { registerRdkitWasmLoader } from "../rdkitWasmLoader";
import { preparePluginStructureRecognition } from "./pluginStructureRecognition";
import type { StructureRecognitionOutcome } from "./structureRecognitionEngine";

/*
 * The app's validation path, run for real. Only the WASM loader's *source* is swapped: the app's
 * loader needs Vite's `?raw`/`?url` imports, so the mock registers the Node loader instead — at the
 * moment the app's registration is called, and not before. The RDKit adapter itself is not mocked,
 * so if validation reaches it without registering first, it rejects exactly as it did in the app:
 * "RDKit module loader not set (call setRdkitModuleLoader)".
 */
vi.mock("../rdkitWasmLoader", async () => {
  const { installRealRdkitModuleLoader } = await import("@chemdraft/rdkit-adapter/testing");
  return { registerRdkitWasmLoader: vi.fn(() => installRealRdkitModuleLoader()) };
});

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

const outcome: Extract<StructureRecognitionOutcome, { status: "recognized" }> = {
  status: "recognized",
  smiles: "C=O",
  molfile,
  confidence: 0.91,
  atoms: [],
  bonds: [],
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

beforeEach(() => {
  resetRdkitForTesting();
  vi.mocked(registerRdkitWasmLoader).mockClear();
});

afterAll(() => {
  resetRdkitForTesting();
});

describe("recognition validation reaches RDKit only after the app loader is registered", () => {
  it("control: the unmocked adapter rejects when no loader has been registered", async () => {
    await expect(
      createRdkitAdapter().validateStructure({ format: "molfile-v2000", value: molfile })
    ).rejects.toThrow(/module loader not set/);
  });

  it("the default validator registers the loader, then validates with real RDKit", async () => {
    const prepared = await preparePluginStructureRecognition(outcome, image, createPhase4Document());

    expect(registerRdkitWasmLoader).toHaveBeenCalledTimes(1);
    if (prepared.status !== "recognized") {
      throw new Error(`expected a recognized result, got: ${JSON.stringify(prepared)}`);
    }
    expect(prepared.result.proposedMolfile).toBe(molfile);
  }, 60_000);

  it("reports an unsanitizable structure through real RDKit instead of crashing", async () => {
    const tripleBondedOxygen = {
      ...outcome,
      molfile: molfile.replace("  1  2  2  0  0  0  0", "  1  2  3  0  0  0  0")
    };

    const prepared = await preparePluginStructureRecognition(tripleBondedOxygen, image, createPhase4Document());

    expect(registerRdkitWasmLoader).toHaveBeenCalled();
    expect(prepared.status).toBe("failed");
    if (prepared.status === "failed") expect(prepared.message).not.toMatch(/module loader not set/);
  }, 60_000);
});
