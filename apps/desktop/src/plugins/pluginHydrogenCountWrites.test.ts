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
// committed formula and hydrogen counts: a write that cannot keep what it states must be refused,
// never committed with different chemistry (AGENTS.md section 7).
//
// Bugs pinned (bot review of PRs #487/#489):
// (a) an accepted proposal drops a nonzero stated count it cannot keep, where documents.applyPatch refuses;
// (b) a typed carbon label's stated count is overridden by the label text, and the write is accepted;
// (c) an explicit hydrogenCount 0 is never checked, so a write whose 0 the patch engine drops is accepted.
// The BUG tests fail on purpose until the fixes land. Run on v1.2.2 (2026-11-25), all three commit the same
// wrong formulas; there no stated count on a plain atom is counted at all, and nothing is refused.

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

type Outcome = { committed: ChemDraftDocument; refusal?: undefined } | { committed?: undefined; refusal: Error };

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
    return { refusal: error as Error };
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

  it("guard: the same patch through documents.applyPatch is refused (the check the accept path lacks)", async () => {
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
  // 3 is overridden and the write commits C2H3 (CH3-C with no H on a1) without a word.
  const typedEthane = () => molecule("m2", [atom("a1", "C", 100, { labelLiteral: true, hydrogenCount: 3 }), atom("a2", "C", 130)],
    [bond("b1", "a1", "a2")]);

  it("BUG (b): documents.applyPatch commits C2H3, the label text overriding the stated 3, instead of C2H6 or a refusal", async () => {
    const blank = documentWith([]);
    expectKeptOrRefused(await pluginApplyPatch(blank, { op: "addObject", pageId: blank.pages[0]!.id, object: typedEthane() }, []),
      "m2", { formula: "C2H6", counts: { a1: 3 } });
  });

  it("BUG (b): an accepted proposal commits C2H3 the same way", async () => {
    const blank = documentWith([]);
    expectKeptOrRefused(await acceptedProposal(blank, { op: "addObject", pageId: blank.pages[0]!.id, object: typedEthane() }),
      "m2", { formula: "C2H6", counts: { a1: 3 } });
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
