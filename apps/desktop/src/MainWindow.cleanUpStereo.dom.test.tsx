// @vitest-environment jsdom
// Clean Up 2D's stereo guard as the user sees it: a molecule the polygon-and-tree layout would
// turn into another stereoisomer keeps its drawing, the status line says so in plain words, and a
// Clean Up that changed nothing adds no undo entry.
import { act, createElement, StrictMode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createEmptyDocument, type ChemDraftDocument, type MoleculeObject } from "@chemdraft/chem-core";
import { createSmilesMolecule } from "@chemdraft/document-workflow-core";
import * as ocl from "@chemdraft/ocl-adapter";
import { MainWindow } from "./MainWindow";
import { cleanUpNativeMolecules2d, moleculeHasFusedRingSystem, type CleanUpStereoGuardOptions } from "./documentWorkflow";
import { cleanUpStereoSignature } from "./cleanUpStereoGuard";
import { getAssistantHistoryPort } from "./assistant/historyPort";
import { MemoryStorage } from "./testSupport/memoryStorage";
import { DOM_COMMAND_EVENT } from "./window-manager";
import { installDomRdkitLoader } from "./testSupport/rdkitIdentity";

vi.mock("@scena/react-ruler", () => ({ default: () => createElement("canvas") }));
// The engine re-layout falls back to the RDKit layouts; load the real vendored module in jsdom.
vi.mock("./rdkitWasmLoader", () => ({ registerRdkitWasmLoader: vi.fn() }));
beforeAll(() => installDomRdkitLoader());
(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
class TestResizeObserver { observe() {} unobserve() {} disconnect() {} }
const rect = { x: 0, y: 0, left: 0, top: 0, right: 792, bottom: 612, width: 792, height: 612,
  toJSON: () => ({}) } as DOMRect;

// Recorded Clean Up flips (2026-11-25 sweep). The test uses the first one this depiction breaks.
const CANDIDATES = ["C[S@](=O)c1ccccc1", "C[C@H](O)c1ccccc1", "C[C@@H](O)c1ccccc1", "C[C@H](N)c1ccccc1", "O=C(O)/C=C/c1ccccc1",
  "C/N=C/c1ccccc1", "O/N=C/c1ccccc1", "C/C=C/c1ccccc1", "CC(C)[C@@H]1CC[C@@H](C)C[C@H]1O", "C[C@H]1CCCCO1"];
const SKIP = "Clean Up skipped 1 structure: tidying it would have changed its stereochemistry.";

function molecule(document: ChemDraftDocument, smiles: string, x: number): MoleculeObject {
  return createSmilesMolecule(document, { x, y: 250 }, ocl.depictSmiles2D(smiles), smiles);
}
function breakingMolecule(document: ChemDraftDocument): MoleculeObject {
  for (const smiles of CANDIDATES) {
    const candidate = molecule(document, smiles, 220);
    const probe = createEmptyDocument();
    probe.pages[0]!.objects.push(candidate);
    const skipped: NonNullable<CleanUpStereoGuardOptions["skipped"]> = [];
    if (cleanUpNativeMolecules2d(probe, [candidate.id], { stereoEngine: ocl, skipped }) === probe && skipped.length === 1) return candidate;
  }
  throw new Error("No recorded flip breaks under this depiction.");
}
function ordinaryMolecule(document: ChemDraftDocument): MoleculeObject {
  const ordinary = molecule(document, "CC(=O)c1ccccc1", 520);
  return { ...ordinary, id: "ordinary", atoms: ordinary.atoms.map((atom, i) => ({ ...atom, x: atom.x + ((i * 7) % 5) - 2, y: atom.y + ((i * 11) % 7) - 3 })) };
}

describe("Clean Up 2D stereo guard in the window", () => {
  let container: HTMLDivElement, root: Root;
  beforeEach(() => {
    vi.stubGlobal("localStorage", new MemoryStorage());
    vi.stubGlobal("ResizeObserver", TestResizeObserver);
    vi.stubGlobal("CSS", { escape: (value: string) => value });
    HTMLElement.prototype.setPointerCapture = () => {};
    HTMLElement.prototype.releasePointerCapture = () => {};
    HTMLElement.prototype.hasPointerCapture = () => false;
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
  });
  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });
  const current = () => getAssistantHistoryPort().read("initial")!;
  const objects = () => current().pages[0]!.objects as MoleculeObject[];
  const status = () => container.querySelector("[role=status]")?.textContent;
  const canUndo = () => container.querySelector("main")?.getAttribute("data-can-undo");
  async function cleanUp() {
    await act(async () => window.dispatchEvent(new CustomEvent(DOM_COMMAND_EVENT, { detail: { commandId: "structure.cleanup2d" } })));
  }
  async function render(initialDocument: ChemDraftDocument) {
    await act(async () => root.render(createElement(StrictMode, null, createElement(MainWindow, {
      initialDocument, initialActiveToolCommandId: "tool.select", initialPaletteMode: "hidden",
      initialCrosshairsVisible: false, initialRulersVisible: false, nativePalette: false
    }))));
    container.querySelector<HTMLElement>(".page")!.getBoundingClientRect = () => rect;
  }

  it("keeps a molecule that would flip exactly as drawn, says so, and adds no undo entry", async () => {
    const document = createEmptyDocument();
    const breaking = breakingMolecule(document);
    document.pages[0]!.objects.push(breaking);
    document.selection = { pageId: document.pages[0]!.id, objectIds: [breaking.id] };
    await render(document);
    const before = current();

    await cleanUp();
    await vi.waitFor(async () => {
      await act(async () => {});
      expect(status()).toBe(SKIP);
    }, { timeout: 10_000 });

    expect(current()).toEqual(before);
    expect(canUndo()).toBe("false");
  }, 20_000);

  it("cleans the ordinary molecule of a mixed selection and skips only the one that would flip", async () => {
    const document = createEmptyDocument();
    const breaking = breakingMolecule(document);
    const ordinary = ordinaryMolecule(document);
    document.pages[0]!.objects.push(breaking, ordinary);
    document.selection = { pageId: document.pages[0]!.id, objectIds: [breaking.id, ordinary.id] };
    await render(document);
    const before = objects();

    await cleanUp();
    await vi.waitFor(async () => {
      await act(async () => {});
      expect(status()).toBe(`Cleaned up selected structures — ${SKIP}`);
    }, { timeout: 10_000 });

    expect(objects().find(object => object.id === breaking.id)!.atoms).toEqual(before[0]!.atoms);
    expect(objects().find(object => object.id === ordinary.id)!.atoms).not.toEqual(before[1]!.atoms);
    expect(canUndo()).toBe("true");
  }, 20_000);

  it("cleans a molecule without stereo as before, with no skip in the status", async () => {
    const document = createEmptyDocument();
    const ordinary = ordinaryMolecule(document);
    document.pages[0]!.objects.push(ordinary);
    document.selection = { pageId: document.pages[0]!.id, objectIds: [ordinary.id] };
    await render(document);
    const before = objects();

    await cleanUp();

    expect(status()).toBe("Cleaned up selected structure");
    expect(objects()[0]!.atoms).not.toEqual(before[0]!.atoms);
  });
  it("keeps an alkene with a query bond as drawn on both the first and a repeated Clean Up", async () => {
    // A query bond makes the alkene's stereo unreadable. Neither the route that loads the
    // perceivers nor the synchronous one taken once they are loaded may clean it unchecked. (Run
    // alone, the first Clean Up loads them; after the tests above it is already synchronous.)
    const document = createEmptyDocument();
    const pasted = molecule(document, "O=C(O)/C=C/c1ccccc1", 220);
    const degree = new Map<string, number>();
    for (const b of pasted.bonds) for (const id of [b.fromAtomId, b.toAtomId]) degree.set(id, (degree.get(id) ?? 0) + 1);
    const hydroxyl = pasted.bonds.find(b => b.order === "single" && [b.fromAtomId, b.toAtomId].some(id =>
      degree.get(id) === 1 && pasted.atoms.find(a => a.id === id)!.element === "O"))!;
    const alkene: MoleculeObject = { ...pasted, id: "alkene",
      bonds: pasted.bonds.map(b => b.id === hydroxyl.id ? { ...b, order: "unknown" as const } : b),
      atoms: pasted.atoms.map((atom, i) => ({ ...atom, x: atom.x + ((i * 7) % 5) - 2, y: atom.y + ((i * 11) % 7) - 3 })) };
    document.pages[0]!.objects.push(alkene);
    document.selection = { pageId: document.pages[0]!.id, objectIds: [alkene.id] };
    await render(document);
    const before = current();
    const unchecked = "Clean Up skipped 1 structure: its stereochemistry couldn't be checked.";

    await cleanUp();
    await vi.waitFor(async () => {
      await act(async () => {});
      expect(status()).toBe(unchecked);
    }, { timeout: 10_000 });
    expect(current()).toEqual(before);
    expect(canUndo()).toBe("false");

    // The perceivers are loaded now, so this run takes the synchronous route. Its status reads
    // the same, so the document and the undo stack are what show it was guarded too.
    await cleanUp();
    expect(status()).toBe(unchecked);
    expect(current()).toEqual(before);
    expect(canUndo()).toBe("false");
  }, 20_000);

  // Molecules with a fused ring system take the engine re-layout, whose own read-back is R/S
  // only. The same guard keeps them as drawn, with the same status.
  const scuff = (m: MoleculeObject): MoleculeObject =>
    ({ ...m, atoms: m.atoms.map((atom, i) => ({ ...atom, x: atom.x + ((i * 7) % 5) - 2, y: atom.y + ((i * 11) % 7) - 3 })) });
  /** An indane whose alkene is drawn with its methyl in line with the double bond: no E/Z. */
  function inLineFusedAlkene(document: ChemDraftDocument): MoleculeObject {
    const pasted = molecule(document, "C/C=C/c1ccc2c(c1)CCC2", 220);
    const bondId = [...cleanUpStereoSignature(pasted, ocl).doubleBonds.keys()][0]!;
    const bond = pasted.bonds.find(b => b.id === bondId)!;
    const [end, other] = [bond.fromAtomId, bond.toAtomId].map(id => pasted.atoms.find(a => a.id === id)!);
    const substituent = pasted.bonds.find(b => b.id !== bondId && (b.fromAtomId === end!.id || b.toAtomId === end!.id))!;
    const movedId = substituent.fromAtomId === end!.id ? substituent.toAtomId : substituent.fromAtomId;
    const drawn = { ...pasted, id: "in-line", atoms: pasted.atoms.map(a => a.id === movedId ? { ...a, x: 2 * end!.x - other!.x, y: 2 * end!.y - other!.y } : a) };
    expect(moleculeHasFusedRingSystem(drawn)).toBe(true);
    expect(cleanUpStereoSignature(drawn, ocl).doubleBonds.size).toBe(0);
    return drawn;
  }

  it("keeps a fused molecule whose alkene would gain an E/Z as drawn, beside a fused one it cleans", async () => {
    const document = createEmptyDocument();
    const alkene = inLineFusedAlkene(document);
    const naphthalene = { ...scuff(molecule(document, "Cc1ccc2ccccc2c1", 520)), id: "naphthalene" };
    document.pages[0]!.objects.push(alkene, naphthalene);
    document.selection = { pageId: document.pages[0]!.id, objectIds: [alkene.id, naphthalene.id] };
    await render(document);

    await cleanUp();
    await vi.waitFor(async () => {
      await act(async () => {});
      expect(status()).toBe(`Cleaned up selected structures — ${SKIP}`);
    }, { timeout: 15_000 });
    expect(objects().find(object => object.id === alkene.id)).toEqual(alkene);
    expect(objects().find(object => object.id === naphthalene.id)!.atoms).not.toEqual(naphthalene.atoms);
    expect(canUndo()).toBe("true");
  }, 30_000);

  it("skips a wedged fused molecule with a query bond in plain words instead of failing the command", async () => {
    const document = createEmptyDocument();
    const pasted = molecule(document, "C[C@]12CC[C@H]3[C@@H](CCC4=CC(=O)CC[C@@]34C)[C@@H]1CC[C@@H]2O", 220);
    expect(pasted.bonds.some(b => b.display?.bondStyle === "wedge" || b.display?.bondStyle === "hashed")).toBe(true);
    // A query bond on a ring CH2-CH2, away from every wedge.
    const degree = new Map<string, number>();
    for (const b of pasted.bonds) for (const id of [b.fromAtomId, b.toAtomId]) degree.set(id, (degree.get(id) ?? 0) + 1);
    const wedged = new Set(pasted.bonds.filter(b => b.display?.bondStyle).flatMap(b => [b.fromAtomId, b.toAtomId]));
    const query = pasted.bonds.find(b => b.order === "single" && !b.display?.bondStyle && [b.fromAtomId, b.toAtomId].every(id =>
      degree.get(id) === 2 && !wedged.has(id) && pasted.atoms.find(a => a.id === id)!.element === "C"))!;
    const steroid = scuff({ ...pasted, id: "steroid", bonds: pasted.bonds.map(b => b.id === query.id ? { ...b, order: "unknown" as const } : b) });
    document.pages[0]!.objects.push(steroid);
    document.selection = { pageId: document.pages[0]!.id, objectIds: [steroid.id] };
    await render(document);
    const before = current();

    await cleanUp();
    await vi.waitFor(async () => {
      await act(async () => {});
      expect(status()).toBe("Clean Up skipped 1 structure: its stereochemistry couldn't be checked.");
    }, { timeout: 15_000 });
    expect(current()).toEqual(before);
    expect(canUndo()).toBe("false");
  }, 30_000);
});
