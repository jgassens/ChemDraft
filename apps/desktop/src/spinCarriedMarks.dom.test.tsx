// @vitest-environment jsdom
// The 1.2.3 repro end to end through MainWindow: paste aspirin, hover the carboxylate O and press
// '-', open Spin 3D. Before any drag the opening projection must already paint the circled minus
// beside the carboxylate O (on 1.2.3 it sat beside the ester O), the drag must carry it and its
// selection box, a click outside must commit it where it was painted, one undo must restore the
// drawing, and Copy As SMILES must not change. Also with the molecule selected WITHOUT the mark,
// and 3D clean-up and a typed X rotation of the stored model, which commit through other paths.
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { applyPatch, type ChemDraftDocument, type ElectronMarkObject, type MoleculeObject } from "@chemdraft/chem-core";
import { transformPointForObject } from "@chemdraft/layout-engine";
import { depictSmiles2D } from "@chemdraft/ocl-adapter";
import { ensureRdkit, rdkitConformerGenerator, resetRdkitForTesting, setRdkitModuleLoader } from "@chemdraft/rdkit-adapter";
import { MainWindow } from "./MainWindow";
import { writeClipboardText } from "./clipboard";
import {
  analysisFacingStructure, applyChargeToolAtNativeAtom, attachSpin3dModelFromConformer, createPhase4Document,
  insertNativeMolfileMolecule, normalizeCommittedDocument, selectDocumentObjects
} from "./documentWorkflow";
import { quatFromAxisAngle } from "./interaction/rotation3d";
import { installDomRdkitLoader } from "./testSupport/rdkitIdentity";
import { MemoryStorage } from "./testSupport/memoryStorage";
import { DOM_COMMAND_EVENT } from "./window-manager";

vi.mock("./rdkitWasmLoader", () => ({ registerRdkitWasmLoader: vi.fn() }));
vi.mock("./clipboard", async original => ({ ...await original<typeof import("./clipboard")>(), writeClipboardText: vi.fn() }));
// The desktop build embeds in a worker; stand in for it with the same seeded RDKit embed, so the
// spun geometry (and so the drag that crowds the mark) is the same on every run.
const conformerWorker = vi.hoisted(() => ({
  generate: vi.fn(), prefetch: vi.fn(), warmup: vi.fn(), refineWorkspaceSeed: vi.fn(async () => ({ status: "skipped" as const }))
}));
vi.mock("./conformerClient", async original => ({
  ...await original<typeof import("./conformerClient")>(), getConformerWorkerClient: () => conformerWorker
}));

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
class TestResizeObserver { observe() {} unobserve() {} disconnect() {} }

const aspirin = "CC(=O)Oc1ccccc1C(=O)O";
type ConformerSeed = { seed: number; optimize: "none" | "mmff94s" };
/** The first drag repro's embed. */
const dragReproSeed: ConformerSeed = { seed: 42, optimize: "none" };
/** On 1.2.3 (ca73ce95f) this embed's OPENING view drew the carboxylate O's '-' beside the ester O. */
const esterReproSeed: ConformerSeed = { seed: 44, optimize: "mmff94s" };
/** The seeded embed the stand-in worker returns. */
let conformerSeed: ConformerSeed = dragReproSeed;

function aspirinDrawing() {
  return insertNativeMolfileMolecule(createPhase4Document("Spin marks"), { x: 300, y: 300 }, depictSmiles2D(aspirin).molfile, "molfile-v2000");
}
const moleculeOf = (document: ChemDraftDocument) =>
  document.pages[0].objects.find((object): object is MoleculeObject => object.type === "molecule")!;
const marksOf = (document: ChemDraftDocument) =>
  document.pages[0].objects.filter((object): object is ElectronMarkObject => object.type === "electron-mark");
/** The carboxylate O: the last atom of this SMILES, singly bonded once. */
const acidOxygenOf = (molecule: MoleculeObject) => molecule.atoms[molecule.atoms.length - 1]!;
const centerOf = (mark: ElectronMarkObject) => ({ x: mark.x + mark.width / 2, y: mark.y + mark.height / 2 });

function expectBesideItsAtom(document: ChemDraftDocument, atomId: string, distance: number, label: string) {
  const molecule = moleculeOf(document);
  const [mark] = marksOf(document);
  const center = centerOf(mark!);
  const own = molecule.atoms.find(atom => atom.id === atomId)!;
  expect(mark!.anchor, label).toMatchObject({ kind: "atom", objectId: molecule.id, atomId });
  expect(Math.hypot(center.x - own.x, center.y - own.y), `${label}: distance from its atom`).toBeCloseTo(distance, 6);
  const nearest = [...molecule.atoms].sort((left, right) =>
    Math.hypot(left.x - center.x, left.y - center.y) - Math.hypot(right.x - center.x, right.y - center.y))[0]!;
  expect(nearest.id, `${label}: nearest atom to the mark`).toBe(atomId);
}

describe.each(["macos", "windows"] as const)("Spin 3D keeps the acid O's charge beside it (%s)", platform => {
  let container: HTMLDivElement, root: Root;
  const capture = { set: Element.prototype.setPointerCapture, release: Element.prototype.releasePointerCapture,
    has: Element.prototype.hasPointerCapture };
  beforeAll(async () => {
    installDomRdkitLoader();
    installDomRdkitLoader(setRdkitModuleLoader);
    await ensureRdkit();
  });
  afterAll(() => resetRdkitForTesting());
  beforeEach(() => {
    vi.stubGlobal("localStorage", new MemoryStorage());
    vi.stubGlobal("ResizeObserver", TestResizeObserver);
    vi.stubGlobal("CSS", { escape: (value: string) => value });
    // Rotation frames are pushed on requestAnimationFrame; run them on the next task.
    vi.spyOn(window, "requestAnimationFrame").mockImplementation(callback =>
      setTimeout(() => callback(performance.now()), 0) as unknown as number);
    Element.prototype.setPointerCapture = () => {};
    Element.prototype.releasePointerCapture = () => {};
    Element.prototype.hasPointerCapture = () => false;
    vi.mocked(writeClipboardText).mockReset().mockResolvedValue(true);
    conformerSeed = dragReproSeed;
    conformerWorker.generate.mockReset().mockImplementation((molfile: string, count: number, _options, _engine, handlers) => {
      void rdkitConformerGenerator.generate3DConformer({ molfile, originalAtomCount: count }, conformerSeed)
        .then(result => handlers.onEmbedded(result));
      return () => undefined;
    });
    window.history.replaceState(null, "", "/?agentBridge=1");
    container = document.createElement("div"); document.body.append(container);
    root = createRoot(container);
  });
  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
    window.history.replaceState(null, "", "/");
    delete window.__CHEMDRAFT_AGENT__;
    Element.prototype.setPointerCapture = capture.set;
    Element.prototype.releasePointerCapture = capture.release;
    Element.prototype.hasPointerCapture = capture.has;
    vi.restoreAllMocks(); vi.unstubAllGlobals();
  });

  const snapshot = () => window.__CHEMDRAFT_AGENT__!.snapshot().document;
  const status = () => container.querySelector("[data-status-message]")?.textContent ?? "";
  const overlay = () => container.querySelector<SVGSVGElement>("[data-spin3d-overlay]");
  const page = () => container.querySelector<HTMLElement>(".page")!;
  const command = (commandId: string) => act(async () => {
    window.dispatchEvent(new CustomEvent(DOM_COMMAND_EVENT, { detail: { commandId } }));
  });
  function pointer(target: EventTarget, type: string, x: number, y: number) {
    const event = new MouseEvent(type, { bubbles: true, cancelable: true, button: 0, buttons: type === "pointerup" ? 0 : 1, clientX: x, clientY: y });
    Object.defineProperties(event, { pointerId: { value: 1 }, isPrimary: { value: true }, pointerType: { value: "mouse" } });
    target.dispatchEvent(event);
  }
  async function mount(document: ChemDraftDocument) {
    const { width, height } = document.pages[0];
    const rect = { x: 0, y: 0, left: 0, top: 0, width, height, right: width, bottom: height, toJSON: () => ({}) };
    await act(async () => root.render(createElement(MainWindow, { initialDocument: document,
      initialActiveToolCommandId: "tool.select", initialPaletteMode: "hidden", nativePalette: true,
      initialRulersVisible: false, initialCrosshairsVisible: false, shortcutPlatform: platform })));
    page().getBoundingClientRect = () => rect;
    return rect;
  }
  async function pressMinusOnAcidOxygen() {
    const molecule = moleculeOf(snapshot());
    const oxygen = transformPointForObject(molecule, acidOxygenOf(molecule));
    await act(async () => pointer(page(), "pointermove", oxygen.x, oxygen.y));
    await act(async () => window.dispatchEvent(new KeyboardEvent("keydown", { key: "-", bubbles: true, cancelable: true })));
    expect(status()).toBe("Placed negative charge on hovered atom");
    const [mark] = marksOf(snapshot());
    // The mark joins the whole-selected molecule (#483), and Spin 3D takes them together.
    expect(snapshot().selection.objectIds).toEqual([molecule.id, mark!.id]);
    return mark!;
  }
  async function copySmiles() {
    vi.mocked(writeClipboardText).mockClear();
    await command("clipboard.copyAs.smiles");
    await act(async () => vi.waitFor(() => expect(writeClipboardText, status()).toHaveBeenCalledOnce()));
    return vi.mocked(writeClipboardText).mock.calls[0]![0];
  }

  /** Paste, '-' on the carboxylate O, Spin 3D (optionally a drag), click outside; checks every stage. */
  async function spinRepro({ seed, drag, moleculeOnly }: { seed: ConformerSeed; drag: boolean; moleculeOnly: boolean }) {
    conformerSeed = seed;
    let rect: Awaited<ReturnType<typeof mount>>;
    let mark: ElectronMarkObject;
    if (moleculeOnly) {
      // The molecule alone is selected, its '-' not: Spin 3D still carries the mark. (The mark is
      // placed by the call the hover key makes.)
      const plain = aspirinDrawing();
      const molecule = moleculeOf(plain);
      const charged = normalizeCommittedDocument(applyChargeToolAtNativeAtom(plain, { kind: "charge", charge: -1 },
        { kind: "atom", objectId: molecule.id, atomId: acidOxygenOf(molecule).id, distanceToPointer: 0 }));
      rect = await mount(selectDocumentObjects(charged, charged.pages[0].id, [molecule.id]));
      expect(snapshot().selection.objectIds).toEqual([molecule.id]);
      mark = marksOf(snapshot())[0]!;
    } else {
      rect = await mount(aspirinDrawing());
      mark = await pressMinusOnAcidOxygen();
    }
    const charged = snapshot();
    const acidOxygen = acidOxygenOf(moleculeOf(charged));
    const drawnDistance = Math.hypot(centerOf(mark).x - acidOxygen.x, centerOf(mark).y - acidOxygen.y);
    const smiles = await copySmiles();
    expect(smiles).toContain("[O-]");

    await command("structure.spin3d");
    await act(async () => vi.waitFor(() => expect(overlay(), status()).not.toBeNull()));
    const svg = overlay()!;
    svg.getBoundingClientRect = () => rect;
    // The page hides its own copy of the mark and its object view (with the selection box) …
    expect(container.querySelector(`[data-page-svg-object-visual="${mark.id}"]`)?.getAttribute("visibility")).toBe("hidden");
    expect(container.querySelector(`.charge-mark-object[data-object-id="${mark.id}"]`), "the mark's box at its old spot").toBeNull();
    // … and the overlay paints the mark, with a selection box only when the mark is selected.
    const painted = () => overlay()!.querySelector(`[data-spin3d-electron-mark="${mark.id}"]`)!;
    expect(painted()).not.toBeNull();
    expect(painted().querySelector(`[data-spin3d-mark-selection="${mark.id}"]`) !== null).toBe(!moleculeOnly);
    if (drag) {
      // Drag to turn: a left drag from the molecule's centre.
      const molecule = moleculeOf(charged);
      const center = { x: molecule.x + molecule.width / 2, y: molecule.y + molecule.height / 2 };
      await act(async () => pointer(svg, "pointerdown", center.x, center.y));
      const frame = () => new Promise(resolve => setTimeout(resolve, 5));
      await act(async () => { pointer(svg, "pointermove", center.x - 30, center.y); await frame(); });
      await act(async () => { pointer(svg, "pointermove", center.x - 60, center.y); await frame(); });
      await act(async () => pointer(svg, "pointerup", center.x - 60, center.y));
      expect(snapshot()).toBe(charged);
    }
    const [dx, dy] = painted().getAttribute("data-spin3d-mark-offset")!.split(" ").map(Number);
    // The selection box is painted inside the mark's group, so it moves with the mark.
    if (!moleculeOnly) expect(painted().getAttribute("transform")).toMatch(/^translate\(/);

    // Click outside: flatten.
    await act(async () => pointer(overlay()!, "pointerdown", 20, 20));
    await act(async () => vi.waitFor(() => expect(overlay(), status()).toBeNull()));
    expect(status()).toMatch(/^Flattened /);
    const flattened = snapshot();
    expect(moleculeOf(flattened).atoms).not.toEqual(moleculeOf(charged).atoms);
    expectBesideItsAtom(flattened, acidOxygen.id, drawnDistance, drag ? "after drag and flatten" : "flattened at the opening view");
    // Committed exactly where the overlay painted it: the overlay at the opening view (or after the
    // drag) drew the mark beside its own atom too.
    const committed = marksOf(flattened)[0]!;
    expect(committed.x - mark.x).toBeCloseTo(dx!, 6);
    expect(committed.y - mark.y).toBeCloseTo(dy!, 6);
    // The page draws it there, and its object view (selection box) is back at the committed spot.
    const circle = container.querySelector(`[data-page-svg-object-visual="${mark.id}"] circle[data-mark-kind="charge"]`)!;
    expect(Number(circle.getAttribute("cx"))).toBeCloseTo(centerOf(committed).x, 6);
    expect(Number(circle.getAttribute("cy"))).toBeCloseTo(centerOf(committed).y, 6);
    expect(container.querySelector(`.charge-mark-object[data-object-id="${mark.id}"]`)).not.toBeNull();
    // Chemistry unchanged: same SMILES, same anchor, same charge.
    expect(await copySmiles()).toBe(smiles);
    expect(committed.anchor).toEqual(mark.anchor);
    expect(committed.charge).toBe(mark.charge);

    // One undo restores molecule and mark together.
    await command("edit.undo");
    expect(moleculeOf(snapshot()).atoms).toEqual(moleculeOf(charged).atoms);
    expect(marksOf(snapshot())).toEqual(marksOf(charged));
  }

  it("repro: Spin 3D opens with the '-' beside the carboxylate O (not the ester O), before any drag; release keeps it; one undo restores",
    () => spinRepro({ seed: esterReproSeed, drag: false, moleculeOnly: false }));

  it("the same with only the molecule selected (the mark not selected)",
    () => spinRepro({ seed: esterReproSeed, drag: false, moleculeOnly: true }));

  it("repro: paste, '-' on the carboxylate O, Spin 3D, drag, click outside — the mark stays beside its O; one undo restores",
    () => spinRepro({ seed: dragReproSeed, drag: true, moleculeOnly: false }));

  it("a drag with only the molecule selected carries the unselected mark",
    () => spinRepro({ seed: esterReproSeed, drag: true, moleculeOnly: true }));

  it.each([37, 90])("a molecule turned %d° on the page: release stores the '-' at the page position the overlay painted it", async degrees => {
    conformerSeed = esterReproSeed;
    // Aspirin with its '-', the molecule turned on the page (its object rotation) and the mark turned
    // with it, bound to the carboxylate O. Only the molecule is selected.
    const plain = aspirinDrawing();
    const molecule = moleculeOf(plain);
    const acidOxygen = acidOxygenOf(molecule);
    const charged = normalizeCommittedDocument(applyChargeToolAtNativeAtom(plain, { kind: "charge", charge: -1 },
      { kind: "atom", objectId: molecule.id, atomId: acidOxygen.id, distanceToPointer: 0 }));
    const [drawnMark] = marksOf(charged);
    const turned = { ...moleculeOf(charged), rotation: degrees };
    const center = transformPointForObject(turned, centerOf(drawnMark!));
    let document = applyPatch(charged, { op: "updateObject", objectId: molecule.id, changes: { rotation: degrees } });
    document = normalizeCommittedDocument(applyPatch(document, { op: "updateObject", objectId: drawnMark!.id, changes: {
      x: center.x - drawnMark!.width / 2, y: center.y - drawnMark!.height / 2, atomAssociation: "explicit",
      anchor: { kind: "atom", objectId: molecule.id, atomId: acidOxygen.id }
    } }));
    const rect = await mount(selectDocumentObjects(document, document.pages[0].id, [molecule.id]));
    const mark = marksOf(snapshot())[0]!;
    const smiles = await copySmiles();
    await command("structure.spin3d");
    await act(async () => vi.waitFor(() => expect(overlay(), status()).not.toBeNull()));
    overlay()!.getBoundingClientRect = () => rect;
    const painted = overlay()!.querySelector(`[data-spin3d-electron-mark="${mark.id}"]`)!;
    const [dx, dy] = painted.getAttribute("data-spin3d-mark-offset")!.split(" ").map(Number);
    await act(async () => pointer(overlay()!, "pointerdown", 20, 20));
    await act(async () => vi.waitFor(() => expect(overlay(), status()).toBeNull()));
    expect(status()).toMatch(/^Flattened /);
    const flattened = snapshot();
    const committed = marksOf(flattened)[0]!;
    // The page position the overlay painted is the one stored.
    expect(committed.x).toBeCloseTo(mark.x + dx!, 6);
    expect(committed.y).toBeCloseTo(mark.y + dy!, 6);
    // Still turned, the mark beside its O where the page draws it, chemistry unchanged.
    const flatMolecule = moleculeOf(flattened);
    expect(flatMolecule.rotation).toBe(degrees);
    const oxygen = transformPointForObject(flatMolecule, flatMolecule.atoms.find(atom => atom.id === acidOxygen.id)!);
    const drawnOxygen = transformPointForObject(turned, acidOxygen);
    expect(Math.hypot(centerOf(committed).x - oxygen.x, centerOf(committed).y - oxygen.y))
      .toBeCloseTo(Math.hypot(centerOf(mark).x - drawnOxygen.x, centerOf(mark).y - drawnOxygen.y), 6);
    expect(committed.anchor).toEqual(mark.anchor);
    expect(committed.charge).toBe(mark.charge);
    expect(await copySmiles()).toBe(smiles);
  });

  it("3D clean-up carries the charge with its O and undoes in one step", async () => {
    const plain = aspirinDrawing();
    const molecule = moleculeOf(plain);
    const bent = normalizeCommittedDocument(applyPatch(plain, { op: "updateObject", objectId: molecule.id, changes: {
      atoms: molecule.atoms.map((atom, index) => ({ ...atom, x: atom.x + (index % 3) * 7, y: atom.y - (index % 2) * 9 }))
    } }));
    await mount(bent);
    const mark = await pressMinusOnAcidOxygen();
    const charged = snapshot();
    const acidOxygen = acidOxygenOf(moleculeOf(charged));
    const drawnDistance = Math.hypot(centerOf(mark).x - acidOxygen.x, centerOf(mark).y - acidOxygen.y);
    const smiles = await copySmiles();
    await command("structure.cleanup3d");
    await act(async () => vi.waitFor(() => expect(status()).toMatch(/^Rebuilt a clean 2D layout/)));
    const cleaned = snapshot();
    const moved = moleculeOf(cleaned).atoms.find(atom => atom.id === acidOxygen.id)!;
    expect(Math.hypot(moved.x - acidOxygen.x, moved.y - acidOxygen.y)).toBeGreaterThan(1);
    expectBesideItsAtom(cleaned, acidOxygen.id, drawnDistance, "after 3D clean-up");
    expect(await copySmiles()).toBe(smiles);
    await command("edit.undo");
    expect(moleculeOf(snapshot()).atoms).toEqual(moleculeOf(charged).atoms);
    expect(marksOf(snapshot())).toEqual(marksOf(charged));
  });

  it("a typed X rotation of the stored model carries the charge and undoes in one step", async () => {
    const plain = aspirinDrawing();
    const molecule = moleculeOf(plain);
    const coords3d = (await rdkitConformerGenerator.generate3DConformer(
      { molfile: analysisFacingStructure(molecule).structure }, { seed: 42, optimize: "none" }
    )).mapping.coords3dByOriginalAtom.slice(0, molecule.atoms.length * 3);
    // A molecule already spun once (its stored model reopens at the committed orientation), with a
    // '-' on the acid O; X/Y rotation acts on the molecule alone.
    const acidOxygen = acidOxygenOf(molecule);
    const modeled = attachSpin3dModelFromConformer(normalizeCommittedDocument(applyChargeToolAtNativeAtom(plain,
      { kind: "charge", charge: -1 }, { kind: "atom", objectId: molecule.id, atomId: acidOxygen.id, distanceToPointer: 0 })),
    molecule.id, { coords3d, orientation: quatFromAxisAngle([1, 0, 0], 0) });
    const [mark] = marksOf(modeled);
    const drawnDistance = Math.hypot(centerOf(mark!).x - acidOxygen.x, centerOf(mark!).y - acidOxygen.y);
    await mount(selectDocumentObjects(modeled, modeled.pages[0].id, [molecule.id]));
    await act(async () => window.dispatchEvent(new KeyboardEvent("keydown", { key: "Shift", shiftKey: true, bubbles: true })));
    const handle = container.querySelector<HTMLElement>("[data-selection-tilt3d-handle]");
    expect(handle, status()).not.toBeNull();
    await act(async () => { handle!.dispatchEvent(new MouseEvent("dblclick", { bubbles: true, cancelable: true })); });
    const form = container.querySelector<HTMLFormElement>('[data-rotation-input-kind="xy"]')!;
    expect(form).not.toBeNull();
    const x = form.querySelector<HTMLInputElement>('input[aria-label="X rotation degrees"]')!;
    const before = snapshot();
    for (let attempt = 0; attempt < 20 && snapshot() === before; attempt += 1) {
      await act(async () => {
        Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(x, "60");
        x.dispatchEvent(new Event("input", { bubbles: true }));
      });
      await act(async () => { form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })); });
      // The synchronous commit waits for the stereo reader to load once.
      if (snapshot() === before) await act(async () => { await new Promise(resolve => setTimeout(resolve, 50)); });
    }
    const rotated = snapshot();
    expect(rotated, status()).not.toBe(before);
    expect(moleculeOf(rotated).atoms).not.toEqual(moleculeOf(before).atoms);
    expectBesideItsAtom(rotated, acidOxygen.id, drawnDistance, "after typed X60");
    await command("edit.undo");
    expect(moleculeOf(snapshot()).atoms).toEqual(moleculeOf(before).atoms);
    expect(marksOf(snapshot())).toEqual(marksOf(before));
  });
});
