// @vitest-environment jsdom
// Clean Up 2D's stereo guard as the user sees it: a molecule the polygon-and-tree layout would
// turn into another stereoisomer keeps its drawing, the status line says so in plain words, and a
// Clean Up that changed nothing adds no undo entry.
import { act, createElement, StrictMode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createEmptyDocument, type ChemDraftDocument, type MoleculeObject } from "@chemdraft/chem-core";
import { createSmilesMolecule } from "@chemdraft/document-workflow-core";
import * as ocl from "@chemdraft/ocl-adapter";
import { MainWindow } from "./MainWindow";
import { cleanUpNativeMolecules2d, type CleanUpStereoGuardOptions } from "./documentWorkflow";
import { getAssistantHistoryPort } from "./assistant/historyPort";
import { MemoryStorage } from "./testSupport/memoryStorage";
import { DOM_COMMAND_EVENT } from "./window-manager";

vi.mock("@scena/react-ruler", () => ({ default: () => createElement("canvas") }));
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
});
