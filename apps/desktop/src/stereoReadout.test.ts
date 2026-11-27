import { afterEach, describe, expect, it, vi } from "vitest";
import { createEmptyDocument, type MoleculeObject } from "@chemdraft/chem-core";
import { createSmilesMolecule, stereoPerceptionMolfile } from "@chemdraft/document-workflow-core";
import * as ocl from "@chemdraft/ocl-adapter";
import { buildObjectCanvasMenu } from "./canvasContextMenuModel";
import { popupNativeCanvasMenu } from "./nativeCanvasContextMenu";
import {
  loadStereoEngine, resetStereoEngineForTests, resolveStereoReadout, stereoReadoutLabel, stereoReadoutMolfile,
  stereoReadoutRequest, stereoReadoutTargetFromPart, type StereoEngine
} from "./stereoReadout";

const tauriInvoke = vi.hoisted(() => vi.fn());
vi.mock("@tauri-apps/api/core", () => ({ invoke: tauriInvoke }));

const engine: StereoEngine = ocl;

function molecule(smiles: string): MoleculeObject {
  return createSmilesMolecule(createEmptyDocument(), { x: 300, y: 250 }, ocl.depictSmiles2D(smiles), smiles);
}
const mirrored = (source: MoleculeObject): MoleculeObject =>
  ({ ...source, atoms: source.atoms.map(atom => ({ ...atom, x: 600 - atom.x })) });
const doubleBond = (source: MoleculeObject) => source.bonds.find(bond => bond.order === "double")!;

// Expected descriptors were checked with `pnpm -s chemdraft stereo --smiles ...` (2026-11-24):
// [C@H] ibuprofen → atom 10 S, [C@@H] → R, unwedged → unspecified; C/C=C/C → E, C/C=C\C → Z.
const S_IBUPROFEN = "CC(C)Cc1ccc(cc1)[C@H](C)C(=O)O";
const R_IBUPROFEN = "CC(C)Cc1ccc(cc1)[C@@H](C)C(=O)O";
const STEREOCENTRE_INDEX = 10;

describe("stereo readout from the existing OCL perceiver", () => {
  it("reads R/S from a drawn wedge, and the opposite from its mirror image", () => {
    const s = molecule(S_IBUPROFEN);
    const centre = s.atoms[STEREOCENTRE_INDEX]!;
    expect(centre.element).toBe("C");
    expect(s.bonds.some(bond => (bond.fromAtomId === centre.id || bond.toAtomId === centre.id) &&
      (bond.display?.bondStyle === "wedge" || bond.display?.bondStyle === "hashed"))).toBe(true);
    expect(stereoReadoutLabel({ molecule: s, atomId: centre.id }, engine)).toBe("Stereocenter: S");
    expect(stereoReadoutLabel({ molecule: mirrored(s), atomId: centre.id }, engine)).toBe("Stereocenter: R");
    const r = molecule(R_IBUPROFEN);
    expect(stereoReadoutLabel({ molecule: r, atomId: r.atoms[STEREOCENTRE_INDEX]!.id }, engine)).toBe("Stereocenter: R");
  });

  it("shows nothing for a non-stereogenic atom or an undrawn stereocentre", () => {
    const s = molecule(S_IBUPROFEN);
    expect(stereoReadoutLabel({ molecule: s, atomId: s.atoms[0]!.id }, engine)).toBeUndefined();
    const racemic = molecule("CC(C)Cc1ccc(cc1)C(C)C(=O)O");
    expect(engine.perceiveStereoCentersFromMolfile).toBeDefined();
    expect(stereoReadoutLabel({ molecule: racemic, atomId: racemic.atoms[STEREOCENTRE_INDEX]!.id }, engine)).toBeUndefined();
    expect(stereoReadoutLabel({ molecule: s, atomId: "missing" }, engine)).toBeUndefined();
  });

  it("reads E/Z on a defined double bond and nothing on an unspecified or non-double bond", () => {
    const e = molecule("C/C=C/C"), z = molecule("C/C=C\\C");
    expect(stereoReadoutLabel({ molecule: e, bondId: doubleBond(e).id }, engine)).toBe("Double bond: E");
    expect(stereoReadoutLabel({ molecule: z, bondId: doubleBond(z).id }, engine)).toBe("Double bond: Z");
    const either = { ...e, bonds: e.bonds.map(bond => bond.order === "double" ? { ...bond, stereo: "either" as const } : bond) };
    expect(stereoReadoutLabel({ molecule: either, bondId: doubleBond(either).id }, engine)).toBeUndefined();
    const terminal = molecule("C=CC");
    expect(stereoReadoutLabel({ molecule: terminal, bondId: doubleBond(terminal).id }, engine)).toBeUndefined();
    expect(stereoReadoutLabel({ molecule: e, bondId: e.bonds.find(bond => bond.order === "single")!.id }, engine)).toBeUndefined();
  });

  it("shows nothing when the engine throws, and never recomputes CIP itself", () => {
    const s = molecule(S_IBUPROFEN);
    const failing: StereoEngine = {
      perceiveStereoCentersFromMolfile: () => { throw new Error("engine down"); },
      perceiveDoubleBondStereoFromMolfile: () => { throw new Error("engine down"); }
    };
    expect(stereoReadoutLabel({ molecule: s, atomId: s.atoms[STEREOCENTRE_INDEX]!.id }, failing)).toBeUndefined();
    const fixed: StereoEngine = {
      perceiveStereoCentersFromMolfile: vi.fn(() => s.atoms.map(() => ({ isStereoCenter: true, descriptor: "R" as const }))),
      perceiveDoubleBondStereoFromMolfile: vi.fn(() => [])
    };
    // Whatever the engine says is what the row says: the label is the engine's descriptor.
    expect(stereoReadoutLabel({ molecule: s, atomId: s.atoms[STEREOCENTRE_INDEX]!.id }, fixed)).toBe("Stereocenter: R");
    expect(fixed.perceiveStereoCentersFromMolfile).toHaveBeenCalledOnce();
  });
});

/** Collapses the atoms after `keepIndex` in `removeFrom..` into one labelled atom at `keepIndex`,
 * the way a drawn abbreviation stands in for a group. */
function abbreviate(source: MoleculeObject, keepIndex: number, removeFrom: number, label: string): MoleculeObject {
  const kept = source.atoms[keepIndex]!.id;
  const removed = new Set(source.atoms.slice(removeFrom).map(atom => atom.id));
  return {
    ...source,
    atoms: source.atoms.filter(atom => !removed.has(atom.id)).map(atom => atom.id === kept ? { ...atom, element: label } : atom),
    bonds: source.bonds.filter(bond => !removed.has(bond.fromAtomId) && !removed.has(bond.toAtomId))
  };
}
const relabel = (source: MoleculeObject, index: number, label: string): MoleculeObject =>
  ({ ...source, atoms: source.atoms.map((atom, i) => i === index ? { ...atom, element: label } : atom) });

// (S)-1-phenylethylamine: atom 1 is the centre (N > Ph > CH3 > H); atom 3 is the ipso carbon.
const S_PHENYLETHYLAMINE = "N[C@@H](C)c1ccccc1";

describe("molecules with placeholder atoms show no row (AGENTS.md §8)", () => {
  it("declines a centre next to Ph, where the engine's placeholder reading is wrong", () => {
    const expanded = molecule(S_PHENYLETHYLAMINE);
    const centreId = expanded.atoms[1]!.id;
    expect(stereoReadoutLabel({ molecule: expanded, atomId: centreId }, engine)).toBe("Stereocenter: S");
    const ph = abbreviate(expanded, 3, 4, "Ph");
    expect(ph.atoms.map(atom => atom.element)).toEqual(["N", "C", "C", "Ph"]);
    // The perceiver alone would answer R here: the "Ph" placeholder does not rank as phenyl.
    expect(engine.perceiveStereoCentersFromMolfile(stereoPerceptionMolfile(ph))[1]).toEqual({ isStereoCenter: true, descriptor: "R" });
    expect(stereoReadoutMolfile(ph)).toBeUndefined();
    expect(stereoReadoutLabel({ molecule: ph, atomId: centreId }, engine)).toBeUndefined();
  });

  it.each(["Ph", "CH3", "OMe", "R1", "R", "*", "Et"])("declines every atom and bond in a molecule holding a %s label", label => {
    // The label sits on a methyl far from the centre, and still nothing is shown for the molecule.
    const s = relabel(molecule(S_IBUPROFEN), 0, label);
    expect(stereoReadoutMolfile(s)).toBeUndefined();
    expect(stereoReadoutLabel({ molecule: s, atomId: s.atoms[STEREOCENTRE_INDEX]!.id }, engine)).toBeUndefined();
    const e = relabel(molecule("C/C=C/CC"), 4, label);
    expect(stereoReadoutLabel({ molecule: e, bondId: doubleBond(e).id }, engine)).toBeUndefined();
  });

  it("still reads R/S and E/Z in plain molecules, including D and T isotope symbols", () => {
    const s = molecule(S_IBUPROFEN);
    expect(stereoReadoutMolfile(s)).toBe(stereoPerceptionMolfile(s));
    expect(stereoReadoutLabel({ molecule: s, atomId: s.atoms[STEREOCENTRE_INDEX]!.id }, engine)).toBe("Stereocenter: S");
    // A drawn "D" or "T" atom is written as that symbol, which is hydrogen, not a placeholder.
    for (const isotope of ["D", "T"]) {
      const labelled = relabel(molecule("C/C=C/CC"), 4, isotope);
      expect(stereoReadoutMolfile(labelled)?.split("\n")[8]?.slice(31, 34).trim()).toBe(isotope);
      expect(stereoReadoutLabel({ molecule: labelled, bondId: doubleBond(labelled).id }, engine)).toBe("Double bond: E");
    }
  });

  it("keeps the index mapping across a disconnected second component", () => {
    // Two ibuprofen components in one molecule object, S then R; the second centre is atom 15 + 10.
    const two = molecule(`${S_IBUPROFEN}.${R_IBUPROFEN}`);
    expect(two.atoms).toHaveLength(30);
    expect(stereoReadoutLabel({ molecule: two, atomId: two.atoms[STEREOCENTRE_INDEX]!.id }, engine)).toBe("Stereocenter: S");
    expect(stereoReadoutLabel({ molecule: two, atomId: two.atoms[15 + STEREOCENTRE_INDEX]!.id }, engine)).toBe("Stereocenter: R");
    expect(stereoReadoutLabel({ molecule: two, atomId: two.atoms[15]!.id }, engine)).toBeUndefined();
    // A labelled atom in either component declines the whole molecule object.
    const labelled = relabel(two, 15, "Ph");
    expect(stereoReadoutLabel({ molecule: labelled, atomId: labelled.atoms[STEREOCENTRE_INDEX]!.id }, engine)).toBeUndefined();
    // A Ph in a different molecule object leaves this one alone.
    const other = abbreviate(molecule(S_PHENYLETHYLAMINE), 3, 4, "Ph");
    expect(stereoReadoutLabel({ molecule: other, atomId: other.atoms[1]!.id }, engine)).toBeUndefined();
    expect(stereoReadoutLabel({ molecule: two, atomId: two.atoms[15 + STEREOCENTRE_INDEX]!.id }, engine)).toBe("Stereocenter: R");
  });

  it("reports ring E/Z exactly as the engine does, and nothing where it reports none", () => {
    // Expected values checked against perceiveDoubleBondStereoFromMolfile (2026-11-24).
    for (const [smiles, expected] of [
      ["C1=C\\CCCCCC/1", "Double bond: Z"], // cis-cyclooctene
      ["C1=C/CCCCCC/1", "Double bond: E"], // trans-cyclooctene
      ["C1=CCCCC1", undefined] // cyclohexene: the engine assigns no E/Z
    ] as const) {
      const ring = molecule(smiles);
      const bond = doubleBond(ring);
      const index = (id: string) => ring.atoms.findIndex(atom => atom.id === id);
      const reported = engine.perceiveDoubleBondStereoFromMolfile(stereoPerceptionMolfile(ring)).find(entry =>
        [entry.from, entry.to].sort().join() === [index(bond.fromAtomId), index(bond.toAtomId)].sort().join());
      const engineLabel = reported?.descriptor === "E" || reported?.descriptor === "Z" ? `Double bond: ${reported.descriptor}` : undefined;
      expect(stereoReadoutLabel({ molecule: ring, bondId: bond.id }, engine), smiles).toBe(engineLabel);
      expect(engineLabel, smiles).toBe(expected);
    }
  });
});

describe("lazy engine loading", () => {
  afterEach(() => resetStereoEngineForTests());

  it("loads the engine once and resolves the label", async () => {
    const s = molecule(S_IBUPROFEN);
    const importer = vi.fn(async () => engine);
    const load = () => loadStereoEngine(importer);
    const request = stereoReadoutRequest(s, { kind: "atom", atomId: s.atoms[STEREOCENTRE_INDEX]!.id }, load)!;
    expect(await request()).toBe("Stereocenter: S");
    expect(await request()).toBe("Stereocenter: S");
    expect(importer).toHaveBeenCalledOnce();
  });

  it("resolves undefined when the engine is unavailable, and retries the load next time", async () => {
    const s = molecule(S_IBUPROFEN);
    const target = { molecule: s, atomId: s.atoms[STEREOCENTRE_INDEX]!.id };
    const importer = vi.fn().mockRejectedValueOnce(new Error("chunk failed")).mockResolvedValue(engine);
    await expect(resolveStereoReadout(target, () => loadStereoEngine(importer))).resolves.toBeUndefined();
    await expect(resolveStereoReadout(target, () => loadStereoEngine(importer))).resolves.toBe("Stereocenter: S");
    expect(importer).toHaveBeenCalledTimes(2);
  });

  it("the default loader imports the real adapter", async () => {
    const loaded = await loadStereoEngine();
    expect(loaded.perceiveStereoCentersFromMolfile).toBe(ocl.perceiveStereoCentersFromMolfile);
  });

  it("only atoms and bonds carry a readout target", () => {
    const s = molecule(S_IBUPROFEN);
    expect(stereoReadoutTargetFromPart(s, { kind: "ring" })).toBeUndefined();
    expect(stereoReadoutTargetFromPart(undefined, { kind: "atom", atomId: "a" })).toBeUndefined();
    expect(stereoReadoutRequest(s, { kind: "parts" })).toBeUndefined();
    expect(stereoReadoutTargetFromPart(s, { kind: "bond", bondId: "b" })).toEqual({ molecule: s, bondId: "b" });
  });
});

// One Tauri command serves both macOS and Windows (canvas_context_menu.rs has no platform branch).
describe("native canvas menu path (macOS and Windows)", () => {
  afterEach(() => { tauriInvoke.mockReset(); vi.useRealTimers(); });
  const items = buildObjectCanvasMenu({ objectIndex: 0, objectCount: 1, targetKind: "atom" });

  it("puts the readout first as a disabled, unroutable item", async () => {
    tauriInvoke.mockResolvedValue("canvas-context:any:0");
    const result = await popupNativeCanvasMenu(items, { x: 1, y: 2 }, { loadStereoReadout: async () => "Stereocenter: R" });
    const [, args] = tauriInvoke.mock.calls[0]!;
    const sent = (args as { items: Array<Record<string, unknown>> }).items;
    expect(sent[0]).toMatchObject({ kind: "item", label: "Stereocenter: R", enabled: false });
    expect(sent[1]).toEqual({ kind: "separator" });
    expect(sent[2]).toMatchObject({ label: "Cut" });
    // Selecting the readout row (were the OS to report it) invokes nothing.
    const invoke = vi.fn();
    expect(result!.select(invoke)).toBe(false);
    expect(invoke).not.toHaveBeenCalled();
  });

  it("omits the row when the readout is undefined or rejects", async () => {
    tauriInvoke.mockResolvedValue(null);
    await popupNativeCanvasMenu(items, { x: 1, y: 2 }, { loadStereoReadout: async () => undefined });
    await popupNativeCanvasMenu(items, { x: 1, y: 2 }, { loadStereoReadout: () => Promise.reject(new Error("x")) });
    for (const [, args] of tauriInvoke.mock.calls) {
      expect((args as { items: Array<{ label?: string }> }).items[0]!.label).toBe("Cut");
    }
  });

  it("opens without the row rather than waiting on a slow engine load", async () => {
    vi.useFakeTimers();
    tauriInvoke.mockResolvedValue(null);
    const pending = popupNativeCanvasMenu(items, { x: 1, y: 2 }, {
      loadStereoReadout: () => new Promise(() => {}), stereoReadoutBudgetMs: 50
    });
    await vi.advanceTimersByTimeAsync(50);
    await pending;
    expect((tauriInvoke.mock.calls[0]![1] as { items: Array<{ label?: string }> }).items[0]!.label).toBe("Cut");
  });
});
