import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import * as ocl from "@chemdraft/ocl-adapter";
import { generateSmiles2DMolfile } from "@chemdraft/rdkit-adapter";
import { smilesListCandidates } from "@chemdraft/clipboard-adapter";
import { SmilesListPasteError, depictSmilesForPaste, depictSmilesListForPaste, unspecifiedDoubleBondNotice } from "./smilesListPaste";
import { depictInWorker } from "./depiction2d/depict";
import { depictSmilesOffThread } from "./depiction2d/client";
import { registerRdkitWasmLoader } from "./rdkitWasmLoader";
import { applyClipboardPastePayload, createPhase4Document, insertSmilesMoleculeGrid, insertSmilesMoleculeGridStatus } from "./documentWorkflow";
import { SmilesPasteIdentityError, SmilesIdentityEngineUnavailableError } from "./smilesPasteIdentity";
import { templateMoleculeForSmiles } from "./structureTemplateInsertion";

// These cases exercise generic depiction; template identity/layout has its own real-engine tests.
vi.mock("./structureTemplateInsertion", () => ({ templateMoleculeForSmiles: vi.fn().mockResolvedValue(undefined) }));
vi.mock("./depiction2d/client", () => ({ depictSmilesOffThread: vi.fn() }));
vi.mock("./rdkitWasmLoader", () => ({ registerRdkitWasmLoader: vi.fn() }));
vi.mock("@chemdraft/rdkit-adapter", () => ({ generateSmiles2DMolfile: vi.fn() }));

beforeAll(async () => { await ocl.ensureOclResources(); });
beforeEach(() => {
  vi.mocked(templateMoleculeForSmiles).mockReset().mockResolvedValue(undefined);
  vi.mocked(generateSmiles2DMolfile).mockReset().mockRejectedValue(new Error("WASM unavailable"));
  vi.mocked(registerRdkitWasmLoader).mockClear();
  vi.mocked(depictSmilesOffThread).mockReset().mockImplementation((smiles) => depictInWorker(smiles, (input, options) => {
    registerRdkitWasmLoader();
    return generateSmiles2DMolfile(input, options);
  }, () => {}));
});
afterEach(() => { vi.restoreAllMocks(); });

describe("depictSmilesForPaste", () => {
  it("prefers RDKit's generated molfile and reports perceived stereocenters", async () => {
    const smiles = "C[C@H](F)Cl";
    const generated = ocl.depictSmiles2D(smiles);
    vi.mocked(generateSmiles2DMolfile).mockResolvedValue(generated.molfile);
    const fallback = vi.spyOn(ocl, "depictSmiles2D");
    const result = await depictSmilesForPaste(smiles);
    expect(depictSmilesOffThread).toHaveBeenCalledExactlyOnceWith(smiles, { priority: "interactive" });
    expect(result?.molecule).toBeUndefined();
    expect(registerRdkitWasmLoader).toHaveBeenCalledOnce();
    expect(generateSmiles2DMolfile).toHaveBeenCalledWith(smiles, expect.objectContaining({ onStandardMolfile: expect.any(Function) }));
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

  it.each(["n1cccc1", "c1cccc1"])("propagates the specific chemistry refusal for %s", async (smiles) => {
    await expect(depictSmilesForPaste(smiles)).rejects.toThrow(
      new ocl.UnrequestedSmilesRadicalError(smiles).message
    );
  });

  it("propagates an invented-hydrogen refusal like a radical refusal", async () => {
    await expect(depictSmilesForPaste("O=[N]=O")).rejects.toThrow(
      new ocl.UnrequestedSmilesHydrogenError("O=[N]=O", { bracket: "[N]", atomNumber: 2, written: 0, parsed: 1 }).message
    );
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

  it("returns undefined for whitespace-only input without invoking the depiction worker", async () => {
    expect(await depictSmilesForPaste("")).toBeUndefined();
    expect(await depictSmilesForPaste("   ")).toBeUndefined();
    expect(depictSmilesOffThread).not.toHaveBeenCalled();
  });

  it("propagates a specific worker failure instead of returning a text-paste fallback", async () => {
    vi.mocked(depictSmilesOffThread).mockRejectedValueOnce(new Error("2D depiction worker exited (1)."));
    await expect(depictSmilesForPaste("CCO")).rejects.toThrow("2D depiction worker exited (1).");
  });

  it("keeps fallback deadline warnings for the status path", async () => {
    const result = { depiction: ocl.depictSmiles2D("CCO"), stereoCount: 0,
      warnings: ["2D depiction exceeded its 2000 ms layout deadline; used the standard layout."] };
    vi.mocked(depictSmilesOffThread).mockResolvedValueOnce(result);
    expect((await depictSmilesForPaste("CCO"))?.warnings).toEqual(result.warnings);
  });
});

describe("depictSmilesListForPaste", () => {
  it("inspects each input before template lookup and forwards placement and cancellation together", async () => {
    const document = createPhase4Document("Template placement");
    const centre = { x: 150, y: 180 };
    const reservedObjectIds = new Set<string>(["reserved"]);
    const controller = new AbortController();
    const order: string[] = [];
    const inspectInput = vi.fn(async (smiles: string, signal?: AbortSignal) => {
      expect(signal).toBe(controller.signal);
      order.push(`inspect:${smiles}`);
    });
    vi.mocked(templateMoleculeForSmiles).mockImplementation(async smiles => {
      order.push(`template:${smiles}`);
      return undefined;
    });
    const text = "CCO\nCCN";
    const result = await depictSmilesListForPaste(text, smilesListCandidates(text), undefined, {
      signal: controller.signal, inspectInput, templatePlacement: { document, centre, reservedObjectIds }
    });
    expect(result?.entries).toHaveLength(2);
    expect(order).toEqual(["inspect:CCO", "template:CCO", "inspect:CCN", "template:CCN"]);
    expect(templateMoleculeForSmiles).toHaveBeenNthCalledWith(1, "CCO", document, centre, reservedObjectIds);
    expect(templateMoleculeForSmiles).toHaveBeenNthCalledWith(2, "CCN", document, centre, reservedObjectIds);
  });

  it("checks cancellation after input inspection and before template lookup", async () => {
    const controller = new AbortController();
    const text = "CCO\nCCN";
    await expect(depictSmilesListForPaste(text, smilesListCandidates(text), undefined, {
      signal: controller.signal, inspectInput: async () => { controller.abort(); }
    })).rejects.toMatchObject({ name: "AbortError" });
    expect(templateMoleculeForSmiles).not.toHaveBeenCalled();
    expect(depictSmilesOffThread).not.toHaveBeenCalled();
  });

  it("records an empty depiction as an item failure and continues the list", async () => {
    vi.mocked(depictSmilesOffThread).mockResolvedValueOnce({ depiction: { atoms: [], bonds: [] }, stereoCount: 0 });
    const text = "CCO\nCCN\nCCC";
    const result = await depictSmilesListForPaste(text, smilesListCandidates(text));
    expect(result?.entries.map(entry => entry.smiles)).toEqual(["CCN", "CCC"]);
    expect(result?.failures).toEqual([{ input: "CCO", error: "The 2D depiction engine returned no atoms." }]);
    expect(result?.skipped).toBe(0);
    expect(result?.skippedItems).toEqual([]);
  });

  it("keeps identity-engine refusals in the per-line report with their own reason", async () => {
    const text = "CCO\nCCN";
    const result = await depictSmilesListForPaste(text, smilesListCandidates(text), undefined, {
      inspectInput: async smiles => {
        if (smiles === "CCO") throw new SmilesIdentityEngineUnavailableError("test WASM unavailable");
      }
    });
    expect(result?.entries.map(entry => entry.smiles)).toEqual(["CCN"]);
    expect(result?.skippedItems).toEqual([{ line: 1, token: "CCO",
      reason: "the structure could not be verified because the RDKit engine did not load: test WASM unavailable" }]);
    expect(result?.skipped).toBe(result?.skippedItems.length);
  });

  it.each([
    [["C1CC("], "; skipped line 2: 'C1CC(' (not valid SMILES)"],
    [["C1CC(", "C2CC(", "C3CC("], "; skipped line 2: 'C1CC(' (not valid SMILES); skipped line 3: 'C2CC(' (not valid SMILES); skipped line 4: 'C3CC(' (not valid SMILES)"],
    [["C1CC(", "C2CC(", "C3CC(", "C4CC(", "C5CC("], "; skipped line 2: 'C1CC(' (not valid SMILES); skipped line 3: 'C2CC(' (not valid SMILES); skipped line 4: 'C3CC(' (not valid SMILES); and 2 more"],
    [["C".repeat(40) + "1"], `; skipped line 2: '${"C".repeat(23)}…' (not valid SMILES)`]
  ] as const)("names skipped lines and caps their status: %j", async (badTokens, suffix) => {
    // Keep enough valid rows to qualify as a list, even when five entries are bad.
    const text = ["CCO", ...badTokens, "CCN", "CCC", "CCCC", "CCCCC"].join("\r\n");
    const parsed = await depictSmilesListForPaste(text, smilesListCandidates(text));
    expect(parsed?.skipped).toBe(badTokens.length);
    expect(parsed?.skippedItems).toEqual(badTokens.map((token, index) => ({ line: index + 2, token, reason: "not valid SMILES" })));
    const grid = insertSmilesMoleculeGrid(createPhase4Document("Skipped lines"), { x: 100, y: 100 }, parsed!.entries);
    const base = insertSmilesMoleculeGridStatus(grid, 0);
    expect(insertSmilesMoleculeGridStatus(grid, parsed!.skipped, parsed!.skippedItems)).toBe(base + suffix);
  });

  it("keeps original line numbers and identifies tokens rejected before parsing", async () => {
    const text = "CCO aspirin\n\nCCN caffeine";
    const result = await depictSmilesListForPaste(text, smilesListCandidates(text));
    expect(result?.skippedItems).toEqual([
      { line: 1, token: "aspirin", reason: "not valid SMILES" },
      { line: 3, token: "caffeine", reason: "not valid SMILES" }
    ]);
  });

  const refuseStereo = async (smiles: string) => {
    if (smiles.includes("@SP")) throw new SmilesPasteIdentityError(smiles, "unsupported stereo");
  };

  it.each([
    "Use CO with [Pt@SP1] please",
    "Add the CO and CS to N[Pt@SP1](N)(Cl)Cl in DMSO then stir it for an hour at room temperature"
  ])("declines prose containing a refused stereo token: %s", async text => {
    expect(await depictSmilesListForPaste(text, smilesListCandidates(text),
      undefined, { inspectInput: refuseStereo })).toBeUndefined();
  });

  it("recognises a two-line list of refused stereo entries", async () => {
    const text = "N[Pt@SP1](N)(Cl)Cl\nN[Pt@SP2](N)(Cl)Cl";
    const result = await depictSmilesListForPaste(text, smilesListCandidates(text),
      undefined, { inspectInput: refuseStereo });
    expect(result?.entries).toEqual([]);
    expect(result?.failures.map(failure => failure.input)).toEqual(text.split("\n"));
    expect(result?.skipped).toBe(2);
    expect(result?.skippedItems).toEqual(text.split("\n").map((token, index) => ({
      line: index + 1, token, reason: "unsupported stereo"
    })));
    const grid = insertSmilesMoleculeGrid(createPhase4Document("Refused stereo"), { x: 100, y: 100 }, result!.entries);
    expect(insertSmilesMoleculeGridStatus(grid, result!.skipped, result!.skippedItems)).toContain(
      "; skipped line 1: 'N[Pt@SP1](N)(Cl)Cl' (unsupported stereo)");
    expect(depictSmilesOffThread).not.toHaveBeenCalled();
  });

  it("retains deadline warnings for individual list entries", async () => {
    const warning = "2D depiction reached its layout deadline; retried the standard layout in a fresh worker.";
    vi.mocked(depictSmilesOffThread).mockResolvedValueOnce({ depiction: ocl.depictSmiles2D("CCO"), stereoCount: 0, warnings: [warning] });
    const text = "CCO\nCCN";
    const result = await depictSmilesListForPaste(text, smilesListCandidates(text));
    expect(result?.warnings).toEqual([`CCO: ${warning}`]);
  });

  it("totals unspecified E/Z while keeping identity refusals and invalid lines in skipped items", async () => {
    const text = "CC=CC\nN[Pt@SP1](N)(Cl)Cl\nC1CC(\nC/C=C/C\nCC=CC";
    const parsed = await depictSmilesListForPaste(text, smilesListCandidates(text), undefined, { inspectInput: refuseStereo });
    expect(parsed?.entries.map(entry => entry.smiles)).toEqual(["CC=CC", "C/C=C/C", "CC=CC"]);
    expect(parsed?.failures).toEqual([{ input: "N[Pt@SP1](N)(Cl)Cl", error: expect.stringContaining("unsupported stereo") }]);
    expect(parsed?.skipped).toBe(2);
    expect(parsed?.skippedItems).toEqual([
      { line: 2, token: "N[Pt@SP1](N)(Cl)Cl", reason: "unsupported stereo" },
      { line: 3, token: "C1CC(", reason: "not valid SMILES" }
    ]);
    expect(parsed?.warnings).toEqual([unspecifiedDoubleBondNotice(2)]);
    const grid = insertSmilesMoleculeGrid(createPhase4Document(), { x: 100, y: 100 }, parsed!.entries);
    expect(grid.document.pages[0]!.objects.flatMap(object => object.type === "molecule"
      ? object.bonds.filter(bond => bond.stereo === "either") : [])).toHaveLength(2);
    const status = insertSmilesMoleculeGridStatus(grid, parsed!.skipped, parsed!.skippedItems);
    expect(status).toContain("skipped line 2: 'N[Pt@SP1](N)(Cl)Cl' (unsupported stereo)");
    expect(status).toContain("skipped line 3: 'C1CC(' (not valid SMILES)");
  });

  it("cancels a long list before submitting later entries", async () => {
    const controller = new AbortController();
    vi.mocked(depictSmilesOffThread).mockImplementationOnce(async () => {
      controller.abort();
      return { depiction: ocl.depictSmiles2D("CCO"), stereoCount: 0 };
    });
    const text = "CCO\nCCN\nCCC\nCCCC";
    await expect(depictSmilesListForPaste(text, smilesListCandidates(text), undefined, { signal: controller.signal }))
      .rejects.toMatchObject({ name: "AbortError" });
    expect(depictSmilesOffThread).toHaveBeenCalledOnce();
    expect(depictSmilesOffThread).toHaveBeenCalledWith("CCO", { signal: controller.signal, priority: "background" });
  });
  it("records each refused ring and continues with later valid entries", async () => {
    const text = "CCO\nn1cccc1\nc1cccc1\n[nH]1cccc1\nc1ccccc1\nCCN";
    const result = await depictSmilesListForPaste(text, smilesListCandidates(text));
    expect(result?.entries.map((entry) => entry.smiles)).toEqual(["CCO", "[nH]1cccc1", "c1ccccc1", "CCN"]);
    expect(result?.failures).toEqual(["n1cccc1", "c1cccc1"].map((smiles) => ({
      input: smiles, error: new ocl.UnrequestedSmilesRadicalError(smiles).message
    })));
    expect(result?.skipped).toBe(0);
  });

  it("records an invented-hydrogen refusal per item and keeps the valid entries", async () => {
    const text = "CCO\nO=[N]=O\nn1cccc1\n[NH4+]\nCCN";
    const result = await depictSmilesListForPaste(text, smilesListCandidates(text));
    expect(result?.entries.map((entry) => entry.smiles)).toEqual(["CCO", "[NH4+]", "CCN"]);
    expect(result?.failures).toEqual([
      {
        input: "O=[N]=O",
        error: new ocl.UnrequestedSmilesHydrogenError("O=[N]=O", { bracket: "[N]", atomNumber: 2, written: 0, parsed: 1 }).message
      },
      { input: "n1cccc1", error: new ocl.UnrequestedSmilesRadicalError("n1cccc1").message }
    ]);
    expect(result?.skipped).toBe(0);
  });

  it("counts an unparseable SMILES-like item as skipped", async () => {
    const text = "CCO\nC1CC\nCCN\nCCC";
    const result = await depictSmilesListForPaste(text, smilesListCandidates(text));
    expect(result?.entries.map((entry) => entry.smiles)).toEqual(["CCO", "CCN", "CCC"]);
    expect(result?.failures).toEqual([]);
    expect(result?.skipped).toBe(1);
  });

  it("preserves refusal messages even when no list entry can be drawn", async () => {
    const text = "n1cccc1\nc1cccc1";
    await expect(depictSmilesListForPaste(text, smilesListCandidates(text))).rejects.toMatchObject({
      name: "SmilesListPasteError",
      failures: ["n1cccc1", "c1cccc1"].map((input) => ({
        input, error: new ocl.UnrequestedSmilesRadicalError(input).message
      }))
    } satisfies Partial<SmilesListPasteError>);
  });

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

  it("counts all-caps names in an accepted list as skipped", async () => {
    const text = "CCO ETHANOL\nCCN ETHYLAMINE";
    const result = await depictSmilesListForPaste(text, smilesListCandidates(text));
    expect(result?.entries.map((entry) => entry.smiles)).toEqual(["CCO", "CCN"]);
    expect(result?.failures).toEqual([]);
    expect(result?.skipped).toBe(2);
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
