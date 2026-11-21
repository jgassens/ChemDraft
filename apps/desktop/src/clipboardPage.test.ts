import { describe, expect, it } from "vitest";
import {
  applyPatches, serializeDocument,
  type ChemDraftDocument, type DocumentObject, type ElectronMarkObject, type MoleculeObject, type TextObject
} from "@chemdraft/chem-core";
import { testMoleculeFromSmiles } from "@chemdraft/layout-engine/testing";
import { nativeSingleBondGraphMetadata, nativeSingleBondGraphSmiles, phase4Timestamp } from "@chemdraft/document-workflow-core";
import * as workflow from "./documentWorkflow";
import { dropMark, dropMolecule, electronMarkDropFixture } from "./testSupport/electronMarkDropFixture";

// Copy reads the page that holds the selection, and every paste lands on the page the user is on
// (the selection's page). Both used to read `firstPage(document)`: copying a selection on page 2
// found nothing, and every paste landed on page 1.

const PAGE_ONE = "page_001";
const PAGE_TWO = "page_002";
const PASTE_POINT = { x: 520, y: 600 };

const pageOf = (document: ChemDraftDocument, pageId: string) => document.pages.find(page => page.id === pageId)!;
const moleculesOn = (document: ChemDraftDocument, pageId: string) =>
  pageOf(document, pageId).objects.filter((object): object is MoleculeObject => object.type === "molecule");
const marksOn = (document: ChemDraftDocument, pageId: string) =>
  pageOf(document, pageId).objects.filter((object): object is ElectronMarkObject => object.type === "electron-mark");
const atomsOf = (molecule: MoleculeObject) => molecule.atoms.map(atom => ({ id: atom.id, element: atom.element }));

/** Boc-glycine carrying a plus mark on its nitrogen (page one's content). */
function bocGlycineWithPlus() {
  return workflow.normalizeCommittedDocument(electronMarkDropFixture({ kind: "charge", charge: 1 }).document);
}

/** A lone carbanion: a carbon with a minus mark from the charge tool, anchored to its atom. */
function carbanion() {
  const base = electronMarkDropFixture().document;
  const graph = testMoleculeFromSmiles("C");
  const atoms = graph.atoms.map(atom => ({ ...atom, x: 228, y: 250 }));
  const withCarbon = applyPatches(base, [
    { op: "removeObject", objectId: dropMark(base).id },
    { op: "updateObject", objectId: dropMolecule(base).id, changes: {
      x: 228, y: 250, width: 0, height: 0, atoms, bonds: graph.bonds,
      structure: nativeSingleBondGraphSmiles(atoms, graph.bonds), chemistry: nativeSingleBondGraphMetadata(atoms, graph.bonds)
    } }
  ], { now: phase4Timestamp });
  const molecule = dropMolecule(withCarbon);
  return workflow.normalizeCommittedDocument(workflow.applyChargeToolAtNativeAtom(withCarbon,
    { kind: "charge", charge: -1 }, { kind: "atom", objectId: molecule.id, atomId: atoms[0].id, distanceToPointer: 0 }));
}

/** The first page of `source`, with its page, molecule and mark ids renamed so it can sit beside another. */
function renamedFirstPage(source: ChemDraftDocument, pageId: string, ids: Record<string, string>) {
  let text = JSON.stringify(source.pages[0]);
  for (const [from, to] of Object.entries({ [source.pages[0].id]: pageId, ...ids })) {
    text = text.split(JSON.stringify(from)).join(JSON.stringify(to));
  }
  return JSON.parse(text) as ChemDraftDocument["pages"][number];
}

/** Page one: Boc-glycine and its plus. Page two: a carbanion and its minus. Nothing is shared. */
function twoPageDocument(): ChemDraftDocument {
  const one = bocGlycineWithPlus();
  const two = carbanion();
  const pageTwo = renamedFirstPage(two, PAGE_TWO, {
    [dropMolecule(two).id]: "p2_carbanion", [dropMark(two).id]: "p2_minus"
  });
  const pageOne = renamedFirstPage(one, PAGE_ONE, {});
  // Nothing may be shared between the pages, or the test would prove nothing about which page is read.
  const ids = [...pageOne.objects, ...pageTwo.objects].map(object => object.id);
  expect(new Set(ids).size).toBe(ids.length);
  return { ...one, pages: [pageOne, pageTwo] } as ChemDraftDocument;
}

/** The two-page document with the user on page 2: the page-2 carbanion selected, the way the app selects. */
function onPageTwo(): ChemDraftDocument {
  return workflow.selectDocumentObjects(twoPageDocument(), PAGE_TWO, ["p2_carbanion"]);
}

/** A ChemDraft selection payload of a carbanion and its minus, copied from a one-page document. */
function carbanionPayload() {
  const source = carbanion();
  const selected = workflow.selectDocumentObjects(source, source.pages[0].id, [dropMolecule(source).id]);
  const payload = workflow.createSelectionClipboardPayload(selected);
  expect(payload).toBeDefined();
  return payload!;
}

/** Every object on `pageId` that was not there in `before`. */
function addedOn(before: ChemDraftDocument, after: ChemDraftDocument, pageId: string): DocumentObject[] {
  const existing = new Set(pageOf(before, pageId).objects.map(object => object.id));
  return pageOf(after, pageId).objects.filter(object => !existing.has(object.id));
}

describe("Copy reads the page that holds the selection", () => {
  it("copies a page-2 molecule with its atom-anchored charge mark", () => {
    const selected = onPageTwo();
    expect(selected.selection.pageId).toBe(PAGE_TWO);
    const before = serializeDocument(selected);

    const payload = workflow.createSelectionClipboardPayload(selected);

    expect(serializeDocument(selected)).toBe(before);
    expect(payload).toBeDefined();
    const ids = payload!.objects.map(object => object.id).sort();
    // The page-2 carbanion and the minus it carries; nothing from page 1.
    expect(ids).toEqual(["p2_carbanion", "p2_minus"]);
    const molecule = payload!.objects.find((object): object is MoleculeObject => object.type === "molecule")!;
    expect(atomsOf(molecule)).toEqual(atomsOf(moleculesOn(selected, PAGE_TWO)[0]));
    const mark = payload!.objects.find((object): object is ElectronMarkObject => object.type === "electron-mark")!;
    expect(mark.charge).toBe(-1);
    expect(mark.anchor).toMatchObject({ kind: "atom", objectId: "p2_carbanion", atomId: molecule.atoms[0].id });
    expect(payload!.selectionIds).toEqual(["p2_carbanion"]);
  });

  it("copies a lasso fragment of a page-2 molecule with its mark", () => {
    const document = workflow.selectDocumentObjects(twoPageDocument(), PAGE_TWO, []);
    const molecule = moleculesOn(document, PAGE_TWO)[0];

    const payload = workflow.createSelectionClipboardPayload(document,
      [{ objectId: molecule.id, atomIds: [molecule.atoms[0].id], bondIds: [] }]);

    expect(payload).toBeDefined();
    expect(payload!.objects.map(object => object.id).sort()).toEqual(["p2_carbanion", "p2_minus"]);
  });

  it("still copies a page-1 selection of the same two-page document", () => {
    const document = twoPageDocument();
    const boc = moleculesOn(document, PAGE_ONE)[0];
    const selected = workflow.selectDocumentObjects(document, PAGE_ONE, [boc.id]);

    const payload = workflow.createSelectionClipboardPayload(selected);

    expect(payload).toBeDefined();
    expect(payload!.objects.map(object => object.id).sort()).toEqual([boc.id, marksOn(document, PAGE_ONE)[0].id].sort());
  });

  it("single-page control: a carbanion and its minus are copied together", () => {
    const payload = carbanionPayload();
    expect(payload.objects.map(object => object.type).sort()).toEqual(["electron-mark", "molecule"]);
  });
});

describe("Paste lands on the page the user is on", () => {
  it("pastes a ChemDraft selection onto page 2, carries its mark, and leaves page 1 alone", () => {
    const payload = carbanionPayload();
    const document = onPageTwo();
    const pageOneBefore = structuredClone(document.pages[0]);
    const pageTwoBefore = structuredClone(document.pages[1]);
    const before = serializeDocument(document);
    const warnings: string[] = [];

    const pasted = workflow.pasteSelectionClipboardPayload(document, payload, PASTE_POINT, warnings);

    expect(serializeDocument(document)).toBe(before);
    expect(warnings).toEqual([]);
    // Page 1 is exactly as it was.
    expect(pasted.pages[0]).toEqual(pageOneBefore);
    // Page 2 keeps every original object and gains the pasted molecule and its mark.
    for (const object of pageTwoBefore.objects as DocumentObject[]) {
      expect(pasted.pages[1].objects.find(candidate => candidate.id === object.id)).toEqual(object);
    }
    const added = addedOn(document, pasted, PAGE_TWO);
    expect(added.map(object => object.type).sort()).toEqual(["electron-mark", "molecule"]);
    const copy = added.find((object): object is MoleculeObject => object.type === "molecule")!;
    const copiedMark = added.find((object): object is ElectronMarkObject => object.type === "electron-mark")!;
    const source = payload.objects.find((object): object is MoleculeObject => object.type === "molecule")!;
    expect(atomsOf(copy)).toEqual(atomsOf(source));
    expect(copiedMark.charge).toBe(-1);
    expect(copiedMark.anchor).toMatchObject({ kind: "atom", objectId: copy.id, atomId: source.atoms[0].id });
    // The paste is the new selection, on page 2.
    expect(pasted.selection).toEqual({ pageId: PAGE_TWO, objectIds: [copy.id] });
    // The copy keeps its charge; the page-2 original and page 1's plus are untouched.
    const committed = workflow.normalizeCommittedDocument(pasted);
    expect(moleculesOn(committed, PAGE_TWO).find(molecule => molecule.id === copy.id)!.atoms[0].formalCharge).toBe(-1);
    expect(moleculesOn(committed, PAGE_TWO).find(molecule => molecule.id === "p2_carbanion")!.atoms[0].formalCharge).toBe(-1);
    expect(moleculesOn(committed, PAGE_ONE)).toEqual(moleculesOn(workflow.normalizeCommittedDocument(document), PAGE_ONE));
  });

  it("pastes onto page 2 when the user is on page 2 with nothing selected", () => {
    const payload = carbanionPayload();
    const document = workflow.selectDocumentObjects(twoPageDocument(), PAGE_TWO, []);
    const pageOneBefore = structuredClone(document.pages[0]);

    const pasted = workflow.pasteSelectionClipboardPayload(document, payload, PASTE_POINT);

    expect(pasted.pages[0]).toEqual(pageOneBefore);
    expect(addedOn(document, pasted, PAGE_TWO).map(object => object.type).sort()).toEqual(["electron-mark", "molecule"]);
    expect(pasted.selection.pageId).toBe(PAGE_TWO);
  });

  it("pastes a page-2 copy back onto page 2 (copy and paste round trip)", () => {
    const document = onPageTwo();
    const payload = workflow.createSelectionClipboardPayload(document)!;
    expect(payload).toBeDefined();
    const pageOneBefore = structuredClone(document.pages[0]);

    const pasted = workflow.pasteSelectionClipboardPayload(document, payload, PASTE_POINT);

    expect(pasted.pages[0]).toEqual(pageOneBefore);
    expect(addedOn(document, pasted, PAGE_TWO).map(object => object.type).sort()).toEqual(["electron-mark", "molecule"]);
  });

  it("pastes SMILES text onto page 2", () => {
    const document = onPageTwo();
    const pageOneBefore = structuredClone(document.pages[0]);

    const result = workflow.applyClipboardPastePayload(document, { kind: "smiles", text: "CCO", warnings: [] }, PASTE_POINT);

    expect(result.document.pages[0]).toEqual(pageOneBefore);
    const added = addedOn(document, result.document, PAGE_TWO);
    expect(added.map(object => object.type)).toEqual(["molecule"]);
    expect(result.selectedObjectId).toBe(added[0].id);
    expect(result.document.selection).toEqual({ pageId: PAGE_TWO, objectIds: [added[0].id] });
  });

  it("pastes plain text onto page 2", () => {
    const document = onPageTwo();
    const pageOneBefore = structuredClone(document.pages[0]);

    const result = workflow.applyClipboardPastePayload(document,
      { kind: "plain-text", text: "rt, 1 h", warnings: [] }, PASTE_POINT);

    expect(result.document.pages[0]).toEqual(pageOneBefore);
    const added = addedOn(document, result.document, PAGE_TWO);
    expect(added).toHaveLength(1);
    expect((added[0] as TextObject).text).toBe("rt, 1 h");
    expect(result.editTextObjectId).toBe(added[0].id);
    expect(result.document.selection).toEqual({ pageId: PAGE_TWO, objectIds: [added[0].id] });
  });

  it("still pastes onto page 1 when the user is on page 1 of the same two-page document", () => {
    const payload = carbanionPayload();
    const document = twoPageDocument();
    const selected = workflow.selectDocumentObjects(document, PAGE_ONE, [moleculesOn(document, PAGE_ONE)[0].id]);
    const pageTwoBefore = structuredClone(selected.pages[1]);

    const pasted = workflow.pasteSelectionClipboardPayload(selected, payload, PASTE_POINT);
    const smiles = workflow.applyClipboardPastePayload(selected, { kind: "smiles", text: "CCO", warnings: [] }, PASTE_POINT);

    expect(pasted.pages[1]).toEqual(pageTwoBefore);
    expect(addedOn(selected, pasted, PAGE_ONE).map(object => object.type).sort()).toEqual(["electron-mark", "molecule"]);
    expect(pasted.selection.pageId).toBe(PAGE_ONE);
    expect(smiles.document.pages[1]).toEqual(pageTwoBefore);
    expect(addedOn(selected, smiles.document, PAGE_ONE).map(object => object.type)).toEqual(["molecule"]);
  });

  it("single-page control: a ChemDraft selection and SMILES both paste onto the only page", () => {
    const payload = carbanionPayload();
    const document = bocGlycineWithPlus();
    const pageId = document.pages[0].id;

    const pasted = workflow.pasteSelectionClipboardPayload(document, payload, PASTE_POINT);
    const smiles = workflow.applyClipboardPastePayload(document, { kind: "smiles", text: "CCO", warnings: [] }, PASTE_POINT);

    const added = addedOn(document, pasted, pageId);
    expect(added.map(object => object.type).sort()).toEqual(["electron-mark", "molecule"]);
    const copy = added.find((object): object is MoleculeObject => object.type === "molecule")!;
    const copiedMark = added.find((object): object is ElectronMarkObject => object.type === "electron-mark")!;
    expect(copiedMark.anchor).toMatchObject({ kind: "atom", objectId: copy.id });
    expect(pasted.selection).toEqual({ pageId, objectIds: [copy.id] });
    expect(addedOn(document, smiles.document, pageId).map(object => object.type)).toEqual(["molecule"]);
  });
});
