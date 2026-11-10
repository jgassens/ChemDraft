import { afterEach, describe, expect, it, vi } from "vitest";
import { applyPatch, createEmptyDocument, createDocumentHistory, undo, redo, type ChemDraftDocument } from "@chemdraft/chem-core";
import { createSmilesMolecule, normalizeNativeMoleculeGeometry, resolveStructureTemplateName, structureTemplateMolecule } from "@chemdraft/document-workflow-core";
import { depictSmiles2D, relayoutMolfile2D } from "@chemdraft/ocl-adapter";
import { inspectClipboardPayload, readClipboardTsvTable } from "@chemdraft/clipboard-adapter";
import { ProposedDocumentPatchSchema } from "@chemdraft/plugin-api";
import { commitWithPageFit, PageEnlargementConsent, planDocumentPageFit } from "./pageEnlargement";
import {
  applyClipboardPastePayload, applyEditorSaveResultWithLabelWarnings, applyNativeMoleculeEngineRelayout,
  cleanUpNativeMolecules2d, copyAsMolfile, createSelectionClipboardPayload,
  duplicateSelectedDocumentObjects, insertNativeTemplateMolecule, insertNativeTextObject, insertSmilesMolecule,
  insertSmilesMoleculeGrid, insertTableIntoDocument, insertNativeArtGraphicObject, insertNativeBracket, insertNativeSymbolGlyph,
  setDocumentCustomPageSize
} from "./documentWorkflow";
import { pasteSelectionClipboardPayload } from "./documentWorkflow";
import { insertStructureTemplate } from "./structureTemplateInsertion";
import { pasteTableIntoDocument } from "./tableClipboardWiring";
import { applyAcceptedPluginProposal, applyPluginDocumentPatch } from "./plugins/applyPluginDocumentPatch";
import { nameToStructureForPlugin } from "./plugins/pluginChemistry";
import { picturePngBase64, pictureSvg } from "./testSupport/imageFixture";

const dialog = vi.hoisted(() => ({ message: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({ isTauri: () => true, invoke: vi.fn() }));
vi.mock("@tauri-apps/api/window", () => ({ getCurrentWindow: () => ({ label: "main" }) }));
vi.mock("@tauri-apps/plugin-dialog", () => ({ message: dialog.message }));
vi.mock("./nativeUtilitySuspension", () => ({ withNativeUtilitySuspension: (show: () => Promise<string>) => show() }));
afterEach(() => vi.clearAllMocks());

const point = { x: 600, y: 600 };
const smiles = "CCCCCCCCCCCC";
const depiction = depictSmiles2D(smiles);
function page(size: number) {
  return setDocumentCustomPageSize(createEmptyDocument(), { width: size, height: size, unit: "css-px" });
}
function moleculeDocument(size: number) {
  const before = page(size);
  const object = createSmilesMolecule(before, point, depiction, smiles);
  return applyPatch(applyPatch(before, { op: "addObject", pageId: before.pages[0]!.id, object }),
    { op: "setSelection", objectIds: [object.id] });
}
function proposal(document: ChemDraftDocument, object = createSmilesMolecule(document, point, depiction, smiles)) {
  return ProposedDocumentPatchSchema.parse({ reason: "Test insert", patch: {
    op: "addObject", pageId: document.pages[0]!.id, object
  } });
}
const mol = (flavor: "v2000" | "v3000") => copyAsMolfile(moleculeDocument(2000), flavor)!;
const identifiers = () => { let index = 0; return (prefix: string) => `${prefix}_${++index}`; };

type Scenario = { name: string; prepare(size: number): { before: ChemDraftDocument; proposed: ChemDraftDocument } | Promise<{ before: ChemDraftDocument; proposed: ChemDraftDocument }> };
const insert = (name: string, build: (before: ChemDraftDocument) => ChemDraftDocument | Promise<ChemDraftDocument>): Scenario => ({ name,
  async prepare(size) { const before = page(size); return { before, proposed: await build(before) }; } });
const scenarios: Scenario[] = [
  insert("plain text / InChI fallback", before => applyClipboardPastePayload(before,
    { kind: "plain-text", text: "Caption\n".repeat(8), warnings: [] }, point).document),
  ...(["v2000", "v3000"] as const).map(flavor => insert(`MOL ${flavor} paste`, before => applyClipboardPastePayload(before,
    { kind: "molfile", format: flavor === "v2000" ? "molfile-v2000" : "molfile-v3000", text: mol(flavor), warnings: [] }, point).document)),
  insert("multi-molecule RXN paste", before => applyClipboardPastePayload(before,
    { kind: "rxnfile", text: `$RXN\nTest\n\n\n  2  0\n$MOL\n${mol("v2000")}\n$MOL\n${mol("v2000")}`, warnings: [] }, point).document),
  ...(["PNG", "SVG"] as const).map(format => insert(`${format} picture paste`, before => applyClipboardPastePayload(before,
    inspectClipboardPayload(format === "PNG" ? { types: ["image/png"], textItems: [], imageItems: [{ type: "image/png", bytesBase64: picturePngBase64 }] }
      : { types: ["image/svg+xml"], textItems: [{ type: "image/svg+xml", text: pictureSvg }] }), point).document)),
  insert("single SMILES paste", before => insertSmilesMolecule(before, point, depiction, smiles)),
  insert("SMILES-list grid paste (builder proposes growth)", before => insertSmilesMoleculeGrid(before, point,
    Array.from({ length: 6 }, () => ({ smiles, depiction }))).document),
  insert("private selection / fragment paste", before => pasteSelectionClipboardPayload(before,
    createSelectionClipboardPayload(moleculeDocument(2000))!, point)),
  insert("HTML / TSV table paste", before => {
    const parsed = readClipboardTsvTable("Name\tMass\nAlpha\t10\nBeta\t20");
    if (!parsed?.ok) throw new Error("Expected a table");
    return pasteTableIntoDocument(before, parsed, point, {}, identifiers()).document;
  }),
  insert("Insert Table (active or inactive tab)", before => insertTableIntoDocument(before,
    { rows: 4, columns: 4, headerRows: 1, preset: "grid", center: point, newId: identifiers() })),
  insert("structure template picker (active or inactive tab)", before => insertStructureTemplate(before,
    resolveStructureTemplateName("beta-cyclodextrin")!.id, point).document),
  insert("ring template canvas placement", before => insertNativeTemplateMolecule(before, point, "cyclohexane")),
  insert("native bracket stamp", before => insertNativeBracket(before, point, "square")),
  insert("native symbol stamp", before => insertNativeSymbolGlyph(before, point, "‡")),
  insert("Name to Structure plugin insert", async before => {
    const named = await nameToStructureForPlugin({ name: "β-CD" });
    expect(named).toMatchObject({ available: true, parsed: true });
    const object = structureTemplateMolecule(resolveStructureTemplateName("beta-cyclodextrin")!, { document: before, centre: point });
    return applyPluginDocumentPatch(before, proposal(before, object)).document;
  }),
  insert("documents.applyPatch plugin batch", before => {
    const object = createSmilesMolecule(before, point, depiction, smiles);
    return applyPluginDocumentPatch(before, ProposedDocumentPatchSchema.parse({ reason: "Batch", patch: { op: "batch", patches: [
      { op: "addObject", pageId: before.pages[0]!.id, object },
      { op: "addObject", pageId: before.pages[0]!.id, object: { ...object, id: "second" } }
    ] } })).document;
  }),
  { name: "documents.applyPatch update of selected content", prepare(size) {
    const before = moleculeDocument(size), object = before.pages[0]!.objects[0]!;
    if (object.type !== "molecule") throw new Error("Expected molecule");
    const changes = { x: object.x + 1000, atoms: object.atoms.map(atom => ({ ...atom, x: atom.x + 1000 })) };
    return { before, proposed: applyPluginDocumentPatch(before, ProposedDocumentPatchSchema.parse({ reason: "Move selected molecule", patch: {
      op: "updateObject", objectId: object.id, changes
    } })).document };
  } },
  insert("accepted recognition proposal", before => applyAcceptedPluginProposal(before, proposal(before)).document),
  { name: "Duplicate", prepare(size) {
    const before = moleculeDocument(size);
    return { before, proposed: duplicateSelectedDocumentObjects(before) };
  } },
  { name: "Clean Up 2D engine relayout for fused/coordination geometry", prepare(size) {
    const before = moleculeDocument(size);
    return { before, proposed: applyNativeMoleculeEngineRelayout(before, before.selection.objectIds[0]!, relayoutMolfile2D,
      { targetBondLengthPx: 32 }) };
  } },
  { name: "legacy 3D Cleanup engine command", prepare(size) {
    let before = moleculeDocument(size);
    const object = before.pages[0]!.objects[0]!;
    if (object.type !== "molecule") throw new Error("Expected molecule");
    const distorted = normalizeNativeMoleculeGeometry({ ...object, atoms: object.atoms.map((atom, index) => ({ ...atom,
      x: 200 + Math.sqrt(index) * 30, y: 200 + (index % 2 ? 18 : 0) })) });
    before = applyPatch(before, { op: "updateObject", objectId: object.id, changes: distorted });
    return { before, proposed: applyNativeMoleculeEngineRelayout(before, object.id, relayoutMolfile2D) };
  } },
  { name: "structure-editor Save", prepare(size) {
    const before = moleculeDocument(size);
    const object = createSmilesMolecule(before, { x: 700, y: 700 }, depictSmiles2D(smiles + smiles), smiles + smiles);
    return { before, proposed: applyEditorSaveResultWithLabelWarnings(before,
      { object: { ...object, id: before.selection.objectIds[0]! }, warnings: [] }).document };
  } },
  insert("art / arrow placement", before => insertNativeArtGraphicObject(before, point, "tool.art.rect")),
  { name: "Clean Up 2D native geometry", prepare(size) {
    let before = insertNativeTemplateMolecule(page(size), point, "cyclohexane");
    const ring = before.pages[0]!.objects[0]!;
    if (ring.type !== "molecule") throw new Error("Expected ring");
    const squeezed = normalizeNativeMoleculeGeometry({ ...ring, atoms: ring.atoms.map(atom => ({ ...atom, x: 100 + atom.x * 0.2, y: 100 + atom.y * 0.2 })) });
    before = applyPatch(before, { op: "updateObject", objectId: ring.id, changes: squeezed });
    return { before, proposed: cleanUpNativeMolecules2d(before, [ring.id]) };
  } }
];

describe.each(["macos", "windows"] as const)("page enlargement paths on %s", platform => {
  describe.each(scenarios)("$name", ({ prepare }) => {
    it("commits fitting content synchronously without a question", async () => {
      const { before, proposed } = await prepare(2000);
      expect(proposed).not.toBe(before);
      expect(planDocumentPageFit(before, proposed).growth).toEqual([]);
      const commit = vi.fn();
      expect(commitWithPageFit(before, proposed, commit, { consent: new PageEnlargementConsent(platform) })).toBeUndefined();
      expect(commit).toHaveBeenCalledExactlyOnceWith(proposed);
      expect(dialog.message).not.toHaveBeenCalled();
    });
    it.each(["Enlarge", "Keep Page Size"])("%s asks once and records page + content in one undo step", async answer => {
      const { before, proposed } = await prepare(20);
      expect(planDocumentPageFit(before, proposed).growth.length).toBeGreaterThan(0);
      dialog.message.mockResolvedValue(answer);
      let history = createDocumentHistory(before);
      await commitWithPageFit(before, proposed, document => {
        history = { past: [...history.past, history.present], present: document, future: [] };
      }, { consent: new PageEnlargementConsent(platform) });
      expect(dialog.message).toHaveBeenCalledExactlyOnceWith("This doesn't fit on the page. Enlarge the page to fit? Content on the page may shift to make room.", {
        title: "ChemDraft", kind: "info", buttons: { ok: "Enlarge", cancel: "Keep Page Size" }
      });
      expect(history.past).toHaveLength(1);
      const after = history.present;
      expect(after.selection).toEqual(proposed.selection);
      const growth = planDocumentPageFit(before, proposed).growth;
      for (const [index, page] of proposed.pages.entries()) {
        const fit = growth.find(candidate => candidate.pageId === page.id);
        const dx = answer === "Enlarge" ? fit?.shiftX ?? 0 : 0;
        const dy = answer === "Enlarge" ? fit?.shiftY ?? 0 : 0;
        const expected = page.objects.map(object => ({ ...object, x: object.x + dx, y: object.y + dy,
          ...(object.type === "molecule" ? { atoms: object.atoms.map(atom => ({ ...atom, x: atom.x + dx, y: atom.y + dy })) } : {}) }));
        expect(after.pages[index]!.objects).toEqual(expected);
      }
      if (answer === "Enlarge") {
        expect(after.pages[0]!.width > 20 || after.pages[0]!.height > 20).toBe(true);
      } else {
        expect(after.pages[0]!.layout).toEqual(before.pages[0]!.layout);
        expect(after.pages[0]!.width).toBe(20); expect(after.pages[0]!.height).toBe(20);
      }
      history = undo(history);
      expect(history.present).toEqual(before);
      expect(redo(history).present).toEqual(after);
      expect(dialog.message).toHaveBeenCalledOnce();
    });
  });

  it("shares one answer across successive and concurrent writes in an action", async () => {
    const consent = new PageEnlargementConsent(platform);
    dialog.message.mockResolvedValue("Enlarge");
    expect(await Promise.all([consent.confirm(), consent.confirm(), consent.confirm()])).toEqual(["enlarge", "enlarge", "enlarge"]);
    expect(await consent.confirm()).toBe("enlarge");
    expect(dialog.message).toHaveBeenCalledOnce();
  });
  it.each(["first", "later"])("honours the %s caller's abort and keeps the shared question unanswered", async caller => {
    const consent = new PageEnlargementConsent(platform);
    const abort = new AbortController();
    let answer!: (value: string) => void;
    dialog.message.mockImplementation(() => new Promise<string>(resolve => { answer = resolve; }));
    const first = consent.confirm(caller === "first" ? abort.signal : undefined);
    const second = consent.confirm(caller === "later" ? abort.signal : undefined);
    await vi.waitFor(() => expect(dialog.message).toHaveBeenCalledOnce());
    abort.abort();
    expect(await Promise.all([first, second])).toEqual(["unanswered", "unanswered"]);
    expect(await consent.confirm()).toBe("unanswered");
    answer("Enlarge");
    expect(await consent.confirm()).toBe("unanswered");
    expect(dialog.message).toHaveBeenCalledOnce();
  });
  it("holds the entire action until answered and rejects a stale tab/document", async () => {
    let answer!: (value: string) => void;
    dialog.message.mockImplementation(() => new Promise<string>(resolve => { answer = resolve; }));
    const before = page(20), proposed = insertNativeTextObject(before, point, "Many\nlines\n");
    const commit = vi.fn();
    const pending = commitWithPageFit(before, proposed, commit, { consent: new PageEnlargementConsent(platform), isCurrent: () => false });
    await vi.waitFor(() => expect(dialog.message).toHaveBeenCalledOnce());
    expect(commit).not.toHaveBeenCalled();
    answer("Enlarge");
    await expect(pending).rejects.toThrow("drawing changed");
    expect(commit).not.toHaveBeenCalled();
  });
  it.each(["fits", "Enlarge", "Keep Page Size"])("one decision covers a multi-page plugin patch (%s)", async answer => {
    let before = page(answer === "fits" ? 2000 : 20);
    before = { ...before, pages: [...before.pages, { ...before.pages[0]!, id: "second", objects: [] }] };
    const object = createSmilesMolecule(before, point, depiction, smiles);
    const proposed = applyPluginDocumentPatch(before, ProposedDocumentPatchSchema.parse({ reason: "Two pages", patch: { op: "batch", patches: [
      { op: "addObject", pageId: before.pages[0]!.id, object },
      { op: "addObject", pageId: "second", object: { ...object, id: "second-molecule" } }
    ] } })).document;
    dialog.message.mockResolvedValue(answer);
    let history = createDocumentHistory(before);
    await commitWithPageFit(before, proposed, document => { history = { past: [before], present: document, future: [] }; },
      { consent: new PageEnlargementConsent(platform) });
    expect(dialog.message).toHaveBeenCalledTimes(answer === "fits" ? 0 : 1);
    for (let i = 0; i < 2; i++) {
      if (answer === "Enlarge") expect(history.present.pages[i]!.width).toBeGreaterThan(20);
      else expect(history.present.pages[i]!.layout).toEqual(before.pages[i]!.layout);
    }
    expect(undo(history).present).toEqual(before);
  });
});

it("leaves Page Setup, selections, deletions and same-bounds edits on existing off-page content alone", () => {
  const before = moleculeDocument(20);
  const id = before.selection.objectIds[0]!;
  for (const proposed of [setDocumentCustomPageSize(before, { width: 30, height: 30, unit: "css-px" }),
    applyPatch(before, { op: "setSelection", objectIds: [] }),
    applyPatch(before, { op: "removeObject", objectId: id }),
    applyPatch(before, { op: "updateObject", objectId: id, changes: { style: { color: "#ff0000" } } })]) {
    expect(planDocumentPageFit(before, proposed).growth).toEqual([]);
  }
});
