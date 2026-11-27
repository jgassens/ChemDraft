import {
  applyPatch, createEmptyDocument, type ChemDraftDocument, type DocumentPatch, type MoleculeAtom, type MoleculeBond, type MoleculeObject
} from "@chemdraft/chem-core";
import { nativeSingleBondGraphMetadata } from "@chemdraft/document-workflow-core";
import { PluginHost, rebasePluginPatch } from "@chemdraft/plugin-host";
import { describe, expect, it } from "vitest";
import { normalizeCommittedDocument } from "../documentWorkflow";
import { applyPluginDocumentPatch, previewAcceptedPluginProposal, refreshPluginPatchChemistry } from "./applyPluginDocumentPatch";

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
