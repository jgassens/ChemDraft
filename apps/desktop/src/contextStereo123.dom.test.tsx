// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterAll, afterEach, beforeAll, beforeEach, expect, it, vi } from "vitest";
import { applyPatches, type MoleculeObject } from "@chemdraft/chem-core";
import { moleculeLayoutLabelBoxes, nativeMoleculeRings } from "@chemdraft/layout-engine";
import { depictSmiles2D, ensureOclResources } from "@chemdraft/ocl-adapter";
import type { ShortcutPlatform } from "@chemdraft/shortcut-engine";
import { documentZoomCommandId } from "./documentZoom";
import { createPhase4Document, getSelectedMolecule, insertSmilesMolecule, selectDocumentObjects } from "./documentWorkflow";
import { MainWindow } from "./MainWindow";
import { loadStereoEngine } from "./stereoReadout";
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
  selected = false, platform = "windows", zoom = 100, labelFontSize
}: { selected?: boolean; platform?: ShortcutPlatform; zoom?: Zoom; labelFontSize?: number } = {}) {
  let drawing = insertSmilesMolecule(createPhase4Document("Context stereo"), { x: 220, y: 170 }, depictSmiles2D(smiles), smiles);
  if (labelFontSize) {
    const molecule = getSelectedMolecule(drawing)!;
    drawing = applyPatches(drawing, [{ op: "updateObject", objectId: molecule.id, changes: {
      style: { ...molecule.style, atomLabelFontSizePx: labelFontSize }
    } }]);
  }
  const molecule = getSelectedMolecule(drawing)!;
  await act(async () => root.render(<MainWindow
    initialDocument={selected ? drawing : selectDocumentObjects(drawing, drawing.pages[0].id, [])}
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

async function clickAt(point: Point, { target = page as Element, button = 2, ctrlKey = false, context = true } = {}) {
  expect(page.contains(target)).toBe(true);
  const mouse = { bubbles: true, cancelable: true, clientX: origin.x + point.x * scale,
    clientY: origin.y + point.y * scale, button, ctrlKey };
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
  .map(row => row.textContent).filter(label => /^(Stereocentre|Double bond): /.test(label ?? ""));
const rotateItem = () => objectMenu()?.querySelector('[data-command-id="layout.rotateMolecule"]');

function incidentBondClick(molecule: MoleculeObject, center: MoleculeObject["atoms"][number]) {
  const bond = molecule.bonds.find(bond => bond.fromAtomId === center.id || bond.toAtomId === center.id)!;
  const other = molecule.atoms.find(atom => atom.id === (bond.fromAtomId === center.id ? bond.toAtomId : bond.fromAtomId))!;
  const length = Math.hypot(other.x - center.x, other.y - center.y);
  return {
    point: { x: center.x + (other.x - center.x) * 12 / length, y: center.y + (other.y - center.y) * 12 / length },
    target: bondTarget(molecule, bond.id)
  };
}

it.each<ShortcutPlatform>(["macos", "windows"])("shows R/S on an exact right-click on %s", async platform => {
  const molecule = await mount(IBUPROFEN, { platform });
  const atom = molecule.atoms[10]!;
  await clickAt(atom, { target: atomTarget(molecule, atom.id) });
  expect(stereoRows()).toEqual(["Stereocentre: S"]);
});

it.each([50, 100, 200].flatMap(zoom => [5, 10].map(offset => [zoom as Zoom, offset] as const)))(
  "shows R/S at %s%% zoom and %s screen pixels from the stereocenter", async (zoom, offset) => {
    const molecule = await mount(IBUPROFEN, { zoom });
    const center = molecule.atoms[10]!;
    const catcher = atomTarget(molecule, center.id);
    const target = offset / scale <= Number(catcher.getAttribute("r")) ? catcher : page;
    await clickAt({ x: center.x, y: center.y + offset / scale }, { target });
    expect(stereoRows()).toEqual(["Stereocentre: S"]);
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
  expect(stereoRows()).toEqual([expect.stringMatching(/^Stereocentre: [RS]$/)]);
});

it("shows R/S over the first part of an incident bond", async () => {
  const molecule = await mount();
  const { point, target } = incidentBondClick(molecule, molecule.atoms[10]!);
  await clickAt(point, { target });
  expect(stereoRows()).toEqual(["Stereocentre: S"]);
});

it("keeps Rotate molecule and the R/S row for a selected molecule on Windows", async () => {
  const molecule = await mount(IBUPROFEN, { selected: true });
  const center = molecule.atoms[10]!;
  await clickAt({ x: center.x, y: center.y + 10 });
  expect(stereoRows()).toEqual(["Stereocentre: S"]);
  expect(rotateItem()?.textContent).toBe("Rotate molecule…");
});

it("keeps the selected molecule on a macOS Ctrl+click near the stereocenter", async () => {
  const molecule = await mount(IBUPROFEN, { selected: true, platform: "macos" });
  const center = molecule.atoms[10]!;
  await clickAt({ x: center.x, y: center.y + 10 }, { button: 0, ctrlKey: true });
  expect(stereoRows()).toEqual(["Stereocentre: S"]);
  expect(rotateItem()).not.toBeNull();
});

it("keeps the selected atom on a macOS Ctrl+click over an incident bond", async () => {
  const molecule = await mount(IBUPROFEN, { platform: "macos" });
  const center = molecule.atoms[10]!;
  await clickAt(center, { button: 0, context: false, target: atomTarget(molecule, center.id) });
  expect(renderedMolecule(molecule).getAttribute("data-selected-native-atom-id")).toBe(center.id);
  const { point, target } = incidentBondClick(molecule, center);
  await clickAt(point, { button: 0, ctrlKey: true, target });
  expect(stereoRows()).toEqual(["Stereocentre: S"]);
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
  await act(async () => window.dispatchEvent(new CustomEvent(DOM_COMMAND_EVENT, {
    detail: { commandId: "view.toggleRingInspector" }
  })));
  await clickAt(ring.center, { button: 0, context: false, target: page.querySelector(`[data-ring-hit-key="${ring.ringKey}"]`)! });
  expect(renderedMolecule(molecule).getAttribute("data-selected-native-ring-key")).toBe(ring.ringKey);
  await clickAt(ring.center);
  expect(objectMenu()?.getAttribute("data-context-target-kind")).toBe("ring");
  expect(renderedMolecule(molecule).getAttribute("data-selected-native-ring-key")).toBe(ring.ringKey);
});

it.each([false, true])("shows E/Z near the middle of a stereo double bond (bond selected: %s)", async selected => {
  const molecule = await mount("C/C=C/C", { zoom: 200 });
  const bond = molecule.bonds.find(bond => bond.order === "double")!;
  const from = molecule.atoms.find(atom => atom.id === bond.fromAtomId)!;
  const to = molecule.atoms.find(atom => atom.id === bond.toAtomId)!;
  const length = Math.hypot(to.x - from.x, to.y - from.y);
  const center = { x: (from.x + to.x) / 2, y: (from.y + to.y) / 2 };
  if (selected) {
    await clickAt(center, { button: 0, context: false, target: bondTarget(molecule, bond.id) });
    expect(renderedMolecule(molecule).getAttribute("data-selected-native-bond-id")).toBe(bond.id);
  }
  await clickAt({ x: center.x + (to.y - from.y) * 10 / (length * scale),
    y: center.y - (to.x - from.x) * 10 / (length * scale) });
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
  expect(stereoRows()).toEqual(["Stereocentre: S"]);
  await clickAt({ x: right.x + (left.x - right.x) * 9 / length, y: right.y + (left.y - right.y) * 9 / length },
    { target: bondTarget(molecule, connecting.id) });
  expect(stereoRows()).toEqual(["Stereocentre: R"]);
});

it("omits stereo near a non-stereogenic atom", async () => {
  const molecule = await mount();
  const atom = molecule.atoms[0]!;
  await clickAt({ x: atom.x, y: atom.y + 5 }, { target: renderedMolecule(molecule) });
  expect(objectMenu()).not.toBeNull();
  expect(stereoRows()).toEqual([]);
});

it.each([17, 100])("keeps the canvas menu %s screen pixels away", async offset => {
  const molecule = await mount(IBUPROFEN, { zoom: 200 });
  const center = molecule.atoms[10]!;
  await clickAt({ x: center.x, y: center.y + offset / scale });
  expect(pageMenu()).not.toBeNull();
  expect(pageMenu()?.querySelector('[data-command-id="edit.selectAll"]')).not.toBeNull();
  expect(objectMenu()).toBeNull();
});
