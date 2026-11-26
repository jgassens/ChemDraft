// @vitest-environment jsdom
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { resolve } from "node:path";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { applyPatch, applyPatches, type BracketObject, type ChemDraftDocument } from "@chemdraft/chem-core";
import { depictSmiles2D } from "@chemdraft/ocl-adapter";
import { ensureRdkit, resetRdkitForTesting, setRdkitModuleLoader } from "@chemdraft/rdkit-adapter";
import { MainWindow } from "./MainWindow";
import { writeClipboardText } from "./clipboard";
import {
  attachSpin3dModelFromConformer, createNativeTextObject, createPhase4Document, getSelectedMolecule, insertNativeMolfileMolecule
} from "./documentWorkflow";
import { quatFromAxisAngle, type Vec3 } from "./interaction/rotation3d";
import { DOM_COMMAND_EVENT } from "./window-manager";

vi.mock("./rdkitWasmLoader", () => ({ registerRdkitWasmLoader: vi.fn() }));
vi.mock("./clipboard", async original => ({
  ...await original<typeof import("./clipboard")>(), writeClipboardText: vi.fn()
}));

// Copy As V3000 read-back and seed-42 conformer for B<-[P@](C)(CC)CCC, in matching atom order.
const phosphineBoraneMolfile = `
  ChemDraft

  0  0  0  0  0  0  0  0  0  0999 V3000
M  V30 BEGIN CTAB
M  V30 COUNTS 8 7 0 0 1
M  V30 BEGIN ATOM
M  V30 1 B 15 -15 0 0
M  V30 2 P 16.299 -14.25 0 0
M  V30 3 C 17.5981 -13.5 0 0
M  V30 4 C 17.049 -15.549 0 0
M  V30 5 C 18.549 -15.549 0 0
M  V30 6 C 15.549 -12.951 0 0
M  V30 7 C 16.299 -11.6519 0 0
M  V30 8 C 15.549 -10.3529 0 0
M  V30 END ATOM
M  V30 BEGIN BOND
M  V30 1 9 2 1
M  V30 2 1 2 3 CFG=3
M  V30 3 1 2 4
M  V30 4 1 4 5
M  V30 5 1 2 6
M  V30 6 1 6 7
M  V30 7 1 7 8
M  V30 END BOND
M  V30 END CTAB
M  END
`;
const phosphineBoraneCoords = Float64Array.of(
  -1.8293090726258194, -1.2517235026469828, -1.3584599127380361,
  -0.48163833996476146, -0.3840339125379121, -0.2521316123061992,
  -0.09208094367771708, -1.5254271209908608, 1.148551121087054,
  -1.2019662650821972, 1.181134871704935, 0.44789269591418013,
  -2.5329441498653753, 1.4744185420236684, -0.232514382431668,
  0.987917814418237, 0.03459339133482113, -1.2729736711698518,
  2.29861046645705, -0.27104789268795165, -0.6084917729725502,
  2.466522032819316, 0.48858835563559555, 0.6828210542545733
);
const coordinationRefusal = "3D rotation not applied: the P→B coordination bond would change. Rotate slightly and try again.";

describe("Spin 3D flatten chemistry refusals", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeAll(() => {
    const vendor = resolve("packages/rdkit-adapter/vendor");
    const glue = resolve(vendor, "RDKit_minimal.js");
    const wasmBinary = new Uint8Array(readFileSync(resolve(vendor, "RDKit_minimal.wasm")));
    const factory = new Function("require", "__dirname", `${readFileSync(glue, "utf8")}\n;return initRDKitModule;`)(createRequire(glue), vendor);
    setRdkitModuleLoader(() => factory({ wasmBinary }));
  });
  afterAll(resetRdkitForTesting);
  beforeEach(() => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    vi.stubGlobal("ResizeObserver", class { observe() {} unobserve() {} disconnect() {} });
    vi.stubGlobal("CSS", { escape: (value: string) => value });
    vi.mocked(writeClipboardText).mockReset().mockResolvedValue(true);
    window.history.replaceState(null, "", "/?agentBridge=1");
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
  });
  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
    window.history.replaceState(null, "", "/");
    vi.unstubAllGlobals();
  });

  const status = () => container.querySelector("[data-status-message]")?.textContent ?? "";
  const overlay = () => container.querySelector<SVGSVGElement>("[data-spin3d-overlay]");
  const snapshot = () => window.__CHEMDRAFT_AGENT__!.snapshot().document;

  // Poll OUTSIDE act, flushing React on each try. An act scope holds React updates back until it
  // exits, so `act(() => vi.waitFor(...))` never sees an update that lands after a macrotask, however
  // long it waits. Flatten lands after one whenever the mount-time OCL preload is still loading
  // when it awaits the same import (a cold worker on a loaded Linux runner, CI run 45693901107):
  // a single injected setTimeout(0) in flatten failed the old wait at 1000 ms and at 5000 ms, with
  // the commit done at 45 ms. Locally the whole first flatten takes ~45 ms (35 of them RDKit's stereo
  // reference) on this branch and on 7f2322bb0 alike; the Linux runner spent 1728 ms on the test.
  async function waitRendered(assertion: () => void, timeout = 1000) {
    await vi.waitFor(async () => {
      await act(async () => {});
      assertion();
    }, { timeout });
  }

  async function command(commandId: string) {
    await act(async () => { window.dispatchEvent(new CustomEvent(DOM_COMMAND_EVENT, { detail: { commandId } })); });
  }

  async function mount(source: ChemDraftDocument, coords3d: Float64Array, axis: Vec3, degrees: number) {
    const molecule = getSelectedMolecule(source)!;
    const initialDocument = attachSpin3dModelFromConformer(source, molecule.id, {
      coords3d, orientation: quatFromAxisAngle(axis, degrees * Math.PI / 180)
    });
    await act(async () => root.render(createElement(MainWindow, {
      initialDocument, initialActiveToolCommandId: "tool.select", initialPaletteMode: "hidden",
      initialRulersVisible: false, initialCrosshairsVisible: false, nativePalette: true
    })));
  }

  async function spinAndFlatten() {
    await command("structure.spin3d");
    const spin = overlay();
    expect(spin, status()).not.toBeNull();
    const { width, height } = snapshot().pages[0];
    spin!.getBoundingClientRect = () => new DOMRect(0, 0, width, height);
    const spinStatus = status();
    const event = new MouseEvent("pointerdown", {
      bubbles: true, cancelable: true, button: 0, buttons: 1, clientX: 20, clientY: 20
    });
    await act(async () => { spin!.dispatchEvent(event); });
    // The first flatten in a worker may wait on the cold OCL load (above), so allow it time.
    await waitRendered(() => expect(status()).not.toBe(spinStatus), 5000);
  }

  async function mountPhosphineBoraneForRotation() {
    const source = insertNativeMolfileMolecule(createPhase4Document(), { x: 300, y: 300 },
      phosphineBoraneMolfile, "molfile-v3000");
    await mount(source, phosphineBoraneCoords, [1, 0, 0], 0);
    await act(async () => {
      window.dispatchEvent(new KeyboardEvent("keydown", { key: "Shift", shiftKey: true, bubbles: true }));
    });
    const handle = container.querySelector<HTMLButtonElement>("[data-selection-tilt3d-handle]")!;
    expect(handle).not.toBeNull();
    const page = handle.closest<HTMLElement>(".page")!;
    page.setPointerCapture = vi.fn();
    page.hasPointerCapture = () => false;
    return { handle, page };
  }

  async function tiltPointer(target: Element, type: string, degrees: number) {
    const { scale } = window.__CHEMDRAFT_AGENT__!.snapshot().viewport as { scale: number };
    // Vertical page motion rotates X one degree per page unit.
    await act(async () => {
      target.dispatchEvent(new PointerEvent(type, {
        bubbles: true, cancelable: true, pointerId: 1, pointerType: "mouse", isPrimary: true,
        button: 0, buttons: type === "pointerup" ? 0 : 1, clientX: 300, clientY: (300 - degrees) * scale
      }));
    });
  }

  async function copy(flavor: "v2000" | "v3000") {
    const writer = vi.mocked(writeClipboardText);
    writer.mockClear();
    await command(flavor === "v2000" ? "clipboard.copyAs.molV2000" : "clipboard.copyAs.mol");
    await waitRendered(() => expect(writer, status()).toHaveBeenCalledOnce());
    return writer.mock.calls[0][0];
  }

  async function canonical(molfile: string) {
    const mol = (await ensureRdkit()).get_mol(molfile, JSON.stringify({ removeHs: false }))!;
    try { return mol.get_smiles!(); }
    finally { mol.delete(); }
  }

  const views = ([
    { name: "X", axis: [1, 0, 0], refused: [15, 30] },
    { name: "Y", axis: [0, 1, 0], refused: [105, 120, 135, 150] }
  ] satisfies { name: string; axis: Vec3; refused: number[] }[]).flatMap(({ name, axis, refused }) =>
    Array.from({ length: 12 }, (_, index) => {
      const degrees = index * 15;
      return { view: `${name}${degrees}`, axis, degrees, refused: refused.includes(degrees) };
    }));

  it("flattens when two other molecules on different pages share an object id", async () => {
    const source = insertNativeMolfileMolecule(createPhase4Document(), { x: 300, y: 300 },
      depictSmiles2D("CCC").molfile, "molfile-v2000");
    const target = getSelectedMolecule(source)!;
    const page = source.pages[0];
    function spectator(smiles: string) {
      const drawing = insertNativeMolfileMolecule(createPhase4Document(), { x: 100, y: 100 },
        depictSmiles2D(smiles).molfile, "molfile-v2000");
      return { ...getSelectedMolecule(drawing)!, id: "shared-molecule" };
    }
    const multipage = { ...source, pages: [
      { ...page, objects: [...page.objects, spectator("CC")] },
      { ...page, id: "second-page", objects: [spectator("O")] }
    ] };
    const coords3d = Float64Array.from(target.atoms.flatMap(atom => [(atom.x - 300) / 20, (300 - atom.y) / 20, 0]));
    await mount(multipage, coords3d, [0, 0, 1], 90);
    const before = snapshot();

    await spinAndFlatten();

    expect(status()).toMatch(/^Flattened /);
    expect(overlay()).toBeNull();
    const after = snapshot();
    expect(getSelectedMolecule(after)!.atoms).not.toEqual(getSelectedMolecule(before)!.atoms);
    expect(after.pages[0].objects[1]).toEqual(before.pages[0].objects[1]);
    expect(after.pages[1]).toEqual(before.pages[1]);
  });

  it("flattens when a spectator molecule and the following text share an object id", async () => {
    const source = insertNativeMolfileMolecule(createPhase4Document(), { x: 300, y: 300 },
      depictSmiles2D("CCC").molfile, "molfile-v2000");
    const target = getSelectedMolecule(source)!;
    const drawing = insertNativeMolfileMolecule(createPhase4Document(), { x: 100, y: 100 },
      depictSmiles2D("CC").molfile, "molfile-v2000");
    const spectator = { ...getSelectedMolecule(drawing)!, id: "spectator" };
    const text = { ...createNativeTextObject(source, { x: 150, y: 100 }, "Label"), id: spectator.id };
    const page = source.pages[0];
    const document = { ...source, pages: [{ ...page, objects: [...page.objects, spectator, text] }] };
    const coords3d = Float64Array.from(target.atoms.flatMap(atom => [(atom.x - 300) / 20, (300 - atom.y) / 20, 0]));
    await mount(document, coords3d, [0, 0, 1], 90);
    const before = snapshot();

    await spinAndFlatten();

    expect(status()).toMatch(/^Flattened /);
    expect(overlay()).toBeNull();
    const after = snapshot();
    expect(getSelectedMolecule(after)!.atoms).not.toEqual(getSelectedMolecule(before)!.atoms);
    expect(after.pages[0].objects.slice(1)).toEqual(before.pages[0].objects.slice(1));
  });

  describe("when the drawing changes while Spin 3D is open", () => {
    const changedRefusal = "Couldn't flatten: the drawing changed while Spin 3D was open. Reopen Spin 3D and try again.";

    // A bent butane that Clean Up redraws, as in a Linux beta tester's video (#304): Spin 3D was open,
    // Clean Up ran, and every later click outside refused while the stale overlay stayed on screen.
    async function mountSpinThenCleanUp() {
      const source = insertNativeMolfileMolecule(createPhase4Document(), { x: 300, y: 300 },
        depictSmiles2D("CCCC").molfile, "molfile-v2000");
      const molecule = getSelectedMolecule(source)!;
      const x = [260, 300, 302, 345];
      const y = [300, 300, 340, 338];
      const bent = applyPatch(source, { op: "updateObject", objectId: molecule.id,
        changes: { atoms: molecule.atoms.map((atom, index) => ({ ...atom, x: x[index], y: y[index] })) } });
      const coords3d = Float64Array.from(x.flatMap((value, index) => [(value - 300) / 20, (300 - y[index]) / 20, 0]));
      await mount(bent, coords3d, [0, 0, 1], 0);
      await command("structure.spin3d");
      expect(overlay(), status()).not.toBeNull();
      const beforeCleanUp = getSelectedMolecule(snapshot())!;
      await command("structure.cleanup2d");
      await waitRendered(() => expect(status()).toMatch(/^Cleaned up/));
      const cleaned = snapshot();
      expect(getSelectedMolecule(cleaned)!.atoms).not.toEqual(beforeCleanUp.atoms);
      return cleaned;
    }

    async function clickOutsideSpin() {
      const spin = overlay()!;
      const { width, height } = snapshot().pages[0];
      spin.getBoundingClientRect = () => new DOMRect(0, 0, width, height);
      const before = status();
      await act(async () => {
        spin.dispatchEvent(new MouseEvent("pointerdown", {
          bubbles: true, cancelable: true, button: 0, buttons: 1, clientX: 20, clientY: 20
        }));
      });
      await waitRendered(() => expect(status()).not.toBe(before));
    }

    it("closes the stale overlay when a click outside refuses, keeping the changed drawing", async () => {
      const cleaned = await mountSpinThenCleanUp();

      await clickOutsideSpin();

      expect(status()).toBe(changedRefusal);
      expect(overlay()).toBeNull();
      expect(snapshot()).toEqual(cleaned);
    });

    it("reopens Spin 3D on the changed molecule instead of keeping the stale session", async () => {
      const cleaned = await mountSpinThenCleanUp();

      await command("structure.spin3d");
      await waitRendered(() => expect(overlay(), status()).not.toBeNull());
      expect(status()).not.toMatch(/already active/);

      await clickOutsideSpin();

      expect(status()).toMatch(/^Flattened /);
      expect(overlay()).toBeNull();
      expect(getSelectedMolecule(snapshot())!.id).toBe(getSelectedMolecule(cleaned)!.id);
    });
  });

  it.each(views)("guards the directed P→B bond in view $view", async ({ axis, degrees, refused }) => {
    const source = insertNativeMolfileMolecule(createPhase4Document(), { x: 300, y: 300 }, phosphineBoraneMolfile, "molfile-v3000");
    await mount(source, phosphineBoraneCoords, axis, degrees);
    const before = snapshot();
    const beforeMolfile = await copy("v3000");
    expect(beforeMolfile).toMatch(/^M  V30 1 9 2 1$/m);
    expect(await canonical(beforeMolfile)).toBe("B<-[P@](C)(CC)CCC");

    await spinAndFlatten();
    if (refused) {
      expect(status()).toBe("Cannot flatten this view: the P→B coordination bond would change. Rotate slightly and try again.");
      expect(overlay()).not.toBeNull();
      expect(snapshot()).toEqual(before);
    } else {
      expect(status()).toMatch(/^Flattened /);
      expect(overlay()).toBeNull();
      expect(getSelectedMolecule(snapshot())!.atoms).not.toEqual(getSelectedMolecule(before)!.atoms);
    }
    const afterMolfile = await copy("v3000");
    expect(afterMolfile).toMatch(/^M  V30 1 9 2 1$/m);
    expect(await canonical(afterMolfile)).toBe("B<-[P@](C)(CC)CCC");
  });

  it.each([
    { label: "after an accepted preview", previewDegrees: 6 },
    { label: "as the first drag position", previewDegrees: 15 },
    { label: "without a pointer move before release", previewDegrees: undefined }
  ])("refuses an X15 handle release $label without editing or creating undo history", async ({ previewDegrees }) => {
    const { handle, page } = await mountPhosphineBoraneForRotation();
    const before = snapshot();
    const paint = () => container.querySelector(".native-molecule-overlay-visual")?.innerHTML;
    const originalPaint = paint();
    expect(originalPaint).toBeTruthy();
    await tiltPointer(handle, "pointerdown", 0);
    if (previewDegrees !== undefined) await tiltPointer(page, "pointermove", previewDegrees);
    if (previewDegrees === 6) {
      const acceptedPaint = paint();
      expect(acceptedPaint).not.toBe(originalPaint);
      expect(snapshot()).toEqual(before);
      await tiltPointer(page, "pointermove", 30);
      expect(paint()).toBe(acceptedPaint);
    }
    await tiltPointer(page, "pointerup", 15);

    expect(status()).toBe(coordinationRefusal);
    expect(paint()).toBe(originalPaint);
    expect(snapshot()).toEqual(before);
    await command("edit.undo");
    expect(status()).toBe("Nothing to undo");
    expect(snapshot()).toEqual(before);
  });

  it("reports the chemistry refusal after submitting numeric X15 rotation", async () => {
    const { handle } = await mountPhosphineBoraneForRotation();
    const before = snapshot();
    await act(async () => {
      handle.dispatchEvent(new MouseEvent("dblclick", { bubbles: true, cancelable: true }));
    });
    const form = container.querySelector<HTMLFormElement>('[data-rotation-input-kind="xy"]')!;
    expect(form).not.toBeNull();
    const x = form.querySelector<HTMLInputElement>('input[aria-label="X rotation degrees"]')!;
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(x, "15");
      x.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await act(async () => {
      form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    });

    expect(status()).toBe(coordinationRefusal);
    expect(snapshot()).toEqual(before);
  });

  it("clears an E/Z refusal when a later numeric Y preview succeeds", async () => {
    const source = insertNativeMolfileMolecule(createPhase4Document(), { x: 300, y: 300 },
      depictSmiles2D("F/C=C/F").molfile, "molfile-v2000");
    const molecule = getSelectedMolecule(source)!;
    const coords3d = Float64Array.from(molecule.atoms.flatMap(atom => [(atom.x - 300) / 20, (300 - atom.y) / 20, 0]));
    await mount(source, coords3d, [1, 0, 0], 0);
    await act(async () => {
      window.dispatchEvent(new KeyboardEvent("keydown", { key: "Shift", shiftKey: true, bubbles: true }));
    });
    const handle = container.querySelector<HTMLButtonElement>("[data-selection-tilt3d-handle]")!;
    await act(async () => handle.dispatchEvent(new MouseEvent("dblclick", { bubbles: true, cancelable: true })));
    const form = container.querySelector<HTMLFormElement>('[data-rotation-input-kind="xy"]')!;
    const y = form.querySelector<HTMLInputElement>('input[aria-label="Y rotation degrees"]')!;
    const enterY = async (value: string) => {
      await act(async () => {
        Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(y, value);
        y.dispatchEvent(new Event("input", { bubbles: true }));
      });
    };
    await enterY("90");
    expect(status()).toContain("3D rotation not applied: the C2=C3 double bond would lose its E geometry");
    const before = snapshot();
    await enterY("10");
    expect(status()).not.toMatch(/3D rotation not applied/);
    expect(getSelectedMolecule(snapshot())!.atoms).not.toEqual(getSelectedMolecule(before)!.atoms);
    await act(async () => form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })));
    expect(await canonical(await copy("v2000"))).toBe("F/C=C/F");
  });

  it.each([
    { label: "refuses a view that moves the repeat unit from carbon to oxygen", bracketed: true, degrees: 180, refused: true },
    { label: "commits a view that leaves the repeat unit on the same carbon", bracketed: true, degrees: 10, refused: false },
    { label: "commits the 180-degree view of the ordinary molecule", bracketed: false, degrees: 180, refused: false }
  ])("$label", async ({ bracketed, degrees, refused }) => {
    const source = insertNativeMolfileMolecule(createPhase4Document(), { x: 300, y: 300 },
      depictSmiles2D("FCCOC").molfile, "molfile-v2000");
    const molecule = getSelectedMolecule(source)!;
    expect(molecule.atoms.map(atom => atom.element)).toEqual(["F", "C", "C", "O", "C"]);
    const x = [252, 276, 300, 324, 348];
    const y = [300, 289, 300, 311, 300];
    let doc = applyPatch(source, { op: "updateObject", objectId: molecule.id,
      changes: { atoms: molecule.atoms.map((atom, index) => ({ ...atom, x: x[index], y: y[index] })) } });
    if (bracketed) {
      const open: BracketObject = {
        id: "repeat-open", type: "bracket", bracketKind: "square", side: "open", pairId: "repeat-pair",
        repeatUnit: true, x: 267, y: 260, width: 5, height: 80, rotation: 0, style: {}, containedObjectIds: []
      };
      const close: BracketObject = { ...open, id: "repeat-close", side: "close", x: 282, label: "n" };
      doc = applyPatches(doc, [open, close].map(object => ({ op: "addObject", pageId: doc.pages[0].id, object })));
    }
    const coords3d = Float64Array.from(x.flatMap((value, index) => [(value - 300) / 20, (300 - y[index]) / 20, 0]));
    await mount(doc, coords3d, [0, 0, 1], degrees);
    const before = snapshot();
    const beforeMolfile = await copy("v2000");
    const sal = (molfile: string) => molfile.split("\n").find(line => line.startsWith("M  SAL "));
    expect(sal(beforeMolfile)).toBe(bracketed ? "M  SAL   1  1   2" : undefined);

    await spinAndFlatten();
    if (refused) {
      expect(status()).toBe("Cannot flatten this view: the polymer bracket would enclose different atoms.");
      expect(overlay()).not.toBeNull();
      expect(snapshot()).toEqual(before);
    } else {
      expect(status()).toMatch(/^Flattened /);
      expect(overlay()).toBeNull();
      expect(getSelectedMolecule(snapshot())!.atoms).not.toEqual(getSelectedMolecule(before)!.atoms);
    }
    const afterMolfile = await copy("v2000");
    expect(sal(afterMolfile)).toBe(sal(beforeMolfile));
    expect(await canonical(afterMolfile)).toBe(await canonical(beforeMolfile));
  });
});
