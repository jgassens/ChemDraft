import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import * as ocl from "@chemdraft/ocl-adapter";
import { generateSmiles2DMolfile } from "@chemdraft/rdkit-adapter";
import { smilesListCandidates } from "@chemdraft/clipboard-adapter";
import { depictSmilesForPaste, depictSmilesListForPaste } from "./smilesListPaste";
import { registerRdkitWasmLoader } from "./rdkitWasmLoader";
import { applyClipboardPastePayload, createPhase4Document } from "./documentWorkflow";

vi.mock("./rdkitWasmLoader", () => ({ registerRdkitWasmLoader: vi.fn() }));
vi.mock("@chemdraft/rdkit-adapter", () => ({ generateSmiles2DMolfile: vi.fn() }));

beforeAll(async () => { await ocl.ensureOclResources(); });
beforeEach(() => {
  vi.mocked(generateSmiles2DMolfile).mockReset().mockRejectedValue(new Error("WASM unavailable"));
  vi.mocked(registerRdkitWasmLoader).mockClear();
});
afterEach(() => { vi.restoreAllMocks(); });

describe("depictSmilesForPaste", () => {
  it("prefers RDKit's generated molfile and reports perceived stereocenters", async () => {
    const smiles = "C[C@H](F)Cl";
    const generated = ocl.depictSmiles2D(smiles);
    vi.mocked(generateSmiles2DMolfile).mockResolvedValue(generated.molfile);
    const fallback = vi.spyOn(ocl, "depictSmiles2D");
    const result = await depictSmilesForPaste(smiles);
    expect(registerRdkitWasmLoader).toHaveBeenCalledOnce();
    expect(generateSmiles2DMolfile).toHaveBeenCalledWith(smiles);
    expect(fallback).not.toHaveBeenCalled();
    expect(result?.depiction.atoms).toHaveLength(4);
    expect(result?.depiction.bonds.some((bond) => bond.wedge !== null)).toBe(true);
    expect(result?.stereoCount).toBe(1);
  });

  it("falls back to OpenChemLib when RDKit cannot load", async () => {
    const result = await depictSmilesForPaste("CCO");
    expect(result?.depiction.atoms.map((atom) => atom.element)).toEqual(["C", "C", "O"]);
    expect(result?.depiction.bonds).toHaveLength(2);
    expect(result?.stereoCount).toBe(0);
  });

  it("preserves structured atom charges, bond orders and wedges on V2000 reparse failure", async () => {
    const fallback = ocl.depictSmiles2D("C[C@H](F)Cl");
    fallback.molfile = "overflowed compatibility molfile";
    fallback.atoms[0].charge = 1;
    fallback.bonds[0].order = "aromatic";
    fallback.bonds[1].order = "unknown";
    vi.spyOn(ocl, "depictSmiles2D").mockReturnValue(fallback);
    vi.spyOn(ocl, "perceiveStereoCentersFromMolfile").mockImplementation(() => { throw new Error("Overflow"); });
    const result = await depictSmilesForPaste("C[C@H](F)Cl");
    expect(result?.depiction.atoms).toEqual(fallback.atoms.map(({ element, x, y, charge }) => ({ element, x, y, charge })));
    expect(result?.depiction.bonds).toEqual(fallback.bonds.map(({ from, to, order, wedge }) => ({ from, to, order, wedge })));
    expect(result?.stereoCount).toBe(fallback.bonds.filter((bond) => bond.wedge !== null).length);
  });

  it("returns undefined for invalid or empty input", async () => {
    expect(await depictSmilesForPaste("aspirin")).toBeUndefined();
    expect(await depictSmilesForPaste("")).toBeUndefined();
  });
});

describe("depictSmilesListForPaste", () => {
  it.each([
    "CCO\nc1ccccc1\nCC(=O)O",
    "CCO c1ccccc1 CC(=O)O",
    "1. CCO\n2) c1ccccc1\n(3) CC(=O)O",
    'SMILES\n["CCO", "c1ccccc1", "CC(=O)O"]'
  ])("parses each candidate in order: %s", async (text) => {
    const result = await depictSmilesListForPaste(text, smilesListCandidates(text));
    expect(result?.entries.map((entry) => entry.smiles)).toEqual(["CCO", "c1ccccc1", "CC(=O)O"]);
    expect(result?.entries.map((entry) => entry.depiction.atoms.length)).toEqual([3, 6, 4]);
  });

  it("keeps duplicates and skips invalid tokens without losing later entries", async () => {
    const text = "CCO aspirin\nCCN caffeine\nCCO";
    const result = await depictSmilesListForPaste(text, smilesListCandidates(text));
    expect(result?.entries.map((entry) => entry.smiles)).toEqual(["CCO", "CCN", "CCO"]);
    expect(result?.skipped).toBe(2);
    expect(vi.mocked(generateSmiles2DMolfile).mock.calls.map(([smiles]) => smiles)).toEqual(["CCO", "CCN", "CCO"]);
  });

  it("accepts .smi first-token structures even with long names and blank lines", async () => {
    const text = "CCO ethanol common solvent\n\nCCN ethylamine primary amine\n";
    const result = await depictSmilesListForPaste(text, smilesListCandidates(text));
    expect(result?.entries.map((entry) => entry.smiles)).toEqual(["CCO", "CCN"]);
    expect(result?.skipped).toBe(6);
  });

  it.each([
    "Add the CO and CS",
    "Please add CO carefully",
    "ethanol common solvent CCO\nethylamine primary amine CCN",
    "CCO",
    "",
    "InChI=1S/CH4/h1H4"
  ])("declines prose or a non-list: %s", async (text) => {
    expect(await depictSmilesListForPaste(text, smilesListCandidates(text))).toBeUndefined();
  });

  it("leaves declined prose available to the unchanged editable-text paste path", async () => {
    const text = "Add the CO and CS";
    const parsed = await depictSmilesListForPaste(text, smilesListCandidates(text));
    expect(parsed).toBeUndefined();
    const result = applyClipboardPastePayload(createPhase4Document("Prose"), {
      kind: "plain-text", text, sourceType: "text/plain", warnings: []
    }, { x: 100, y: 100 });
    expect(result.status).toBe("Pasted editable text");
    expect(result.document.pages[0].objects).toHaveLength(1);
    expect(result.document.pages[0].objects[0]).toMatchObject({ type: "text", text });
  });

  it.each([
    "Please add CO carefully",
    "The reaction mixture was stirred carefully before the solvent was removed. ".repeat(20)
  ])("declines prose with fewer than two strict candidates synchronously, without an engine: %s", (text) => {
    const fallback = vi.spyOn(ocl, "depictSmiles2D");
    const candidates = smilesListCandidates(text);
    expect(candidates.length).toBeLessThan(2);
    // MainWindow inserts text directly on this return value, without awaiting a promise.
    expect(depictSmilesListForPaste(text, candidates)).toBeUndefined();
    expect(registerRdkitWasmLoader).not.toHaveBeenCalled();
    expect(generateSmiles2DMolfile).not.toHaveBeenCalled();
    expect(fallback).not.toHaveBeenCalled();
  });

  it("reports progress every ten candidates only for lists longer than twenty", async () => {
    const progress = vi.fn();
    const text = Array.from({ length: 25 }, () => "CCO").join(" ");
    expect((await depictSmilesListForPaste(text, smilesListCandidates(text), progress))?.entries).toHaveLength(25);
    expect(progress.mock.calls).toEqual([[10, 25], [20, 25]]);
    progress.mockClear();
    const small = "CCO CCN";
    await depictSmilesListForPaste(small, smilesListCandidates(small), progress);
    expect(progress).not.toHaveBeenCalled();
  });
});
