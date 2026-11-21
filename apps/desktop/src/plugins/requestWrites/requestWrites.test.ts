import { computeStructureIdentifiers } from "@chemdraft/rdkit-adapter/identifiers";
import { installNodeRdkitModuleLoader } from "@chemdraft/rdkit-adapter/node";
import { depictSmiles2D } from "@chemdraft/ocl-adapter";
import { chemicalIdentityMolfile, chemicalIdentitySource, createSmilesMolecule, moleculeSmiles, nativeSingleBondGraphMetadata, nativeSingleBondGraphSmiles, planFigureStyle,
  representativeNativeMoleculeBondLength, setReactionArrowConditions } from "@chemdraft/document-workflow-core";
import { repeatUnitMolfileGroups, repeatUnits } from "@chemdraft/export-engine";
import type { ExportWarning } from "@chemdraft/export-engine";
import { exportDocumentToCdxml, openChemDraftPayload } from "@chemdraft/cdx-compat";
import { parseMolfileGraph } from "@chemdraft/clipboard-adapter";
import { applyPatch, BracketObjectSchema, createEmptyDocument, moleculeToMolfileV2000, resolveRepeatUnitAtomMembership,
  toEngineDocument, type ChemDraftDocument, type DocumentObject, type MoleculeObject, type ReactionObject } from "@chemdraft/chem-core";
import { PluginApiVersion, type PluginCommandContext, type PluginPermission, type PluginToolHandler } from "@chemdraft/plugin-api";
import { PluginHost, type RequestDocument, type PluginPatchApplicationRequest } from "@chemdraft/plugin-host";
import { describe, expect, it, vi } from "vitest";
import { createNativeArtLineGraphicObject, createNativeMolfileMolecule, normalizeCommittedDocument, selectionBounds } from "../../documentWorkflow";
import { createPluginWriteGate } from "../applyPluginDocumentPatch";
import { buildPluginTablePatch } from "../buildPluginTablePatch";
import { createFigurePlanProviders } from "../figurePlans";
import { measure } from "../depiction/measureRegion";
import { createRequestHistory } from "./requestHistory";
import { planRequestPageFit } from "../../pageEnlargement";
import { deferred } from "../../testSupport/deferred";
import { expectStoredGraph, graphEditChanges, graphEditFixture, pluginGraphEdits } from "../../testSupport/pluginGraphEdits";

const frame = (id: string) => ({ id, style: {}, x: 120, y: 130, width: 30, height: 20, rotation: 0 });
const note = (id: string, text = id) => ({ ...frame(id), type: "text" as const, text, spans: [] });
const ethane: MoleculeObject = {
  id: "ethane", type: "molecule", x: 200, y: 200, width: 22, height: 20, rotation: 0, style: {},
  structureFormat: "smiles", structure: "CC", rGroups: [], superatoms: [],
  atoms: [
    { id: "a1", element: "C", x: 200, y: 200, formalCharge: 0 },
    { id: "a2", element: "C", x: 222, y: 200, formalCharge: 0 }
  ],
  bonds: [{ id: "b1", fromAtomId: "a1", toAtomId: "a2", order: "single" }]
};
const command = "plugin.requests.send";
const otherCommand = "plugin.requests.ordinary";
const plugin = "org.test.requests";

function setup(initialIds: string[] = [], onToolCall?: PluginToolHandler,
  options: { writeSelection?: string[]; duplicate?: boolean; deferOrdinary?: boolean; objects?: DocumentObject[];
    confirm?: () => Promise<"enlarge" | "keep"> } = {}) {
  const first = toEngineDocument(createEmptyDocument());
  const pageId = first.pages[0]!.id;
  let pinned: ChemDraftDocument | undefined = normalizeCommittedDocument(applyPatch(first, { op: "batch", patches: [
    { op: "addObject", pageId, object: note("anchor") },
    { op: "addObject", pageId, object: { ...ethane, chemistry: nativeSingleBondGraphMetadata(ethane.atoms, ethane.bonds),
      compatibility: { sourceFormat: "smiles", unknown: { smiles: "CC" }, warnings: [] } } },
    ...(options.objects ?? []).map(object => ({ op: "addObject" as const, pageId, object })),
    { op: "setSelection", pageId, objectIds: initialIds }
  ] }));
  if (options.duplicate) {
    pinned = { ...pinned, pages: [...pinned.pages, { ...pinned.pages[0]!, id: "other", objects: [note("anchor", "Other page")] }] };
  }
  const foreground = toEngineDocument(createEmptyDocument());
  let active = "first";
  const history: { before: ChemDraftDocument; after: ChemDraftDocument; label: string }[] = [];
  const edits = new Set<() => void>();
  const gesture = { active: false };
  const gate = createPluginWriteGate({ isGestureActive: () => gesture.active });
  const ordinary = vi.fn((application: PluginPatchApplicationRequest) => gate.run(() => {
    application.signal?.throwIfAborted();
    if (options.deferOrdinary) pinned = applyPatch(pinned!, application.patch.patch);
    return { applied: true as const, objectIds: [] };
  }));
  const document: RequestDocument = { key: "instance-first", read: () => pinned,
    viewport: () => ({ x: 0, y: 0, width: 500, height: 500 }) };
  let owner: symbol | undefined;
  let transformFinal = (document: ChemDraftDocument) => document;
  class TestHost extends PluginHost {
    override createCommandContext(...args: Parameters<PluginHost["createCommandContext"]>) {
      owner ??= args[1];
      return super.createCommandContext(...args);
    }
  }
  const host = new TestHost({
    getActiveDocument: () => active === "first" ? pinned : foreground,
    getActiveDocumentKey: () => active,
    captureRequestDocument: () => active === "first" ? document : { key: "instance-second", read: () => foreground },
    requestDepiction: {
      ...createFigurePlanProviders(),
      measure,
      inspectStructure: async () => ({ ok: false, error: { code: "unsupported", message: "No inspection provider." } }),
      rings: async () => ({ ok: false, error: { code: "unsupported", message: "No ring provider." } }),
      renderRegion: async () => ({ ok: false, error: { code: "unsupported", message: "No raster provider." } })
    },
    requestPageSpace: options.confirm && { plan: planRequestPageFit, confirm: options.confirm },
    buildTablePatch: buildPluginTablePatch,
    applyDocumentPatch: ordinary,
    openRequestHistory: (target, label) => createRequestHistory(target, {
      run: fn => gate.run(fn),
      onEdit: listener => { edits.add(listener); return () => edits.delete(listener); },
      commit(after, label, amend, guard) {
        const final = transformFinal(normalizeCommittedDocument(after));
        guard(final);
        if (amend) history.at(-1)!.after = final;
        else history.push({ before: pinned!, after: final, label });
        pinned = final;
      }
    }, label)
  });
  let context!: PluginCommandContext;
  let release!: () => void;
  host.registerPlugin({ id: plugin, name: "Request plugin", entry: "index.js", version: "0",
    apiVersion: `^${PluginApiVersion}`, permissions: ["document.read", "document.write", "selection.read", "chemistry.compute"],
    contributes: { commands: [{ id: command, title: "Send" }, { id: otherCommand, title: "Ordinary" }] }
  }, { onToolCall, commandHandlers: {
    [command]: ctx => { context = ctx; return new Promise<void>(resolve => { release = resolve; }); },
    [otherCommand]: ctx => ctx.documents.applyPatch!({ reason: "Own command scope", patch: {
      op: "updateObject", objectId: "anchor", changes: { text: "Ordinary edit" }
    } })
  } });
  const invocation = host.invokeCommand(command, options.writeSelection ? { writeSelection: { objectIds: options.writeSelection, molecules: [] } } : {});
  return { host, owner: owner!, pageId, history, context, gesture, gate, ordinary,
    tamperFinal: (transform: (document: ChemDraftDocument) => ChemDraftDocument) => { transformFinal = transform; },
    pinned: () => pinned!, foreground: () => foreground,
    switchTabs: () => { active = "second"; },
    edit: (update: (document: ChemDraftDocument) => ChemDraftDocument, notify = true) => {
      pinned = update(pinned!);
      if (notify) for (const listener of edits) listener();
    },
    clear: () => { pinned = undefined; host.closeRequestsForDocument(document.key); },
    finish: async () => { release(); await invocation; gate.dispose(); },
    async begin() {
      const result = await context.requests!.begin({ label: "Draw requested objects" });
      if (!result.ok) throw new Error(result.error.message);
      return result.value.requestId;
    }
  };
}

describe("request page fit", () => {
  it("asks again after a stale page answer and caches only matching geometry", async () => {
    const answer = deferred<"enlarge">();
    const confirm = vi.fn(async (): Promise<"enlarge" | "keep"> => "keep").mockImplementationOnce(() => answer.promise);
    const f = setup([], undefined, { confirm });
    try {
      const requestId = await f.begin();
      const requests = f.context.requests!;
      async function revision() {
        const result = await requests.getContext({ requestId });
        if (!result.ok) throw new Error(result.error.message);
        return result.value.pages[0]!.revision;
      }
      const input = { requestId, pageId: f.pageId, revision: await revision(),
        requiredBounds: { x: -10, y: 5, width: 30, height: 20 } };
      const pending = requests.requestPageSpace!(input);
      const matching = requests.requestPageSpace!(input);
      await vi.waitFor(() => expect(confirm).toHaveBeenCalledOnce());
      f.edit(doc => applyPatch(doc, { op: "addObject", pageId: f.pageId, object: note("user") }));
      answer.resolve("enlarge");
      expect(await pending).toMatchObject({ ok: false, error: { code: "stale" } });
      expect(await matching).toMatchObject({ ok: false, error: { code: "stale" } });
      const updated = { ...input, revision: await revision(), requiredBounds: { ...input.requiredBounds, x: -500 } };
      for (let i = 0; i < 2; i++) {
        expect(await requests.requestPageSpace!(updated)).toMatchObject({ ok: true, value: { outcome: "keep" } });
      }
      expect(confirm).toHaveBeenCalledTimes(2);
      await requests.requestPageSpace!({ ...updated, requiredBounds: input.requiredBounds });
      expect(confirm).toHaveBeenCalledTimes(3);
      f.edit(doc => applyPatch(doc, { op: "addObject", pageId: f.pageId, object: note("another-edit") }));
      await requests.requestPageSpace!({ ...updated, revision: await revision() });
      expect(confirm).toHaveBeenCalledTimes(4);
    } finally { await f.finish(); }
  });

  it("reuses an explicit rectangle for an implicit fit at the same page revision", async () => {
    const confirm = vi.fn(async () => "enlarge" as const);
    const f = setup([], undefined, { confirm });
    try {
      const requestId = await f.begin();
      const context = await f.context.requests!.getContext({ requestId });
      if (!context.ok) throw new Error(context.error.message);
      const { pageId, revision } = context.value.pages[0]!;
      const requiredBounds = { x: -20, y: 10, width: 8, height: 8 };
      expect(await f.context.requests!.requestPageSpace!({ requestId, pageId, revision, requiredBounds }))
        .toMatchObject({ ok: true, value: { outcome: "enlarge" } });
      expect(await f.context.documents.applyRequestPatch!({ requestId, patch: { op: "addObject", pageId,
        object: { ...frame("plus"), type: "plus", ...requiredBounds } } })).toMatchObject({ ok: true });
      expect(f.history).toHaveLength(1);
      expect(confirm).toHaveBeenCalledOnce();
    } finally { await f.finish(); }
  });

  it.each([
    { change: "an in-bounds move", move: true, keep: false, explicit: false },
    { change: "an in-bounds move followed by Keep Page Size", move: true, keep: true, explicit: false },
    { change: "Keep Page Size at the same revision", move: false, keep: true, explicit: false },
    { change: "Keep Page Size supersedes an explicit decision ID", move: false, keep: true, explicit: true }
  ])("refuses queued growth with identical fit geometry after $change", async ({ move, keep, explicit }) => {
    const confirm = vi.fn(async (): Promise<"enlarge" | "keep"> => "keep").mockResolvedValueOnce("enlarge");
    const f = setup([], undefined, { confirm });
    try {
      const pageId = f.pageId;
      const requiredBounds = { x: -20, y: 10, width: 8, height: 8 };
      async function ask(ctx: PluginCommandContext, requestId: string) {
        const requests = ctx.requests!;
        const context = await requests.getContext({ requestId });
        if (!context.ok) throw new Error(context.error.message);
        return requests.requestPageSpace!({ requestId, pageId, revision: context.value.pages[0]!.revision, requiredBounds });
      }
      const requestId = await f.begin();
      const decision = await ask(f.context, requestId);
      if (!decision.ok || decision.value.outcome !== "enlarge") throw new Error("Expected page enlargement approval.");
      const patch = { op: "addObject" as const, pageId, object: { ...frame("plus"), type: "plus" as const, ...requiredBounds } };
      const fit = () => planRequestPageFit(f.pinned(), applyPatch(f.pinned(), patch)).growth;
      const approved = fit();
      expect(approved).toHaveLength(1);
      f.gesture.active = true;
      const pending = f.context.documents.applyRequestPatch!({ requestId, patch,
        ...(explicit && { pageSpace: { pageId, decisionId: decision.value.decisionId } }) });
      await vi.waitFor(() => expect(f.gate.pending()).toBe(1));
      if (move) f.edit(doc => applyPatch(doc, { op: "updateObject", objectId: "anchor", changes: { x: 150 } }));
      if (keep) {
        const command = "plugin.other.ask";
        f.host.registerPlugin({ id: "org.test.other", name: "Other request", entry: "index.js", version: "1",
          apiVersion: `^${PluginApiVersion}`, permissions: ["document.read", "document.write", "selection.read"],
          contributes: { commands: [{ id: command, title: "Ask about page size" }] }
        }, { commandHandlers: { [command]: async ctx => {
          const begin = await ctx.requests!.begin({ label: "Check page space" });
          if (!begin.ok) throw new Error(begin.error.message);
          expect(await ask(ctx, begin.value.requestId)).toMatchObject({ ok: true, value: { outcome: "keep" } });
        } } });
        await f.host.invokeCommand(command);
      }
      expect(fit()).toEqual(approved);
      const edited = f.pinned();
      f.gesture.active = false;
      f.gate.flush();
      expect(await pending).toMatchObject({ ok: false, error: { code: "stale" } });
      expect(f.pinned()).toBe(edited);
      expect(f.history).toHaveLength(0);
      expect(confirm).toHaveBeenCalledTimes(keep ? 2 : 1);
    } finally { await f.finish(); }
  });

  it.each([
    { initialX: 900, editX: -500, addObject: true, change: "translation and size" },
    { initialX: -20, editX: 20, addObject: true, change: "set of moved objects" },
    { initialX: -20, editX: 1500, addObject: false, change: "width alone" }
  ])("refuses an implicit fit when a page edit changes the $change", async ({ initialX, editX, addObject }) => {
    const confirm = vi.fn(async () => "enlarge" as const);
    const f = setup([], undefined, { confirm });
    try {
      f.gesture.active = true;
      const pending = f.context.documents.applyRequestPatch!({ requestId: await f.begin(), patch: {
        op: "addObject", pageId: f.pageId, object: { ...note("overflow"), x: initialX }
      } });
      await vi.waitFor(() => expect(f.gate.pending()).toBe(1));
      expect(confirm).toHaveBeenCalledOnce();
      f.edit(doc => applyPatch(doc, addObject
        ? { op: "addObject", pageId: f.pageId, object: { ...note("user"), x: editX } }
        : { op: "updateObject", objectId: "anchor", changes: { x: editX } }));
      const edited = f.pinned();
      f.gesture.active = false;
      f.gate.flush();
      expect(await pending).toMatchObject({ ok: false, error: { code: "stale" } });
      expect(f.pinned()).toBe(edited);
      expect(f.history).toHaveLength(0);
    } finally { await f.finish(); }
  });

  it.each([false, true])("fits the normalized attached conditions when an arrow moves near the top edge (rebase: %s)", async rebase => {
    const drawing = createEmptyDocument();
    const pageId = drawing.pages[0]!.id;
    const arrow = createNativeArtLineGraphicObject(drawing, { x: 100, y: 100 }, { x: 200, y: 100 }, "tool.art.reactionArrow")!;
    const labeled = setReactionArrowConditions(applyPatch(drawing, { op: "addObject", pageId, object: arrow }),
      arrow.id, { side: "above", spans: [{ text: "Heat", script: "normal" }] });
    const objects = labeled.pages[0]!.objects;
    const confirm = vi.fn(async () => "enlarge" as const);
    const f = setup(objects.map(object => object.id), undefined, { objects, confirm });
    try {
      const shifted = createNativeArtLineGraphicObject(drawing, { x: 100, y: 5 }, { x: 200, y: 5 }, "tool.art.reactionArrow")!;
      f.gesture.active = rebase;
      const pending = f.context.documents.applyRequestPatch!({ requestId: await f.begin(), patch: {
        op: "updateObject", objectId: arrow.id, changes: { x: shifted.x, y: shifted.y, data: shifted.data }
      } });
      if (rebase) {
        await vi.waitFor(() => expect(f.gate.pending()).toBe(1));
        f.edit(doc => applyPatch(doc, { op: "setSelection", pageId: f.pageId, objectIds: [] }));
        f.gesture.active = false;
        f.gate.flush();
      }
      expect(await pending).toMatchObject({ ok: true });
      expect(confirm).toHaveBeenCalledOnce();
      const label = f.pinned().pages[0]!.objects.find(object => object.type === "text" && object.arrowAttachment)!;
      expect(label.y).toBeGreaterThanOrEqual(0);
    } finally { await f.finish(); }
  });
});

describe("verified request writes", () => {
  it.each(pluginGraphEdits)("refreshes stored chemistry after a normalized plugin $name edit", async edit => {
    const molecule = graphEditFixture(createEmptyDocument(), edit);
    const f = setup([molecule.id], undefined, { objects: [molecule] });
    try {
      const before = f.pinned();
      const requestId = await f.begin();
      const patch = {
        op: "updateObject" as const, objectId: molecule.id, changes: graphEditChanges(molecule, edit)
      };
      await expect(f.context.documents.applyPatch!({ reason: "Undeclared graph edit", patch })).rejects.toMatchObject({ code: "chemistry" });
      expect(f.pinned()).toBe(before);
      const result = await f.context.documents.applyRequestPatch!({ requestId, patch,
        expectedStructures: [{ kind: "object", pageId: f.pageId, objectId: molecule.id, sourceSmiles: edit.product }] });
      if (!result.ok) throw new Error(result.error.message);
      const after = f.pinned();
      expect(after.selection.objectIds).toEqual([molecule.id]);
      const stored = after.pages[0]!.objects.at(-1) as MoleculeObject;
      await expectStoredGraph(stored, edit);
      if (edit.name === "isotopic E/Z") {
        const warnings: ExportWarning[] = [];
        await moleculeSmiles(stored, 0, warnings, undefined);
        expect(warnings).toContainEqual(expect.objectContaining({ code: "export.smiles_stereo_dropped" }));
      }
      expect(f.history).toEqual([{ before, after, label: "Draw requested objects" }]);
    } finally { await f.finish(); }
  }, 20_000);
  function wavyHalide(version: "v2000" | "v3000") {
    const base: MoleculeObject = { ...ethane, id: "halide", structure: "CC(F)Cl",
      atoms: [...ethane.atoms, { ...ethane.atoms[1]!, id: "f", element: "F", x: 233, y: 181 },
        { ...ethane.atoms[1]!, id: "cl", element: "Cl", x: 233, y: 219 }],
      bonds: [...ethane.bonds, { id: "cf", fromAtomId: "a2", toAtomId: "f", order: "single" },
        { id: "ccl", fromAtomId: "a2", toAtomId: "cl", order: "single" }] };
    const marked = { ...base, bonds: base.bonds.map(bond => bond.id === "cf"
      ? { ...bond, display: { bondStyle: "wavy" as const } } : bond) };
    const structure = chemicalIdentitySource(marked, [], version).molfile;
    return { molecule: { ...base, structureFormat: `molfile-${version}` as const, structure }, markedBonds: marked.bonds };
  }

  it.each(["v2000", "v3000"] as const)("refuses loss of stored %s wavy stereo at a surviving centre", async version => {
    const { molecule, markedBonds } = wavyHalide(version);
    expect(molecule.structure).toContain(version === "v2000" ? "  2  3  1  4" : "2 1 2 3 CFG=2");
    const f = setup([molecule.id], undefined, { objects: [molecule] });
    try {
      const before = f.pinned();
      const requestId = await f.begin();
      // Even a proposed edit that restores the stored wave cannot settle the original disagreement.
      for (const bonds of [molecule.bonds, markedBonds, markedBonds.map(bond => bond.id === "cf"
        ? { ...bond, fromAtomId: "f", toAtomId: "a2" } : bond)]) {
        const result = await f.context.documents.applyRequestPatch!({ requestId,
          patch: { op: "updateObject", objectId: molecule.id,
            changes: { atoms: molecule.atoms.map(atom => atom.id === "a1" ? { ...atom, element: "O" } : atom), bonds } },
          expectedStructures: [{ kind: "object", pageId: f.pageId, objectId: molecule.id, sourceSmiles: "OC(F)Cl" }] });
        expect(result).toMatchObject({ ok: false, error: { code: "chemistry", message: /stereo/i } });
        expect(f.history).toHaveLength(0);
        expect(f.pinned()).toBe(before);
      }
    } finally { await f.finish(); }
  });

  it.each(["v2000", "v3000"] as const)("maps retained %s wavy stereo by atom ID through a reordered edit", async version => {
    const { molecule, markedBonds } = wavyHalide(version);
    const f = setup([molecule.id], undefined, { objects: [{ ...molecule, bonds: markedBonds }] });
    try {
      const atoms = molecule.atoms.map(atom => atom.id === "a1" ? { ...atom, element: "O" } : atom).reverse();
      const result = await f.context.documents.applyRequestPatch!({ requestId: await f.begin(),
        expectedStructures: [{ kind: "object", pageId: f.pageId, objectId: molecule.id, sourceSmiles: "OC(F)Cl" }],
        patch: { op: "updateObject", objectId: molecule.id, changes: { atoms, bonds: [...markedBonds].reverse() } } });
      if (!result.ok) throw new Error(result.error.message);
      const final = f.pinned().pages[0]!.objects.at(-1) as MoleculeObject;
      expect(final.structureFormat).toBe(molecule.structureFormat);
      expect(final.structure).toContain(version === "v2000" ? "  3  2  1  4" : "2 1 3 2 CFG=2");
      expect(f.history).toHaveLength(1);
    } finally { await f.finish(); }
  });

  it.each(["v2000", "v3000"] as const)("uses bond neighbors to distinguish coincident carbons in %s", async version => {
    const { molecule, markedBonds } = wavyHalide(version);
    const methyl = molecule.atoms[0]!;
    const drawn: MoleculeObject = { ...molecule, atoms: [...molecule.atoms,
      { ...methyl, id: "ether", element: "O", x: 222, y: 225 }, { ...methyl, id: "methoxy" }],
      bonds: [...markedBonds, { id: "co", fromAtomId: "a2", toAtomId: "ether", order: "single" },
        { id: "oc", fromAtomId: "ether", toAtomId: "methoxy", order: "single" }] };
    // Two terminal carbons share a position and a degree. Only one is bound to the ether oxygen.
    drawn.structure = chemicalIdentitySource({ ...drawn, atoms: [...drawn.atoms].reverse() }, [], version).molfile;
    const f = setup([drawn.id], undefined, { objects: [drawn] });
    try {
      const result = await f.context.documents.applyRequestPatch!({ requestId: await f.begin(),
        patch: { op: "updateObject", objectId: drawn.id,
          changes: { atoms: drawn.atoms.map(atom => atom.id === methyl.id ? { ...atom, element: "O" } : atom) } },
        expectedStructures: [{ kind: "object", pageId: f.pageId, objectId: drawn.id, sourceSmiles: "OC(F)(Cl)OC" }] });
      if (!result.ok) throw new Error(result.error.message);
      expect(f.history).toHaveLength(1);
    } finally { await f.finish(); }
  });

  describe.each(["v2000", "v3000"] as const)("%s stereo on symmetry-related centres", version => {
    const atom = (id: string, element: string, x: number, y: number) => ({ id, element, x, y, formalCharge: 0 });
    const bond = (fromAtomId: string, toAtomId: string, wavy = false): MoleculeObject["bonds"][number] => ({
      id: fromAtomId + toAtomId, fromAtomId, toAtomId, order: "single", ...(wavy ? { display: { bondStyle: "wavy" } } : {})
    });
    const drawn: MoleculeObject = { ...ethane, id: "difluorobutane", x: 470, y: 278, width: 66, height: 64, structureFormat: `molfile-${version}`,
      atoms: [atom("endL", "C", 470, 320), atom("centreL", "C", 492, 300), atom("centreR", "C", 514, 320),
        atom("endR", "C", 536, 300), atom("fL", "F", 492, 278), atom("fR", "F", 514, 342)],
      bonds: [bond("endL", "centreL"), bond("centreL", "centreR"), bond("centreR", "endR"),
        bond("centreL", "fL", true), bond("centreR", "fR")] };
    function waveX(molfile: string) {
      const graph = parseMolfileGraph(molfile);
      const wave = graph.bonds.find(b => b.bondStyle === "wavy")!;
      return graph.atoms.find(a => a.id === wave.fromAtomId)!.x;
    }
    function swapSymmetricPositions(molecule: MoleculeObject) {
      return [3, 2, 1, 0, 5, 4].map((other, i) => ({
        ...molecule.atoms[i]!, x: molecule.atoms[other]!.x, y: molecule.atoms[other]!.y
      }));
    }
    it("refuses chemical edits to opposite stored and drawn waves before and after a symmetry redraw", async () => {
      const structure = chemicalIdentitySource({ ...drawn,
        bonds: [...drawn.bonds.slice(0, 3), bond("centreL", "fL"), bond("centreR", "fR", true)] }, [], version).molfile;
      const molecule = { ...drawn, structure };
      const f = setup([molecule.id], undefined, { objects: [molecule] });
      try {
        const requestId = await f.begin();
        const apply = f.context.documents.applyRequestPatch!;
        const changeEnd = (atoms: MoleculeObject["atoms"]) => apply({ requestId,
          patch: { op: "updateObject", objectId: molecule.id,
            changes: { atoms: atoms.map(a => a.id === "endL" ? { ...a, element: "O" } : a) } },
          expectedStructures: [{ kind: "object", pageId: f.pageId, objectId: molecule.id, sourceSmiles: "OC(F)C(F)C" }] });
        const refused = { ok: false, error: { code: "chemistry", message: /stereo/i } };
        const before = f.pinned();
        expect(await changeEnd(molecule.atoms)).toMatchObject(refused);
        expect(f.history).toHaveLength(0);
        expect(f.pinned()).toBe(before);

        const flipped = swapSymmetricPositions(molecule);
        const placement = await apply({ requestId, patch: { op: "updateObject", objectId: molecule.id, changes: { atoms: flipped } } });
        if (!placement.ok) throw new Error(placement.error.message);
        const redrawn = f.pinned();
        expect(redrawn.pages[0]!.objects.at(-1)).toMatchObject({ structure, atoms: flipped });
        expect(await changeEnd(flipped)).toMatchObject(refused);
        expect(f.pinned()).toBe(redrawn);
        expect(f.history).toHaveLength(1);
      } finally { await f.finish(); }
    });

    it("keeps a consistent wave attached to its atom across a redraw and document reload", async () => {
      const structure = chemicalIdentitySource(drawn, [], version).molfile;
      const f = setup([drawn.id], undefined, { objects: [{ ...drawn, structure }] });
      let saved: MoleculeObject;
      try {
        const result = await f.context.documents.applyRequestPatch!({ requestId: await f.begin(),
          patch: { op: "updateObject", objectId: drawn.id, changes: { atoms: swapSymmetricPositions(drawn) } } });
        expect(result).toMatchObject({ ok: true });
        saved = JSON.parse(JSON.stringify(f.pinned().pages[0]!.objects.at(-1)));
        expect(saved.structure).toBe(structure);
      } finally { await f.finish(); }
      const reopened = setup([saved.id], undefined, { objects: [saved] });
      try {
        const result = await reopened.context.documents.applyRequestPatch!({ requestId: await reopened.begin(),
          patch: { op: "updateObject", objectId: saved.id,
            changes: { atoms: saved.atoms.map(atom => atom.id === "endL" ? { ...atom, element: "O" } : atom) } },
          expectedStructures: [{ kind: "object", pageId: reopened.pageId, objectId: saved.id, sourceSmiles: "OC(F)C(F)C" }] });
        if (!result.ok) throw new Error(result.error.message);
        const final = reopened.pinned().pages[0]!.objects.at(-1) as MoleculeObject;
        expect(waveX(final.structure)).toBe(saved.atoms.find(a => a.id === "centreL")!.x);
        expect(reopened.history).toHaveLength(1);
      } finally { await reopened.finish(); }
    });

    it("accepts a second chemical edit after a pasted wavy MOL is renumbered", async () => {
      const molecule = createNativeMolfileMolecule(createEmptyDocument(), { x: 470, y: 300 },
        chemicalIdentitySource(drawn, [], version).molfile, `molfile-${version}`);
      const f = setup([molecule.id], undefined, { objects: [molecule] });
      try {
        const requestId = await f.begin();
        const edit = (atoms: MoleculeObject["atoms"], sourceSmiles: string) => f.context.documents.applyRequestPatch!({ requestId,
          patch: { op: "updateObject", objectId: molecule.id, changes: { atoms } },
          expectedStructures: [{ kind: "object", pageId: f.pageId, objectId: molecule.id, sourceSmiles }] });
        const atoms = molecule.atoms.map((atom, i) => i === 0 ? { ...atom, element: "O" } : atom).reverse();
        const firstEdit = await edit(atoms, "OC(F)C(F)C");
        if (!firstEdit.ok) throw new Error(firstEdit.error.message);
        const first = f.pinned().pages[0]!.objects.at(-1) as MoleculeObject;
        expect(parseMolfileGraph(first.structure).atoms.at(-1)?.element).toBe("O");
        expect(first.compatibility?.warnings).toContainEqual(expect.objectContaining({ code: "clipboard.molfile_imported" }));
        expect(await edit(first.atoms.map(atom => atom.id === molecule.atoms[3]!.id ? { ...atom, element: "N" } : atom),
          "OC(F)C(F)N")).toMatchObject({ ok: true });
        const final = f.pinned().pages[0]!.objects.at(-1) as MoleculeObject;
        expect(waveX(final.structure)).toBe(waveX(first.structure));
        expect(f.history).toHaveLength(1);
      } finally { await f.finish(); }
    });

    it.each(["reversed order and opposite wave", "normal order", "reversed order and matching wave", "ambiguous coordinates"])(
      "checks the stored stereo correspondence with %s", async scenario => {
        const opposite = scenario === "reversed order and opposite wave";
        const molecule = structuredClone(drawn);
        if (scenario === "ambiguous coordinates") {
          // Preserve the native stereochemical drawing, but remove positional evidence from its stored CTAB.
          molecule.structure = chemicalIdentitySource({ ...molecule, atoms: molecule.atoms.map(a => ({ ...a, x: 0, y: 0 })) }, [], version).molfile;
        } else {
          const atoms = scenario === "normal order" ? molecule.atoms : [3, 2, 1, 0, 5, 4].map(i => molecule.atoms[i]!);
          const bonds = opposite ? [...molecule.bonds.slice(0, 3), bond("centreL", "fL"), bond("centreR", "fR", true)] : molecule.bonds;
          molecule.structure = chemicalIdentitySource({ ...molecule, atoms, bonds }, [], version).molfile;
          expect(waveX(molecule.structure)).toBe(opposite ? 514 : 492);
        }
        const f = setup([molecule.id], undefined, { objects: [molecule] });
        try {
          const before = f.pinned();
          const requestId = await f.begin();
          const result = await f.context.documents.applyRequestPatch!({ requestId,
            patch: { op: "updateObject", objectId: molecule.id,
              changes: { atoms: molecule.atoms.map(a => a.id === "endL" ? { ...a, element: "O" } : a) } },
            expectedStructures: [{ kind: "object", pageId: f.pageId, objectId: molecule.id, sourceSmiles: "OC(F)C(F)C" }] });
          if (opposite || scenario === "ambiguous coordinates") {
            expect(result).toMatchObject({ ok: false, error: { code: "chemistry", message: /stereo/i } });
            expect(f.pinned()).toBe(before);
            expect(f.history).toHaveLength(0);
            const placed = await f.context.documents.applyRequestPatch!({ requestId,
              patch: { op: "updateObject", objectId: molecule.id, changes: { x: molecule.x + 10,
                atoms: molecule.atoms.map(a => ({ ...a, x: a.x + 10 })), style: { strokeColor: "#441144" } } } });
            expect(placed).toMatchObject({ ok: true });
            expect(f.pinned().pages[0]!.objects.at(-1)).toMatchObject({ structure: molecule.structure });
          } else {
            expect(result).toMatchObject({ ok: true });
            expect(waveX((f.pinned().pages[0]!.objects.at(-1) as MoleculeObject).structure)).toBe(492);
            expect(f.history).toHaveLength(1);
          }
        } finally { await f.finish(); }
      });
  });

  it.each(["v2000", "v3000"] as const)("refuses loss of %s atom stereo parity on a surviving atom", async version => {
    const { molecule } = wavyHalide(version);
    const plain = chemicalIdentitySource(molecule, [], version).molfile;
    if (version === "v2000") {
      const lines = plain.split("\n");
      lines[5] = lines[5]!.slice(0, 39) + "  3" + lines[5]!.slice(42);
      molecule.structure = lines.join("\n");
    } else {
      molecule.structure = plain.replace(/(M  V30 2 C [^\n]+)/, "$1 CFG=3");
    }
    const f = setup([molecule.id], undefined, { objects: [molecule] });
    try {
      const before = f.pinned();
      expect(await f.context.documents.applyRequestPatch!({ requestId: await f.begin(),
        patch: { op: "updateObject", objectId: molecule.id,
          changes: { atoms: molecule.atoms.map(atom => atom.id === "a1" ? { ...atom, element: "O" } : atom) } },
        expectedStructures: [{ kind: "object", pageId: f.pageId, objectId: molecule.id, sourceSmiles: "OC(F)Cl" }]
      })).toMatchObject({ ok: false, error: { code: "chemistry", message: /stereo parity/ } });
      expect(f.history).toHaveLength(0);
      expect(f.pinned()).toBe(before);
    } finally { await f.finish(); }
  });

  it.each(["V3000 STERAC", "CXSMILES", "V2000 M RAD", "V3000 RAD=", "V2000 SRU"])(
    "preserves source-only %s through a geometry write", async format => {
      const document = createEmptyDocument();
      const base = createNativeMolfileMolecule(document, { x: 380, y: 300 },
        depictSmiles2D(format === "V2000 SRU" ? "CCCC" : format.includes("RAD") ? "C" : "F[C@H](Cl)C").molfile, "molfile-v2000");
      const v3000 = chemicalIdentitySource(base, [], "v3000").molfile;
      let molecule: MoleculeObject;
      switch (format) {
        case "V3000 STERAC":
          molecule = { ...base, structureFormat: "molfile-v3000", structure: v3000.replace("M  V30 END CTAB",
            "M  V30 BEGIN COLLECTION\nM  V30 MDLV30/STERAC1 ATOMS=(1 2)\nM  V30 END COLLECTION\nM  V30 END CTAB") };
          break;
        case "CXSMILES":
          molecule = { ...base, structureFormat: "smiles", structure: "F[C@H](Cl)C |&1:1|" };
          break;
        case "V2000 M RAD":
          molecule = { ...base, structure: base.structure.replace("M  END", "M  RAD  1   1   2\nM  END") };
          break;
        case "V3000 RAD=":
          molecule = { ...base, structureFormat: "molfile-v3000", structure: v3000.replace(/(M  V30 1 C [^\n]+)/, "$1 RAD=2") };
          break;
        default:
          molecule = { ...base, structure: moleculeToMolfileV2000(base, { kekuleBondOrders: new Map(),
            repeatUnitGroups: [{ objectId: "unit", label: "n", atomIds: base.atoms.slice(1, 3).map(atom => atom.id) }] }).contents };
      }
      if (format.includes("RAD")) {
        installNodeRdkitModuleLoader();
        expect(await computeStructureIdentifiers(molecule.structure)).toMatchObject({ smiles: "[CH3]" });
      }
      const f = setup([molecule.id], undefined, { objects: [molecule] });
      try {
        const requestId = await f.begin();
        const before = f.pinned().pages[0]!.objects.at(-1) as MoleculeObject;
        installNodeRdkitModuleLoader();
        const smiles = (await computeStructureIdentifiers(chemicalIdentityMolfile(before)))?.smiles;
        if (!smiles) throw new Error("The fixture needs a parseable native graph.");
        const stripSource = { op: "updateObject" as const, objectId: before.id,
          changes: { structureFormat: "smiles" as const, structure: smiles } };
        const apply = f.context.documents.applyRequestPatch!;
        for (const expectedStructures of [[], [{ kind: "object" as const, pageId: f.pageId, objectId: before.id, sourceSmiles: smiles }]]) {
          expect(await apply({ requestId, patch: stripSource, expectedStructures })).toMatchObject({
            ok: false, error: { code: "chemistry" }
          });
          expect(f.history).toHaveLength(0);
          expect(f.pinned().pages[0]!.objects.at(-1)).toBe(before);
        }
        expect(await apply({ requestId, patch: { op: "updateObject", objectId: before.id,
          changes: { atoms: ethane.atoms, bonds: ethane.bonds } }, expectedStructures: [
          { kind: "object", pageId: f.pageId, objectId: before.id, sourceSmiles: "CC" }
        ] })).toMatchObject({ ok: false, error: { code: "chemistry" } });
        expect(f.history).toHaveLength(0);
        const changes = { x: before.x + 40, atoms: before.atoms.map(atom => ({ ...atom, x: atom.x + 40 })) };
        const result = await apply({ requestId, patch: {
          op: "updateObject", objectId: before.id, changes
        } });
        if (!result.ok) throw new Error(result.error.message);
        expect(f.pinned().pages[0]!.objects.at(-1)).toEqual({ ...before, ...changes });
        expect(f.history).toHaveLength(1);
      } finally { await f.finish(); }
    });

  function geometricUnit(cached: boolean) {
    const chain: MoleculeObject = { ...ethane, id: "chain", structure: "CCCC", x: 300, width: 66,
      atoms: [0, 1, 2, 3].map(i => ({ id: `c${i}`, element: "C", x: 300 + i * 22, y: 200, formalCharge: 0 })),
      bonds: [0, 1, 2].map(i => ({ id: `b${i}`, fromAtomId: `c${i}`, toAtomId: `c${i + 1}`, order: "single" })) };
    if (cached) chain.chemistry = nativeSingleBondGraphMetadata(chain.atoms, chain.bonds);
    const open = BracketObjectSchema.parse({ ...frame("open"), type: "bracket", bracketKind: "square", side: "open",
      pairId: "polymer", repeatUnit: true, x: 312, y: 190, width: 2, height: 25 });
    const close = { ...open, id: "close", side: "close" as const, x: 353, label: "n" };
    const pair = [open, close];
    expect(resolveRepeatUnitAtomMembership(pair, [chain, ...pair])).toMatchObject({
      members: [{ atomIds: ["c1", "c2"] }], unresolved: false
    });
    return { chain, pair };
  }

  it("refuses a stacking order that changes a legacy SRU to a multiple group", async () => {
    const { chain, pair } = geometricUnit(false);
    const open = BracketObjectSchema.parse({ ...pair[0]!, pairId: "conflict", bracketKind: "polymer", bracketUsage: "sru" });
    const close = BracketObjectSchema.parse({ ...open, id: "close", side: "close", x: 353, label: "n",
      bracketUsage: "multiple", repeatCount: 3 });
    const ids = ["anchor", "ethane", chain.id, open.id, close.id];
    const f = setup(ids, undefined, { objects: [chain, open, close] });
    try {
      const before = f.pinned();
      const patch = { op: "setObjectOrder" as const, pageId: f.pageId, objectIds: [...ids.slice(0, -2), close.id, open.id] };
      const reordered = applyPatch(before, patch);
      expect(repeatUnitMolfileGroups(before, [chain], [])).toMatchObject([{ label: "n", atomIds: ["c1", "c2"] }]);
      expect(repeatUnits(reordered)).toMatchObject([{ usage: "multiple" }]);
      expect(repeatUnitMolfileGroups(reordered, [chain], [])).toEqual([]);
      expect(await f.context.documents.applyRequestPatch!({ requestId: await f.begin(), patch }))
        .toMatchObject({ ok: false, error: { code: "chemistry", message: /repeat unit/i } });
      expect(f.history).toHaveLength(0);
      expect(f.pinned()).toBe(before);
    } finally { await f.finish(); }
  });

  it("refuses a closing glyph edit that changes visible CDXML repeat connectivity", async () => {
    const xml = `<CDXML><page><fragment id="10"><n id="11" p="300 200"/></fragment>
      <graphic id="20" GraphicType="Bracket" BracketType="Square" BoundingBox="280 220 285 180"/>
      <graphic id="21" GraphicType="Bracket" BracketType="Square" BoundingBox="325 180 320 220"/>
      <bracketedgroup id="30" BracketUsage="SRU" BracketedObjectIDs="10" PolymerRepeatPattern="HeadToTail">
        <bracketattachment id="31" GraphicID="20"/><bracketattachment id="32" GraphicID="21"/>
      </bracketedgroup></page></CDXML>`;
    const objects = openChemDraftPayload(xml).document!.pages[0]!.objects;
    const brackets = objects.filter(object => object.type === "bracket");
    expect(brackets.map(bracket => bracket.side)).toEqual(["open", "close"]);
    const close = brackets[1]!;
    const f = setup([close.id], undefined, { objects });
    try {
      const before = f.pinned();
      const compatibility = close.compatibility!;
      const group = compatibility.unknown.bracketedGroup as { attributes: Record<string, string> };
      const patch = { op: "updateObject" as const, objectId: close.id, changes: {
        compatibility: { ...compatibility, unknown: { ...compatibility.unknown, bracketedGroup: {
          ...group, attributes: { ...group.attributes, PolymerRepeatPattern: "HeadToHead" }
        } } }
      } };
      const visible = (doc: ChemDraftDocument) => exportDocumentToCdxml(doc, { embedNativePayload: false }).contents;
      expect(visible(before)).toContain('PolymerRepeatPattern="HeadToTail"');
      expect(visible(applyPatch(before, patch))).toContain('PolymerRepeatPattern="HeadToHead"');
      expect(await f.context.documents.applyRequestPatch!({ requestId: await f.begin(), patch }))
        .toMatchObject({ ok: false, error: { code: "chemistry", message: expect.stringContaining(`bracket "${close.id}"`) } });
      expect(f.pinned()).toBe(before);
      expect(f.history).toHaveLength(0);
    } finally { await f.finish(); }
  });

  function structureOnlyBracketPair(repeatUnit = true) {
    const carbon: MoleculeObject = { ...ethane, id: "stored-carbon", x: 325, structure: "C", atoms: [], bonds: [] };
    const nitrogen = { ...carbon, id: "stored-nitrogen", x: 410, structure: "N" };
    const open = BracketObjectSchema.parse({ ...frame("open"), type: "bracket", bracketKind: "square", side: "open",
      pairId: "stored-pair", repeatUnit, containedObjectIds: [carbon.id], x: 312, y: 190, width: 2, height: 25 });
    const close = { ...open, id: "close", side: "close" as const, x: 353, label: repeatUnit ? "n" : undefined };
    const pair = [open, close];
    expect(resolveRepeatUnitAtomMembership(pair, [carbon, nitrogen, ...pair])).toMatchObject({
      members: [], structureOnlyMembers: [{ id: carbon.id, structure: "C" }], reason: "its atom membership is empty"
    });
    return { carbon, nitrogen, pair };
  }

  it.each(["clear membership", "delete member"] as const)("commits a plain bracket edit to %s", async action => {
    const { carbon, pair } = structureOnlyBracketPair(false);
    const f = setup([carbon.id, ...pair.map(bracket => bracket.id)], undefined, { objects: [carbon, ...pair] });
    try {
      const before = f.pinned();
      const patch = action === "clear membership" ? { op: "batch" as const, patches: pair.map(bracket => ({
        op: "updateObject" as const, objectId: bracket.id, changes: { containedObjectIds: [] }
      })) } : { op: "removeObject" as const, objectId: carbon.id };
      expect(await f.context.documents.applyRequestPatch!({ requestId: await f.begin(), patch }))
        .toMatchObject({ ok: true });
      const after = f.pinned();
      expect(f.history).toEqual([{ before, after, label: "Draw requested objects" }]);
      const objects = after.pages[0]!.objects;
      expect(objects.filter(object => object.type === "bracket")).toMatchObject(
        pair.map(({ id, pairId }) => ({ id, pairId, containedObjectIds: [] })));
      if (action === "clear membership") {
        expect(objects.find(object => object.id === carbon.id)).toEqual(carbon);
      } else {
        expect(objects.find(object => object.id === carbon.id)).toBeUndefined();
      }
    } finally { await f.finish(); }
  });

  it.each(["replace", "delete"] as const)("refuses a request to %s the only stored repeat-unit member", async action => {
    const { carbon, nitrogen, pair } = structureOnlyBracketPair();
    const f = setup([carbon.id, nitrogen.id, ...pair.map(bracket => bracket.id)], undefined,
      { objects: [carbon, nitrogen, ...pair] });
    try {
      const before = f.pinned();
      const patch = action === "replace" ? { op: "batch" as const, patches: pair.map(bracket => ({
        op: "updateObject" as const, objectId: bracket.id, changes: { containedObjectIds: [nitrogen.id] }
      })) } : { op: "removeObject" as const, objectId: carbon.id };
      const draft = applyPatch(before, patch, { preserveRepeatUnitBrackets: true }).pages[0]!.objects;
      const brackets = draft.filter(object => object.type === "bracket");
      expect(brackets).toHaveLength(2);
      expect(resolveRepeatUnitAtomMembership(brackets, draft)).toMatchObject({
        members: [], structureOnlyMembers: action === "replace" ? [{ id: nitrogen.id, structure: "N" }] : [],
        reason: "its atom membership is empty"
      });
      expect(await f.context.documents.applyRequestPatch!({ requestId: await f.begin(), patch }))
        .toMatchObject({ ok: false, error: { code: "chemistry", message: expect.stringContaining('bracket "close"') } });
      expect(f.pinned()).toBe(before);
      expect(f.history).toHaveLength(0);
    } finally { await f.finish(); }
  });

  it("refuses a chemistry change to a stored repeat-unit member that keeps its object ID", async () => {
    const { carbon, pair } = structureOnlyBracketPair();
    const f = setup([carbon.id], undefined, { objects: [carbon, ...pair] });
    try {
      const before = f.pinned();
      expect(await f.context.documents.applyRequestPatch!({ requestId: await f.begin(), patch: {
        op: "updateObject", objectId: carbon.id, changes: { structure: "N" }
      } })).toMatchObject({ ok: false, error: { code: "chemistry", message: expect.stringContaining('bracket "close"') } });
      expect(f.pinned()).toBe(before);
      expect(f.history).toHaveLength(0);
    } finally { await f.finish(); }
  });

  it.each(["moveObject", "updateObject"] as const)("commits an XY move of a stored repeat-unit member via %s", async op => {
    const { carbon, pair } = structureOnlyBracketPair();
    const stored: MoleculeObject = { ...carbon,
      chemistry: { formula: "CH4", isotopeLabels: [], stereochemistry: [], warnings: [] },
      compatibility: { sourceFormat: "smiles", unknown: { smiles: "C" }, warnings: [] } };
    const f = setup([stored.id], undefined, { objects: [stored, ...pair] });
    try {
      const before = f.pinned();
      const original = before.pages[0]!.objects.find(object => object.id === stored.id)!;
      const position = { x: stored.x + 5, y: stored.y + 2 };
      const patch = op === "moveObject" ? { op, objectId: stored.id, ...position }
        : { op, objectId: stored.id, changes: position };
      const requestId = await f.begin();
      expect(await f.context.documents.applyRequestPatch!({ requestId, patch })).toMatchObject({ ok: true });
      const after = f.pinned();
      expect(f.history).toEqual([{ before, after, label: "Draw requested objects" }]);
      expect(after.pages[0]!.objects.find(object => object.id === stored.id)).toEqual({ ...original, ...position });
      expect(await f.context.documents.applyRequestPatch!({ requestId, patch: {
        op: "updateObject", objectId: stored.id, changes: { structure: "N" }
      } })).toMatchObject({ ok: false, error: { code: "chemistry", message: expect.stringContaining('bracket "close"') } });
      expect(f.pinned()).toBe(after);
      expect(f.history).toHaveLength(1);
    } finally { await f.finish(); }
  });

  describe("stored-only SMILES", () => {
    const chemistry: NonNullable<MoleculeObject["chemistry"]> = {
      formula: "C2H6O", totalCharge: 0, isotopeLabels: [], stereochemistry: [], warnings: []
    };
    const stored: MoleculeObject = { ...ethane, id: "stored-smiles", structure: "CCO", atoms: [], bonds: [],
      chemistry, compatibility: { sourceFormat: "smiles", unknown: { smiles: "CCO" }, warnings: [] } };
    const position = { x: stored.x + 6, y: stored.y + 3 };

    it("commits a geometry-only first write with one history entry", async () => {
      const f = setup([stored.id], undefined, { objects: [stored] });
      try {
        const requestId = await f.begin();
        const before = f.pinned();
        const original = before.pages[0]!.objects.find(object => object.id === stored.id)!;
        expect(f.history).toHaveLength(0);
        expect(await f.context.documents.applyRequestPatch!({ requestId, patch: {
          op: "moveObject", objectId: stored.id, ...position
        } })).toMatchObject({ ok: true });
        const after = f.pinned();
        const moved = after.pages[0]!.objects.find(object => object.id === stored.id);
        expect(moved).toStrictEqual({ ...original, ...position });
        expect(JSON.stringify(moved)).toBe(JSON.stringify({ ...original, ...position }));
        expect(f.history).toEqual([{ before, after, label: "Draw requested objects" }]);
      } finally { await f.finish(); }
    });

    describe.each([
      { mode: "without a move", geometry: {} },
      { mode: "with a move", geometry: position }
    ])("$mode", ({ geometry }) => {
      it.each([
        { name: "stored SMILES", structure: "CCO", changes: { structure: "CCN" } },
        { name: "charge in SMILES", structure: "C[NH3+]", changes: { structure: "CN" } },
        { name: "isotope in SMILES", structure: "CCO", changes: { structure: "[13CH3]CO" } },
        { name: "stereo in SMILES", structure: "C[C@H](N)O", changes: { structure: "C[C@@H](N)O" } },
        { name: "stored total formal charge", structure: "CCO", changes: { chemistry: { ...chemistry, totalCharge: 1 } } },
        { name: "stored isotope labels", structure: "CCO", changes: { chemistry: { ...chemistry, isotopeLabels: ["13C"] } } },
        { name: "stored stereochemistry", structure: "CCO", changes: { chemistry: { ...chemistry, stereochemistry: ["R"] } } }
      ])("refuses changing $name on the first write without recording history", async ({ structure, changes }) => {
        const molecule: MoleculeObject = {
          ...stored, structure,
          ...(structure === stored.structure ? {} : { chemistry: undefined, compatibility: undefined })
        };
        const f = setup([molecule.id], undefined, { objects: [molecule] });
        try {
          const requestId = await f.begin();
          const before = f.pinned();
          const beforeBytes = JSON.stringify(before);
          expect(f.history).toHaveLength(0);
          expect(await f.context.documents.applyRequestPatch!({ requestId, patch: {
            op: "updateObject", objectId: molecule.id, changes: { ...changes, ...geometry }
          } })).toMatchObject({ ok: false, error: { code: "chemistry" } });
          expect(f.pinned()).toBe(before);
          expect(JSON.stringify(f.pinned())).toBe(beforeBytes);
          expect(f.history).toHaveLength(0);
        } finally { await f.finish(); }
      });
    });
  });

  it("preserves a stored-only molfile on a move and refuses replacing it", async () => {
    const structure = chemicalIdentitySource(ethane, [], "v2000").molfile;
    const stored: MoleculeObject = { ...ethane, id: "stored-molfile", structureFormat: "molfile-v2000",
      structure, atoms: [], bonds: [] };
    const f = setup([stored.id], undefined, { objects: [stored] });
    try {
      const before = f.pinned();
      const position = { x: stored.x + 6, y: stored.y + 3 };
      const requestId = await f.begin();
      expect(await f.context.documents.applyRequestPatch!({ requestId, patch: {
        op: "moveObject", objectId: stored.id, ...position
      } })).toMatchObject({ ok: true });
      const after = f.pinned();
      expect(after.pages[0]!.objects.find(object => object.id === stored.id)).toEqual({ ...stored, ...position });
      expect(await f.context.documents.applyRequestPatch!({ requestId, patch: {
        op: "updateObject", objectId: stored.id, changes: { structure: `${structure}\n` }
      } })).toMatchObject({ ok: false, error: { code: "chemistry" } });
      expect(f.pinned()).toBe(after);
      expect(f.history).toEqual([{ before, after, label: "Draw requested objects" }]);
    } finally { await f.finish(); }
  });

  it("commits a geometry-only move of a repeat unit with a stored member", async () => {
    const { carbon, pair } = structureOnlyBracketPair();
    const f = setup(pair.map(bracket => bracket.id), undefined, { objects: [carbon, ...pair] });
    try {
      const before = f.pinned();
      const moves = pair.map(bracket => ({ op: "moveObject" as const, objectId: bracket.id, x: bracket.x + 8, y: bracket.y }));
      expect(await f.context.documents.applyRequestPatch!({ requestId: await f.begin(), patch: { op: "batch", patches: moves } }))
        .toMatchObject({ ok: true });
      expect(f.history).toEqual([{ before, after: f.pinned(), label: "Draw requested objects" }]);
      const objects = f.pinned().pages[0]!.objects;
      const brackets = objects.filter(object => object.type === "bracket");
      expect(brackets.map(bracket => bracket.x)).toEqual(moves.map(move => move.x));
      expect(resolveRepeatUnitAtomMembership(brackets, objects).structureOnlyMembers)
        .toMatchObject([{ id: carbon.id, structure: "C" }]);
    } finally { await f.finish(); }
  });

  it("preserves conflicting imported glyph usages when a request reorders the brackets", async () => {
    const xml = `<CDXML><page><fragment id="10"><n id="11" p="300 200"/></fragment>
      <graphic id="20" GraphicType="Bracket" BracketType="Square" BoundingBox="280 220 285 180" BracketUsage="AnyPolymer"/>
      <graphic id="21" GraphicType="Bracket" BracketType="Square" BoundingBox="325 180 320 220" BracketUsage="MultipleGroup"/>
      <bracketedgroup id="30" BracketedObjectIDs="10" RepeatCount="3">
        <bracketattachment id="31" GraphicID="20"/><bracketattachment id="32" GraphicID="21"/>
      </bracketedgroup></page></CDXML>`;
    const objects = openChemDraftPayload(xml).document!.pages[0]!.objects;
    const brackets = objects.filter(object => object.type === "bracket");
    expect(brackets.map(object => object.bracketUsage)).toEqual(["unknown", "unknown"]);
    const ids = ["anchor", "ethane", ...objects.map(object => object.id)];
    const f = setup(ids, undefined, { objects });
    try {
      const before = f.pinned();
      const visible = (doc: ChemDraftDocument) => exportDocumentToCdxml(doc, { embedNativePayload: false }).contents;
      const group = (doc: ChemDraftDocument) => visible(doc).match(/<bracketedgroup\b[^>]*>/)![0];
      expect(group(before)).not.toContain("BracketUsage=");
      expect(visible(before)).toContain('BracketUsage="AnyPolymer"');
      expect(visible(before)).toContain('BracketUsage="MultipleGroup"');
      const [first, second] = brackets;
      const patch = { op: "setObjectOrder" as const, pageId: f.pageId, objectIds: ids.map(id =>
        id === first!.id ? second!.id : id === second!.id ? first!.id : id) };
      expect(await f.context.documents.applyRequestPatch!({ requestId: await f.begin(), patch }))
        .toMatchObject({ ok: true });
      expect(f.history).toHaveLength(1);
      expect(group(f.pinned())).toEqual(group(before));
      expect(visible(f.pinned())).toContain('BracketUsage="AnyPolymer"');
      expect(visible(f.pinned())).toContain('BracketUsage="MultipleGroup"');
    } finally { await f.finish(); }
  });

  function refusalFixture(fixture: string): MoleculeObject {
    const base = { ...ethane, id: "query" };
    switch (fixture) {
      case "V3000 atom list":
        return { ...base, structureFormat: "molfile-v3000", structure: chemicalIdentitySource(base, [], "v3000").molfile
          .replace("M  V30 2 C ", "M  V30 2 [C,N] ") };
      case "V2000 atom list": {
        const lines = chemicalIdentityMolfile(base).replace("M  END", "M  ALS   2  2 F C   N   \nM  END").split("\n");
        lines[5] = lines[5]!.slice(0, 31) + "L  " + lines[5]!.slice(34);
        return { ...base, structureFormat: "molfile-v2000", structure: lines.join("\n") };
      }
      case "R-group":
        return { ...base, structure: "C[*:1]", atoms: [base.atoms[0]!, { ...base.atoms[1]!, element: "R1" }],
          rGroups: [{ label: "R1", querySemantics: "query",
            attachmentPoints: [{ kind: "atom", objectId: base.id, atomId: base.atoms[1]!.id }], warnings: [] }] };
      default: return { ...base, structure: "C1(" };
    }
  }

  it.each(["V3000 atom list", "V2000 atom list", "R-group", "unreadable SMILES"])(
    "style and row plans agree with the write refusal for %s", async fixture => {
      const molecule = refusalFixture(fixture);
      const f = setup([molecule.id], undefined, { objects: [molecule] });
      try {
        const before = f.pinned();
        const request = { requestId: await f.begin(), pageId: f.pageId };
        const style = { objectIds: [molecule.id], targetBondLength: 44 };
        const { updates } = planFigureStyle(before.pages[0]!, style);
        expect(updates).toHaveLength(1);
        const refused = await f.context.documents.applyRequestPatch!({ requestId: request.requestId, patch: { op: "batch", patches: updates } });
        expect(refused).toMatchObject({ ok: false, error: { code: "chemistry" } });
        expect(await f.context.depiction!.planStyle({ ...request, ...style })).toEqual(refused);
        expect(await f.context.depiction!.planLayout({ ...request, spec: {
          kind: "row", objectIds: [molecule.id], anchor: { x: 500, y: 320 }
        } })).toEqual(refused);
        expect(f.history).toHaveLength(0);
        expect(f.pinned()).toBe(before);
      } finally { await f.finish(); }
    });

  it("refuses a move when the retained source cannot be inspected", async () => {
    const molecule: MoleculeObject = { ...ethane, id: "unreadable", structure: "C1(" };
    const f = setup([molecule.id], undefined, { objects: [molecule] });
    try {
      const before = f.pinned();
      expect(await f.context.documents.applyRequestPatch!({ requestId: await f.begin(),
        patch: { op: "moveObject", objectId: molecule.id, x: molecule.x + 15, y: molecule.y } }))
        .toMatchObject({ ok: false, error: { code: "chemistry" } });
      expect(f.pinned()).toBe(before);
      expect(f.history).toHaveLength(0);
    } finally { await f.finish(); }
  });

  it.each(["row", "grid", "reaction"] as const)("refuses a %s plan that strands a geometric repeat unit", async kind => {
    const { chain, pair } = geometricUnit(false);
    const f = setup([chain.id], undefined, { objects: [chain, ...pair] });
    try {
      const anchor = { x: 500, y: 320 };
      const result = await f.context.depiction!.planLayout({ requestId: await f.begin(), pageId: f.pageId, spec:
        kind === "reaction" ? { kind, anchor, reactants: [chain.id], products: ["ethane"], arrowKind: "forward" } :
          { kind, anchor, objectIds: [chain.id] } });
      expect(result).toMatchObject({ ok: false, error: { message: /repeat unit|bracket/i } });
    } finally { await f.finish(); }
  });

  it("refuses a style plan that rescales atoms across a repeat-unit boundary", async () => {
    const { chain, pair } = geometricUnit(false);
    const f = setup([chain.id], undefined, { objects: [chain, ...pair] });
    try {
      const plan = await f.context.depiction!.planStyle({ requestId: await f.begin(), pageId: f.pageId,
        objectIds: [chain.id], targetBondLength: 60 });
      expect(plan).toMatchObject({ ok: false, error: { code: "chemistry", message: /repeat unit/i } });
    } finally { await f.finish(); }
  });

  it.each([false, true])("refuses geometric repeat-unit membership loss with cached chemistry = %s", async cached => {
    const { chain, pair } = geometricUnit(cached);
    const f = setup([chain.id], undefined, { objects: [chain, ...pair] });
    try {
      const before = f.pinned();
      const result = await f.context.documents.applyRequestPatch!({ requestId: await f.begin(), patch: {
        op: "updateObject", objectId: chain.id, changes: {
          x: chain.x + 100, atoms: chain.atoms.map(atom => ({ ...atom, x: atom.x + 100 }))
        }
      } });
      expect(result).toMatchObject({ ok: false, error: { code: "chemistry", message: /repeat unit|bracket/i } });
      expect(f.history).toHaveLength(0);
      expect(f.pinned()).toBe(before);
    } finally { await f.finish(); }
  });

  it("refuses to exchange enclosed atoms even when the repeat-unit member count stays the same", async () => {
    const { chain, pair } = geometricUnit(true);
    const f = setup(pair.map(bracket => bracket.id), undefined, { objects: [chain, ...pair] });
    try {
      const before = f.pinned();
      const patch = { op: "batch" as const, patches: pair.map(bracket => ({
        op: "moveObject" as const, objectId: bracket.id, x: bracket.x + 22, y: bracket.y
      })) };
      const proposed = applyPatch(before, patch).pages[0]!.objects;
      expect(resolveRepeatUnitAtomMembership(proposed.filter(object => object.type === "bracket"), proposed))
        .toMatchObject({ members: [{ atomIds: ["c2", "c3"] }] });
      expect(await f.context.documents.applyRequestPatch!({ requestId: await f.begin(), patch }))
        .toMatchObject({ ok: false, error: { code: "chemistry", message: /repeat unit/i } });
      expect(f.pinned()).toBe(before);
      expect(f.history).toHaveLength(0);
    } finally { await f.finish(); }
  });

  it("refuses an authored mark reassignment when normalization restores its previous owner", async () => {
    const legacy = { ...ethane, id: "legacy", bonds: [{ ...ethane.bonds[0]!, toAtomId: "a1" }] };
    const mark = { ...frame("charge"), x: 198, y: 198, width: 4, height: 4, type: "electron-mark" as const,
      markKind: "charge" as const, charge: 1, anchor: { kind: "atom" as const, objectId: "ethane", atomId: "a1" } };
    const f = setup([mark.id, legacy.id, "ethane"], undefined, { objects: [legacy, mark] });
    try {
      const before = f.pinned();
      const result = await f.context.documents.applyRequestPatch!({ requestId: await f.begin(), patch: {
        op: "updateObject", objectId: mark.id, changes: { x: mark.x + 1, atomAssociation: "explicit",
          anchor: { ...mark.anchor, objectId: legacy.id } }
      } });
      expect(result).toMatchObject({ ok: false, error: { code: "chemistry", message: /charge/ } });
      expect(f.history).toHaveLength(0);
      expect(f.pinned()).toBe(before);
    } finally { await f.finish(); }
  });
  it.each([{ charges: [1] }, { charges: [1, -1] }])("refuses a move onto legacy marks with charges $charges before recording history", async ({ charges }) => {
    const landing = { x: 400, y: 200 };
    const marks = charges.map((charge, index) => ({ ...frame(`mark-${index}`), ...landing, width: 8, height: 8,
      type: "electron-mark" as const, markKind: "charge" as const, charge,
      anchor: { kind: "point" as const, point: landing } }));
    // Grant all affected objects so scope alone cannot reject the implicit edit.
    const f = setup(["ethane", ...marks.map(mark => mark.id)], undefined, { objects: marks });
    try {
      const requestId = await f.begin();
      const before = f.pinned();
      const move = (dx: number) => ({ op: "updateObject" as const, objectId: "ethane",
        changes: { x: ethane.x + dx, atoms: ethane.atoms.map(atom => ({ ...atom, x: atom.x + dx })) } });
      const patch = { op: "batch" as const, patches: [move(landing.x - ethane.x),
        ...marks.map(mark => ({ op: "updateObject" as const, objectId: mark.id, changes: { style: { color: "#123456" } } }))
      ] };
      const normalized = normalizeCommittedDocument(applyPatch(before, patch)).pages[0]!.objects;
      expect(normalized[1]).toMatchObject({ atoms: [{ formalCharge: charges.reduce((a, b) => a + b, 0) }, { formalCharge: 0 }] });
      expect(normalized.at(-1)).toMatchObject({ anchor: { kind: "atom", objectId: "ethane", atomId: "a1" } });
      const apply = f.context.documents.applyRequestPatch!;
      expect(await apply({ requestId, patch })).toMatchObject({ ok: false, error: { code: "chemistry" } });
      expect(f.history).toHaveLength(0);
      expect(f.pinned()).toBe(before);
      expect(await apply({ requestId, patch: move(50) })).toMatchObject({ ok: true });
      expect(f.history).toHaveLength(1);
    } finally { await f.finish(); }
  });

  it("commits an explicitly verified charge edit", async () => {
    const amine = { ...ethane, id: "amine", structure: "CN", atoms: ethane.atoms.map((atom, i) =>
      i === 1 ? { ...atom, element: "N" } : atom) };
    const f = setup([amine.id], undefined, { objects: [amine] });
    try {
      const requestId = await f.begin();
      const patch = { op: "updateObject" as const, objectId: amine.id,
        changes: { atoms: amine.atoms.map(atom => atom.element === "N" ? { ...atom, formalCharge: 1 } : atom) } };
      const apply = f.context.documents.applyRequestPatch!;
      expect(await apply({ requestId, patch })).toMatchObject({ ok: false, error: { code: "chemistry" } });
      expect(f.history).toHaveLength(0);
      const result = await apply({ requestId, patch, expectedStructures: [
        { kind: "object", pageId: f.pageId, objectId: amine.id, sourceSmiles: "C[NH3+]" }
      ] });
      if (!result.ok) throw new Error(result.error.message);
      expect(f.pinned().pages[0]!.objects.at(-1)).toMatchObject({
        atoms: [{ formalCharge: 0 }, { formalCharge: 1 }], structure: "C[NH3+]"
      });
      expect(f.history).toHaveLength(1);
    } finally { await f.finish(); }
  });

  it("commits the native NaOH abbreviation against its source SMILES", async () => {
    const f = setup(["ethane"]);
    try {
      const requestId = await f.begin();
      const document = f.pinned();
      const sourceSmiles = "[Na+].[OH-]";
      const salt = createSmilesMolecule(document, { x: 100, y: 100 }, {
        atoms: [{ element: "Na", x: 0, y: 0, charge: 1 }, { element: "O", x: 2, y: 0, charge: -1 }], bonds: []
      }, sourceSmiles);
      const providers = createFigurePlanProviders(async () => ({ available: true, built: true, object: salt }));
      const result = await providers.planLayout({ requestId, pageId: f.pageId, spec: {
        kind: "reaction", arrowKind: "forward", anchor: { x: 200, y: 200 },
        reactants: [{ ref: "base", smiles: sourceSmiles }], products: ["ethane"]
      } }, { document, signal: new AbortController().signal, revision: () => "revision", check: () => {} });
      if (!result.ok) throw new Error(result.error.message);
      const { objects, transforms, insertionSources } = result.value;
      const commit = await f.context.documents.applyRequestPatch!({ requestId, patch: { op: "batch", patches: [
        ...objects.map(object => ({ op: "addObject" as const, pageId: f.pageId, object })),
        ...transforms.map(({ objectId, changes }) => ({ op: "updateObject" as const, objectId, changes }))
      ] }, expectedStructures: insertionSources!.map(({ objectId, sourceSmiles }) => ({
        kind: "insertion", opIndex: objects.findIndex(object => object.id === objectId), sourceSmiles
      })) });
      if (!commit.ok) throw new Error(commit.error.message);
      expect(f.pinned().pages[0]!.objects.find(object => object.id === commit.value.insertions[0]!.objectId))
        .toMatchObject({ atoms: [{ element: "NaOH", schemeAbbreviation: "NaOH" }] });
      expect(f.history).toHaveLength(1);
    } finally { await f.finish(); }
  });

  it("measures and commits scoped style proposals with unchanged canonical stereochemistry", async () => {
    installNodeRdkitModuleLoader();
    const alkene = createNativeMolfileMolecule(createEmptyDocument(), { x: 300, y: 200 },
      depictSmiles2D("C/C=C/C").molfile, "molfile-v2000");
    const f = setup([alkene.id, "ethane"], undefined, { objects: [alkene] });
    try {
      const requestId = await f.begin();
      const pageId = f.pageId;
      const before = structuredClone(f.pinned());
      const ids = [alkene.id, "ethane"];
      f.switchTabs();
      const plan = await f.context.depiction!.planStyle({ requestId, pageId, objectIds: ids,
        presetId: "chemdraft.rscjournal", targetBondLength: 30 });
      if (!plan.ok) throw new Error(plan.error.message);
      const patch = { op: "batch" as const, patches: plan.value.updates };
      const measured = await f.context.depiction!.measure({ requestId, pageId, preview: patch,
        target: { kind: "objects", objectIds: ids } });
      if (!measured.ok) throw new Error(measured.error.message);
      expect(measured.value.objects.map(object => Math.round(object.bondLength!.measured!))).toEqual([30, 30]);
      expect(f.pinned()).toEqual(before);
      expect(f.history).toHaveLength(0);
      const commit = await f.context.documents.applyRequestPatch!({ requestId, patch });
      if (!commit.ok) throw new Error(commit.error.message);
      expect(commit.value.touched.map(ref => ref.objectId).sort()).toEqual([...ids].sort());
      expect(f.history).toHaveLength(1);
      expect(f.pinned().styles).toEqual(before.styles);
      for (const [id, smiles] of [[alkene.id, "C/C=C/C"], ["ethane", "CC"]] as const) {
        const stored = f.pinned().pages[0]!.objects.find(object => object.id === id) as MoleculeObject;
        expect(representativeNativeMoleculeBondLength(stored)).toBeCloseTo(30);
        expect(await computeStructureIdentifiers(chemicalIdentityMolfile(stored))).toMatchObject({ smiles });
      }
    } finally { await f.finish(); }
  });

  it("commits a proposed native reaction layout with editable condition links", async () => {
    installNodeRdkitModuleLoader();
    const product = createNativeMolfileMolecule(createEmptyDocument(), { x: 300, y: 200 },
      depictSmiles2D("CCO").molfile, "molfile-v2000");
    const f = setup(["ethane", product.id], undefined, { objects: [product] });
    try {
      const requestId = await f.begin();
      const pageId = f.pageId;
      const proposed = await f.context.depiction!.planLayout({ requestId, pageId, spec: {
        kind: "reaction", reactants: ["ethane"], products: [product.id], arrowKind: "forward",
        anchor: { x: 120, y: 220 }, above: ["EtOH"], below: ["25 °C"]
      } });
      if (!proposed.ok) throw new Error(proposed.error.message);
      const { objects, transforms } = proposed.value;
      expect(f.history).toHaveLength(0);
      const commit = await f.context.documents.applyRequestPatch!({ requestId, patch: { op: "batch", patches: [
        ...objects.map(object => ({ op: "addObject" as const, pageId, object })),
        ...transforms.map(({ objectId, changes }) => ({ op: "updateObject" as const, objectId, changes }))
      ] } });
      if (!commit.ok) throw new Error(commit.error.message);
      expect(commit.value.insertions).toHaveLength(4);
      const stored = f.pinned().pages[0]!.objects;
      const step = stored.find(object => object.type === "reaction")!;
      const arrow = stored.find(object => object.type === "reaction-arrow")!;
      expect(step).toMatchObject({ arrowObjectIds: [arrow.id], components: [
        { role: "reactant", objectId: "ethane" }, { role: "product", objectId: product.id }
      ] });
      expect(stored.filter(object => object.type === "text" && object.arrowAttachment))
        .toMatchObject([{ text: "EtOH", arrowAttachment: { side: "above", parentObjectId: arrow.id } },
          { text: "25 °C", arrowAttachment: { side: "below", parentObjectId: arrow.id } }]);
      expect(f.history).toHaveLength(1);
    } finally { await f.finish(); }
  });

  it("uses the pinned tab, rebases forward references and grants only committed insertion IDs", async () => {
    const f = setup();
    try {
      const requestId = await f.begin();
      const original = f.pinned();
      const foreground = f.foreground();
      const request = { requestId, pageId: f.pageId };
      f.switchTabs();
      expect(await f.context.requests!.getContext({ requestId })).toMatchObject({ ok: true, value: {
        documentKey: "instance-first", selection: [], viewport: { pageId: f.pageId }, insertions: []
      } });
      expect(await f.context.documents.readRequest!(request)).toMatchObject({ ok: true, value: { objects: [
        { object: { id: "anchor" } }, { object: { id: "ethane" } }
      ] } });
      const commit = await f.context.documents.applyRequestPatch!({ requestId, patch: { op: "batch", patches: [
        { op: "addObject", pageId: f.pageId, object: { ...frame("group"), type: "group", childObjectIds: ["ethane"] } },
        { op: "addObject", pageId: f.pageId, object: ethane }
      ] }, expectedStructures: [{ kind: "insertion", opIndex: 1, sourceSmiles: "CC" }] });
      if (!commit.ok) throw new Error(commit.error.message);
      expect(commit.value.insertions).toHaveLength(2);
      const id = commit.value.insertions.find(ref => ref.opIndex === 1)!.objectId;
      expect(id).not.toBe("ethane");
      expect(f.pinned().pages[0]!.objects.find(object => object.id === "group")).toMatchObject({ childObjectIds: [id] });
      const moved = await f.context.documents.applyRequestPatch!({ requestId, patch: {
        op: "updateObject", objectId: id, changes: { style: { bondColor: "#112233" } }
      } });
      expect(moved).toMatchObject({ ok: true, value: { touched: [{ objectId: id }], insertions: [] } });
      expect(await f.context.documents.applyRequestPatch!({ requestId, patch: {
        op: "updateObject", objectId: "ethane", changes: { style: { bondColor: "#445566" } }
      } })).toMatchObject({ ok: false, error: { code: "scope" } });
      expect(f.history).toHaveLength(1);
      expect(f.history[0]).toMatchObject({ before: original, label: "Draw requested objects",
        after: { selection: { objectIds: ["group", id] } } });
      expect(f.foreground()).toBe(foreground);
      expect(await f.context.requests!.end({ requestId })).toMatchObject({ ok: true });
      expect(await f.context.documents.readRequest!(request)).toMatchObject({ ok: false });
    } finally { await f.finish(); }
  });

  it("rejects outside and untouched expectations and verifies the live graph with RDKit", async () => {
    const f = setup(["ethane"]);
    try {
      const requestId = await f.begin();
      const apply = f.context.documents.applyRequestPatch!;
      const patch = { op: "updateObject" as const, objectId: "ethane",
        changes: { atoms: ethane.atoms.map((atom, i) => i ? { ...atom, element: "O" } : atom) } };
      for (const objectId of ["anchor", "missing"]) {
        expect(await apply({ requestId, patch, expectedStructures: [
          { kind: "object", pageId: f.pageId, objectId, sourceSmiles: "CO" }
        ] })).toMatchObject({ ok: false, error: { code: "scope" } });
      }
      expect(await apply({ requestId, patch })).toMatchObject({ ok: false, error: { code: "chemistry" } });
      expect(await apply({ requestId, patch, expectedStructures: [
        { kind: "object", pageId: f.pageId, objectId: "ethane", sourceSmiles: "CC" }
      ] })).toMatchObject({ ok: false, error: { code: "chemistry" } });
      expect(f.history).toHaveLength(0);
      expect(await apply({ requestId, patch, expectedStructures: [
        { kind: "object", pageId: f.pageId, objectId: "ethane", sourceSmiles: "CO" }
      ] })).toMatchObject({ ok: true });
      const stored = f.pinned().pages[0]!.objects.find(object => object.id === "ethane") as MoleculeObject;
      expect(stored).toMatchObject({ structure: "CO", chemistry: { formula: "CH4O" }, compatibility: { unknown: { smiles: "CO" } } });
      installNodeRdkitModuleLoader();
      expect(await computeStructureIdentifiers(chemicalIdentityMolfile(stored))).toMatchObject({ smiles: "CO" });
      expect(await moleculeSmiles(stored, 0, [], computeStructureIdentifiers)).toBe("CO");
      expect(await moleculeSmiles(stored, 0, [], undefined)).toBe("CO");
      expect(f.history).toHaveLength(1);
    } finally { await f.finish(); }
  });

  it("translates methanol stored with noncanonical SMILES", async () => {
    installNodeRdkitModuleLoader();
    const methanol: MoleculeObject = { ...ethane, id: "methanol", structure: "OC",
      atoms: ethane.atoms.map((atom, index) => index === 1 ? { ...atom, element: "O" } : atom) };
    const f = setup([methanol.id], undefined, { objects: [methanol] });
    try {
      const requestId = await f.begin();
      const original = f.pinned().pages[0]!.objects.at(-1) as MoleculeObject;
      expect(await moleculeSmiles(original, 0, [], undefined)).toBe("OC");
      expect(await computeStructureIdentifiers(chemicalIdentityMolfile(original))).toMatchObject({ smiles: "CO" });
      expect(await f.context.documents.applyRequestPatch!({ requestId, patch: {
        op: "moveObject", objectId: methanol.id, x: methanol.x + 10, y: methanol.y
      } })).toMatchObject({ ok: true });
      const moved = f.pinned().pages[0]!.objects.at(-1) as MoleculeObject;
      expect(moved).toMatchObject({ x: methanol.x + 10, structure: "OC" });
      expect(moved.chemistry).toEqual(original.chemistry);
      expect(await computeStructureIdentifiers(chemicalIdentityMolfile(moved))).toMatchObject({ smiles: "CO" });
      expect(await moleculeSmiles(moved, 0, [], undefined)).toBe("OC");
      expect(f.history).toHaveLength(1);
    } finally { await f.finish(); }
  });

  it("translates imported trans-2-butene and still verifies E/Z edits with RDKit", async () => {
    installNodeRdkitModuleLoader();
    const alkene = createNativeMolfileMolecule(createEmptyDocument(), { x: 300, y: 200 },
      depictSmiles2D("C/C=C/C").molfile, "molfile-v2000");
    const f = setup([alkene.id], undefined, { objects: [alkene] });
    try {
      const requestId = await f.begin();
      const apply = f.context.documents.applyRequestPatch!;
      expect(await moleculeSmiles(alkene, 0, [], undefined)).toBe("CC=CC");
      expect(await apply({ requestId, patch: { op: "updateObject", objectId: alkene.id, changes: {
        x: alkene.x + 10, atoms: alkene.atoms.map(atom => ({ ...atom, x: atom.x + 10 }))
      } } })).toMatchObject({ ok: true });
      const moved = f.pinned().pages[0]!.objects.at(-1) as MoleculeObject;
      expect(moved.x).toBe(alkene.x + 10);
      expect(await computeStructureIdentifiers(moved.structure)).toMatchObject({ smiles: "C/C=C/C" });
      expect(await moleculeSmiles(moved, 0, [], computeStructureIdentifiers)).toBe("C/C=C/C");
      expect(await moleculeSmiles(moved, 0, [], undefined)).toBe("CC=CC");

      const end = moved.atoms.find(atom => moved.bonds.filter(b => b.fromAtomId === atom.id || b.toAtomId === atom.id).length === 1)!;
      const bond = moved.bonds.find(b => b.fromAtomId === end.id || b.toAtomId === end.id)!;
      const pivot = moved.atoms.find(atom => atom.id === (bond.fromAtomId === end.id ? bond.toAtomId : bond.fromAtomId))!;
      const atoms = moved.atoms.map(atom => atom === end ? { ...end, x: 2 * pivot.x - end.x, y: 2 * pivot.y - end.y } : atom);
      const cis = "C/C=C\\C";
      expect(await computeStructureIdentifiers(chemicalIdentityMolfile({ ...moved, atoms }))).toMatchObject({ smiles: cis });
      const patch = { op: "updateObject" as const, objectId: alkene.id, changes: { atoms } };
      expect(await apply({ requestId, patch })).toMatchObject({ ok: false, error: { code: "chemistry" } });
      // RDKit verifies the new isomer in the stored CTAB even when the native fallback omits stereo.
      expect(await apply({ requestId, patch, expectedStructures: [
        { kind: "object", pageId: f.pageId, objectId: alkene.id, sourceSmiles: cis }
      ] })).toMatchObject({ ok: true });
      const edited = f.pinned().pages[0]!.objects.at(-1) as MoleculeObject;
      expect(await computeStructureIdentifiers(edited.structure)).toMatchObject({ smiles: cis });
      expect(await apply({ requestId, patch: { op: "updateObject", objectId: alkene.id,
        changes: { chemistry: { ...edited.chemistry!, formula: "C4H10" } } } }))
        .toMatchObject({ ok: false, error: { code: "chemistry", message: expect.stringContaining("exported SMILES") } });
      expect(f.pinned().pages[0]!.objects.at(-1)).toBe(edited);
      expect(f.history).toHaveLength(1);
    } finally { await f.finish(); }
  });

  it("rechecks stale anchors after waiting and never grants their IDs", async () => {
    const f = setup();
    try {
      const requestId = await f.begin();
      const read = await f.context.documents.readRequest!({ requestId, pageId: f.pageId, objectIds: ["anchor"] });
      if (!read.ok) throw new Error(read.error.message);
      const token = read.value.objects[0]!.revision;
      const preconditions = [{ kind: "objectRevision" as const, pageId: f.pageId, objectId: "anchor", token }];
      const apply = f.context.documents.applyRequestPatch!;
      const insert = { op: "addObject" as const, pageId: f.pageId, object: note("planned") };
      f.gesture.active = true;
      const pending = apply({ requestId, patch: insert, preconditions });
      await vi.waitFor(() => expect(f.gate.pending()).toBe(1));
      f.edit(document => applyPatch(document, { op: "updateObject", objectId: "anchor", changes: { text: "Changed anchor" } }));
      f.gesture.active = false;
      f.gate.flush();
      expect(await pending).toMatchObject({ ok: false, error: { code: "stale" } });
      expect(await apply({ requestId, patch: { op: "removeObject", objectId: "anchor" }, preconditions: [] }))
        .toMatchObject({ ok: false, error: { code: "scope" } });
      expect(await apply({ requestId, patch: { op: "removeObject", objectId: "planned" } }))
        .toMatchObject({ ok: false, error: { code: "scope" } });
      expect(f.history).toHaveLength(0);
    } finally { await f.finish(); }
  });

  it("keeps ordinary commands separate and refuses to amend past an intervening edit", async () => {
    const f = setup(["ethane"]);
    try {
      const requestId = await f.begin();
      expect(await f.context.documents.insertTable!({ columns: [{ header: "A" }], rows: [["First row"]] }))
        .toMatchObject({ applied: true });
      expect(f.history).toHaveLength(1);
      await expect(f.host.invokeCommand(otherCommand, { writeSelection: { objectIds: ["anchor"], molecules: [] } }))
        .resolves.toMatchObject({ applied: true });
      expect(f.ordinary).toHaveBeenCalledOnce();
      f.edit(document => applyPatch(document, { op: "updateObject", objectId: "anchor", changes: { text: "User edit" } }));
      expect(await f.context.documents.applyRequestPatch!({ requestId, patch: {
        op: "addObject", pageId: f.pageId, object: note("refused")
      } })).toMatchObject({ ok: false, error: { code: "interrupted" } });
      expect(f.history).toHaveLength(1);
      expect(f.pinned().pages[0]!.objects.some(object => object.id === "refused")).toBe(false);
    } finally { await f.finish(); }
  });

  it("rejects a changed normalized graph at the last history boundary", async () => {
    const f = setup(["ethane"]);
    try {
      const requestId = await f.begin();
      f.tamperFinal(document => applyPatch(document, { op: "updateObject", objectId: "ethane",
        changes: { atoms: ethane.atoms.map((atom, i) => i ? { ...atom, element: "O" } : atom) } }));
      const before = f.pinned();
      expect(await f.context.documents.applyRequestPatch!({ requestId, patch: {
        op: "updateObject", objectId: "ethane", changes: { style: { bondColor: "#112233" } }
      } })).toMatchObject({ ok: false, error: { code: "chemistry" } });
      expect(f.pinned()).toBe(before);
      expect(f.history).toHaveLength(0);
    } finally { await f.finish(); }
  });

  it.each([false, true])("captures the initiating selection before begin (explicit grant %s)", async explicit => {
    const f = setup(explicit ? ["ethane"] : ["anchor"], undefined, explicit ? { writeSelection: ["anchor"] } : {});
    try {
      f.edit(doc => applyPatch(doc, { op: "setSelection", pageId: f.pageId, objectIds: ["ethane"] }), false);
      const requestId = await f.begin();
      expect(await f.context.requests!.getContext({ requestId })).toMatchObject({ ok: true,
        value: { selection: [{ pageId: f.pageId, objectId: "anchor" }] } });
      expect(await f.context.documents.applyRequestPatch!({ requestId, patch: { op: "removeObject", objectId: "ethane" } }))
        .toMatchObject({ ok: false, error: { code: "scope" } });
    } finally { await f.finish(); }
  });

  it("never transfers a selection grant to the same ID on another page", async () => {
    const f = setup(["anchor"], undefined, { duplicate: true });
    try {
      const requestId = await f.begin();
      f.edit(doc => ({ ...doc, pages: doc.pages.map(page => page.id !== f.pageId ? page :
        { ...page, objects: page.objects.filter(object => object.id !== "anchor") }) }));
      expect(await f.context.documents.applyRequestPatch!({ requestId, patch: { op: "removeObject", objectId: "anchor" } }))
        .toMatchObject({ ok: false, error: { code: "scope" } });
      expect(f.pinned().pages[1]!.objects).toEqual([note("anchor", "Other page")]);
    } finally { await f.finish(); }
  });

  it("cancels an ordinary write waiting when its invocation begins and ends a request", async () => {
    const f = setup(["anchor"], undefined, { deferOrdinary: true });
    try {
      f.gesture.active = true;
      const before = f.pinned();
      const pending = f.context.documents.applyPatch!({ reason: "Move anchor", patch: { op: "moveObject", objectId: "anchor", x: 2, y: 3 } });
      await vi.waitFor(() => expect(f.gate.pending()).toBe(1));
      const requestId = await f.begin();
      await f.context.requests!.end({ requestId });
      f.gesture.active = false;
      f.gate.flush();
      await expect(pending).rejects.toThrow();
      expect(f.pinned()).toBe(before);
    } finally { await f.finish(); }
  });

  it("keeps retained patch and table calls bound after end and refuses a pending commit", async () => {
    const f = setup(["anchor"]);
    try {
      const requestId = await f.begin();
      const patch = { reason: "Late", patch: { op: "removeObject" as const, objectId: "anchor" } };
      const { applyPatch, insertTable } = f.context.documents;
      f.gesture.active = true;
      const pending = applyPatch!(patch);
      await vi.waitFor(() => expect(f.gate.pending()).toBe(1));
      await f.context.requests!.end({ requestId });
      f.gesture.active = false;
      f.gate.flush();
      await expect(pending).rejects.toMatchObject({ code: "cancelled" });
      await expect(applyPatch!(patch)).rejects.toMatchObject({ code: "cancelled" });
      await expect(insertTable!({ columns: [{ header: "A" }], rows: [["value"]] })).rejects.toMatchObject({ code: "cancelled" });
      expect(f.ordinary).not.toHaveBeenCalled();
      expect(f.history).toHaveLength(0);
    } finally { await f.finish(); }
  });

  it.each(["end", "abort"] as const)("refuses a pending tool write when its caller signals %s", async stop => {
    const f = setup([], async ctx => {
      await ctx.documents.applyPatch!({ reason: "Pending", patch: { op: "addObject", pageId: f.pageId, object: note("pending") } });
      return { ok: true, value: null };
    });
    try {
      const requestId = await f.begin();
      const deadline = new AbortController();
      f.gesture.active = true;
      const work = f.host.invokeRequestTool(plugin, requestId, f.owner,
        { requestId, sessionId: "test", name: "write", input: {} }, deadline.signal, false);
      await vi.waitFor(() => expect(f.gate.pending()).toBe(1));
      if (stop === "end") await f.context.requests!.end({ requestId });
      else deadline.abort(new Error("Tool deadline expired."));
      f.gesture.active = false;
      f.gate.flush();
      await expect(work).rejects.toMatchObject({ code: "cancelled" });
      expect(f.history).toHaveLength(0);
    } finally { await f.finish(); }
  });

  it("invalidates table placement when its implicit anchor moves behind a gesture", async () => {
    const f = setup(["anchor"]);
    try {
      await f.begin();
      f.gesture.active = true;
      const pending = f.context.documents.insertTable!({ columns: [{ header: "A" }], rows: [["value"]] });
      await vi.waitFor(() => expect(f.gate.pending()).toBe(1));
      f.edit(doc => applyPatch(doc, { op: "moveObject", objectId: "anchor", x: 800, y: 450 }));
      f.gesture.active = false;
      f.gate.flush();
      await expect(pending).rejects.toMatchObject({ code: "stale" });
      expect(f.history).toHaveLength(0);
    } finally { await f.finish(); }
  });

  it("places a table beside a group's remaining child when another child is already missing", async () => {
    const group = { ...frame("group"), x: 700, y: 600, type: "group" as const, childObjectIds: ["anchor", "missing"] };
    const f = setup([group.id], undefined, { objects: [group] });
    try {
      await f.begin();
      const { objects } = f.pinned().pages[0]!;
      expect(objects.at(-1)).toMatchObject({ childObjectIds: ["anchor", "missing"] });
      const bounds = selectionBounds(objects, ["anchor"])!;
      const receipt = await f.context.documents.insertTable!({ columns: [{ header: "A" }], rows: [["value"]] });
      expect(receipt).toMatchObject({ applied: true });
      const table = f.pinned().pages[0]!.objects.find(object => object.id === receipt.objectIds[0])!;
      expect(table).toMatchObject({ type: "table", x: bounds.x + bounds.width + 12,
        y: bounds.y + (bounds.height - table.height) / 2 });
      expect(f.history).toHaveLength(1);
    } finally { await f.finish(); }
  });

  it("rejects a first table write when a nested group child moves during the wait", async () => {
    const group = (id: string, child: string) => ({ ...frame(id), type: "group" as const, childObjectIds: [child] });
    const f = setup(["outer"], undefined, { objects: [group("inner", "anchor"), group("outer", "inner")] });
    try {
      await f.begin();
      const outer = f.pinned().pages[0]!.objects.at(-1);
      f.gesture.active = true;
      const pending = f.context.documents.insertTable!({ columns: [{ header: "A" }], rows: [["value"]] });
      await vi.waitFor(() => expect(f.gate.pending()).toBe(1));
      f.edit(doc => applyPatch(doc, { op: "moveObject", objectId: "anchor", x: 800, y: 450 }));
      expect(f.pinned().pages[0]!.objects.at(-1)).toBe(outer);
      f.gesture.active = false;
      f.gate.flush();
      await expect(pending).rejects.toMatchObject({ code: "stale" });
      expect(f.history).toHaveLength(0);
    } finally { await f.finish(); }
  });

  it("refuses grouping an existing unselected object", async () => {
    const f = setup();
    try {
      const requestId = await f.begin();
      expect(await f.context.documents.applyRequestPatch!({ requestId, patch: { op: "addObject", pageId: f.pageId,
        object: { ...frame("new-group"), type: "group", childObjectIds: ["anchor"] } } }))
        .toMatchObject({ ok: false, error: { code: "scope" } });
      expect(f.history).toHaveLength(0);
    } finally { await f.finish(); }
  });

  const reaction: ReactionObject = { ...frame("step"), type: "reaction", mappingState: "unknown",
    components: [{ role: "reactant", objectId: ethane.id }], conditionsTextObjectIds: [] };

  it("refuses a new reaction naming an unselected molecule and records no history", async () => {
    const f = setup();
    try {
      const before = f.pinned();
      expect(await f.context.documents.applyRequestPatch!({ requestId: await f.begin(), patch: {
        op: "addObject", pageId: f.pageId, object: reaction
      } })).toMatchObject({ ok: false, error: { code: "scope", message: /ethane.*step/ } });
      expect(f.pinned()).toBe(before);
      expect(f.history).toHaveLength(0);
    } finally { await f.finish(); }
  });

  it.each(["this batch", "a prior write"])("allows a reaction over a selected molecule and one inserted in %s", async when => {
    const f = setup([ethane.id]);
    try {
      const requestId = await f.begin();
      const apply = f.context.documents.applyRequestPatch!;
      const product = { ...ethane, id: "product", x: 300, atoms: ethane.atoms.map(atom => ({ ...atom, x: atom.x + 100 })) };
      const insertProduct = { op: "addObject" as const, pageId: f.pageId, object: product };
      const step: ReactionObject = { ...reaction, components: [...reaction.components, { role: "product", objectId: product.id }] };
      const insertStep = { op: "addObject" as const, pageId: f.pageId, object: step };
      const expectedStructures = [{ kind: "insertion" as const, opIndex: 0, sourceSmiles: "CC" }];
      if (when === "a prior write") {
        const inserted = await apply({ requestId, patch: insertProduct, expectedStructures });
        if (!inserted.ok) throw new Error(inserted.error.message);
      }
      const result = await apply(when === "a prior write" ? { requestId, patch: insertStep } : {
        requestId, patch: { op: "batch", patches: [insertProduct, insertStep] }, expectedStructures
      });
      if (!result.ok) throw new Error(result.error.message);
      expect(f.pinned().pages[0]!.objects.find(object => object.id === step.id)).toMatchObject(step);
      expect(f.history).toHaveLength(1);
    } finally { await f.finish(); }
  });

  it("refuses an in-scope reaction update adding an unselected component and records no history", async () => {
    const product = { ...ethane, id: "product" };
    const f = setup([reaction.id, ethane.id], undefined, { objects: [product, reaction] });
    try {
      const before = f.pinned();
      expect(await f.context.documents.applyRequestPatch!({ requestId: await f.begin(), patch: {
        op: "updateObject", objectId: reaction.id,
        changes: { components: [...reaction.components, { role: "product", objectId: product.id }] }
      } })).toMatchObject({ ok: false, error: { code: "scope", message: /product.*step/ } });
      expect(f.pinned()).toBe(before);
      expect(f.history).toHaveLength(0);
    } finally { await f.finish(); }
  });

  it("checks a changed reaction role and allows unrelated edits to an existing reference", async () => {
    const f = setup([reaction.id], undefined, { objects: [reaction] });
    try {
      const requestId = await f.begin();
      const apply = f.context.documents.applyRequestPatch!;
      expect(await apply({ requestId, patch: { op: "updateObject", objectId: reaction.id,
        changes: { components: [{ role: "agent", objectId: ethane.id }] }
      } })).toMatchObject({ ok: false, error: { code: "scope" } });
      expect(f.history).toHaveLength(0);
      expect(await apply({ requestId, patch: { op: "updateObject", objectId: reaction.id,
        changes: { x: reaction.x + 10, components: reaction.components }
      } })).toMatchObject({ ok: true });
      expect(f.history).toHaveLength(1);
    } finally { await f.finish(); }
  });

  it("refuses an electron-mark association with an unselected molecule and records no history", async () => {
    const mark = { ...frame("electrons"), type: "electron-mark" as const, markKind: "lone-pair" as const,
      anchor: { kind: "point" as const, point: { x: 120, y: 130 } } };
    const f = setup([mark.id], undefined, { objects: [mark] });
    try {
      const before = f.pinned();
      expect(await f.context.documents.applyRequestPatch!({ requestId: await f.begin(), patch: {
        op: "updateObject", objectId: mark.id, changes: { atomAssociation: "explicit",
          anchor: { kind: "atom", objectId: ethane.id, atomId: "a1" } }
      } })).toMatchObject({ ok: false, error: { code: "scope", message: /ethane.*electrons/ } });
      expect(f.pinned()).toBe(before);
      expect(f.history).toHaveLength(0);
    } finally { await f.finish(); }
  });

  it("refuses a bracket crossing reference before draft cleanup can drop it", async () => {
    const f = setup();
    try {
      const before = f.pinned();
      const bracket = BracketObjectSchema.parse({ ...frame("bracket"), type: "bracket", bracketKind: "square",
        crossingBondIds: [{ objectId: ethane.id, bondId: "missing" }] });
      expect(await f.context.documents.applyRequestPatch!({ requestId: await f.begin(), patch: {
        op: "addObject", pageId: f.pageId, object: bracket
      } })).toMatchObject({ ok: false, error: { code: "scope", message: /ethane.*bracket/ } });
      expect(f.pinned()).toBe(before);
      expect(f.history).toHaveLength(0);
    } finally { await f.finish(); }
  });

  it("refuses an out-of-scope link in preserved reaction metadata", async () => {
    const f = setup([reaction.id], undefined, { objects: [reaction] });
    try {
      const before = f.pinned();
      expect(await f.context.documents.applyRequestPatch!({ requestId: await f.begin(), patch: {
        op: "updateObject", objectId: reaction.id, changes: { compatibility: { warnings: [], unknown: {
          cdxmlStepReferences: { ReactionStepObjectsAboveArrow: ["anchor"] }
        } } }
      } })).toMatchObject({ ok: false, error: { code: "scope", message: /anchor.*step/ } });
      expect(f.pinned()).toBe(before);
      expect(f.history).toHaveLength(0);
    } finally { await f.finish(); }
  });

  it("refuses a reference to an object selected on another page", async () => {
    const f = setup([ethane.id]);
    try {
      f.edit(doc => ({ ...doc, pages: [...doc.pages, { ...doc.pages[0]!, id: "other", objects: [] }] }));
      const before = f.pinned();
      expect(await f.context.documents.applyRequestPatch!({ requestId: await f.begin(), patch: {
        op: "addObject", pageId: "other", object: reaction
      } })).toMatchObject({ ok: false, error: { code: "scope", message: /ethane.*other/ } });
      expect(f.pinned()).toBe(before);
      expect(f.history).toHaveLength(0);
    } finally { await f.finish(); }
  });

  it("derives the full chemistry record when a style patch also claims a formula", async () => {
    const f = setup(["ethane"]);
    try {
      const requestId = await f.begin();
      const result = await f.context.documents.applyRequestPatch!({ requestId, patch: { op: "updateObject", objectId: "ethane",
        changes: { style: { bondColor: "#123456" }, chemistry: { ...nativeSingleBondGraphMetadata(ethane.atoms, ethane.bonds),
          formula: "CH4O" } } } });
      expect(result).toMatchObject({ ok: true });
      expect(f.pinned().pages[0]!.objects[1]).toMatchObject({ structure: "CC", chemistry: { formula: "C2H6" } });
    } finally { await f.finish(); }
  });

  it("inserts the exact native standalone CH3 group without a molecular SMILES expectation", async () => {
    const f = setup();
    try {
      const requestId = await f.begin();
      const atoms = [{ ...ethane.atoms[0]!, element: "CH3", labelLiteral: true }];
      const group = { ...ethane, id: "methyl", atoms, bonds: [], structure: nativeSingleBondGraphSmiles(atoms, []),
        chemistry: nativeSingleBondGraphMetadata(atoms, []) };
      const result = await f.context.documents.applyRequestPatch!({ requestId, patch: { op: "addObject", pageId: f.pageId, object: group } });
      expect(result).toMatchObject({ ok: true });
      expect(f.pinned().pages[0]!.objects.at(-1)).toMatchObject(group);
    } finally { await f.finish(); }
  });

  it("scopes document read cursors to a pinned page revision and filter", async () => {
    const f = setup();
    try {
      f.edit(document => applyPatch(document, { op: "batch", patches: Array.from({ length: 70 }, (_, i) =>
        ({ op: "addObject", pageId: f.pageId, object: note(`note-${i}`) })) }));
      const requestId = await f.begin();
      const request = { requestId, pageId: f.pageId };
      const read = f.context.documents.readRequest!;
      const first = await read(request);
      if (!first.ok) throw new Error(first.error.message);
      expect(first.value.objects).toHaveLength(64);
      const cursor = first.value.nextCursor!;
      expect(cursor).toBeTruthy();
      expect(await read({ ...request, cursor, objectIds: ["ethane"] }))
        .toMatchObject({ ok: false, error: { code: "stale" } });
      const second = await read({ ...request, cursor });
      if (!second.ok) throw new Error(second.error.message);
      expect(second.value.objects).toHaveLength(8);
      expect(second.value.nextCursor).toBeUndefined();
      f.edit(document => applyPatch(document, { op: "updateObject", objectId: "anchor", changes: { text: "Edited" } }));
      expect(await read({ ...request, cursor })).toMatchObject({ ok: false, error: { code: "stale" } });
      expect(f.history).toHaveLength(0);
    } finally { await f.finish(); }
  });

  it("binds tool authority to its own invocation and denies request creation from a read-only tool", async () => {
    const f = setup([], async (context, call) => {
      expect(context.documents.applyRequestPatch).toBeUndefined();
      expect(context.documents.applyPatch).toBeUndefined();
      expect(await context.requests!.begin({ label: "Nested" })).toMatchObject({ ok: false, error: { code: "permission" } });
      expect(await context.requests!.getContext({ requestId: call.requestId })).toMatchObject({ ok: true });
      return { ok: true, value: null };
    });
    try {
      const requestId = await f.begin();
      const standalone = f.host.createCommandContext(plugin);
      expect(await standalone.requests!.getContext({ requestId })).toMatchObject({ ok: false, error: { code: "cancelled" } });
      await expect(f.host.invokeRequestTool(plugin, requestId, f.owner,
        { requestId, sessionId: "test", name: "inspect", input: {} }, new AbortController().signal, true))
        .resolves.toEqual({ ok: true, value: null });
      expect(f.history).toHaveLength(0);
    } finally { await f.finish(); }
  });

  it("invalidates a write after permission loss while waiting", async () => {
    const f = setup();
    try {
      const requestId = await f.begin();
      f.gesture.active = true;
      const pending = f.context.documents.applyRequestPatch!({ requestId,
        patch: { op: "addObject", pageId: f.pageId, object: note("pending") } });
      await vi.waitFor(() => expect(f.gate.pending()).toBe(1));
      (f.host.getPlugin(plugin)!.permissions as Set<PluginPermission>).delete("document.write");
      f.gesture.active = false;
      f.gate.flush();
      expect(await pending).toMatchObject({ ok: false, error: { code: "permission" } });
      expect(f.history).toHaveLength(0);
      expect(await f.context.requests!.getContext({ requestId })).toMatchObject({ ok: false, error: { code: "cancelled" } });
    } finally { await f.finish(); }
  });

  it("refuses an indirect reaction change and invalidates a queued write when the instance closes", async () => {
    const f = setup(["ethane"]);
    try {
      f.edit(document => applyPatch(document, { op: "addObject", pageId: f.pageId, object: {
        ...frame("reaction"), type: "reaction", components: [{ role: "reactant", objectId: "ethane" }],
        conditionsTextObjectIds: [], mappingState: "absent"
      } }));
      const requestId = await f.begin();
      const apply = f.context.documents.applyRequestPatch!;
      expect(await apply({ requestId, patch: { op: "removeObject", objectId: "ethane" } }))
        .toMatchObject({ ok: false, error: { code: "scope" } });
      f.gesture.active = true;
      const pending = apply({ requestId, patch: { op: "addObject", pageId: f.pageId, object: note("pending") } });
      await vi.waitFor(() => expect(f.gate.pending()).toBe(1));
      f.clear();
      f.gesture.active = false;
      f.gate.flush();
      expect(await pending).toMatchObject({ ok: false, error: { code: "cancelled" } });
      expect(f.history).toHaveLength(0);
    } finally { await f.finish(); }
  });
});
