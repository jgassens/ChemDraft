// @vitest-environment jsdom

import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { applyPatch, applyPatches, serializeDocument, type ChemDraftDocument, type MoleculeObject } from "@chemdraft/chem-core";
import { testMoleculeFromSmiles } from "@chemdraft/layout-engine/testing";
import { nativeSingleBondGraphMetadata, nativeSingleBondGraphSmiles, phase4Timestamp } from "@chemdraft/document-workflow-core";
import { MainWindow } from "./MainWindow";
import * as workflow from "./documentWorkflow";
import { DOM_COMMAND_EVENT } from "./window-manager";
import { dropMark, dropMolecule, electronMarkDropFixture } from "./testSupport/electronMarkDropFixture";

vi.mock("./rdkitWasmLoader", () => ({ registerRdkitWasmLoader: vi.fn() }));

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

// The commit funnel's chemistry guard (commitChemistryGuard.ts), driven through the real UI: a paste
// is placed at the pointer AFTER pasteSelectionClipboardPayload returns, and commit normalization
// then re-attributes a legacy loose "+" by distance. Nothing here is mocked in documentWorkflow.

const pageRect = { x: 0, y: 0, left: 0, top: 0, right: 792, bottom: 612, width: 792, height: 612, toJSON: () => ({}) } as DOMRect;
const B_ID = "b_mol";
const B_AT = { x: 420, y: 350 };
// 10 px left of B's first atom: commit normalization attributes a loose + here to B.
const STEAL = { x: B_AT.x - 10, y: B_AT.y };

/** A neutral ethane at B_AT. */
function withNeutralB(document: ChemDraftDocument): ChemDraftDocument {
  const graph = testMoleculeFromSmiles("CC");
  const atoms = graph.atoms.map((atom, index) => ({ ...atom, x: B_AT.x + index * 22, y: B_AT.y }));
  const molecule: MoleculeObject = { id: B_ID, type: "molecule", x: B_AT.x, y: B_AT.y, width: 22, height: 0,
    rotation: 0, style: {}, atoms, bonds: graph.bonds, structureFormat: "smiles",
    structure: nativeSingleBondGraphSmiles(atoms, graph.bonds), chemistry: nativeSingleBondGraphMetadata(atoms, graph.bonds),
    superatoms: [], rGroups: [] };
  return applyPatches(document, [{ op: "addObject", pageId: document.pages[0].id, object: molecule }], { now: phase4Timestamp });
}

/**
 * A file as an older version stored it: neutral Boc-glycine (A) and ethane (B), with B carrying +1
 * from a "+" stored as a loose point (not anchored to B's atom). Opening preserves the mark as
 * stored, so the next commit attributes it by distance again.
 */
function legacyFile(): ChemDraftDocument {
  const fixture = electronMarkDropFixture({ kind: "charge", charge: 1 });
  const mark = dropMark(fixture.document);
  const loose = { anchor: { kind: "point" as const, point: STEAL }, atomAssociation: undefined };
  const besideB = withNeutralB(applyPatch(fixture.document, { op: "updateObject", objectId: mark.id,
    changes: { ...loose, x: STEAL.x - mark.width / 2, y: STEAL.y - mark.height / 2 } }, { now: phase4Timestamp }));
  // The charge as it was attributed when the file was saved; the mark itself stays a loose point.
  const settled = workflow.normalizeCommittedDocument(besideB);
  const stored = applyPatch(settled, { op: "updateObject", objectId: mark.id, changes: loose }, { now: phase4Timestamp });
  return workflow.selectDocumentObjects(stored, stored.pages[0].id, []);
}

describe("MainWindow commit chemistry guard", () => {
  let container: HTMLDivElement;
  let root: Root;
  const captureMethods = { set: Element.prototype.setPointerCapture,
    release: Element.prototype.releasePointerCapture, has: Element.prototype.hasPointerCapture };

  beforeEach(() => {
    vi.stubGlobal("ResizeObserver", class { observe() {} unobserve() {} disconnect() {} });
    vi.stubGlobal("CSS", { escape: (value: string) => value });
    Element.prototype.setPointerCapture = () => {};
    Element.prototype.releasePointerCapture = () => {};
    Element.prototype.hasPointerCapture = () => false;
    window.history.replaceState(null, "", "/?agentBridge=1");
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    vi.unstubAllGlobals();
    Element.prototype.setPointerCapture = captureMethods.set;
    Element.prototype.releasePointerCapture = captureMethods.release;
    Element.prototype.hasPointerCapture = captureMethods.has;
    window.history.replaceState(null, "", "/");
    delete window.__CHEMDRAFT_AGENT__;
  });

  const snapshot = () => window.__CHEMDRAFT_AGENT__!.snapshot().document;
  const status = () => container.querySelector("[data-status-message]")?.textContent;
  const canUndo = () => container.querySelector("main")?.getAttribute("data-can-undo");
  const page = () => container.querySelector<HTMLElement>(".page")!;
  const moleculeB = (document: ChemDraftDocument) =>
    document.pages[0].objects.find((object): object is MoleculeObject => object.type === "molecule" && object.id === B_ID)!;
  const molecules = (document: ChemDraftDocument) => document.pages[0].objects.filter(object => object.type === "molecule");

  /** jsdom has no layout: the page is drawn 1:1 from (0, 0), so a client point is a page point. */
  function stubLayout() {
    page().getBoundingClientRect = () => pageRect;
    const canvas = container.querySelector<HTMLElement>(".canvas-region");
    if (canvas) canvas.getBoundingClientRect = () => pageRect;
  }

  async function mount(initialDocument: ChemDraftDocument) {
    await act(async () => root.render(createElement(MainWindow, {
      initialDocument,
      initialActiveToolCommandId: "tool.select",
      initialCrosshairsVisible: false,
      initialRulersVisible: false,
      initialPaletteMode: "hidden",
      nativePalette: false,
      shortcutPlatform: "macos"
    })));
    stubLayout();
    await act(async () => { await Promise.resolve(); });
  }

  async function openFile(document: ChemDraftDocument) {
    const input = container.querySelector<HTMLInputElement>('input[aria-label="Open native ChemDraft document"]')!;
    expect(input).not.toBeNull();
    const file = new File([serializeDocument(document)], "legacy-charge.chemdraft", { type: "application/json" });
    Object.defineProperty(input, "files", { configurable: true, value: [file] });
    await act(async () => { input.dispatchEvent(new Event("change", { bubbles: true })); await file.text(); });
    await act(async () => { await Promise.resolve(); });
    stubLayout();
  }

  async function pasteAt(payloadText: string, pagePoint: { x: number; y: number }) {
    const { client } = window.__CHEMDRAFT_AGENT__!.resolvePoint({ page: pagePoint });
    await act(async () => {
      window.dispatchEvent(new MouseEvent("pointermove", { bubbles: true, cancelable: true, clientX: client.x, clientY: client.y }));
    });
    const event = new Event("paste", { bubbles: true, cancelable: true });
    Object.defineProperty(event, "clipboardData", { value: {
      types: [workflow.CHEMDRAFT_SELECTION_CLIPBOARD_TYPE],
      getData: (type: string) => type === workflow.CHEMDRAFT_SELECTION_CLIPBOARD_TYPE ? payloadText : ""
    } });
    await act(async () => { window.dispatchEvent(event); });
    await act(async () => { await Promise.resolve(); });
  }

  function pointer(target: EventTarget, type: string, point: { x: number; y: number }) {
    const event = new MouseEvent(type, { bubbles: true, cancelable: true, button: 0,
      buttons: type === "pointerup" ? 0 : 1, clientX: point.x, clientY: point.y });
    Object.defineProperties(event, { pointerId: { value: 1 }, isPrimary: { value: true }, pointerType: { value: "mouse" } });
    target.dispatchEvent(event);
  }

  async function command(commandId: string) {
    await act(async () => window.dispatchEvent(new CustomEvent(DOM_COMMAND_EVENT, { detail: { commandId } })));
  }

  it("refuses a paste whose placement beside a legacy loose + would take B's charge, and shows why", async () => {
    await mount(workflow.createPhase4Document("Paste placement"));
    await openFile(legacyFile());
    const opened = snapshot();
    // The file's + is still the loose point it stored, and B carries its charge.
    expect(dropMark(opened).anchor).toEqual({ kind: "point", point: STEAL });
    expect(moleculeB(opened).atoms[0]).toMatchObject({ formalCharge: 1, markCharge: 1 });
    expect(canUndo()).toBe("false");

    const a = dropMolecule(opened);
    const hydroxylOxygen = a.atoms[11]!;
    expect(hydroxylOxygen).toMatchObject({ element: "O", x: 294, y: 250 });
    const payloadText = workflow.serializeSelectionClipboardPayload(
      workflow.createSelectionClipboardPayload(workflow.selectDocumentObjects(opened, opened.pages[0].id, [a.id]))!);
    const payload = workflow.parseSelectionClipboardPayload(payloadText)!;
    // The pointer that puts the pasted copy's hydroxyl oxygen exactly on the +.
    const onMark = { x: payload.bounds.centerX + STEAL.x - hydroxylOxygen.x, y: payload.bounds.centerY + STEAL.y - hydroxylOxygen.y };

    // The case is real: placed there and normalized, B would lose its charge to the copy.
    const pasted = workflow.pasteSelectionClipboardPayload(opened, payload, { x: payload.bounds.centerX, y: payload.bounds.centerY });
    const openedIds = new Set(opened.pages[0].objects.map(object => object.id));
    const placed = workflow.translateInsertedDocumentObjects(pasted,
      pasted.pages[0].objects.filter(object => !openedIds.has(object.id)).map(object => object.id),
      onMark.x - payload.bounds.centerX, onMark.y - payload.bounds.centerY);
    expect(moleculeB(workflow.normalizeCommittedDocument(placed)).atoms[0]).toMatchObject({ formalCharge: 0 });

    await pasteAt(payloadText, onMark);
    expect(status()).toMatch(new RegExp(`^Cannot paste without changing the chemistry of molecule "${B_ID}": its atom ` +
      `"[^"]+" would have charge 0 and 0 radical marks instead of 1 and 0\\.$`));
    expect(snapshot()).toEqual(opened);
    expect(moleculeB(snapshot()).atoms[0]).toMatchObject({ formalCharge: 1, markCharge: 1 });
    expect(canUndo()).toBe("false");

    // Pasted away from the +, the same selection commits and B keeps its charge.
    await pasteAt(payloadText, { x: payload.bounds.centerX, y: payload.bounds.centerY - 150 });
    const after = snapshot();
    expect(molecules(after)).toHaveLength(molecules(opened).length + 1);
    expect(moleculeB(after).atoms[0]).toMatchObject({ formalCharge: 1, markCharge: 1 });
    expect(status()).toBe("Pasted ChemDraft selection");
    expect(canUndo()).toBe("true");
  });

  it("still commits an intentional charge edit on a molecule already on the page", async () => {
    const ethane = workflow.insertNativeSingleBondMolecule(workflow.createPhase4Document("Charge edit"), { x: 300, y: 300 });
    await mount(workflow.selectDocumentObjects(ethane, ethane.pages[0].id, []));
    const before = snapshot();
    const molecule = dropMolecule(before);
    const atom = molecule.atoms[0]!;
    expect(atom.formalCharge).toBe(0);
    await command("tool.plus");
    await act(async () => pointer(page(), "pointermove", atom));
    const atomTarget = container.querySelector(`[data-hit-target="atom"][data-atom-id="${atom.id}"]`) ?? page();
    await act(async () => pointer(atomTarget, "pointerdown", atom));
    await act(async () => pointer(atomTarget, "pointerup", atom));

    const after = snapshot();
    expect(dropMolecule(after).id).toBe(molecule.id);
    expect(dropMolecule(after).atoms.find(candidate => candidate.id === atom.id)).toMatchObject({ formalCharge: 1 });
    expect(status() ?? "").not.toMatch(/^Cannot /);
    expect(canUndo()).toBe("true");
    await command("edit.undo");
    expect(snapshot()).toEqual(before);
  });
});
