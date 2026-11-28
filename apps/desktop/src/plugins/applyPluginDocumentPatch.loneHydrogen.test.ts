import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createEmptyDocument, moleculeToMolfileV2000, moleculeToMolfileV3000, type BracketObject, type MoleculeAtom, type MoleculeBond, type MoleculeObject
} from "@chemdraft/chem-core";
import { ProposedDocumentPatchSchema } from "@chemdraft/plugin-api";
import { rebasePluginPatch } from "@chemdraft/plugin-host";
import {
  impliedRadicalCacheDeclinedLine, normalizeCommittedDocument, refreshNativeSingleBondGraph, type ImpliedRadicalRefreshTarget
} from "../documentWorkflow";
import {
  applyAcceptedPluginProposal, applyPluginDocumentPatch, rebaseProposedInsertion, refreshPluginPatchChemistry
} from "./applyPluginDocumentPatch";

// Calls the tests count: each native metadata derivation (by the atom ids it read) and each lone-H
// cache refresh of the workflow (by the targets it was given).
const calls = vi.hoisted(() => ({
  metadata: [] as string[][], refreshOf: [] as { pageId: string; objectId: string }[][], refreshAll: 0
}));

// A recompute that throws, for the fail-safe: the native metadata derivation throws for any graph
// holding the atom id "poison-h". Every other graph is derived by the real implementation. Mocked at
// its own module, so the lone-H refresh inside document-workflow-core (which imports it from there)
// sees the mock as well as every caller of the package.
vi.mock("../../../../packages/document-workflow-core/src/atoms", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../../../packages/document-workflow-core/src/atoms")>();
  return {
    ...actual,
    nativeSingleBondGraphMetadata: (...args: Parameters<typeof actual.nativeSingleBondGraphMetadata>) => {
      calls.metadata.push(args[0].map((atom) => atom.id));
      if (args[0].some((atom) => atom.id === "poison-h")) throw new Error("recompute boom");
      return actual.nativeSingleBondGraphMetadata(...args);
    }
  };
});
vi.mock("../documentWorkflow", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../documentWorkflow")>();
  return {
    ...actual,
    rederiveImpliedRadicalChemistryOf: (document: Parameters<typeof actual.rederiveImpliedRadicalChemistryOf>[0],
      targets: Iterable<ImpliedRadicalRefreshTarget>, options?: Parameters<typeof actual.rederiveImpliedRadicalChemistryOf>[2]) => {
      const list = [...targets];
      calls.refreshOf.push(list);
      return actual.rederiveImpliedRadicalChemistryOf(document, list, options);
    },
    withImpliedRadicalChemistryRederived: (...args: Parameters<typeof actual.withImpliedRadicalChemistryRederived>) => {
      calls.refreshAll += 1;
      return actual.withImpliedRadicalChemistryRederived(...args);
    }
  };
});

// A plugin's documents.applyPatch (and an accepted proposal) can insert a molecule object copied from
// a document saved before the H• reading (owner decision 2026-11-23), carrying the old H2 cache. The
// insert re-derives that molecule's cached chemistry before it is verified and committed, in the
// write's one history entry, so the app never shows H2 for a lone H.
describe("a plugin inserting a lone H that carries the old H2 cache", () => {
  afterEach(() => { vi.restoreAllMocks(); });
  const atom = (id: string, element: string, x = 300): MoleculeAtom => ({ id, element, x, y: 300, formalCharge: 0 });
  const molecule = (id: string, atoms: MoleculeAtom[], structure: string, formula: string, x = 290): MoleculeObject => ({
    id, type: "molecule", x, y: 290, width: 20, height: 20, rotation: 0, style: {},
    structureFormat: "smiles", structure, superatoms: [], rGroups: [], atoms, bonds: [],
    chemistry: {
      formula, averageMass: 2.016, exactMass: 2.01565, atomCount: atoms.length, bondCount: 0,
      totalCharge: 0, radicalCount: 0, isotopeLabels: [], stereochemistry: [], warnings: []
    }
  });
  const insert = (pageId: string, objects: MoleculeObject[]) => ProposedDocumentPatchSchema.parse({
    reason: "Insert structure", patch: { op: "batch", patches: objects.map((object) => ({ op: "addObject", pageId, object })) }
  });
  const molecules = (document: ReturnType<typeof createEmptyDocument>) =>
    document.pages[0]!.objects.filter((object): object is MoleculeObject => object.type === "molecule");

  it("re-derives the inserted lone H as H• (formula H, radicalCount 1), selected, with nothing else changed", async () => {
    const before = createEmptyDocument();
    const stale = molecule("lone", [atom("h", "H")], "[HH]", "H2");
    const patch = insert(before.pages[0]!.id, [stale]);
    const { document, receipt } = applyPluginDocumentPatch(before, patch);
    const [lone] = molecules(document);
    expect(lone!.structure).toBe("[H]");
    expect(lone!.chemistry?.formula).toBe("H");
    expect(lone!.chemistry?.radicalCount).toBe(1);
    expect(lone!.atoms).toEqual(stale.atoms);
    expect([lone!.x, lone!.y]).toEqual([stale.x, stale.y]);
    expect(receipt.objectIds).toEqual(["lone"]);
    expect(document.selection.objectIds).toEqual(["lone"]);
    // The commit's own verification accepts it as the native derivation it now is: no further
    // refresh (and no RDKit inspection) is needed, so the write commits as authored, once.
    const normalized = normalizeCommittedDocument(document);
    expect(molecules(normalized)[0]!.chemistry?.formula).toBe("H");
    expect(refreshPluginPatchChemistry(before, normalized, rebasePluginPatch(before, patch))).toBeUndefined();
  });

  it("re-derives a lone H the user accepts from a proposal the same way", () => {
    const before = createEmptyDocument();
    const { document } = applyAcceptedPluginProposal(before, insert(before.pages[0]!.id, [molecule("lone", [atom("h", "H")], "[HH]", "H2")]));
    expect(molecules(document)[0]!.chemistry?.formula).toBe("H");
    expect(molecules(document)[0]!.chemistry?.radicalCount).toBe(1);
  });

  it("inserts molecules without a lone H exactly as authored, and leaves resident molecules alone", () => {
    const base = createEmptyDocument();
    // A stale lone H already on the page: not part of this write, so not re-derived by it.
    const resident = molecule("resident", [atom("r", "H", 100)], "[HH]", "H2", 90);
    const before = { ...base, pages: [{ ...base.pages[0]!, objects: [resident] }] };
    const methane = molecule("methane", [atom("c", "C")], "C-stored", "CH4-stored");
    const typed = molecule("typed", [{ ...atom("t", "H", 340), labelLiteral: true }], "typed-stored", "H-stored", 330);
    const { document } = applyPluginDocumentPatch(before, insert(before.pages[0]!.id, [methane, typed]));
    const [keptResident, insertedMethane, insertedTyped] = molecules(document);
    expect(keptResident).toEqual(resident);
    expect(insertedMethane).toEqual(methane);
    expect(insertedTyped).toEqual(typed);
    expect(document.selection.objectIds).toEqual(["methane", "typed"]);
  });

  it("keeps an inserted molecule whose recompute throws exactly as authored, logs it, and completes the insert", () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const before = createEmptyDocument();
    const poisoned = molecule("poisoned", [atom("poison-h", "H")], "[HH]-stored", "H2-stored");
    const stale = molecule("stale", [atom("h", "H", 360)], "[HH]", "H2", 350);
    const { document, receipt } = applyPluginDocumentPatch(before, insert(before.pages[0]!.id, [poisoned, stale]));
    const [insertedPoisoned, insertedStale] = molecules(document);
    expect(insertedPoisoned).toEqual(poisoned);
    expect(insertedStale!.chemistry?.formula).toBe("H");
    expect(receipt.objectIds).toEqual(["poisoned", "stale"]);
    expect(error).toHaveBeenCalledTimes(1);
    expect(String(error.mock.calls[0]![0])).toContain("poisoned");
    expect(String(error.mock.calls[0]![0])).toContain("on plugin insert");
  });
});

// What a plugin insert (a direct documents.applyPatch, or a proposal the user accepts) makes of a
// molecule with a lone H, as the desktop makes it and verifies it before committing. Its cache is
// refreshed only when it is ChemDraft's own earlier output for the drawing, field for field
// (documentWorkflow's `rederiveImpliedRadicalChemistryOf`), exactly as release/1.2.3 refreshed it;
// any other cache is kept as authored, the write names the molecule in one warning, and the verifier
// then checks the stored chemistry as it checks any insertion: chemistry that disagrees with the
// drawing (stale H2 included) is refused, never corrected (AGENTS.md section 7).
describe("verifying a plugin insert of a lone H's cache", () => {
  afterEach(() => { vi.restoreAllMocks(); });
  const atom = (id: string, element: string, x: number, y = 300): MoleculeAtom => ({ id, element, x, y, formalCharge: 0 });
  const bond = (id: string, fromAtomId: string, toAtomId: string, display?: MoleculeBond["display"]): MoleculeBond =>
    ({ id, fromAtomId, toAtomId, order: "single", ...(display ? { display } : {}) });
  /** A chemistry record in the native writer's key order; radicalCount 0 is the H2 reading's. */
  const record = (formula: string, averageMass: number, exactMass: number, atomCount: number, bondCount: number,
    options: { radicalCount?: number; isotopeLabels?: string[]; stereochemistry?: string[] } = {}) => ({
    formula, averageMass, exactMass, atomCount, bondCount, totalCharge: 0, radicalCount: options.radicalCount ?? 0,
    isotopeLabels: options.isotopeLabels ?? [], stereochemistry: options.stereochemistry ?? [], warnings: []
  });
  const moleculeOf = (id: string, atoms: MoleculeAtom[], bonds: MoleculeBond[], structure: string,
    chemistry: NonNullable<MoleculeObject["chemistry"]>, compatibility?: MoleculeObject["compatibility"]): MoleculeObject => ({
    id, type: "molecule", x: 280, y: 280, width: 70, height: 40, rotation: 0, style: {},
    structureFormat: "smiles", structure, superatoms: [], rGroups: [], atoms, bonds, chemistry, ...(compatibility ? { compatibility } : {})
  });
  // Ethane beside a lone H, as the H2 reading stored it ("CC.[HH]", C2H8, no radical).
  const ethaneH2 = record("C2H8", 32.086, 32.0626, 3, 1);
  const ethane = (structure = "CC.[HH]", chemistry = ethaneH2, compatibility?: MoleculeObject["compatibility"]) =>
    moleculeOf("ethane", [atom("c1", "C", 300), atom("c2", "C", 314, 308), atom("h", "H", 350)], [bond("b1", "c1", "c2")],
      structure, chemistry, compatibility);
  // Ethanol beside a lone H; its H2 reading is "CCO.[HH]", C2H8O.
  const ethanol = (structure: string, compatibility?: MoleculeObject["compatibility"]) => moleculeOf("ethanol",
    [atom("c1", "C", 300), atom("c2", "C", 314, 308), atom("o", "O", 328), atom("h", "H", 350)],
    [bond("b1", "c1", "c2"), bond("b2", "c2", "o")], structure, record("C2H8O", 48.085, 48.05751, 4, 2), compatibility);
  // CHBrClF with F on a wedge (RDKit reads F[C@@H](Cl)Br, atom 0 (S)) beside a lone H.
  const haloAtoms = [atom("c", "C", 300), atom("f", "F", 314), atom("cl", "Cl", 293, 312), atom("br", "Br", 293, 288), atom("h", "H", 340)];
  const haloBonds = [bond("cf", "c", "f", { bondStyle: "wedge" }), bond("ccl", "c", "cl"), bond("cbr", "c", "br")];
  // Saved under the H2 reading with its stereo: "F[C@@H](Cl)Br.[HH]", CH3BrClF, no radical.
  const wedgedH2 = () => moleculeOf("wedged", haloAtoms, haloBonds, "F[C@@H](Cl)Br.[HH]",
    record("CH3BrClF", 149.387, 147.90907, 5, 3, { stereochemistry: ["atom 0 (S)"] }));
  // The drawing's own native record with RDKit's stereo label added and no stored structure: not the
  // native writer's output (it writes no stereo), so kept as authored; it states the drawing (H•) truly.
  const labelled = (): MoleculeObject => {
    const drawn = moleculeOf("labelled", haloAtoms, haloBonds, "", record("C", 0, 0, 0, 0));
    const derived = refreshNativeSingleBondGraph(drawn, haloAtoms, haloBonds);
    return { ...drawn, chemistry: { ...derived.chemistry!, stereochemistry: ["atom 0 (S)"] } };
  };
  const insert = (pageId: string, object: MoleculeObject) => ProposedDocumentPatchSchema.parse({
    reason: "Insert structure", patch: { op: "addObject", pageId, object }
  });
  /** The insert as the desktop makes it, and the verification it runs before committing it. */
  function verify(object: MoleculeObject, accepted: boolean) {
    const before = createEmptyDocument();
    const patch = insert(before.pages[0]!.id, object);
    const applied = (accepted ? applyAcceptedPluginProposal : applyPluginDocumentPatch)(before, patch);
    const authored = accepted ? rebaseProposedInsertion(before, patch) : rebasePluginPatch(before, patch);
    const normalized = normalizeCommittedDocument(applied.document);
    const inserted = () => applied.document.pages[0]!.objects.find((candidate): candidate is MoleculeObject => candidate.type === "molecule")!;
    return { applied, inserted, normalized, verified: refreshPluginPatchChemistry(before, normalized, authored) };
  }
  /** What release/1.2.3 (ddaa4d498) made of a stale molecule: its structure, format and record re-derived, nothing else. */
  const refreshedAt123 = (stored: MoleculeObject) => {
    const derived = refreshNativeSingleBondGraph(stored, stored.atoms, stored.bonds);
    return { structureFormat: derived.structureFormat, structure: derived.structure, chemistry: derived.chemistry };
  };
  const cacheOf = (molecule: MoleculeObject) =>
    ({ structureFormat: molecule.structureFormat, structure: molecule.structure, chemistry: molecule.chemistry });

  it.each([false, true])("refreshes a plain CC.[HH] cache exactly as release/1.2.3 did, with no warning (accepted: %s)", async (accepted) => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const stored = ethane();
    const { applied, inserted, verified } = verify(stored, accepted);
    expect(applied.warnings).toEqual([]);
    expect(cacheOf(inserted())).toEqual(refreshedAt123(stored));
    expect(inserted().structure).toBe("CC.[H]");
    expect(inserted().chemistry?.radicalCount).toBe(1);
    expect(inserted().atoms).toEqual(stored.atoms);
    // The commit's verification accepts the native derivation it now is, as release/1.2.3 did.
    expect(await verified).toBeUndefined();
    expect(warn).not.toHaveBeenCalled();
  }, 60_000);

  // A repeat-unit bracket pair ("n") inserted around the molecule in the same write: chem-core notes on
  // the molecule's record that its values are for one drawn copy (`chemistry.bracket_multiplier`), and
  // the H2 reading's record is compared with that note on it too.
  const BRACKET_NOTE = "chemistry.bracket_multiplier";
  const repeatUnitPair = (moleculeId: string): BracketObject[] => {
    const open: BracketObject = { id: "open", type: "bracket", x: 270, y: 260, width: 8, height: 70, rotation: 0, style: {},
      bracketKind: "square", side: "open", pairId: "pair", repeatUnit: true, containedObjectIds: [moleculeId] };
    return [open, { ...open, id: "close", x: 360, side: "close", label: "n" }];
  };
  it.each([false, true])("refreshes a CC.[HH] cache inserted inside a repeat-unit bracket pair as release/1.2.3 did, and the verifier accepts it (accepted: %s)", async (accepted) => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const stored = ethane();
    const before = createEmptyDocument();
    const pageId = before.pages[0]!.id;
    const patch = ProposedDocumentPatchSchema.parse({ reason: "Insert structure", patch: { op: "batch",
      patches: [stored, ...repeatUnitPair(stored.id)].map((object) => ({ op: "addObject", pageId, object })) } });
    const applied = (accepted ? applyAcceptedPluginProposal : applyPluginDocumentPatch)(before, patch);
    const authored = accepted ? rebaseProposedInsertion(before, patch) : rebasePluginPatch(before, patch);
    const molecule = (document: typeof before) =>
      document.pages[0]!.objects.find((candidate): candidate is MoleculeObject => candidate.type === "molecule")!;
    const inserted = molecule(applied.document);
    expect(applied.warnings).toEqual([]);
    expect(inserted.structure).toBe("CC.[H]");
    expect(inserted.chemistry?.radicalCount).toBe(1);
    // Release/1.2.3's record, with the page's own note kept on it.
    const notes = inserted.chemistry!.warnings.filter((warning) => warning.code === BRACKET_NOTE);
    expect(notes).toHaveLength(1);
    expect(notes[0]!.message).toContain("repeat unit n");
    const at123 = refreshedAt123(stored);
    expect({ structureFormat: inserted.structureFormat, structure: inserted.structure,
      chemistry: { ...inserted.chemistry!, warnings: inserted.chemistry!.warnings.filter((warning) => warning.code !== BRACKET_NOTE) } })
      .toEqual(at123);
    expect(inserted.atoms).toEqual(stored.atoms);
    // The commit's verification accepts it, as release/1.2.3's did.
    const normalized = normalizeCommittedDocument(applied.document);
    const committed = molecule((await refreshPluginPatchChemistry(before, normalized, authored)) ?? normalized);
    expect(committed.structure).toBe("CC.[H]");
    expect(committed.chemistry?.formula).toBe("C2H7");
    expect(committed.chemistry?.radicalCount).toBe(1);
    expect(warn).not.toHaveBeenCalled();
  }, 60_000);

  it.each([false, true])("refreshes a bonded H2 beside a lone D ([2HH].[H][H]) and its cached copy, with no warning (accepted: %s)", async (accepted) => {
    const stored = moleculeOf("h2d", [atom("h1", "H", 300), atom("h2", "H", 314), atom("d", "D", 350)], [bond("hh", "h1", "h2")],
      "[2HH].[H][H]", record("H3D", 5.038, 5.03758, 3, 1, { isotopeLabels: ["2H"] }), { warnings: [], unknown: { smiles: "[2HH].[H][H]" } });
    const { applied, inserted, normalized, verified } = verify(stored, accepted);
    expect(applied.warnings).toEqual([]);
    expect(inserted().structure).toBe("[2H].[H][H]");
    expect(inserted().compatibility?.unknown.smiles).toBe("[2H].[H][H]");
    expect(inserted().chemistry?.formula).toBe("H2D");
    expect(inserted().chemistry?.radicalCount).toBe(1);
    // The verifier checks the refreshed copy against the drawing and accepts it.
    const document = (await verified) ?? normalized;
    const kept = document.pages[0]!.objects.find((candidate): candidate is MoleculeObject => candidate.type === "molecule")!;
    expect(kept.structure).toBe("[2H].[H][H]");
    expect(kept.compatibility?.unknown.smiles).toBe("[2H].[H][H]");
  }, 60_000);

  it.each([false, true])("keeps a wedged F[C@@H](Cl)Br.[HH] as authored, warns once, and the verifier refuses it (accepted: %s)", async (accepted) => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const stored = wedgedH2();
    const { applied, inserted, verified } = verify(stored, accepted);
    expect(applied.warnings).toHaveLength(1);
    expect(applied.warnings[0]).toContain('molecule "wedged"');
    expect(applied.warnings[0]).toContain("not ChemDraft's own earlier output");
    expect(applied.warnings[0]).toContain("was not refreshed");
    // In the words a paste names its kept molecules with.
    expect(applied.warnings[0]).toBe(impliedRadicalCacheDeclinedLine("wedged"));
    expect(cacheOf(inserted())).toEqual(cacheOf(stored));
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0]![0])).toContain("on plugin insert");
    expect(verified).toBeDefined();
    await expect(verified!).rejects.toThrow(/stored structure doesn't match the drawn atoms/);
  }, 60_000);

  // Dimethyl ether (COC) stored for an ethanol drawing: other chemistry than the drawing's, which the
  // refresh must never overwrite.
  const conflicting: [string, MoleculeObject, RegExp][] = [
    ["dimethyl ether in the structure of an ethanol drawing", ethanol("COC.[HH]"), /stored structure doesn't match the drawn atoms/],
    ["dimethyl ether in the cached copy of an ethanol drawing", ethanol("CCO.[HH]", { warnings: [], unknown: { smiles: "COC.[HH]" } }),
      /stored structure doesn't match the drawn atoms/],
    ["CC.[HH] with a [HH].CC copy and a formula claiming C9H99",
      ethane("CC.[HH]", { ...ethaneH2, formula: "C9H99" }, { warnings: [], unknown: { smiles: "[HH].CC" } }),
      /stored structure doesn't match the drawn atoms/],
    // The structure is today's; only the formula claims other chemistry, which the verifier itself refuses.
    ["a formula claiming C9H99 beside today's structure",
      ethane("CC.[H]", record("C9H99", 31.078, 31.05478, 3, 1, { radicalCount: 1 })), /formula doesn't match the drawn structure/],
    ["C(-1)CC1.[HH] stored for a cyclopropane drawing", moleculeOf("ring",
      [atom("r1", "C", 300), atom("r2", "C", 314, 308), atom("r3", "C", 314, 292), atom("h", "H", 350)],
      [bond("k1", "r1", "r2"), bond("k2", "r2", "r3"), bond("k3", "r3", "r1")], "C(-1)CC1.[HH]", record("C3H8", 44.097, 44.0626, 4, 3)),
      /stored structure doesn't match the drawn atoms/]
  ];
  for (const [what, stored, refusal] of conflicting) {
    it.each([false, true])(`keeps ${what} as authored, warns once, and the verifier refuses it (accepted: %s)`, async (accepted) => {
      vi.spyOn(console, "warn").mockImplementation(() => undefined);
      const { applied, inserted, verified } = verify(stored, accepted);
      expect(applied.warnings).toHaveLength(1);
      expect(applied.warnings[0]).toContain(`molecule "${stored.id}"`);
      expect(inserted().structure).toBe(stored.structure);
      expect(inserted().compatibility).toEqual(stored.compatibility);
      expect(inserted().chemistry).toEqual(stored.chemistry);
      expect(verified).toBeDefined();
      await expect(verified!).rejects.toThrow(refusal);
    }, 60_000);
  }

  it.each([false, true])("keeps a record that states the drawing with its stereo label as authored, warns once, and the verifier accepts it (accepted: %s)", async (accepted) => {
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const stored = labelled();
    const { applied, inserted, normalized, verified } = verify(stored, accepted);
    expect(applied.warnings).toHaveLength(1);
    expect(applied.warnings[0]).toContain('molecule "labelled"');
    expect(inserted().chemistry).toEqual(stored.chemistry);
    const document = (await verified) ?? normalized;
    const kept = document.pages[0]!.objects.find((candidate): candidate is MoleculeObject => candidate.type === "molecule")!;
    expect(kept.chemistry?.stereochemistry).toEqual(["atom 0 (S)"]);
  }, 60_000);

  // Ethane beside a lone H whose stored structure is a V2000 molfile carrying the H's radical as an
  // `M  RAD` doublet (RDKit reads CC.[H], the drawing), beside today's chemistry record.
  const radicalCtab = (radicals: string) => {
    const drawn = ethane("CC.[H]");
    const molfile = moleculeToMolfileV2000(drawn, { kekuleBondOrders: new Map() }).contents.replace("M  END", `${radicals}\nM  END`);
    return { ...drawn, ...refreshedAt123(drawn), structureFormat: "molfile-v2000" as const, structure: molfile };
  };

  // Known, deliberate limitation (as on release/1.2.3, deferred to 1.2.4): the verifier does not read
  // a radical doublet, so a stored molfile carrying one is refused, loudly.
  // The refresh cannot confirm a CTAB that is not ChemDraft's own writing of the drawing without parsing
  // it, so it keeps it as authored and names it.
  it.each([false, true])("keeps an M  RAD doublet molfile as authored, warns once, and the verifier refuses it (accepted: %s)", async (accepted) => {
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const stored = radicalCtab("M  RAD  1   3   2");
    const { applied, inserted, verified } = verify(stored, accepted);
    expect(applied.warnings).toEqual([impliedRadicalCacheDeclinedLine("ethane")]);
    expect(cacheOf(inserted())).toEqual(cacheOf(stored));
    expect(verified).toBeDefined();
    await expect(verified!).rejects.toThrow(/stored structure carries annotations that can't be checked/);
  }, 60_000);

  it.each([
    // A doublet is accepted only on a lone hydrogen atom of the CTAB, so one on a carbon is refused as
    // an annotation the graph writer cannot verify, before RDKit's reading is compared.
    ["a doublet on a carbon instead of the H", "M  RAD  1   1   2", /stored structure carries annotations that can't be checked/],
    ["a triplet on the H (its spin cannot be checked)", "M  RAD  1   3   3", /stored structure carries annotations that can't be checked/]
  ])("refuses an M  RAD molfile with %s", async (_what, radicals, refusal) => {
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const { inserted, verified } = verify(radicalCtab(radicals), false);
    expect(inserted().structure).toContain(radicals);
    expect(verified).toBeDefined();
    await expect(verified!).rejects.toThrow(refusal);
  }, 60_000);

  // The same molecule as a V3000 molfile (with the writer's own VAL=-1 on the lone H), with `edit`
  // applied to the writer's text.
  const radicalCtabV3000 = (edit: (molfile: string) => string) => {
    const drawn = ethane("CC.[H]");
    const molfile = edit(moleculeToMolfileV3000(drawn, { kekuleBondOrders: new Map() }).contents);
    return { ...drawn, ...refreshedAt123(drawn), structureFormat: "molfile-v3000" as const, structure: molfile };
  };

  it("keeps a V3000 molfile with RAD=2 on the lone H's atom line as authored, warns once, and the verifier refuses it (deferred to 1.2.4)", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const stored = radicalCtabV3000((molfile) => molfile.replace(/^(M {2}V30 3 H .*)$/m, "$1 RAD=2"));
    expect(stored.structure).toMatch(/^M {2}V30 3 H .* RAD=2$/m);
    const { applied, inserted, verified } = verify(stored, false);
    expect(applied.warnings).toEqual([impliedRadicalCacheDeclinedLine("ethane")]);
    expect(cacheOf(inserted())).toEqual(cacheOf(stored));
    expect(verified).toBeDefined();
    await expect(verified!).rejects.toThrow(/stored structure carries annotations that can't be checked/);
  }, 60_000);

  it.each([
    // RDKit reads no radical from a bond line, so the RAD=2 there states nothing it can check.
    ["RAD=2 on the C-C bond line", (molfile: string) => molfile.replace(/^(M {2}V30 1 1 1 2)$/m, "$1 RAD=2"), /M {2}V30 1 1 1 2 RAD=2$/m],
    ["RAD=2 on a carbon's atom line", (molfile: string) => molfile.replace(/^(M {2}V30 1 C .*)$/m, "$1 RAD=2"), /M {2}V30 1 C .* RAD=2$/m]
  ])("refuses a V3000 molfile with %s as an annotation it can't check", async (_what, edit, written) => {
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const stored = radicalCtabV3000(edit);
    expect(stored.structure).toMatch(written);
    const { inserted, verified } = verify(stored, false);
    expect(inserted().structure).toBe(stored.structure);
    expect(verified).toBeDefined();
    await expect(verified!).rejects.toThrow(/stored structure carries annotations that can't be checked/);
  }, 60_000);

  // Ethane beside a lone H as a molfile in ChemDraft's own CTAB writing of the drawing (the lone H at the
  // zero-valence sentinel, which RDKit reads as H•), beside today's record; `edit` applied to the text.
  const ownCtab = (flavor: "v2000" | "v3000", edit: (molfile: string) => string = (molfile) => molfile) => {
    const drawn = ethane("CC.[H]");
    const write = flavor === "v2000" ? moleculeToMolfileV2000 : moleculeToMolfileV3000;
    const molfile = edit(write(drawn, { kekuleBondOrders: new Map() }).contents);
    return { ...drawn, ...refreshedAt123(drawn), structureFormat: `molfile-${flavor}` as const, structure: molfile };
  };

  it.each([
    ["v2000", false], ["v2000", true], ["v3000", false], ["v3000", true]
  ] as const)("keeps ChemDraft's own %s writing of the drawing (lone H as H•) with no warning, and the verifier accepts it (accepted: %s)", async (flavor, accepted) => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const stored = ownCtab(flavor);
    expect(stored.structure).toMatch(flavor === "v2000" ? /^ .* H {3}0 {2}0 {2}0 {2}0 {2}0 15 /m : /^M {2}V30 3 H .* VAL=-1$/m);
    const { applied, inserted, normalized, verified } = verify(stored, accepted);
    expect(applied.warnings).toEqual([]);
    expect(cacheOf(inserted())).toEqual(cacheOf(stored));
    const document = (await verified) ?? normalized;
    const kept = document.pages[0]!.objects.find((candidate): candidate is MoleculeObject => candidate.type === "molecule")!;
    expect(kept.structure).toBe(stored.structure);
    expect(warn).not.toHaveBeenCalled();
  }, 60_000);

  // The verifier compares no radical, so a stored CTAB whose lone H is written with no radical (read as
  // H2: stale) beside a record stating H• must never pass silently: the refresh cannot confirm it, so
  // it keeps it as authored and names it, and the verifier refuses it as on release/1.2.3.
  it.each([
    ["v2000", false], ["v2000", true], ["v3000", false], ["v3000", true]
  ] as const)("keeps a %s molfile whose lone H is unmarked (read as H2) as authored, warns once, and the verifier refuses it (accepted: %s)", async (flavor, accepted) => {
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const stored = ownCtab(flavor, (molfile) => flavor === "v2000"
      ? molfile.replace(/^(.* H {3}0 {2}0 {2}0 {2}0 {2}0) 15/m, "$1  0")
      : molfile.replace(/^(M {2}V30 3 H .*) VAL=-1$/m, "$1"));
    expect(stored.structure).toMatch(flavor === "v2000" ? /^ .* H {3}0 {2}0 {2}0 {2}0 {2}0 {2}0 /m : /^M {2}V30 3 H [^A-Z]*$/m);
    expect(stored.chemistry?.radicalCount).toBe(1);
    const { applied, inserted, verified } = verify(stored, accepted);
    expect(applied.warnings).toEqual([impliedRadicalCacheDeclinedLine("ethane")]);
    expect(cacheOf(inserted())).toEqual(cacheOf(stored));
    expect(verified).toBeDefined();
    await expect(verified!).rejects.toThrow(/stored structure doesn't match the drawn atoms/);
  }, 60_000);

  // (The commit's verification then refuses any dative bond, which a V2000 molfile cannot carry; only
  // the refresh is checked here.)
  it.each([false, true])("refreshes a dative Fe–D beside a lone H as the H2 reading stored it ([2HH][Fe].[HH]), with no warning (accepted: %s)", (accepted) => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const stored = moleculeOf("dative", [atom("d", "D", 300), atom("fe", "Fe", 315), atom("lone", "H", 350)],
      [bond("coord", "d", "fe", { bondStyle: "dashed" })], "[2HH][Fe].[HH]", record("H3DFe", 60.883, 60.97251, 3, 1, { isotopeLabels: ["2H"] }));
    const before = createEmptyDocument();
    const applied = (accepted ? applyAcceptedPluginProposal : applyPluginDocumentPatch)(before, insert(before.pages[0]!.id, stored));
    const inserted = applied.document.pages[0]!.objects.find((candidate): candidate is MoleculeObject => candidate.type === "molecule")!;
    expect(applied.warnings).toEqual([]);
    expect(cacheOf(inserted)).toEqual(refreshedAt123(stored));
    expect(inserted.structure).toBe("[2H][Fe].[H]");
    expect(inserted.chemistry?.formula).toBe("HDFe");
    expect(warn).not.toHaveBeenCalled();
  });

  it("names only the kept molecule when it is inserted beside a refreshed one", () => {
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const before = createEmptyDocument();
    const pageId = before.pages[0]!.id;
    const patch = ProposedDocumentPatchSchema.parse({ reason: "Insert structures", patch: { op: "batch", patches: [
      { op: "addObject", pageId, object: ethane() }, { op: "addObject", pageId, object: wedgedH2() }
    ] } });
    for (const apply of [applyPluginDocumentPatch, applyAcceptedPluginProposal]) {
      const { document, warnings } = apply(before, patch);
      expect(warnings).toHaveLength(1);
      expect(warnings[0]).toContain('molecule "wedged"');
      const inserted = document.pages[0]!.objects.filter((object): object is MoleculeObject => object.type === "molecule");
      expect(inserted.find((object) => object.id === "ethane")!.structure).toBe("CC.[H]");
      expect(inserted.find((object) => object.id === "wedged")!.structure).toBe("F[C@@H](Cl)Br.[HH]");
    }
  });
});

describe("a plugin batch inserting many lone-H molecules", () => {
  afterEach(() => { vi.restoreAllMocks(); });
  it("refreshes each inserted molecule once, in one refresh of only the inserted molecules", () => {
    const base = createEmptyDocument();
    const pageId = base.pages[0]!.id;
    const lone = (index: number): MoleculeObject => ({
      id: `lone-${index}`, type: "molecule", x: 10 + index * 12, y: 290, width: 10, height: 10, rotation: 0, style: {},
      structureFormat: "smiles", structure: "[HH]", superatoms: [], rGroups: [],
      atoms: [{ id: `h-${index}`, element: "H", x: 15 + index * 12, y: 295, formalCharge: 0 }], bonds: [],
      chemistry: { formula: "H2", averageMass: 2.016, exactMass: 2.01565, atomCount: 1, bondCount: 0,
        totalCharge: 0, radicalCount: 0, isotopeLabels: [], stereochemistry: [], warnings: [] }
    });
    // A stale lone H already on the page is not this write's to refresh.
    const resident = { ...lone(99), id: "resident", atoms: [{ id: "h-resident", element: "H", x: 100, y: 100, formalCharge: 0 }] };
    const before = { ...base, pages: [{ ...base.pages[0]!, objects: [resident] }] };
    const count = 40;
    const added = Array.from({ length: count }, (_, index) => lone(index));
    const patch = ProposedDocumentPatchSchema.parse({ reason: "Insert structures",
      patch: { op: "batch", patches: added.map((object) => ({ op: "addObject", pageId, object })) } });
    calls.metadata.length = 0; calls.refreshOf.length = 0; calls.refreshAll = 0;
    const { document } = applyPluginDocumentPatch(before, patch);
    expect(calls.refreshAll).toBe(0);
    expect(calls.refreshOf).toHaveLength(1);
    expect(calls.refreshOf[0]!.map((target) => target.objectId)).toEqual(added.map((object) => object.id));
    // Each inserted molecule is derived once as drawn (H•), and once under the H2 reading its stale
    // cache is compared with (each lone H given a hydrogen of its own), and never again.
    const partner = "\u0000h2";
    for (let index = 0; index < count; index++) {
      const derivations = calls.metadata.filter((ids) => ids.includes(`h-${index}`));
      expect(derivations.filter((ids) => !ids.some((id) => id.endsWith(partner)))).toHaveLength(1);
      expect(derivations.filter((ids) => ids.some((id) => id.endsWith(partner)))).toHaveLength(1);
    }
    expect(calls.metadata.filter((ids) => ids.includes("h-resident"))).toHaveLength(0);
    const molecules = document.pages[0]!.objects.filter((object): object is MoleculeObject => object.type === "molecule");
    expect(molecules.filter((object) => object.id !== "resident").every((object) => object.chemistry?.radicalCount === 1)).toBe(true);
    expect(molecules.find((object) => object.id === "resident")).toEqual(resident);
  });
});
