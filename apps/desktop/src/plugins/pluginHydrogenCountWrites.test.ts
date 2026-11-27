import {
  applyPatch, createEmptyDocument, type ChemDraftDocument, type DocumentPatch, type MoleculeAtom, type MoleculeBond, type MoleculeObject
} from "@chemdraft/chem-core";
import { nativeSingleBondGraphMetadata, tryNativeSingleBondGraphSmiles } from "@chemdraft/document-workflow-core";
import { PluginHost, rebasePluginPatch } from "@chemdraft/plugin-host";
import { describe, expect, it } from "vitest";
import { normalizeCommittedDocument } from "../documentWorkflow";
import {
  applyPluginDocumentPatch, droppedHydrogenCountKeepsChemistry, previewAcceptedPluginProposal, refreshPluginPatchChemistry
} from "./applyPluginDocumentPatch";

// Stated hydrogen counts through the two ways a plugin's chemistry reaches a document: a plugin's own
// documents.applyPatch, and the user accepting its documents.proposePatch proposal. Both run here as the
// desktop runs them (MainWindow's applyDocumentPatch and acceptPluginProposal): the real PluginHost, then
// the desktop's application, normalization and RDKit-backed chemistry refresh. Each test asserts the
// refusal or committed formula and hydrogen counts. These cover counts dropped by bond edits,
// explicit zero counts, and counts overridden by atom label text (AGENTS.md section 7).

const now = "2026-11-25T00:00:00.000Z";
const atom = (id: string, element: string, x: number, extra: Partial<MoleculeAtom> = {}): MoleculeAtom =>
  ({ id, element, x, y: 120, formalCharge: 0, ...extra });
const bond = (id: string, fromAtomId: string, toAtomId: string): MoleculeBond => ({ id, fromAtomId, toAtomId, order: "single" });
const molecule = (id: string, atoms: MoleculeAtom[], bonds: MoleculeBond[]): MoleculeObject => ({
  id, type: "molecule", x: 100, y: 110, width: 60, height: 20, rotation: 0, style: {},
  structureFormat: "smiles", structure: "", superatoms: [], rGroups: [], atoms, bonds
});

/** A document holding `objects`, committed as the canvas commits it. */
function documentWith(objects: MoleculeObject[]): ChemDraftDocument {
  let document = createEmptyDocument({ now });
  if (objects.length) {
    document = applyPatch(document, { op: "batch", patches: objects.map(object => ({ op: "addObject", pageId: document.pages[0]!.id, object })) }, { now });
  }
  return normalizeCommittedDocument(document);
}
/** Ethane as drawn: two plain carbons, nothing stated. */
const ethane = () => documentWith([molecule("m", [atom("a1", "C", 100), atom("a2", "C", 130)], [bond("b1", "a1", "a2")])]);

function committedMolecule(document: ChemDraftDocument, id: string): MoleculeObject {
  const object = document.pages.flatMap(page => page.objects).find(candidate => candidate.id === id);
  if (object?.type !== "molecule") throw new Error(`molecule ${id} was not committed`);
  return object;
}
/** The formula the canvas, export and inspector read from the committed graph. */
const formulaOf = (object: MoleculeObject) => nativeSingleBondGraphMetadata(object.atoms, object.bonds).formula;
/** The graph SMILES the app writes for the committed molecule (document-workflow-core, atom order). */
const smilesOf = (object: MoleculeObject) => {
  const written = tryNativeSingleBondGraphSmiles(object.atoms, object.bonds);
  return "smiles" in written ? written.smiles : undefined;
};
const countOf = (object: MoleculeObject, atomId: string) => object.atoms.find(candidate => candidate.id === atomId)?.hydrogenCount;

type Outcome = { committed: ChemDraftDocument; refusal?: undefined; pending?: number } |
  { committed?: undefined; refusal: Error; pending?: number };

/** A plugin command calling documents.applyPatch, committed as MainWindow's applyDocumentPatch does. */
async function pluginApplyPatch(before: ChemDraftDocument, patch: DocumentPatch, selected: string[]): Promise<Outcome> {
  let document: ChemDraftDocument = { ...before, selection: { pageId: before.pages[0]!.id, objectIds: selected } };
  const host = new PluginHost({
    getActiveDocument: () => document,
    getSelection: () => ({ objectIds: selected, molecules: [] }),
    applyDocumentPatch: async ({ patch: proposed, writeScopeObjectIds, writeScopePages, signal, onCommitted }) => {
      const start = document;
      const applied = applyPluginDocumentPatch(start, proposed);
      let prepared = normalizeCommittedDocument(applied.document);
      const refreshed = refreshPluginPatchChemistry(start, prepared, rebasePluginPatch(start, proposed), writeScopeObjectIds, signal, writeScopePages);
      if (refreshed) prepared = await refreshed;
      document = prepared;
      onCommitted?.(document);
      return applied.receipt;
    }
  });
  host.registerPlugin({
    id: "org.test.hcount", name: "H Count", version: "0.0.1", apiVersion: "^0.1.8", entry: "plugin.js",
    permissions: ["document.write"], contributes: { commands: [{ id: "plugin.hcount.write", title: "Write" }] }
  }, { commandHandlers: { "plugin.hcount.write": context => context.documents.applyPatch!({ reason: "stated counts", patch }) } });
  try {
    await host.invokeCommand("plugin.hcount.write");
    return { committed: document };
  } catch (error) {
    return { refusal: error as Error };
  }
}

/** A plugin command calling documents.proposePatch, then the user accepting it as MainWindow's acceptPluginProposal does. */
async function acceptedProposal(before: ChemDraftDocument, patch: DocumentPatch): Promise<Outcome> {
  const host = new PluginHost({ getActiveDocument: () => before, getSelection: () => ({ objectIds: [], molecules: [] }) });
  host.registerPlugin({
    id: "org.test.hcount", name: "H Count", version: "0.0.1", apiVersion: "^0.1.8", entry: "plugin.js",
    permissions: ["document.proposePatch"], contributes: { commands: [{ id: "plugin.hcount.propose", title: "Propose" }] }
  }, { commandHandlers: { "plugin.hcount.propose": context => context.documents.proposePatch({ reason: "stated counts", patch }) } });
  await host.invokeCommand("plugin.hcount.propose");
  const [queued] = host.listProposedPatches("pending");
  if (!queued) throw new Error("the proposal was not queued");
  try {
    let prepared = normalizeCommittedDocument(previewAcceptedPluginProposal(host, queued.id, before));
    const refreshed = refreshPluginPatchChemistry(before, prepared, rebasePluginPatch(before, queued.proposal, true));
    if (refreshed) prepared = await refreshed;
    return { committed: host.acceptProposedPatch(queued.id, before, { apply: () => prepared }) };
  } catch (error) {
    return { refusal: error as Error, pending: host.listProposedPatches("pending").length };
  }
}

/** Either refused, naming the hydrogen count, or committed with exactly the stated chemistry. */
function expectKeptOrRefused(outcome: Outcome, moleculeId: string, expected: { formula: string; counts: Record<string, number> }) {
  if (outcome.refusal) {
    expect(outcome.refusal.message).toMatch(/hydrogenCount/);
    return;
  }
  const written = committedMolecule(outcome.committed, moleculeId);
  expect({ formula: formulaOf(written), stored: written.chemistry?.formula ?? formulaOf(written),
    counts: Object.fromEntries(Object.keys(expected.counts).map(id => [id, countOf(written, id)])) })
    .toEqual({ formula: expected.formula, stored: expected.formula, counts: expected.counts });
}

// The first RDKit-backed verification in a worker can take several seconds.
describe("(a) an accepted proposal stating a nonzero hydrogen count", { timeout: 30_000 }, () => {
  // Ethane -> ethyl radical: a1 states 2 H (C2H5) and the C-C bond is redrawn under a new id, as a plugin that
  // regenerates a structure writes it. The patch engine drops a1's count (its bond changed), so the derived 3
  // replaces the stated 2.
  const toEthyl: DocumentPatch = { op: "updateObject", objectId: "m", changes: {
    atoms: [atom("a1", "C", 100, { hydrogenCount: 2 }), atom("a2", "C", 130)], bonds: [bond("b2", "a1", "a2")] } };

  it("BUG (a): commits the proposed C2H5 as C2H6, silently dropping the stated count, instead of keeping it or refusing", async () => {
    expectKeptOrRefused(await acceptedProposal(ethane(), toEthyl), "m", { formula: "C2H5", counts: { a1: 2 } });
  });

  it("guard: the same patch through documents.applyPatch is refused", async () => {
    const outcome = await pluginApplyPatch(ethane(), toEthyl, ["m"]);
    expect(outcome.refusal?.message).toMatch(/hydrogenCount 2, which the written molecule would not keep/);
  });

  it("guard: a proposed ethane over an ethyl radical (a1 states 3, bond redrawn) commits C2H6, not C2H5", async () => {
    // The direction the review described (C2H6 proposed, C2H5 committed) does not reproduce: the dropped count
    // falls back to the derived 3, which is what ethane states.
    const ethyl = documentWith([molecule("m", [atom("a1", "C", 100, { hydrogenCount: 2 }), atom("a2", "C", 130)], [bond("b1", "a1", "a2")])]);
    expect(formulaOf(committedMolecule(ethyl, "m"))).toBe("C2H5");
    const outcome = await acceptedProposal(ethyl, { op: "updateObject", objectId: "m", changes: {
      atoms: [atom("a1", "C", 100, { hydrogenCount: 3 }), atom("a2", "C", 130)], bonds: [bond("b2", "a1", "a2")] } });
    expect(outcome.refusal).toBeUndefined();
    expect(formulaOf(committedMolecule(outcome.committed!, "m"))).toBe("C2H6");
  });
});

describe("(b) a typed carbon label stating a hydrogen count", { timeout: 30_000 }, () => {
  // Ethane whose a1 is a typed literal "C" stating 3 H. The label text "C" reads as a bare carbon, so the stated
  // 3 would be overridden and the write would commit C2H3 (CH3-C with no H on a1) without a word. Owner ruling:
  // refuse, naming the atom, the label text and the stated count, on both paths, with nothing written.
  const typedEthane = () => molecule("m2", [atom("a1", "C", 100, { labelLiteral: true, hydrogenCount: 3 }), atom("a2", "C", 130)],
    [bond("b1", "a1", "a2")]);
  const refusal = 'Plugin write refused: atom "a1" of molecule "m2" has label "C", which ChemDraft reads as its own hydrogen count ' +
    "(0 H from the label text), but the write states hydrogenCount 3. Remove the count (or state 0), or write the element " +
    "without the literal label. Nothing was changed.";

  it("BUG (b): documents.applyPatch would commit C2H3, the label text overriding the stated 3; it is refused, naming a1, \"C\" and 3", async () => {
    // Assertion narrowed from expectKeptOrRefused to the refusal and its message: the ruling is to refuse.
    const blank = documentWith([]);
    const outcome = await pluginApplyPatch(blank, { op: "addObject", pageId: blank.pages[0]!.id, object: typedEthane() }, []);
    expect(outcome.refusal?.message).toBe(refusal);
  });

  it("BUG (b): an accepted proposal would commit C2H3 the same way; it is refused with the same message and stays pending", async () => {
    // Assertion narrowed from expectKeptOrRefused to the refusal and its message: the ruling is to refuse.
    const blank = documentWith([]);
    const outcome = await acceptedProposal(blank, { op: "addObject", pageId: blank.pages[0]!.id, object: typedEthane() });
    expect(outcome.refusal?.message).toBe(refusal);
    expect(outcome.pending).toBe(1);
  });

  it("guard: the same write stating what the label text gives (0) commits C2H3 on both paths", async () => {
    const blank = documentWith([]);
    const stated0 = () => molecule("m2", [atom("a1", "C", 100, { labelLiteral: true, hydrogenCount: 0 }), atom("a2", "C", 130)],
      [bond("b1", "a1", "a2")]);
    for (const outcome of [await pluginApplyPatch(blank, { op: "addObject", pageId: blank.pages[0]!.id, object: stated0() }, []),
      await acceptedProposal(blank, { op: "addObject", pageId: blank.pages[0]!.id, object: stated0() })]) {
      expect(outcome.refusal).toBeUndefined();
      const written = committedMolecule(outcome.committed!, "m2");
      expect({ formula: formulaOf(written), a1: countOf(written, "a1") }).toEqual({ formula: "C2H3", a1: 0 });
    }
  });

  it("guard: a typed CH3 label states its own 3 H, so ethane commits C2H6", async () => {
    const blank = documentWith([]);
    const outcome = await pluginApplyPatch(blank, { op: "addObject", pageId: blank.pages[0]!.id, object: molecule("m2",
      [atom("a1", "CH3", 100, { labelLiteral: true, hydrogenCount: 3 }), atom("a2", "C", 130)], [bond("b1", "a1", "a2")]) }, []);
    expect(outcome.refusal).toBeUndefined();
    expect(formulaOf(committedMolecule(outcome.committed!, "m2"))).toBe("C2H6");
  });
});

describe("(c) an explicit hydrogenCount 0 in a plugin write", { timeout: 30_000 }, () => {
  it("BUG (c): an O stating 0 H joined onto ethane commits ethanol (C2H6O) instead of the stated ethoxy radical (C2H5O) or a refusal", async () => {
    const outcome = await pluginApplyPatch(ethane(), { op: "updateObject", objectId: "m", changes: {
      atoms: [atom("a1", "C", 100), atom("a2", "C", 130), atom("o", "O", 160, { hydrogenCount: 0 })],
      bonds: [bond("b1", "a1", "a2"), bond("b2", "a2", "o")] } }, ["m"]);
    expectKeptOrRefused(outcome, "m", { formula: "C2H5O", counts: { o: 0 } });
  });

  it("BUG (c): a carbon stating 0 H with its bond redrawn commits C2H6 instead of the stated C2H3 or a refusal", async () => {
    const outcome = await pluginApplyPatch(ethane(), { op: "updateObject", objectId: "m", changes: {
      atoms: [atom("a1", "C", 100), atom("a2", "C", 130, { hydrogenCount: 0 })], bonds: [bond("b2", "a1", "a2")] } }, ["m"]);
    expectKeptOrRefused(outcome, "m", { formula: "C2H3", counts: { a2: 0 } });
  });

  it("guard: the same write stating 1 instead of 0 is refused", async () => {
    const outcome = await pluginApplyPatch(ethane(), { op: "updateObject", objectId: "m", changes: {
      atoms: [atom("a1", "C", 100), atom("a2", "C", 130, { hydrogenCount: 1 })], bonds: [bond("b2", "a1", "a2")] } }, ["m"]);
    expect(outcome.refusal?.message).toMatch(/hydrogenCount 1, which the written molecule would not keep/);
  });

  it("guard: a 0 the write keeps (no bond change) commits as stated, C2H3", async () => {
    const outcome = await pluginApplyPatch(ethane(), { op: "updateObject", objectId: "m", changes: {
      atoms: [atom("a1", "C", 100), atom("a2", "C", 130, { hydrogenCount: 0 })] } }, ["m"]);
    expect(outcome.refusal).toBeUndefined();
    const written = committedMolecule(outcome.committed!, "m");
    expect({ formula: formulaOf(written), stored: written.chemistry?.formula, a2: countOf(written, "a2") })
      .toEqual({ formula: "C2H3", stored: "C2H3", a2: 0 });
  });
});

describe.each([
  ["documents.applyPatch", pluginApplyPatch],
  ["proposal acceptance", acceptedProposal]
] as const)("counts spelled by a label on %s", (_path, write) => {
  const methanol = (label: string, hydrogenCount: number) => molecule("m3",
    [atom("o", label, 100, { labelLiteral: true, hydrogenCount }), atom("c", "C", 130)], [bond("b1", "o", "c")]);
  const redrawBond = (hydrogenCount: number): DocumentPatch => ({ op: "updateObject", objectId: "m3", changes: {
    atoms: methanol("HO", hydrogenCount).atoms, bonds: [bond("b2", "o", "c")]
  } });

  it.each(["HO", "OH"] as const)("refuses a typed %s stating 0 H", async (label) => {
    const blank = documentWith([]);
    const outcome = await write(blank, { op: "addObject", pageId: blank.pages[0]!.id, object: methanol(label, 0) }, []);
    expect(outcome.refusal).toMatchObject({
      reason: "hydrogen_count_unrepresentable",
      details: { moleculeId: "m3", atomId: "o", element: label, hydrogenCount: 0, labelHydrogenCount: 1 }
    });
    if (write === acceptedProposal) expect(outcome.pending).toBe(1);
  });

  it("commits a typed HO stating 1 H as CH4O", async () => {
    const blank = documentWith([]);
    const outcome = await write(blank, { op: "addObject", pageId: blank.pages[0]!.id, object: methanol("HO", 1) }, []);
    expect(outcome.refusal).toBeUndefined();
    const written = committedMolecule(outcome.committed!, "m3");
    expect({ formula: formulaOf(written), hydrogenCount: countOf(written, "o") }).toEqual({ formula: "CH4O", hydrogenCount: 1 });
  });

  it("refuses a conflicting count even when a bond redraw drops the count field", async () => {
    const outcome = await write(documentWith([methanol("HO", 1)]), redrawBond(0), ["m3"]);
    expect(outcome.refusal).toMatchObject({
      reason: "hydrogen_count_unrepresentable",
      details: { moleculeId: "m3", atomId: "o", element: "HO", hydrogenCount: 0, labelHydrogenCount: 1 }
    });
    if (write === acceptedProposal) expect(outcome.pending).toBe(1);
  });

  it("keeps the chemistry of a matching stated count when a bond redraw drops the count field", async () => {
    const outcome = await write(documentWith([methanol("HO", 1)]), redrawBond(1), ["m3"]);
    expect(outcome.refusal).toBeUndefined();
    const written = committedMolecule(outcome.committed!, "m3");
    expect({ formula: formulaOf(written), hydrogenCount: countOf(written, "o"), bondId: written.bonds[0]?.id })
      .toEqual({ formula: "CH4O", hydrogenCount: undefined, bondId: "b2" });
  });
});

// A stated count is a request the whole batch must keep. The host records, per molecule, the counts each
// atoms-writing op asked for; it used to replace that record on every such op, so a later op that rewrote the
// atoms without restating the count erased the first op's request and the dropped count went unchecked.
describe.each([
  ["documents.applyPatch", pluginApplyPatch],
  ["proposal acceptance", acceptedProposal]
] as const)("a batch stating a hydrogen count on %s", (path, write) => {
  // Op 1: a2 states 0 H (C2H3 stated) and its bond is redrawn, so the patch engine drops the count. Alone it is refused.
  const stateZeroAndRedraw: DocumentPatch = { op: "updateObject", objectId: "m", changes: {
    atoms: [atom("a1", "C", 100), atom("a2", "C", 130, { hydrogenCount: 0 })], bonds: [bond("b2", "a1", "a2")] } };
  // Op 2: the atoms written again, a2 omitting hydrogenCount (a plugin re-sending positions, say).
  const rewriteAtoms: DocumentPatch = { op: "updateObject", objectId: "m", changes: {
    atoms: [atom("a1", "C", 101), atom("a2", "C", 131)] } };

  it("refuses the first op alone (C2H6 would be committed where C2H3 was stated)", async () => {
    const outcome = await write(ethane(), stateZeroAndRedraw, ["m"]);
    expect(outcome.refusal).toMatchObject({ reason: "hydrogen_count_unrepresentable",
      details: { moleculeId: "m", atomId: "a2", element: "C", hydrogenCount: 0 } });
    if (path === "proposal acceptance") expect(outcome.pending).toBe(1);
  });

  it("BUG: a later atoms update omitting the count no longer launders it: the batch is refused, nothing committed", async () => {
    const before = ethane();
    expect({ formula: formulaOf(committedMolecule(before, "m")), smiles: smilesOf(committedMolecule(before, "m")) })
      .toEqual({ formula: "C2H6", smiles: "CC" });
    const outcome = await write(before, { op: "batch", patches: [stateZeroAndRedraw, rewriteAtoms] }, ["m"]);
    expect(outcome.refusal).toMatchObject({ reason: "hydrogen_count_unrepresentable",
      details: { moleculeId: "m", atomId: "a2", element: "C", hydrogenCount: 0 } });
    if (path === "proposal acceptance") expect(outcome.pending).toBe(1);
  });

  it("guard: a later op restating the count replaces only that atom's request (0 then a kept 0 commits C2H3)", async () => {
    // Op 2 states a2's 0 again after the bond redraw, so the count lands: [CH3]-[C] as stated.
    const restate: DocumentPatch = { op: "updateObject", objectId: "m", changes: {
      atoms: [atom("a1", "C", 100), atom("a2", "C", 130, { hydrogenCount: 0 })] } };
    const outcome = await write(ethane(), { op: "batch", patches: [stateZeroAndRedraw, restate] }, ["m"]);
    expect(outcome.refusal).toBeUndefined();
    const written = committedMolecule(outcome.committed!, "m");
    expect({ formula: formulaOf(written), a2: countOf(written, "a2"), bonds: written.bonds.map(entry => entry.id) })
      .toEqual({ formula: "C2H3", a2: 0, bonds: ["b2"] });
  });

  it("BUG: a later op retyping the atom C to O without a count drops the request (methanol commits CH4O)", async () => {
    const toOxygen: DocumentPatch = { op: "updateObject", objectId: "m", changes: {
      atoms: [atom("a1", "C", 100), atom("a2", "O", 130)] } };
    const outcome = await write(ethane(), { op: "batch", patches: [stateZeroAndRedraw, toOxygen] }, ["m"]);
    expect(outcome.refusal).toBeUndefined();
    const written = committedMolecule(outcome.committed!, "m");
    expect({ formula: formulaOf(written), smiles: smilesOf(written), a2: written.atoms.find(entry => entry.id === "a2")?.element })
      .toEqual({ formula: "CH4O", smiles: "CO", a2: "O" });
  });

  it("guard: a later op changing the element AND restating a count uses the new count (O stating 0 is refused as O)", async () => {
    const toOxygenStating: DocumentPatch = { op: "updateObject", objectId: "m", changes: {
      atoms: [atom("a1", "C", 100), atom("a2", "O", 130, { hydrogenCount: 0 })] } };
    const outcome = await write(ethane(), { op: "batch", patches: [stateZeroAndRedraw, toOxygenStating] }, ["m"]);
    expect(outcome.refusal).toMatchObject({ reason: "hydrogen_count_unrepresentable",
      details: { moleculeId: "m", atomId: "a2", element: "O", hydrogenCount: 0 } });
  });

  it("guard: a later bond-only op keeps the request (still refused)", async () => {
    const bondsOnly: DocumentPatch = { op: "updateObject", objectId: "m", changes: { bonds: [bond("b3", "a1", "a2")] } };
    const outcome = await write(ethane(), { op: "batch", patches: [stateZeroAndRedraw, bondsOnly] }, ["m"]);
    expect(outcome.refusal).toMatchObject({ reason: "hydrogen_count_unrepresentable",
      details: { moleculeId: "m", atomId: "a2", element: "C", hydrogenCount: 0 } });
  });

  it("guard: a later op moving the atom (position only) keeps the request (still refused)", async () => {
    const moved: DocumentPatch = { op: "updateObject", objectId: "m", changes: {
      atoms: [atom("a1", "C", 100), atom("a2", "C", 150)] } };
    const outcome = await write(ethane(), { op: "batch", patches: [stateZeroAndRedraw, moved] }, ["m"]);
    expect(outcome.refusal).toMatchObject({ reason: "hydrogen_count_unrepresentable",
      details: { moleculeId: "m", atomId: "a2", element: "C", hydrogenCount: 0 } });
  });

  it("guard: a later op deleting the atom drops its request (methane commits CH4)", async () => {
    const dropA2: DocumentPatch = { op: "updateObject", objectId: "m", changes: { atoms: [atom("a1", "C", 100)], bonds: [] } };
    const outcome = await write(ethane(), { op: "batch", patches: [stateZeroAndRedraw, dropA2] }, ["m"]);
    expect(outcome.refusal).toBeUndefined();
    const written = committedMolecule(outcome.committed!, "m");
    expect({ formula: formulaOf(written), smiles: smilesOf(written), atoms: written.atoms.map(entry => entry.id) })
      .toEqual({ formula: "CH4", smiles: "C", atoms: ["a1"] });
  });
});

// A lone H, D or T stating no count is a radical (H•, owner decision 2026-11-23); a stated 0 is the plain atom.
// The accept path lets a dropped count be when the committed molecule derives the same chemistry back, which
// compared formula and graph SMILES only: both match for H• and H, so the radical was committed silently.
describe.each([
  ["documents.applyPatch", pluginApplyPatch],
  ["proposal acceptance", acceptedProposal]
] as const)("a dropped count on a hydrogen atom left lone, on %s", (path, write) => {
  // CH3-H (methane drawn with one explicit H). The write states h is a plain H (0) and breaks its bond, so the patch
  // engine drops h's count and h becomes a lone H with no count: H•, CH4 + H• (one radical) instead of CH4 + H.
  const methaneWithH = () => documentWith([molecule("m4", [atom("c", "C", 100), atom("h", "H", 130)], [bond("b1", "c", "h")])]);
  const breakAndStateZero: DocumentPatch = { op: "updateObject", objectId: "m4", changes: {
    atoms: [atom("c", "C", 100), atom("h", "H", 130, { hydrogenCount: 0 })], bonds: [] } };

  it("BUG (proposal acceptance committed H•): a plain H stated with 0 is refused on both paths", async () => {
    const before = methaneWithH();
    const drawn = committedMolecule(before, "m4");
    const drawnMetadata = nativeSingleBondGraphMetadata(drawn.atoms, drawn.bonds);
    expect({ formula: drawnMetadata.formula, radicals: drawnMetadata.radicalCount, smiles: smilesOf(drawn) })
      .toEqual({ formula: "CH4", radicals: 0, smiles: "C[H]" });
    const outcome = await write(before, breakAndStateZero, ["m4"]);
    expect(outcome.refusal).toMatchObject({ reason: "hydrogen_count_unrepresentable",
      details: { moleculeId: "m4", atomId: "h", element: "H", hydrogenCount: 0 } });
    expect(outcome.refusal?.message).toMatch(/hydrogenCount 0, which the written molecule would not keep/);
    if (path === "proposal acceptance") expect(outcome.pending).toBe(1);
  });

  it("guard: the same break stating nothing commits the lone H as H• (one radical), as drawn", async () => {
    const outcome = await write(methaneWithH(), { op: "updateObject", objectId: "m4", changes: {
      atoms: [atom("c", "C", 100), atom("h", "H", 130)], bonds: [] } }, ["m4"]);
    expect(outcome.refusal).toBeUndefined();
    const written = committedMolecule(outcome.committed!, "m4");
    const metadata = nativeSingleBondGraphMetadata(written.atoms, written.bonds);
    expect({ formula: metadata.formula, radicals: metadata.radicalCount }).toEqual({ formula: "CH5", radicals: 1 });
  });
});

describe("the accept path's dropped-count check on a lone hydrogen atom", () => {
  it("formula and SMILES alone do not tell the radical apart; the radical count does", () => {
    const lone = [atom("c", "C", 100), atom("h", "H", 130)];
    const stated = [atom("c", "C", 100), atom("h", "H", 130, { hydrogenCount: 0 })];
    const read = (atoms: MoleculeAtom[]) => {
      const metadata = nativeSingleBondGraphMetadata(atoms, []);
      return { formula: metadata.formula, radicals: metadata.radicalCount };
    };
    expect(read(lone)).toEqual({ formula: "CH5", radicals: 1 });
    // The graph SMILES writes the lone H the same way whether or not it is a radical.
    expect(tryNativeSingleBondGraphSmiles(lone, [])).toEqual(tryNativeSingleBondGraphSmiles(stated, []));
    expect(read(stated)).toEqual({ formula: "CH5", radicals: 0 });
    expect(droppedHydrogenCountKeepsChemistry(molecule("m4", lone, []), stated[1]!)).toBe(false);
  });
});
