// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { applyPatches, type DocumentObject, type MoleculeObject } from "@chemdraft/chem-core";
import { moleculeLayoutLabelBoxes, nativeMoleculeRings } from "@chemdraft/layout-engine";
import { depictSmiles2D, ensureOclResources } from "@chemdraft/ocl-adapter";
import type { ShortcutPlatform } from "@chemdraft/shortcut-engine";
import { documentZoomCommandId } from "./documentZoom";
import {
  applyReactionArrowToolAtPoint, createPhase4Document, documentObjectVisualBounds, getSelectedMolecule, insertSmilesMolecule,
  selectDocumentObjects
} from "./documentWorkflow";
import { MainWindow } from "./MainWindow";
import { CONTEXT_STEREO_DEADLINE_MS, loadStereoEngine, resetStereoEngineForTests } from "./stereoReadout";
import { MemoryStorage } from "./testSupport/memoryStorage";
import { DOM_COMMAND_EVENT } from "./window-manager";

vi.mock("./rdkitWasmLoader", () => ({ registerRdkitWasmLoader: vi.fn() }));
vi.mock("@scena/react-ruler", () => ({ default: () => <canvas /> }));

const IBUPROFEN = "CC(C)Cc1ccc(cc1)[C@H](C)C(=O)O";
type Point = { x: number; y: number };
type Zoom = 50 | 100 | 200;
let container: HTMLDivElement;
let root: Root;
let page: HTMLElement;
let scale: number;
const origin = { x: 40, y: 30 };

const captureMethods = ["setPointerCapture", "releasePointerCapture", "hasPointerCapture"] as const;
const missingCaptureMethods = captureMethods.filter(name => !(name in Element.prototype));
beforeAll(async () => {
  for (const name of missingCaptureMethods) {
    Object.defineProperty(Element.prototype, name, { configurable: true, value: () => false });
  }
  await ensureOclResources();
  await loadStereoEngine();
});
afterAll(() => {
  for (const name of missingCaptureMethods) Reflect.deleteProperty(Element.prototype, name);
});
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("localStorage", new MemoryStorage());
  vi.stubGlobal("CSS", { escape: (value: string) => value });
  vi.stubGlobal("ResizeObserver", class { observe() {} unobserve() {} disconnect() {} });
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

async function mount(smiles = IBUPROFEN, {
  selected = false, platform = "windows", zoom = 100, labelFontSize, overlay
}: { selected?: boolean; platform?: ShortcutPlatform; zoom?: Zoom; labelFontSize?: number;
  overlay?: (drawing: ReturnType<typeof createPhase4Document>, molecule: MoleculeObject) => ReturnType<typeof createPhase4Document>;
} = {}) {
  let drawing = insertSmilesMolecule(createPhase4Document("Context stereo"), { x: 220, y: 170 }, depictSmiles2D(smiles), smiles);
  if (labelFontSize) {
    const molecule = getSelectedMolecule(drawing)!;
    drawing = applyPatches(drawing, [{ op: "updateObject", objectId: molecule.id, changes: {
      style: { ...molecule.style, atomLabelFontSizePx: labelFontSize }
    } }]);
  }
  const molecule = getSelectedMolecule(drawing)!;
  drawing = selected ? drawing : selectDocumentObjects(drawing, drawing.pages[0].id, []);
  await act(async () => root.render(<MainWindow
    initialDocument={overlay ? overlay(drawing, molecule) : drawing}
    initialActiveToolCommandId="tool.select" initialPaletteMode="hidden" nativePalette={false}
    initialCrosshairsVisible={false} initialRulersVisible={false} shortcutPlatform={platform}
  />));
  page = container.querySelector<HTMLElement>(".page")!;
  const stage = container.querySelector<HTMLElement>(".page-stage")!;
  scale = Number(stage.style.getPropertyValue("--page-scale"));
  page.getBoundingClientRect = () => new DOMRect(origin.x, origin.y, 792 * scale, 612 * scale);
  const canvas = container.querySelector<HTMLElement>(".canvas-region")!;
  canvas.getBoundingClientRect = () => new DOMRect(0, 0, 792, 612);
  Object.defineProperties(canvas, { clientWidth: { value: 792 }, clientHeight: { value: 612 } });
  canvas.focus();
  if (zoom !== 100) {
    await act(async () => window.dispatchEvent(new CustomEvent(DOM_COMMAND_EVENT, {
      detail: { commandId: documentZoomCommandId(zoom) }
    })));
  }
  scale = Number(stage.style.getPropertyValue("--page-scale"));
  expect(scale).toBe(zoom / 100);
  return molecule;
}

const renderedMolecule = (molecule: MoleculeObject) =>
  page.querySelector<HTMLElement>(`.native-molecule-object[data-object-id="${molecule.id}"]`)!;
const atomTarget = (molecule: MoleculeObject, id: string) =>
  renderedMolecule(molecule).querySelector(`[data-atom-id="${id}"][data-hit-target="atom"]`)!;
const bondTarget = (molecule: MoleculeObject, id: string) =>
  renderedMolecule(molecule).querySelector(`[data-bond-id="${id}"][data-hit-target="bond"]`)!;

async function clickAt(point: Point, { target = page as Element, button = 2, ctrlKey = false, shiftKey = false, context = true } = {}) {
  // On the page, or a selection handle drawn beside it (outside its paint clip) on the same board.
  expect(page.closest(".document-board")!.contains(target)).toBe(true);
  const mouse = { bubbles: true, cancelable: true, clientX: origin.x + point.x * scale,
    clientY: origin.y + point.y * scale, button, ctrlKey, shiftKey };
  await act(async () => {
    for (const type of ["pointerdown", "pointerup"]) {
      target.dispatchEvent(new PointerEvent(type, {
        ...mouse, buttons: type === "pointerdown" ? (button === 2 ? 2 : 1) : 0,
        pointerId: 13, pointerType: "mouse", isPrimary: true
      }));
    }
    if (context) target.dispatchEvent(new MouseEvent("contextmenu", mouse));
  });
}

const objectMenu = () => container.querySelector('[aria-label="Object layer options"]');
const pageMenu = () => container.querySelector('[aria-label="Page options"]');
const stereoRows = () => [...(objectMenu()?.querySelectorAll(".object-context-menu-title") ?? [])]
  .map(row => row.textContent).filter(label => /^(Stereocenter|Double bond): /.test(label ?? ""));
const rotateItem = () => objectMenu()?.querySelector('[data-command-id="layout.rotateMolecule"]');

function selectRingInspector() {
  return act(async () => window.dispatchEvent(new CustomEvent(DOM_COMMAND_EVENT, {
    detail: { commandId: "view.toggleRingInspector" }
  })));
}

function incidentBondClick(molecule: MoleculeObject, center: MoleculeObject["atoms"][number]) {
  const bond = molecule.bonds.find(bond => bond.fromAtomId === center.id || bond.toAtomId === center.id)!;
  const other = molecule.atoms.find(atom => atom.id === (bond.fromAtomId === center.id ? bond.toAtomId : bond.fromAtomId))!;
  const length = Math.hypot(other.x - center.x, other.y - center.y);
  return {
    point: { x: center.x + (other.x - center.x) * 12 / length, y: center.y + (other.y - center.y) * 12 / length },
    target: bondTarget(molecule, bond.id)
  };
}

function pointNearDoubleBond(molecule: MoleculeObject, offset: number) {
  const bond = molecule.bonds.find(bond => bond.order === "double")!;
  const from = molecule.atoms.find(atom => atom.id === bond.fromAtomId)!;
  const to = molecule.atoms.find(atom => atom.id === bond.toAtomId)!;
  const length = Math.hypot(to.x - from.x, to.y - from.y);
  return {
    x: (from.x + to.x) / 2 + (to.y - from.y) * offset / (length * scale),
    y: (from.y + to.y) / 2 - (to.x - from.x) * offset / (length * scale)
  };
}

it.each<ShortcutPlatform>(["macos", "windows"])("shows R/S on an exact right-click on %s", async platform => {
  const molecule = await mount(IBUPROFEN, { platform });
  const atom = molecule.atoms[10]!;
  await clickAt(atom, { target: atomTarget(molecule, atom.id) });
  expect(stereoRows()).toEqual(["Stereocenter: S"]);
});

it.each([50, 100, 200].flatMap(zoom => [5, 10].map(offset => [zoom as Zoom, offset] as const)))(
  "shows R/S at %s%% zoom and %s screen pixels from the stereocenter", async (zoom, offset) => {
    const molecule = await mount(IBUPROFEN, { zoom });
    const center = molecule.atoms[10]!;
    const catcher = atomTarget(molecule, center.id);
    const target = offset / scale <= Number(catcher.getAttribute("r")) ? catcher : page;
    await clickAt({ x: center.x, y: center.y + offset / scale }, { target });
    expect(stereoRows()).toEqual(["Stereocenter: S"]);
  }
);

it("shows R/S through the painted stereocenter label", async () => {
  const molecule = await mount("[29Si@](F)(Cl)(Br)I", { labelFontSize: 28 });
  const center = molecule.atoms.find(atom => atom.element === "Si")!;
  const box = moleculeLayoutLabelBoxes(molecule).find(box => molecule.atoms[box.atom]?.id === center.id)!;
  const label = renderedMolecule(molecule).querySelector('[data-atom-label*="Si"] [data-atom-label-run]')!;
  expect(label).not.toBeNull();
  const x = box.x < center.x - 11 ? center.x - 11 : center.x + 11;
  expect(x).toBeGreaterThan(box.x);
  expect(x).toBeLessThan(box.x + box.width);
  expect(center.y).toBeGreaterThan(box.y);
  expect(center.y).toBeLessThan(box.y + box.height);
  await clickAt({ x, y: center.y }, { target: label });
  expect(stereoRows()).toEqual([expect.stringMatching(/^Stereocenter: [RS]$/)]);
});

it("shows R/S over the first part of an incident bond", async () => {
  const molecule = await mount();
  const { point, target } = incidentBondClick(molecule, molecule.atoms[10]!);
  await clickAt(point, { target });
  expect(stereoRows()).toEqual(["Stereocenter: S"]);
});

it("keeps Rotate molecule and the R/S row for a selected molecule on Windows", async () => {
  const molecule = await mount(IBUPROFEN, { selected: true });
  const center = molecule.atoms[10]!;
  await clickAt({ x: center.x, y: center.y + 10 });
  expect(stereoRows()).toEqual(["Stereocenter: S"]);
  expect(rotateItem()?.textContent).toBe("Rotate molecule…");
});

it("keeps the selected molecule on a macOS Ctrl+click near the stereocenter", async () => {
  const molecule = await mount(IBUPROFEN, { selected: true, platform: "macos" });
  const center = molecule.atoms[10]!;
  await clickAt({ x: center.x, y: center.y + 10 }, { button: 0, ctrlKey: true });
  expect(stereoRows()).toEqual(["Stereocenter: S"]);
  expect(rotateItem()).not.toBeNull();
});

it("keeps the selected atom on a macOS Ctrl+click over an incident bond", async () => {
  const molecule = await mount(IBUPROFEN, { platform: "macos" });
  const center = molecule.atoms[10]!;
  await clickAt(center, { button: 0, context: false, target: atomTarget(molecule, center.id) });
  expect(renderedMolecule(molecule).getAttribute("data-selected-native-atom-id")).toBe(center.id);
  const { point, target } = incidentBondClick(molecule, center);
  await clickAt(point, { button: 0, ctrlKey: true, target });
  expect(stereoRows()).toEqual(["Stereocenter: S"]);
  expect(objectMenu()?.getAttribute("data-context-target-kind")).toBe("atom");
});

it("opens the selection menu in the empty middle of a selected ring molecule", async () => {
  const molecule = await mount("c1ccccc1", { selected: true });
  await clickAt(nativeMoleculeRings(molecule)[0]!.center);
  expect(pageMenu()).toBeNull();
  expect(objectMenu()?.getAttribute("data-context-object-id")).toBe(molecule.id);
  expect(objectMenu()?.querySelector('[data-command-id="clipboard.copy"]')).not.toBeNull();
});

it("keeps a ring-part selection when right-clicking its empty middle", async () => {
  const molecule = await mount("c1ccccc1");
  const ring = nativeMoleculeRings(molecule)[0]!;
  await selectRingInspector();
  await clickAt(ring.center, { button: 0, context: false, target: page.querySelector(`[data-ring-hit-key="${ring.ringKey}"]`)! });
  expect(renderedMolecule(molecule).getAttribute("data-selected-native-ring-key")).toBe(ring.ringKey);
  await clickAt(ring.center);
  expect(objectMenu()?.getAttribute("data-context-target-kind")).toBe("ring");
  expect(renderedMolecule(molecule).getAttribute("data-selected-native-ring-key")).toBe(ring.ringKey);
});

it.each(["atom", "bond"] as const)("opens the unselected overlay %s menu over a selected ring", async kind => {
  let foreground!: MoleculeObject;
  await mount("c1ccccc1", { selected: true, overlay: (drawing, background) => {
    const smiles = kind === "atom" ? "O" : "CC";
    const withForeground = insertSmilesMolecule(drawing, nativeMoleculeRings(background)[0]!.center, depictSmiles2D(smiles), smiles);
    foreground = getSelectedMolecule(withForeground)!;
    return selectDocumentObjects(withForeground, drawing.pages[0].id, [background.id]);
  } });
  const [first, second] = foreground.atoms;
  const point = kind === "atom" ? first! : { x: (first!.x + second!.x) / 2, y: (first!.y + second!.y) / 2 };
  const target = kind === "atom" ? atomTarget(foreground, first!.id) : bondTarget(foreground, foreground.bonds[0]!.id);
  await clickAt(point, { target });
  expect(objectMenu()?.getAttribute("data-context-object-id")).toBe(foreground.id);
  expect(objectMenu()?.getAttribute("data-context-target-kind")).toBe(kind);
});

it("opens the selection menu for a selected atom inside a selected ring part", async () => {
  let foreground!: MoleculeObject;
  const background = await mount("c1ccccc1", { overlay: (drawing, ringMolecule) => {
    const center = nativeMoleculeRings(ringMolecule)[0]!.center;
    const withForeground = insertSmilesMolecule(drawing, { x: center.x + 9, y: center.y }, depictSmiles2D("O"), "O");
    foreground = getSelectedMolecule(withForeground)!;
    return selectDocumentObjects(withForeground, drawing.pages[0].id, []);
  } });
  await selectRingInspector();
  const ring = nativeMoleculeRings(background)[0]!;
  await clickAt({ x: ring.center.x - 7, y: ring.center.y }, {
    button: 0, context: false, target: renderedMolecule(background).querySelector(`[data-ring-hit-key="${ring.ringKey}"]`)!
  });
  const atom = foreground.atoms[0]!;
  const atomCatcher = atomTarget(foreground, atom.id);
  await clickAt(atom, { button: 0, context: false, shiftKey: true, target: atomCatcher });
  expect(renderedMolecule(background).getAttribute("data-selected-native-ring-key")).toBe(ring.ringKey);
  expect(renderedMolecule(foreground).getAttribute("data-selected-native-atom-id")).toBe(atom.id);

  await clickAt(atom, { target: atomTarget(foreground, atom.id) });
  expect(objectMenu()?.getAttribute("data-context-object-id")).toBe(foreground.id);
  expect(objectMenu()?.getAttribute("data-context-target-kind")).toBe("atom");
  expect(objectMenu()?.querySelector('[data-command-id="clipboard.copy"]')).not.toBeNull();
  expect(renderedMolecule(background).getAttribute("data-selected-native-ring-key")).toBe(ring.ringKey);
  expect(renderedMolecule(foreground).getAttribute("data-selected-native-atom-id")).toBe(atom.id);
});

it("uses the topmost selected whole object when two selection boxes overlap over bare paper", async () => {
  let foreground!: MoleculeObject;
  const background = await mount("c1ccccc1", { overlay: (drawing, ringMolecule) => {
    const withForeground = insertSmilesMolecule(drawing, nativeMoleculeRings(ringMolecule)[0]!.center,
      depictSmiles2D("c1ccccc1"), "c1ccccc1");
    foreground = getSelectedMolecule(withForeground)!;
    return selectDocumentObjects(withForeground, drawing.pages[0].id, [ringMolecule.id, foreground.id]);
  } });
  await clickAt(nativeMoleculeRings(background)[0]!.center);
  expect(objectMenu()?.getAttribute("data-context-object-id")).toBe(foreground.id);
});

it("uses the topmost selected part when two part boxes overlap over bare paper", async () => {
  let foreground!: MoleculeObject;
  const background = await mount("O", { overlay: (drawing, firstMolecule) => {
    const firstAtom = firstMolecule.atoms[0]!;
    const withForeground = insertSmilesMolecule(drawing, { x: firstAtom.x + 22, y: firstAtom.y }, depictSmiles2D("O"), "O");
    foreground = getSelectedMolecule(withForeground)!;
    return selectDocumentObjects(withForeground, drawing.pages[0].id, []);
  } });
  const first = background.atoms[0]!;
  const second = foreground.atoms[0]!;
  await clickAt(first, { button: 0, context: false, target: atomTarget(background, first.id) });
  await clickAt(second, { button: 0, context: false, shiftKey: true, target: atomTarget(foreground, second.id) });
  expect(renderedMolecule(background).getAttribute("data-selected-native-atom-id")).toBe(first.id);
  expect(renderedMolecule(foreground).getAttribute("data-selected-native-atom-id")).toBe(second.id);

  await clickAt({ x: (first.x + second.x) / 2, y: first.y });
  expect(objectMenu()?.getAttribute("data-context-object-id")).toBe(foreground.id);
});

it("uses the 14 px stereo reach of the top object over a selected ring", async () => {
  let foreground!: MoleculeObject;
  const background = await mount("c1ccccc1", { selected: true, zoom: 200, overlay: (drawing, ringMolecule) => {
    const withForeground = insertSmilesMolecule(drawing, nativeMoleculeRings(ringMolecule)[0]!.center,
      depictSmiles2D("C/C=C/C"), "C/C=C/C");
    foreground = getSelectedMolecule(withForeground)!;
    return selectDocumentObjects(withForeground, drawing.pages[0].id, [ringMolecule.id]);
  } });
  const point = pointNearDoubleBond(foreground, 10);
  const { center } = nativeMoleculeRings(background)[0]!;
  expect(Math.hypot(point.x - center.x, point.y - center.y)).toBeLessThan(10);
  await clickAt(point);
  expect(objectMenu()?.getAttribute("data-context-object-id")).toBe(foreground.id);
  expect(stereoRows()).toEqual(["Double bond: E"]);
});

it.each(["pointerleave", "pointerdown", "Escape"] as const)("discards a pending bare-paper stereo menu on %s", async cancel => {
  const engine = await loadStereoEngine();
  let finishLoading!: () => void;
  const pendingEngine = new Promise<typeof engine>(resolve => { finishLoading = () => resolve(engine); });
  resetStereoEngineForTests();
  try {
    void loadStereoEngine(() => pendingEngine);
    const molecule = await mount("C/C=C/C", { zoom: 200 });
    await clickAt(pointNearDoubleBond(molecule, 10));
    expect(objectMenu()).toBeNull();
    expect(pageMenu()).toBeNull();
    await act(async () => {
      if (cancel === "pointerleave") {
        page.dispatchEvent(new PointerEvent("pointerout", { bubbles: true, relatedTarget: page.closest(".canvas-region") }));
      } else if (cancel === "pointerdown") {
        container.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, button: 0, buttons: 1 }));
      } else {
        document.activeElement!.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, key: "Escape" }));
      }
      finishLoading();
    });
    expect(objectMenu()).toBeNull();
    expect(pageMenu()).toBeNull();
  } finally {
    finishLoading();
    resetStereoEngineForTests();
    await loadStereoEngine();
  }
});

// Review (1.2.3 RC5): a stereo engine import that never settles must not leave right-click without
// a menu, and must not keep later right-clicks from using the engine once it does load.
it.each<ShortcutPlatform>(["macos", "windows"])("opens the ordinary menu when the stereo engine misses its deadline on %s", async platform => {
  const engine = await loadStereoEngine();
  let finishLoading!: () => void;
  const pendingEngine = new Promise<typeof engine>(resolve => { finishLoading = () => resolve(engine); });
  resetStereoEngineForTests();
  const press = platform === "macos" ? { button: 0, ctrlKey: true } : {};
  const escape = () => act(async () => {
    document.activeElement!.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, key: "Escape" }));
  });
  const advance = (ms: number) => act(async () => { vi.advanceTimersByTime(ms); });
  try {
    void loadStereoEngine(() => pendingEngine);
    const molecule = await mount("C/C=C/C", { zoom: 200, platform });
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const point = pointNearDoubleBond(molecule, 10);

    // A cancelled opening stays closed past the deadline.
    await clickAt(point, press);
    await escape();
    await advance(CONTEXT_STEREO_DEADLINE_MS);
    expect(objectMenu()).toBeNull();
    expect(pageMenu()).toBeNull();

    await clickAt(point, press);
    await advance(CONTEXT_STEREO_DEADLINE_MS - 1);
    expect(objectMenu()).toBeNull();
    expect(pageMenu()).toBeNull();
    await advance(1);
    expect(pageMenu()).not.toBeNull();
    expect(objectMenu()).toBeNull();

    // The engine's late answer leaves the open menu alone.
    await act(async () => finishLoading());
    expect(pageMenu()).not.toBeNull();
    expect(objectMenu()).toBeNull();

    // The next right-click uses the engine, and its deadline never fires afterwards.
    await escape();
    expect(pageMenu()).toBeNull();
    await clickAt(point, press);
    expect(objectMenu()?.getAttribute("data-context-target-kind")).toBe("bond");
    expect(stereoRows()).toEqual(["Double bond: E"]);
    await advance(CONTEXT_STEREO_DEADLINE_MS);
    expect(pageMenu()).toBeNull();
    expect(stereoRows()).toEqual(["Double bond: E"]);
  } finally {
    vi.useRealTimers();
    finishLoading();
    resetStereoEngineForTests();
    await loadStereoEngine();
  }
});

// CodeRabbit (1.2.3 RC5): a selection change while the descriptor is pending, with the document
// unchanged, must not open a menu built from the selection captured at the press.
it.each([false, true])("opens a pending stereo menu only from the live ring selection (cleared: %s)", async cleared => {
  const molecule = await mount("C[C@H]1CCCO1");
  const ring = nativeMoleculeRings(molecule)[0]!;
  const center = molecule.atoms[1]!;
  expect(ring.atomIds).toContain(center.id);
  // Bare paper 11 screen pixels from the stereocenter (past its 8 px atom reach, inside the 14 px
  // stereo reach), on the side away from its three bonds.
  const away = molecule.bonds.filter(bond => bond.fromAtomId === center.id || bond.toAtomId === center.id)
    .map(bond => molecule.atoms.find(atom => atom.id === (bond.fromAtomId === center.id ? bond.toAtomId : bond.fromAtomId))!)
    .reduce((sum, atom) => {
      const length = Math.hypot(atom.x - center.x, atom.y - center.y);
      return { x: sum.x - (atom.x - center.x) / length, y: sum.y - (atom.y - center.y) / length };
    }, { x: 0, y: 0 });
  const awayLength = Math.hypot(away.x, away.y);
  const point = { x: center.x + away.x * 11 / (awayLength * scale), y: center.y + away.y * 11 / (awayLength * scale) };

  await selectRingInspector();
  await clickAt(ring.center, { button: 0, context: false, target: page.querySelector(`[data-ring-hit-key="${ring.ringKey}"]`)! });
  expect(renderedMolecule(molecule).getAttribute("data-selected-native-ring-key")).toBe(ring.ringKey);

  const engine = await loadStereoEngine();
  let finishLoading!: () => void;
  const pendingEngine = new Promise<typeof engine>(resolve => { finishLoading = () => resolve(engine); });
  resetStereoEngineForTests();
  try {
    void loadStereoEngine(() => pendingEngine);
    await clickAt(point);
    expect(objectMenu()).toBeNull();
    expect(pageMenu()).toBeNull();
    // Closing the Rings toolbar clears the ring part without touching the document.
    if (cleared) await selectRingInspector();
    expect(renderedMolecule(molecule).getAttribute("data-selected-native-ring-key")).toBe(cleared ? null : ring.ringKey);
    await act(async () => finishLoading());
    if (cleared) {
      expect(objectMenu()).toBeNull();
      expect(renderedMolecule(molecule).getAttribute("data-selected-native-ring-key")).toBeNull();
    } else {
      expect(objectMenu()?.getAttribute("data-context-target-kind")).toBe("ring");
      expect(stereoRows()).toHaveLength(1);
    }
  } finally {
    finishLoading();
    resetStereoEngineForTests();
    await loadStereoEngine();
  }
});

it.each([false, true])("shows E/Z near the middle of a stereo double bond (bond selected: %s)", async selected => {
  const molecule = await mount("C/C=C/C", { zoom: 200 });
  const bond = molecule.bonds.find(bond => bond.order === "double")!;
  if (selected) {
    await clickAt(pointNearDoubleBond(molecule, 0), { button: 0, context: false, target: bondTarget(molecule, bond.id) });
    expect(renderedMolecule(molecule).getAttribute("data-selected-native-bond-id")).toBe(bond.id);
  }
  await clickAt(pointNearDoubleBond(molecule, 10));
  expect(stereoRows()).toEqual(["Double bond: E"]);
  expect(objectMenu()?.getAttribute("data-context-target-kind")).toBe("bond");
});

it("picks the nearest of two stereocenters within reach", async () => {
  const molecule = await mount("N[C@@H](C)[C@H](F)Cl");
  const left = molecule.atoms[1]!;
  const right = molecule.atoms[3]!;
  const connecting = molecule.bonds.find(bond => [bond.fromAtomId, bond.toAtomId].includes(left.id) &&
    [bond.fromAtomId, bond.toAtomId].includes(right.id))!;
  const length = Math.hypot(right.x - left.x, right.y - left.y);
  expect(length - 9).toBeLessThan(14);
  await clickAt({ x: left.x + (right.x - left.x) * 9 / length, y: left.y + (right.y - left.y) * 9 / length },
    { target: bondTarget(molecule, connecting.id) });
  expect(stereoRows()).toEqual(["Stereocenter: S"]);
  await clickAt({ x: right.x + (left.x - right.x) * 9 / length, y: right.y + (left.y - right.y) * 9 / length },
    { target: bondTarget(molecule, connecting.id) });
  expect(stereoRows()).toEqual(["Stereocenter: R"]);
});

it("omits stereo near a non-stereogenic atom", async () => {
  const molecule = await mount();
  const atom = molecule.atoms[0]!;
  await clickAt({ x: atom.x, y: atom.y + 5 }, { target: renderedMolecule(molecule) });
  expect(objectMenu()).not.toBeNull();
  expect(stereoRows()).toEqual([]);
});

it.each([17, 100])("keeps the canvas menu %s screen pixels away", async offset => {
  const molecule = await mount("C/C=C/C", { zoom: 200 });
  await clickAt(pointNearDoubleBond(molecule, offset));
  expect(pageMenu()).not.toBeNull();
  expect(pageMenu()?.querySelector('[data-command-id="edit.selectAll"]')).not.toBeNull();
  expect(objectMenu()).toBeNull();
});

// CodeRabbit on PR #529: bare paper between two whole-selected objects, inside the group
// selection frame that is drawn around them, must keep the selection's menu.
describe("right-click inside the drawn group selection frame", () => {
  const FIRST = { x: 200, y: 170 };
  const SECOND = { x: 420, y: 170 };
  const GAP = { x: 310, y: 170 };
  let first: MoleculeObject;
  let second: MoleculeObject;
  let middle: MoleculeObject | undefined;

  async function mountPair(withMiddle = false, platform: ShortcutPlatform = "windows") {
    middle = undefined;
    first = await mount("O", { platform, overlay: (drawing, firstMolecule) => {
      let next = insertSmilesMolecule(drawing, SECOND, depictSmiles2D("O"), "O");
      second = getSelectedMolecule(next)!;
      if (withMiddle) {
        next = insertSmilesMolecule(next, GAP, depictSmiles2D("O"), "O");
        middle = getSelectedMolecule(next)!;
      }
      return selectDocumentObjects(next, drawing.pages[0].id, []);
    } });
    expect(first.atoms[0]!.x).toBeLessThan(second.atoms[0]!.x);
  }

  async function marqueeSelect(from: Point, to: Point, shiftKey = false) {
    const fire = (type: string, point: Point) => act(async () => {
      page.dispatchEvent(new PointerEvent(type, { bubbles: true, cancelable: true, button: 0, shiftKey,
        buttons: type === "pointerup" ? 0 : 1, pointerId: 21, pointerType: "mouse", isPrimary: true,
        clientX: origin.x + point.x * scale, clientY: origin.y + point.y * scale }));
    });
    await fire("pointerdown", from);
    await fire("pointermove", { x: (from.x + to.x) / 2, y: (from.y + to.y) / 2 });
    await fire("pointermove", to);
    await fire("pointerup", to);
  }

  // Both molecules whole-selected, one marquee at a time: a click on a native molecule selects
  // an atom or bond part, not the object, so a Shift-click cannot build a whole-object pair.
  async function marqueeSelectPair() {
    await marqueeSelect({ x: 120, y: 90 }, { x: 260, y: 250 });
    await marqueeSelect({ x: 360, y: 90 }, { x: 520, y: 250 }, true);
    expect(container.querySelector('[data-group-selection="true"]')).not.toBeNull();
  }

  const frameBounds = () => {
    const frame = container.querySelector<HTMLElement>('[data-group-selection="true"]')!;
    expect(frame).not.toBeNull();
    const px = (name: "left" | "top" | "width" | "height") =>
      Number(/^calc\(([-\d.]+)px/.exec(frame.style[name])![1]);
    return { x: px("left"), y: px("top"), width: px("width"), height: px("height") };
  };

  it.each(
    (["macos", "windows"] as const).flatMap(platform => (["one marquee", "shift marquee"] as const).map(how => [platform, how] as const))
  )("keeps the selection menu on bare paper inside the group frame (%s, %s)", async (platform, how) => {
    await mountPair(false, platform);
    if (how === "one marquee") await marqueeSelect({ x: 120, y: 90 }, { x: 520, y: 250 });
    else await marqueeSelectPair();
    const frame = frameBounds();
    expect(GAP.x).toBeGreaterThan(frame.x);
    expect(GAP.x).toBeLessThan(frame.x + frame.width);
    expect(GAP.y).toBeGreaterThan(frame.y);
    expect(GAP.y).toBeLessThan(frame.y + frame.height);
    await clickAt(GAP, platform === "macos" ? { button: 0, ctrlKey: true } : {});
    expect(pageMenu()).toBeNull();
    expect(objectMenu()).not.toBeNull();
    expect([first.id, second.id]).toContain(objectMenu()!.getAttribute("data-context-object-id"));
    expect(objectMenu()!.querySelector('[data-command-id="clipboard.copy"]')).not.toBeNull();
    expect(frameBounds()).toEqual(frame);
  });

  it("opens the page menu on bare paper outside the group frame", async () => {
    await mountPair();
    await marqueeSelectPair();
    const frame = frameBounds();
    await clickAt({ x: GAP.x, y: frame.y + frame.height + 40 });
    expect(objectMenu()).toBeNull();
    expect(pageMenu()).not.toBeNull();
  });

  it("lets an unselected object inside the group frame win the right-click", async () => {
    await mountPair(true);
    await marqueeSelectPair();
    const frame = frameBounds();
    const atom = middle!.atoms[0]!;
    expect(atom.x).toBeGreaterThan(frame.x);
    expect(atom.x).toBeLessThan(frame.x + frame.width);
    await clickAt(atom, { target: atomTarget(middle!, atom.id) });
    expect(objectMenu()?.getAttribute("data-context-object-id")).toBe(middle!.id);
  });
});

// Review (1.2.3 RC5): a selected molecule's selection handles are portaled chrome, so a right-click
// on one reaches the canvas with the molecule's id even where the handle lies over another object.
describe("right-click on a selected molecule's selection handle", () => {
  async function mountHandleOver(withArrow: boolean, platform: ShortcutPlatform) {
    let drawn!: ReturnType<typeof createPhase4Document>;
    let arrow: DocumentObject | undefined;
    const molecule = await mount("CCO", { platform, overlay: (drawing, molecule) => {
      let next = drawing;
      if (withArrow) {
        // A default reaction arrow through the selection frame's top-left corner.
        next = applyReactionArrowToolAtPoint(drawing, { x: molecule.x - 60, y: molecule.y }, "forward");
        arrow = next.pages[0].objects.at(-1);
        expect(arrow?.type).toBe("reaction-arrow");
      }
      drawn = selectDocumentObjects(next, drawing.pages[0].id, [molecule.id]);
      return drawn;
    } });
    const handle = container.querySelector<HTMLElement>(".object-resize-handle.object-resize-top-left")!;
    expect(handle).not.toBeNull();
    const chrome = handle.closest<HTMLElement>(".document-object-chrome")!;
    const frame = handle.closest<HTMLElement>(".object-transform-frame")!;
    const { width, height } = drawn.pages[0];
    const calcPx = (value: string) => Number(/^calc\(([-\d.]+)px/.exec(value)![1]);
    const point = {
      x: Number.parseFloat(chrome.style.left) / 100 * width + calcPx(frame.style.left),
      y: Number.parseFloat(chrome.style.top) / 100 * height + calcPx(frame.style.top)
    };
    // Off every atom and bond, and past the 14 px stereo reach.
    for (const atom of molecule.atoms) expect(Math.hypot(atom.x - point.x, atom.y - point.y) * scale).toBeGreaterThan(14);
    if (arrow) {
      const bounds = documentObjectVisualBounds(arrow, drawn.pages[0].objects);
      expect(point.x).toBeGreaterThan(bounds.x);
      expect(point.x).toBeLessThan(bounds.x + bounds.width);
      expect(point.y).toBeGreaterThanOrEqual(bounds.y);
      expect(point.y).toBeLessThanOrEqual(bounds.y + bounds.height);
    }
    return { molecule, arrow, handle, point };
  }

  it.each<ShortcutPlatform>(["macos", "windows"])("opens the arrow's menu under the handle on %s", async platform => {
    const { arrow, handle, point } = await mountHandleOver(true, platform);
    await clickAt(point, { target: handle, ...(platform === "macos" ? { button: 0, ctrlKey: true } : {}) });
    expect(pageMenu()).toBeNull();
    expect(objectMenu()?.getAttribute("data-context-object-id")).toBe(arrow!.id);
  });

  it.each<ShortcutPlatform>(["macos", "windows"])("keeps the selection menu on a handle over bare paper on %s", async platform => {
    const { molecule, handle, point } = await mountHandleOver(false, platform);
    await clickAt(point, { target: handle, ...(platform === "macos" ? { button: 0, ctrlKey: true } : {}) });
    expect(pageMenu()).toBeNull();
    expect(objectMenu()?.getAttribute("data-context-object-id")).toBe(molecule.id);
  });
});
