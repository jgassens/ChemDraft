// @vitest-environment jsdom
// Owner report for 1.2.3: "Zn" and "Zn2+" typed with the Text tool on empty canvas stayed text, so no
// bond could be drawn to them. A finished new text box holding one element symbol, with an optional
// charge, becomes a one-atom molecule in the typing's own undo entry; everything else stays text.
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ChemDraftDocument, MoleculeObject } from "@chemdraft/chem-core";
import { MainWindow } from "./MainWindow";
import {
  applyNativeAtomElementTarget,
  createPhase4Document,
  insertNativeSingleBondMolecule,
  insertNativeTextObject,
  selectDocumentObjects
} from "./documentWorkflow";
import { DOM_COMMAND_EVENT } from "./window-manager";
import { MemoryStorage } from "./testSupport/memoryStorage";

vi.mock("./rdkitWasmLoader", () => ({ registerRdkitWasmLoader: vi.fn() }));
vi.mock("@scena/react-ruler", () => ({ default: () => <canvas /> }));

/** A two-atom ligand on the right of the page whose left atom is a nitrogen. */
function documentWithLigandNitrogen(): { document: ChemDraftDocument; nitrogenId: string } {
  const seeded = insertNativeSingleBondMolecule(createPhase4Document("Typed atoms"), { x: 460, y: 300 });
  const molecule = seeded.pages[0].objects.find((object): object is MoleculeObject => object.type === "molecule")!;
  const nitrogen = [...molecule.atoms].sort((left, right) => left.x - right.x)[0]!;
  const withNitrogen = applyNativeAtomElementTarget(seeded, {
    objectId: molecule.id, kind: "atom", atomId: nitrogen.id, distanceToPointer: 0
  }, "N");
  return { document: selectDocumentObjects(withNitrogen, withNitrogen.pages[0].id, []), nitrogenId: nitrogen.id };
}

describe.each(["macos", "windows"] as const)("typed element symbols become atoms (%s)", platform => {
  let container: HTMLDivElement;
  let root: Root;
  let originalPlatform: PropertyDescriptor | undefined;
  const captureMethods = ["setPointerCapture", "releasePointerCapture", "hasPointerCapture"] as const;
  let captureDescriptors: Array<PropertyDescriptor | undefined>;
  const editor = () => container.querySelector<HTMLTextAreaElement>(".text-object-editor");
  const snapshot = () => window.__CHEMDRAFT_AGENT__!.snapshot();
  const objects = () => snapshot().document.pages[0]!.objects;
  const molecules = () => objects().filter((object): object is MoleculeObject => object.type === "molecule");
  const texts = () => objects().filter(object => object.type === "text");
  const historyState = () => [
    container.querySelector("main")!.getAttribute("data-can-undo"),
    container.querySelector("main")!.getAttribute("data-can-redo")
  ];

  beforeEach(() => {
    (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    vi.stubGlobal("localStorage", new MemoryStorage());
    vi.stubGlobal("ResizeObserver", class { observe() {} unobserve() {} disconnect() {} });
    vi.stubGlobal("CSS", { escape: (value: string) => value });
    vi.spyOn(document, "hasFocus").mockReturnValue(true);
    originalPlatform = Object.getOwnPropertyDescriptor(navigator, "platform");
    Object.defineProperty(navigator, "platform", { configurable: true, value: platform === "windows" ? "Win32" : "MacIntel" });
    captureDescriptors = captureMethods.map(name => Object.getOwnPropertyDescriptor(HTMLElement.prototype, name));
    for (const name of captureMethods) {
      Object.defineProperty(HTMLElement.prototype, name, { configurable: true, value: name === "hasPointerCapture" ? () => false : () => {} });
    }
    window.history.replaceState(null, "", "/?agentBridge=1");
    container = document.createElement("div"); document.body.append(container); root = createRoot(container);
  });

  afterEach(async () => {
    await act(async () => root.unmount()); container.remove();
    captureMethods.forEach((name, index) => {
      const descriptor = captureDescriptors[index];
      if (descriptor) Object.defineProperty(HTMLElement.prototype, name, descriptor);
      else Reflect.deleteProperty(HTMLElement.prototype, name);
    });
    if (originalPlatform) Object.defineProperty(navigator, "platform", originalPlatform);
    else Reflect.deleteProperty(navigator, "platform");
    window.history.replaceState(null, "", "/"); delete window.__CHEMDRAFT_AGENT__;
    vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllGlobals();
  });

  async function mount(initialDocument: ChemDraftDocument = createPhase4Document("Typed atoms"), tool = "tool.text") {
    await act(async () => root.render(<MainWindow initialDocument={initialDocument}
      initialActiveToolCommandId={tool} initialPaletteMode="floating" nativePalette={false}
      initialRulersVisible={false} initialCrosshairsVisible={false} shortcutPlatform={platform} />));
    const rect = { x: 0, y: 0, left: 0, top: 0, right: 792, bottom: 612, width: 792, height: 612, toJSON: () => ({}) };
    for (const element of container.querySelectorAll<HTMLElement>(".page, .canvas-region")) {
      vi.spyOn(element, "getBoundingClientRect").mockReturnValue(rect);
    }
    const canvas = container.querySelector<HTMLElement>(".canvas-region")!;
    vi.spyOn(canvas, "clientWidth", "get").mockReturnValue(792);
    vi.spyOn(canvas, "clientHeight", "get").mockReturnValue(612);
  }

  async function pointer(type: string, point: { x: number; y: number }, target: Element, buttons = type === "pointerdown" ? 1 : 0) {
    const event = new MouseEvent(type, { bubbles: true, cancelable: true, button: 0, buttons, clientX: point.x, clientY: point.y });
    Object.defineProperties(event, { pointerId: { value: 1 }, pointerType: { value: "mouse" }, isPrimary: { value: true } });
    await act(async () => target.dispatchEvent(event));
    // jsdom omits pointerdown's native focus default; perform the allowed blur explicitly.
    if (type === "pointerdown" && !event.defaultPrevented && document.activeElement === editor() && target !== editor()) {
      await act(async () => editor()?.blur());
    }
  }

  async function click(target: Element, x: number, y: number) {
    await pointer("pointerdown", { x, y }, target);
    await pointer("pointerup", { x, y }, target);
    await act(async () => vi.advanceTimersByTimeAsync(100));
  }

  async function typeText(value: string) {
    expect(editor()).not.toBeNull();
    expect(document.activeElement).toBe(editor());
    await act(async () => {
      editor()!.dispatchEvent(new KeyboardEvent("keydown", { key: value[0], bubbles: true, cancelable: true }));
      // jsdom does not insert characters for keyboard defaults. Use the native value setter
      // and input event so React receives the same change as a browser text edit.
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(editor(), value);
      editor()!.dispatchEvent(new Event("input", { bubbles: true }));
    });
  }

  async function command(commandId: string) {
    await act(async () => { window.dispatchEvent(new CustomEvent(DOM_COMMAND_EVENT, { detail: { commandId } })); });
  }

  async function historyKey(redo = false) {
    const canvas = container.querySelector<HTMLElement>(".canvas-region")!;
    await act(async () => canvas.focus());
    await act(async () => canvas.dispatchEvent(new KeyboardEvent("keydown", {
      key: redo && platform === "windows" ? "y" : "z",
      metaKey: platform === "macos", ctrlKey: platform === "windows",
      shiftKey: redo && platform === "macos", bubbles: true, cancelable: true
    })));
  }

  /** Text tool: click empty canvas, type, and finish by clicking away on empty canvas. */
  async function typeOnEmptyCanvas(value: string, at = { x: 200, y: 300 }) {
    await click(container.querySelector(".page")!, at.x, at.y);
    await typeText(value);
    await click(container.querySelector(".page")!, 600, 520);
    expect(editor()).toBeNull();
  }

  it("turns Zn2+ typed on empty canvas into a zinc atom with charge +2, removed by one undo", async () => {
    await mount();
    expect(historyState()).toEqual(["false", "false"]);
    await typeOnEmptyCanvas("Zn2+");
    expect(texts()).toHaveLength(0);
    expect(molecules()).toHaveLength(1);
    expect(molecules()[0]!.atoms).toHaveLength(1);
    expect(molecules()[0]!.atoms[0]).toMatchObject({ element: "Zn", formalCharge: 2, labelLiteral: true });
    expect(molecules()[0]!.bonds).toHaveLength(0);
    const visual = container.querySelector(".molecule-object")!;
    expect(visual.getAttribute("data-atom-count")).toBe("1");
    expect(visual.getAttribute("data-structure")).toBe("[Zn+2]");
    // The charge is drawn as the atom label's superscript run, as for any charged atom.
    expect([...container.querySelectorAll('[data-atom-label-run="charge"]')].map(node => node.textContent)).toContain("2+");
    expect(container.querySelector('[role="status"]')?.textContent).toBe("Placed naked Zn2+ atom");
    await historyKey();
    expect(molecules()).toHaveLength(0);
    expect(texts()).toHaveLength(0);
    expect(historyState()).toEqual(["false", "true"]);
    await historyKey(true);
    expect(texts()).toHaveLength(0);
    expect(molecules().map(molecule => molecule.atoms)).toEqual([[expect.objectContaining({ element: "Zn", formalCharge: 2 })]]);
    expect(historyState()).toEqual(["true", "false"]);
  });

  it("reads a charge typed as superscript: Zn with a superscript 2+ becomes Zn2+", async () => {
    await mount();
    await click(container.querySelector(".page")!, 200, 300);
    await typeText("Zn2+");
    await act(async () => {
      editor()!.setSelectionRange(2, 4);
      editor()!.dispatchEvent(new KeyboardEvent("keyup", { key: "Shift", bubbles: true, cancelable: true }));
    });
    await command("text.script.superscript");
    expect(texts()[0]).toMatchObject({ text: "Zn2+", spans: [
      expect.objectContaining({ text: "Zn", script: "normal" }), expect.objectContaining({ text: "2+", script: "superscript" })
    ] });
    await click(container.querySelector(".page")!, 600, 520);
    expect(texts()).toHaveLength(0);
    expect(molecules().map(molecule => molecule.atoms)).toEqual([[expect.objectContaining({ element: "Zn", formalCharge: 2 })]]);
  });

  it.each([["Zn", "Zn", 0], ["Zn+2", "Zn", 2], ["Fe3+", "Fe", 3], ["Cl-", "Cl", -1], ["Na+", "Na", 1]] as const)(
    "turns '%s' into %s with charge %d", async (typed, element, charge) => {
      await mount();
      await typeOnEmptyCanvas(typed);
      expect(texts()).toHaveLength(0);
      expect(molecules().map(molecule => molecule.atoms)).toEqual([[expect.objectContaining({ element, formalCharge: charge })]]);
    }
  );

  it("draws a bond from the typed zinc atom to a ligand nitrogen and back from the nitrogen", async () => {
    const { document: initial, nitrogenId } = documentWithLigandNitrogen();
    await mount(initial);
    await typeOnEmptyCanvas("Zn2+", { x: 300, y: 300 });
    const zincMolecule = molecules().find(molecule => molecule.atoms.some(atom => atom.element === "Zn"))!;
    const zinc = zincMolecule.atoms[0]!;
    const ligand = molecules().find(molecule => molecule.atoms.some(atom => atom.id === nitrogenId))!;
    const nitrogen = ligand.atoms.find(atom => atom.id === nitrogenId)!;
    await command("tool.bond");
    const visualOf = (id: string) => container.querySelector(`[data-page-svg-object-visual="${id}"], [data-object-id="${id}"]`)!;
    await pointer("pointermove", zinc, visualOf(zincMolecule.id));
    await pointer("pointerdown", zinc, visualOf(zincMolecule.id));
    // The pressed object captures the pointer, so the move and release reach it, not the ligand.
    await pointer("pointermove", nitrogen, visualOf(zincMolecule.id), 1);
    await pointer("pointerup", nitrogen, visualOf(zincMolecule.id));
    const joined = molecules().find(molecule => molecule.atoms.some(atom => atom.element === "Zn"))!;
    const joinedZinc = joined.atoms.find(atom => atom.element === "Zn")!;
    const joinedNitrogen = joined.atoms.find(atom => atom.element === "N")!;
    expect(joinedZinc.formalCharge).toBe(2);
    expect(joined.bonds.some(bond =>
      [bond.fromAtomId, bond.toAtomId].sort().join() === [joinedZinc.id, joinedNitrogen.id].sort().join())).toBe(true);
    // And the reverse direction: undo the bond, then draw it from the nitrogen to the zinc.
    await historyKey();
    const zincAgain = molecules().find(molecule => molecule.atoms.some(atom => atom.element === "Zn"))!;
    const ligandAgain = molecules().find(molecule => molecule.atoms.some(atom => atom.id === nitrogenId))!;
    expect(zincAgain.id).not.toBe(ligandAgain.id);
    await pointer("pointermove", nitrogen, visualOf(ligandAgain.id));
    await pointer("pointerdown", nitrogen, visualOf(ligandAgain.id));
    await pointer("pointermove", zinc, visualOf(ligandAgain.id), 1);
    await pointer("pointerup", zinc, visualOf(ligandAgain.id));
    const rejoined = molecules().find(molecule => molecule.atoms.some(atom => atom.element === "Zn"))!;
    const rejoinedZinc = rejoined.atoms.find(atom => atom.element === "Zn")!;
    expect(rejoinedZinc.formalCharge).toBe(2);
    expect(rejoined.bonds.some(bond => [bond.fromAtomId, bond.toAtomId].includes(rejoinedZinc.id) &&
      [bond.fromAtomId, bond.toAtomId].includes(nitrogenId))).toBe(true);
  });

  it.each(["H2O", "hello", "CO2", "Xx", "zn", "Zn 2+", "Zn++", "Zn2+\nZn"])("keeps '%s' typed on empty canvas as text", async value => {
    await mount();
    await typeOnEmptyCanvas(value);
    expect(molecules()).toHaveLength(0);
    expect(texts()).toHaveLength(1);
    expect(texts()[0]).toMatchObject({ text: value });
  });

  it.each([
    ["bold, after typing", "text.bold", "after", { fontWeight: 700 }],
    ["red, after typing", "text.color.red", "after", { color: "#b3261e" }],
    // Formatting chosen with nothing selected sets the Text tool's style, so the next box is placed with it.
    ["bold, before placing it", "text.bold", "before", { fontWeight: 700 }],
    ["red, before placing it", "text.color.red", "before", { color: "#b3261e" }]
  ] as const)("keeps a whole text box formatted %s 'Na+' as text when finished", async (_label, commandId, when, style) => {
    await mount();
    if (when === "before") await command(commandId);
    await click(container.querySelector(".page")!, 200, 300);
    await typeText("Na+");
    if (when === "after") await command(commandId);
    expect(texts()).toHaveLength(1);
    // Formatted as a whole: the box's own style, not a run's.
    expect(texts()[0]).toMatchObject({ text: "Na+", style: expect.objectContaining(style) });
    if (texts()[0]!.type === "text") {
      for (const run of texts()[0]!.spans) expect(Object.keys(run.style)).toEqual([]);
    }
    await click(container.querySelector(".page")!, 600, 520);
    expect(editor()).toBeNull();
    expect(molecules()).toHaveLength(0);
    expect(texts()).toEqual([expect.objectContaining({ text: "Na+", style: expect.objectContaining(style) })]);
  });

  it("leaves a text 'Zn' in an opened document as text, even after it is opened for editing and finished unchanged", async () => {
    const opened = insertNativeTextObject(createPhase4Document("Opened"), { x: 220, y: 200 }, "Zn");
    await mount(selectDocumentObjects(opened, opened.pages[0].id, []), "tool.select");
    expect(texts()).toHaveLength(1);
    expect(molecules()).toHaveLength(0);
    await click(container.querySelector(".page")!, 600, 520);
    await command("tool.text");
    const glyph = container.querySelector(`[data-page-svg-object-visual="${texts()[0]!.id}"] text`)!;
    await click(glyph, 230, 208);
    expect(editor()).not.toBeNull();
    await click(container.querySelector(".page")!, 600, 520);
    expect(editor()).toBeNull();
    expect(molecules()).toHaveLength(0);
    expect(texts()).toEqual([expect.objectContaining({ text: "Zn" })]);
  });
});
