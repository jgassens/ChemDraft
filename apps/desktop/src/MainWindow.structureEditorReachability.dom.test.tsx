// @vitest-environment jsdom
// Reachability probe: can a user open the structure editor (KetcherEditorHost, title
// "Molecule Editor") with real selection-tool gestures? The opening logic is NOT mocked.
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createEmptyDocument, type ChemDraftDocument, type MoleculeObject } from "@chemdraft/chem-core";
import { createSmilesMolecule } from "@chemdraft/document-workflow-core";
import { getAssistantHistoryPort } from "./assistant/historyPort";
import { insertNativeSingleBondMolecule } from "./documentWorkflow";
import { KetcherEditorHost } from "./KetcherEditorHost";
import { MainWindow, shouldActivateDocumentObject, shouldOpenMoleculeEditorFromObjectClick } from "./MainWindow";
import { MemoryStorage } from "./testSupport/memoryStorage";
import { bondDepiction } from "./drawingDefaults.testHelpers";

vi.mock("./rdkitWasmLoader", () => ({ registerRdkitWasmLoader: vi.fn() }));
vi.mock("@scena/react-ruler", () => ({ default: () => <canvas /> }));
// The Ketcher runtime is heavy and not loadable in jsdom. Only the *host's* runtime module is
// stubbed; MainWindow's decision to render the host is the real code under test.
vi.mock("@chemdraft/ketcher-adapter", () => ({
  createKetcherAdapter: vi.fn(),
  createKetcherEngineHost: vi.fn()
}));
(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
class TestResizeObserver { observe() {} unobserve() {} disconnect() {} }

const rect = { x: 0, y: 0, left: 0, top: 0, right: 792, bottom: 612, width: 792, height: 612, toJSON: () => ({}) } as DOMRect;

describe("structure editor reachability with the selection tool", () => {
  let root: Root;
  let container: HTMLDivElement;
  beforeEach(() => {
    vi.stubGlobal("localStorage", new MemoryStorage());
    vi.stubGlobal("ResizeObserver", TestResizeObserver);
    vi.stubGlobal("CSS", { escape: (value: string) => value });
    // jsdom lacks pointer capture; the real handlers call these on every selection press.
    Element.prototype.setPointerCapture = () => {};
    Element.prototype.releasePointerCapture = () => {};
    Element.prototype.hasPointerCapture = () => false;
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

  const editorOpen = () => container.querySelector(".ketcher-editor-host") !== null
    || [...container.querySelectorAll("span")].some(span => span.textContent === "Molecule Editor");

  async function mount(initial: ChemDraftDocument) {
    await act(async () => root.render(<MainWindow initialDocument={initial} initialActiveToolCommandId="tool.select"
      initialPaletteMode="hidden" initialRulersVisible={false} nativePalette={false} />));
    for (const element of container.querySelectorAll<HTMLElement>(".page, .canvas-region")) {
      element.getBoundingClientRect = () => rect;
    }
  }
  const pointer = (type: string, x: number, y: number, detail: number) => {
    const event = new MouseEvent(type, { bubbles: true, cancelable: true, button: 0,
      buttons: type === "pointerup" ? 0 : 1, clientX: x, clientY: y, detail });
    Object.defineProperties(event, { pointerId: { value: 7 }, pointerType: { value: "mouse" }, isPrimary: { value: true } });
    return event;
  };
  /** One real click: pointerdown, pointerup, click (and optionally dblclick) on `target`. */
  async function click(target: Element, x: number, y: number, detail = 1) {
    await act(async () => {
      target.dispatchEvent(pointer("pointerdown", x, y, detail));
      target.dispatchEvent(pointer("pointerup", x, y, detail));
      target.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, button: 0, clientX: x, clientY: y, detail }));
      if (detail >= 2) {
        target.dispatchEvent(new MouseEvent("dblclick", { bubbles: true, cancelable: true, button: 0, clientX: x, clientY: y, detail }));
      }
    });
  }
  const selectionIds = () => getAssistantHistoryPort().read("initial")!.selection.objectIds;

  /** Every element a user could land on for this object: the wrapper plus every SVG node inside it. */
  const targetsFor = (objectId: string) => {
    const wrapper = container.querySelector(`[data-object-id="${objectId}"]`)!;
    return { wrapper, inner: [...wrapper.querySelectorAll("*")] };
  };

  async function runGestures(label: string, build: () => { doc: ChemDraftDocument; object: MoleculeObject; x: number; y: number }) {
    const built = build();
    const { object, x, y } = built;
    const doc: ChemDraftDocument = { ...built.doc, selection: { ...built.doc.selection, objectIds: [] } };
    await mount(doc);
    const { wrapper, inner } = targetsFor(object.id);
    expect(wrapper, `${label}: molecule wrapper rendered`).not.toBeNull();
    // Probe the wrapper and a sample of the molecule's own SVG nodes (atoms/bonds/background).
    const targets: Element[] = [wrapper, ...inner.slice(0, 12)];
    const opened: string[] = [];
    let everSelected = false;

    for (const target of targets) {
      const name = `${target.tagName.toLowerCase()}${target.getAttribute("class") ? "." + target.getAttribute("class") : ""}`;
      // (1) single click on an unselected molecule
      await click(target, x, y, 1);
      if (selectionIds().includes(object.id)) everSelected = true;
      if (editorOpen()) opened.push(`single click on ${name}`);
      // (2) click-after-select: the molecule is now selected; click again
      await click(target, x, y, 1);
      if (editorOpen()) opened.push(`click-after-select on ${name}`);
      // (3) double click
      await click(target, x, y, 2);
      if (editorOpen()) opened.push(`double click on ${name}`);
      // reset: click empty page to deselect
      await act(async () => {
        const page = container.querySelector(".page")!;
        page.dispatchEvent(pointer("pointerdown", 5, 5, 1));
        page.dispatchEvent(pointer("pointerup", 5, 5, 1));
      });
    }
    return { opened, selected: selectionIds(), everSelected };
  }

  it("positive control: the marker used here does detect a rendered KetcherEditorHost", async () => {
    const molecule = insertNativeSingleBondMolecule(createEmptyDocument(), { x: 200, y: 200 }).pages[0]!.objects[0] as MoleculeObject;
    expect(editorOpen()).toBe(false);
    await act(async () => root.render(<KetcherEditorHost molecule={molecule} onApply={() => {}} onClose={() => {}} onStatus={() => {}} />));
    expect(editorOpen()).toBe(true);
  });

  it("the click-to-edit predicate is a constant false and the activation gate cannot reach the editor", () => {
    const molecule = insertNativeSingleBondMolecule(createEmptyDocument(), { x: 200, y: 200 }).pages[0]!.objects[0] as MoleculeObject;
    for (const tool of ["selection", "bond", "atom"]) {
      for (const clicks of [1, 2, 3]) expect(shouldOpenMoleculeEditorFromObjectClick(molecule, tool, clicks)).toBe(false);
    }
    expect(shouldActivateDocumentObject(molecule, "selection")).toBe(true);
    expect(shouldActivateDocumentObject(molecule, "bond")).toBe(false);
  });

  it("(a) native molecule: no selection-tool gesture opens the structure editor", async () => {
    const result = await runGestures("native", () => {
      const doc = insertNativeSingleBondMolecule(createEmptyDocument(), { x: 200, y: 200 });
      const object = doc.pages[0]!.objects[0] as MoleculeObject;
      expect(object.atoms.length).toBeGreaterThan(0);
      return { doc, object, x: object.atoms[0]!.x, y: object.atoms[0]!.y };
    });
    console.info("native opened by:", JSON.stringify(result.opened));
    expect(result.everSelected, "gestures reached the selection handler").toBe(true);
    expect(result.opened).toEqual([]);
    expect(editorOpen()).toBe(false);
  }, 60_000);

  it("(a2) SMILES-built native molecule: no selection-tool gesture opens the structure editor", async () => {
    const result = await runGestures("smiles", () => {
      const doc = createEmptyDocument();
      const object = createSmilesMolecule(doc, { x: 200, y: 200 }, bondDepiction, "CCO");
      const page = { ...doc.pages[0]!, objects: [object] };
      return { doc: { ...doc, pages: [page, ...doc.pages.slice(1)] } as ChemDraftDocument, object, x: object.x + object.width / 2, y: object.y + object.height / 2 };
    });
    console.info("smiles opened by:", JSON.stringify(result.opened), "everSelected:", result.everSelected);
    expect(result.everSelected, "gestures reached the selection handler").toBe(true);
    expect(result.opened).toEqual([]);
    expect(editorOpen()).toBe(false);
  }, 60_000);

  it("(b) non-native molecule (no atom graph, the only kind the ~20901 branch could see): no gesture opens it", async () => {
    const result = await runGestures("non-native", () => {
      const doc = insertNativeSingleBondMolecule(createEmptyDocument(), { x: 200, y: 200 });
      const native = doc.pages[0]!.objects[0] as MoleculeObject;
      // Same molecule with its atom graph stripped: isNativeMoleculeGraph() is false, so the
      // press is not swallowed by the native-hit early return and falls to the object path.
      const object: MoleculeObject = { ...native, atoms: [], bonds: [] };
      const page = { ...doc.pages[0]!, objects: [object] };
      return { doc: { ...doc, pages: [page, ...doc.pages.slice(1)] } as ChemDraftDocument, object, x: native.x + native.width / 2, y: native.y + native.height / 2 };
    });
    console.info("non-native opened by:", JSON.stringify(result.opened), "everSelected:", result.everSelected);
    expect(result.opened).toEqual([]);
    expect(editorOpen()).toBe(false);
  }, 60_000);
});
