import { describe, expect, it } from "vitest";
import {
  applyPatches, serializeDocument,
  type ChemDraftDocument, type DocumentObject, type ElectronMarkObject, type MoleculeObject
} from "@chemdraft/chem-core";
import { testMoleculeFromSmiles } from "@chemdraft/layout-engine/testing";
import { nativeSingleBondGraphMetadata, nativeSingleBondGraphSmiles, phase4Timestamp } from "@chemdraft/document-workflow-core";
import * as workflow from "./documentWorkflow";
import { dropMark, dropMolecule, electronMarkDropFixture } from "./testSupport/electronMarkDropFixture";

// Duplicate acts on the page that holds the selection. It used to read `firstPage(document)`, so with
// the selection on page 2 it looked for the selected ids on page 1, found none, and did nothing.

const OFFSET = { x: 24, y: 24 };
const PAGE_ONE = "page_001";
const PAGE_TWO = "page_002";

const moleculesOn = (document: ChemDraftDocument, pageId: string) =>
  document.pages.find(page => page.id === pageId)!.objects.filter((object): object is MoleculeObject => object.type === "molecule");
const marksOn = (document: ChemDraftDocument, pageId: string) =>
  document.pages.find(page => page.id === pageId)!.objects.filter((object): object is ElectronMarkObject => object.type === "electron-mark");
const atomsOf = (molecule: MoleculeObject) => molecule.atoms.map(atom => ({ id: atom.id, element: atom.element }));

/** Boc-glycine carrying a plus mark on its nitrogen (page one's content). */
function bocGlycineWithPlus() {
  return workflow.normalizeCommittedDocument(electronMarkDropFixture({ kind: "charge", charge: 1 }).document);
}

/** A lone carbanion: a carbon with a minus mark from the charge tool (page two's content). */
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
  const document = { ...one, pages: [pageOne, pageTwo] } as ChemDraftDocument;
  // The way the app selects: the object's own page and ids.
  return workflow.selectDocumentObjects(document, PAGE_TWO, ["p2_carbanion"]);
}

describe("Duplicate acts on the page that holds the selection", () => {
  it("copies the page-2 molecule onto page 2, carries its charge mark, and leaves page 1 alone", () => {
    const selected = twoPageDocument();
    expect(selected.selection.pageId).toBe(PAGE_TWO);
    const pageOneBefore = structuredClone(selected.pages[0]);
    const pageTwoBefore = structuredClone(selected.pages[1]);
    const before = serializeDocument(selected);
    const original = moleculesOn(selected, PAGE_TWO)[0];
    const originalMark = marksOn(selected, PAGE_TWO)[0];
    expect(originalMark.charge).toBe(-1);

    const edited = workflow.duplicateSelectedDocumentObjects(selected, OFFSET);

    expect(serializeDocument(selected)).toBe(before);
    // Page 1 is exactly as it was: nothing of page 1 was copied, moved or changed.
    expect(edited.pages[0]).toEqual(pageOneBefore);
    // Page 2 keeps every original object untouched, and gains exactly one molecule and one mark.
    for (const object of pageTwoBefore.objects as DocumentObject[]) {
      expect(edited.pages[1].objects.find(candidate => candidate.id === object.id)).toEqual(object);
    }
    expect(edited.pages[1].objects).toHaveLength(pageTwoBefore.objects.length + 2);
    const copy = moleculesOn(edited, PAGE_TWO).find(molecule => molecule.id !== original.id)!;
    expect(copy).toBeDefined();
    expect(moleculesOn(edited, PAGE_ONE)).toHaveLength(1);
    // A copy of the page-2 carbanion (not of page 1's Boc-glycine), at the duplicate offset.
    expect(atomsOf(copy)).toEqual(atomsOf(original));
    expect(copy.atoms).toHaveLength(1);
    expect(copy.x).toBeCloseTo(original.x + OFFSET.x);
    expect(copy.y).toBeCloseTo(original.y + OFFSET.y);
    // Its charge mark was carried: its own object on page 2, anchored to the copy's atom.
    const copiedMarks = marksOn(edited, PAGE_TWO).filter(mark => mark.id !== originalMark.id);
    expect(copiedMarks).toHaveLength(1);
    expect(copiedMarks[0].charge).toBe(-1);
    expect(copiedMarks[0].anchor).toEqual({ kind: "atom", objectId: copy.id, atomId: original.atoms[0].id });
    expect(marksOn(edited, PAGE_ONE)).toHaveLength(1);
    // The copy is the new selection, on page 2, and it keeps the chemistry of its original.
    expect(edited.selection).toEqual({ pageId: PAGE_TWO, objectIds: [copy.id] });
    const committed = workflow.normalizeCommittedDocument(edited);
    const committedCopy = moleculesOn(committed, PAGE_TWO).find(molecule => molecule.id === copy.id)!;
    const committedOriginal = moleculesOn(committed, PAGE_TWO).find(molecule => molecule.id === original.id)!;
    expect(committedCopy.atoms[0].formalCharge).toBe(-1);
    expect(committedOriginal.atoms[0].formalCharge).toBe(-1);
  });

  it("still duplicates on page 1 of the same two-page document", () => {
    const document = twoPageDocument();
    const boc = moleculesOn(document, PAGE_ONE)[0];
    const selected = workflow.selectDocumentObjects(document, PAGE_ONE, [boc.id]);
    const pageTwoBefore = structuredClone(selected.pages[1]);

    const edited = workflow.duplicateSelectedDocumentObjects(selected, OFFSET);

    expect(edited.pages[1]).toEqual(pageTwoBefore);
    const copy = moleculesOn(edited, PAGE_ONE).find(molecule => molecule.id !== boc.id)!;
    expect(copy).toBeDefined();
    expect(atomsOf(copy)).toEqual(atomsOf(boc));
    expect(marksOn(edited, PAGE_ONE)).toHaveLength(2);
    expect(edited.selection).toEqual({ pageId: PAGE_ONE, objectIds: [copy.id] });
  });

  it("single-page control: a carbanion and its minus are copied together", () => {
    const document = carbanion();
    const molecule = dropMolecule(document);
    const selected = workflow.selectDocumentObjects(document, document.pages[0].id, [molecule.id]);

    const edited = workflow.duplicateSelectedDocumentObjects(selected, OFFSET);

    const copy = moleculesOn(edited, edited.pages[0].id).find(candidate => candidate.id !== molecule.id)!;
    expect(copy).toBeDefined();
    expect(atomsOf(copy)).toEqual(atomsOf(molecule));
    const copiedMarks = marksOn(edited, edited.pages[0].id).filter(mark => mark.id !== dropMark(document).id);
    expect(copiedMarks).toHaveLength(1);
    expect(copiedMarks[0].charge).toBe(-1);
    expect(copiedMarks[0].anchor).toEqual({ kind: "atom", objectId: copy.id, atomId: molecule.atoms[0].id });
    expect(edited.selection).toEqual({ pageId: edited.pages[0].id, objectIds: [copy.id] });
  });
});
