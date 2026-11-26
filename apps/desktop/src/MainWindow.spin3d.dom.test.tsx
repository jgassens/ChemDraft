// @vitest-environment jsdom
import { invoke } from "@tauri-apps/api/core";
import { applyPatch, type ChemDraftDocument, type MoleculeObject } from "@chemdraft/chem-core";
import { Engine3DProtocolVersion, type Engine3DRequest } from "@chemdraft/engine3d-api";
import { depictSmiles2D } from "@chemdraft/ocl-adapter";
import { ensureRdkit, rdkitConformerGenerator, resetRdkitForTesting, setRdkitModuleLoader } from "@chemdraft/rdkit-adapter";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { MainWindow } from "./MainWindow";
import { writeClipboardText } from "./clipboard";
import { analysisFacingStructure, assertSpin3dDocumentIdentity, attachSpin3dModelFromConformer, createPhase4Document, getSelectedMolecule,
  insertNativeMolfileMolecule, normalizeCommittedDocument, spin3dModelCoordsForMolecule, validSpin3dModelFor } from "./documentWorkflow";
import type { Engine3dSidecarSessionOutput } from "./engine3dSidecar";
import { interactive3dPhaseLabel } from "./interactive3dStatus";
import { serializeSpin3dMolfile, Spin3dStereoReference } from "./interaction/spin3dStereo";
import { quatFromAxisAngle, quatToViewMatrix } from "./interaction/rotation3d";
import { medianBondLength3d, orientedOverlayScale, projectSpin } from "./interaction/spinOverlay";
import { installDomRdkitLoader } from "./testSupport/rdkitIdentity";
import { DOM_COMMAND_EVENT } from "./window-manager";

vi.mock("./rdkitWasmLoader", () => ({ registerRdkitWasmLoader: vi.fn() }));
vi.mock("./clipboard", async original => ({ ...await original<typeof import("./clipboard")>(), writeClipboardText: vi.fn() }));
vi.mock("@tauri-apps/api/core", async original => ({ ...await original<typeof import("@tauri-apps/api/core")>(), invoke: vi.fn() }));
// The mocked invoke stands in for the desktop shell and its sidecar, so keep Interactive 3D as the
// desktop build does while its status is pending; jsdom alone looks like the browser build, which
// leaves the command out (sessionUnavailableCommands.ts).
vi.mock("./sessionUnavailableCommands", async original => ({
  ...await original<typeof import("./sessionUnavailableCommands")>(),
  useSessionUnavailableCommandIds: () => new Set<string>()
}));

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
class TestResizeObserver { observe() {} unobserve() {} disconnect() {} }

const cis = String.raw`C/C=C\C`;
const seed = Float64Array.of(-0.7, 1, 0, 0, 0, 0, 1.33, 0, 0, 2, 1, 0);
const orientation = quatFromAxisAngle([1, 0, 0], 0);
const positionMap = (ids: string[], coords: Float64Array) => Object.fromEntries(ids.map((id, i) =>
  [id, { x: coords[3 * i], y: coords[3 * i + 1], z: coords[3 * i + 2] }]));

beforeAll(async () => {
  // Copy As uses the identifiers entry point. The Spin loader uses the bare
  // package, which can resolve separately when testing with shared links.
  installDomRdkitLoader();
  installDomRdkitLoader(setRdkitModuleLoader);
  await ensureRdkit();
});
afterAll(() => resetRdkitForTesting());

function modeledDrawing() {
  const document = insertNativeMolfileMolecule(createPhase4Document(), { x: 300, y: 300 },
    depictSmiles2D(cis, { openUnspecifiedDoubleBonds: true }).molfile, "molfile-v2000");
  const molecule = getSelectedMolecule(document)!;
  return attachSpin3dModelFromConformer(document, molecule.id, { coords3d: seed, orientation });
}

function pointer(target: Element, type: string, x: number, y: number, buttons = type === "pointerup" ? 0 : 1) {
  const event = new MouseEvent(type, { bubbles: true, cancelable: true, button: 0,
    buttons, clientX: x, clientY: y });
  Object.defineProperties(event, { pointerId: { value: 1 }, isPrimary: { value: true }, pointerType: { value: "mouse" } });
  target.dispatchEvent(event);
}

function rectFor(document: ChemDraftDocument): DOMRect {
  const { width, height } = document.pages[0];
  return { x: 0, y: 0, left: 0, top: 0, width, height, right: width, bottom: height, toJSON: () => ({}) };
}

describe("Spin 3D on the canvas", () => {
  let container: HTMLDivElement;
  let root: Root;
  const captureMethods = {
    set: Element.prototype.setPointerCapture, release: Element.prototype.releasePointerCapture,
    has: Element.prototype.hasPointerCapture
  };
  beforeEach(() => {
    vi.stubGlobal("ResizeObserver", TestResizeObserver);
    vi.stubGlobal("CSS", { escape: (value: string) => value });
    Element.prototype.setPointerCapture = () => {};
    Element.prototype.releasePointerCapture = () => {};
    Element.prototype.hasPointerCapture = () => false;
    vi.mocked(invoke).mockReset();
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
    delete window.__CHEMDRAFT_AGENT__;
    Element.prototype.setPointerCapture = captureMethods.set;
    Element.prototype.releasePointerCapture = captureMethods.release;
    Element.prototype.hasPointerCapture = captureMethods.has;
    vi.unstubAllGlobals();
  });

  const page = () => container.querySelector<HTMLElement>(".page")!;
  const status = () => container.querySelector("[data-status-message]")?.textContent;
  const overlay = () => container.querySelector<SVGSVGElement>("[data-spin3d-overlay]");
  const snapshot = () => window.__CHEMDRAFT_AGENT__!.snapshot().document;
  const command = (commandId: string) => act(async () =>
    window.dispatchEvent(new CustomEvent(DOM_COMMAND_EVENT, { detail: { commandId } })));

  async function mount(document: ChemDraftDocument) {
    await act(async () => root.render(createElement(MainWindow, {
      initialDocument: document, initialActiveToolCommandId: "tool.select", initialPaletteMode: "hidden",
      initialRulersVisible: false, initialCrosshairsVisible: false, nativePalette: true
    })));
    page().getBoundingClientRect = () => rectFor(document);
  }

  async function grabRotate() {
    await act(async () => window.dispatchEvent(new KeyboardEvent("keydown", { key: "Shift", shiftKey: true })));
    const handle = container.querySelector("[data-selection-tilt3d-handle]")!;
    expect(handle).toBeTruthy();
    await act(async () => pointer(handle, "pointerdown", 500, 400));
  }

  it("copies the verified Z-2-butene MOL while a near-edge-on X/Y preview is visible", async () => {
    await mount(modeledDrawing());
    const before = snapshot();
    const paint = () => container.querySelector(".native-molecule-overlay-visual")?.innerHTML;
    const originalPaint = paint();
    await grabRotate();
    await act(async () => pointer(page(), "pointermove", 500, 400 - 89.8));
    expect(paint()).not.toBe(originalPaint);
    expect(snapshot()).toEqual(before);
    await act(async () => {
      await command("clipboard.copyAs.molV2000");
      await vi.waitFor(() => expect(writeClipboardText).toHaveBeenCalledOnce());
    });
    expect(status()).toContain("Copied MOL V2000 text");
    const copied = (await ensureRdkit()).get_mol(vi.mocked(writeClipboardText).mock.calls[0][0])!;
    try { expect(copied.get_smiles!()).toBe(cis); }
    finally { copied.delete(); }
    await act(async () => pointer(page(), "pointerup", 500, 400 - 89.8));
    expect(status()).toContain("3D rotate applied");
  });

  it("retains the bond-specific refusal after the X/Y rotation pointer goes up", async () => {
    await mount(modeledDrawing());
    const before = snapshot();
    await grabRotate();
    await act(async () => pointer(page(), "pointermove", 500, 310));
    await act(async () => pointer(page(), "pointerup", 500, 310));
    expect(status()).toContain("the C2=C3 double bond would lose its Z geometry");
    expect(snapshot()).toEqual(before);
  });

  it("keeps the expanded Copy As stereo for a wedged CMe bonded to F, Cl and Br", async () => {
    const original = insertNativeMolfileMolecule(createPhase4Document(), { x: 300, y: 300 },
      depictSmiles2D("C[C@@](F)(Cl)Br").molfile, "molfile-v2000");
    const full = getSelectedMolecule(original)!;
    const [methyl, center] = full.atoms.filter(atom => atom.element === "C");
    const fluorine = full.atoms.find(atom => atom.element === "F")!;
    const compact: MoleculeObject = {
      ...full,
      atoms: full.atoms.filter(atom => atom.id !== methyl.id).map(atom =>
        atom.id === center.id ? { ...atom, element: "CMe", labelLiteral: true } : atom),
      bonds: full.bonds.filter(bond => bond.fromAtomId !== methyl.id && bond.toAtomId !== methyl.id).map(bond => {
        const { bondStyle: _removed, ...display } = bond.display ?? {};
        if (bond.fromAtomId !== fluorine.id && bond.toAtomId !== fluorine.id) return { ...bond, display };
        return { ...bond, fromAtomId: center.id, toAtomId: fluorine.id, display: { ...display, bondStyle: "wedge" } };
      })
    };
    const expandedStereo = () => {
      const mol = rdkit.get_mol(analysisFacingStructure(compact).structure)!;
      try { return mol.get_smiles!(); }
      finally { mol.delete(); }
    };
    const rdkit = await ensureRdkit();
    if (expandedStereo() !== "C[C@@](F)(Cl)Br") {
      compact.bonds.find(bond => bond.fromAtomId === center.id && bond.toAtomId === fluorine.id)!.display!.bondStyle = "hashed";
    }
    compact.structure = serializeSpin3dMolfile(compact);
    const source = normalizeCommittedDocument(applyPatch(original, { op: "updateObject", objectId: full.id, changes: compact }));
    const molecule = getSelectedMolecule(source)!;
    const coords3d = (await rdkitConformerGenerator.generate3DConformer(
      { molfile: analysisFacingStructure(molecule).structure }, { seed: 42, optimize: "none" }
    )).mapping.coords3dByOriginalAtom.slice(0, molecule.atoms.length * 3);
    const modeled = attachSpin3dModelFromConformer(source, molecule.id, { coords3d, orientation });
    await mount(modeled);
    await command("clipboard.copyAs.smiles");
    await vi.waitFor(() => expect(writeClipboardText).toHaveBeenCalledWith("C[C@@](F)(Cl)Br"));
    vi.mocked(writeClipboardText).mockClear();
    await command("structure.spin3d");
    await vi.waitFor(() => expect(overlay()).toBeTruthy());
    const svg = overlay()!;
    svg.getBoundingClientRect = () => rectFor(modeled);
    await act(async () => pointer(svg, "pointerdown", 20, 20));
    expect(status()).toContain("Flattened");
    expect(overlay()).toBeNull();
    await command("clipboard.copyAs.smiles");
    await vi.waitFor(() => expect(writeClipboardText).toHaveBeenCalledWith("C[C@@](F)(Cl)Br"));

    const flattened = snapshot();
    const dewedged = getSelectedMolecule(flattened)!;
    const bonds = dewedged.bonds.map(bond => ({ ...bond, display: { ...bond.display, bondStyle: undefined } }));
    const changed = normalizeCommittedDocument(applyPatch(flattened, {
      op: "updateObject", objectId: molecule.id,
      changes: { bonds, structure: serializeSpin3dMolfile({ ...dewedged, bonds }) }
    }));
    const reference = new Spin3dStereoReference(rdkit, molecule);
    expect(() => assertSpin3dDocumentIdentity(modeled, changed, reference))
      .toThrow(/the stereocenter at CMe\d+ would lose its stereo assignment/);
  });

  it("shows Interactive 3D's instructions, not its phase name, and rotates on a drag in empty space", async () => {
    // Linux 1.2.2 B8: the status line read the raw phase "tug-ready", which hid the only text saying
    // that a drag on an atom pulls it and a drag in empty space rotates.
    const initial = modeledDrawing();
    const molecule = getSelectedMolecule(initial)!;
    const ids = molecule.atoms.map(atom => atom.id);
    const pairs: [number, number][] = molecule.bonds.map(bond => [ids.indexOf(bond.fromAtomId), ids.indexOf(bond.toAtomId)]);
    const placement = {
      centerX: molecule.atoms.reduce((sum, a) => sum + a.x, 0) / ids.length,
      centerY: molecule.atoms.reduce((sum, a) => sum + a.y, 0) / ids.length,
      scale: orientedOverlayScale(molecule.atoms, seed, pairs, quatToViewMatrix(orientation))
    };
    const requests: Engine3DRequest[] = [];
    vi.mocked(invoke).mockImplementation(async (name, args) => {
      if (name === "engine3d_sidecar_status") return { available: true, source: "bundled", logEnabled: true };
      if (!name.startsWith("engine3d_sidecar_")) return undefined;
      const line = (args as { lines?: string[] })?.lines?.[0];
      const request = line ? JSON.parse(line) as Engine3DRequest : undefined;
      if (request) requests.push(request);
      const output: Engine3dSidecarSessionOutput = { processSessionId: "process", stdoutLines: [], stderr: "", exited: false };
      if (request?.type !== "createSession") return output;
      const envelope = { protocolVersion: Engine3DProtocolVersion, sessionId: "session", requestId: request.requestId };
      output.stdoutLines.push(
        JSON.stringify({ ...envelope, type: "response", ok: true, result: { sessionId: "session" } }),
        JSON.stringify({ ...envelope, type: "event", eventType: "coordinatesChanged", reason: "embed",
          coordinateRevision: 1, coords3dByAtomId: positionMap(ids, seed) })
      );
      return output;
    });
    await mount(initial);
    await command("structure.openInteractive3d");
    const rawStatus = /tug-ready|attaching|coord rev|beginDrag|updateDrag|endDrag/;
    await vi.waitFor(() => expect(status()).toContain(`${interactive3dPhaseLabel("ready")} · `));
    expect(status()).not.toMatch(rawStatus);

    // A point inside the selection box's 14-unit margin and outside every atom's pull radius.
    const atoms = projectSpin(seed, pairs, orientation, placement).atoms;
    const pullRadius = Math.max(6, 0.5 * placement.scale * medianBondLength3d(seed, pairs));
    const clearance = (point: { x: number; y: number }) =>
      Math.min(...atoms.map(atom => Math.hypot(atom.sx - point.x, atom.sy - point.y)));
    const candidates = [0, 0.25, 0.5, 0.75, 1].flatMap(fx => [0, 0.25, 0.5, 0.75, 1].map(fy => ({
      x: molecule.x - 12 + fx * (molecule.width + 24),
      y: molecule.y - 12 + fy * (molecule.height + 24)
    })));
    const spot = candidates.reduce((best, point) => clearance(point) > clearance(best) ? point : best);
    expect(clearance(spot)).toBeGreaterThan(pullRadius);

    const svg = overlay()!;
    svg.getBoundingClientRect = () => rectFor(initial);
    const before = svg.innerHTML;
    await act(async () => {
      pointer(svg, "pointerdown", spot.x, spot.y);
      pointer(svg, "pointermove", spot.x + 40, spot.y + 25);
      pointer(svg, "pointerup", spot.x + 40, spot.y + 25);
    });
    expect(requests.map(request => request.type)).toEqual(["createSession"]);
    expect(overlay()).toBe(svg);
    expect(svg.innerHTML).not.toBe(before);
    expect(status()).toContain(`${interactive3dPhaseLabel("ready")} · `);
    expect(status()).not.toMatch(rawStatus);
    // CHEMDRAFT_ENGINE3D_LOG: the press routing reaches the shell's stderr log.
    await vi.waitFor(() => expect(invoke).toHaveBeenCalledWith("engine3d_sidecar_status",
      { diagnostic: expect.stringMatching(/^press 1 at .*: rotate$/) }));
    await vi.waitFor(() => expect(invoke).toHaveBeenCalledWith("engine3d_sidecar_status",
      { diagnostic: "release 1: rotate ended after 1 moves" }));
  });

  it("names the view Esc and Undo close: Interactive 3D canceled, Spin canceled", async () => {
    // Linux 1.2.2 retest: Esc in Interactive 3D left the drawing unchanged but said "Spin canceled".
    const initial = modeledDrawing();
    const ids = getSelectedMolecule(initial)!.atoms.map(atom => atom.id);
    vi.mocked(invoke).mockImplementation(async (name, args) => {
      if (name === "engine3d_sidecar_status") return { available: true, source: "bundled", logEnabled: false };
      if (!name.startsWith("engine3d_sidecar_")) return undefined;
      const line = (args as { lines?: string[] })?.lines?.[0];
      const request = line ? JSON.parse(line) as Engine3DRequest : undefined;
      const output: Engine3dSidecarSessionOutput = { processSessionId: "process", stdoutLines: [], stderr: "", exited: false };
      if (request?.type !== "createSession") return output;
      const envelope = { protocolVersion: Engine3DProtocolVersion, sessionId: "session", requestId: request.requestId };
      output.stdoutLines.push(
        JSON.stringify({ ...envelope, type: "response", ok: true, result: { sessionId: "session" } }),
        JSON.stringify({ ...envelope, type: "event", eventType: "coordinatesChanged", reason: "embed",
          coordinateRevision: 1, coords3dByAtomId: positionMap(ids, seed) })
      );
      return output;
    });
    const escape = () => act(async () => {
      document.body.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }));
    });
    await mount(initial);
    const before = snapshot();

    await command("structure.openInteractive3d");
    await vi.waitFor(() => expect(status()).toContain(`${interactive3dPhaseLabel("ready")} · `));
    expect(overlay()).toBeTruthy();
    await escape();
    expect(overlay()).toBeNull();
    expect(status()).toContain("Interactive 3D canceled");
    expect(status()).not.toContain("Spin");
    expect(snapshot()).toEqual(before);

    // Undo closes Interactive 3D the same way and names it too.
    await command("structure.openInteractive3d");
    await vi.waitFor(() => expect(status()).toContain(`${interactive3dPhaseLabel("ready")} · `));
    expect(overlay()).toBeTruthy();
    await command("edit.undo");
    expect(overlay()).toBeNull();
    expect(status()).toContain("Interactive 3D canceled");
    expect(status()).not.toContain("Spin");
    expect(snapshot()).toEqual(before);

    // Spin 3D on the same molecule, after Interactive 3D has closed, keeps its own wording.
    await command("structure.spin3d");
    await vi.waitFor(() => expect(overlay()).toBeTruthy());
    await escape();
    expect(overlay()).toBeNull();
    expect(status()).toContain("Spin canceled");
    expect(status()).not.toContain("Interactive 3D");
    expect(snapshot()).toEqual(before);

    await command("structure.spin3d");
    await vi.waitFor(() => expect(overlay()).toBeTruthy());
    await command("edit.undo");
    expect(overlay()).toBeNull();
    expect(status()).toContain("Spin canceled");
    expect(status()).not.toContain("Interactive 3D");
    expect(snapshot()).toEqual(before);
  });

  it.each(["outside click", "second grab", "second grab and outside click", "settle timeout",
    "grab during settle timeout", "quick grab after blocked tug"])(
    "handles %s during or after a tug's settle", async action => {
    const grabDuringTimeout = action === "grab during settle timeout";
    const settleTimesOut = action === "settle timeout" || grabDuringTimeout;
    const blockFirstTug = action === "quick grab after blocked tug";
    const initial = modeledDrawing();
    const molecule = getSelectedMolecule(initial)!;
    const ids = molecule.atoms.map(atom => atom.id);
    const pairs: [number, number][] = molecule.bonds.map(bond => [ids.indexOf(bond.fromAtomId), ids.indexOf(bond.toAtomId)]);
    const placement = {
      centerX: molecule.atoms.reduce((sum, a) => sum + a.x, 0) / ids.length,
      centerY: molecule.atoms.reduce((sum, a) => sum + a.y, 0) / ids.length,
      scale: orientedOverlayScale(molecule.atoms, seed, pairs, quatToViewMatrix(orientation))
    };
    const settled = seed.slice();
    settled[1] += 0.28;
    const flipped = seed.slice();
    flipped[1] = -flipped[1];
    const firstGrab = projectSpin(seed, pairs, orientation, placement).atoms[0];
    const secondGrab = projectSpin(settled, pairs, orientation, placement).atoms[0];
    let finishSettle!: () => void;
    let revision = 0;
    let delayedOnce = false;
    let updates = 0;
    const requests: Engine3DRequest[] = [];
    vi.mocked(invoke).mockImplementation(async (name, args) => {
      if (name === "engine3d_sidecar_status") return { available: true, source: "bundled" };
      if (!name.startsWith("engine3d_sidecar_")) return undefined;
      const line = (args as { lines?: string[] })?.lines?.[0];
      const request = line ? JSON.parse(line) as Engine3DRequest : undefined;
      if (request) requests.push(request);
      const output: Engine3dSidecarSessionOutput = { processSessionId: "process", stdoutLines: [], stderr: "", exited: false };
      if (!request) return output;
      const envelope = { protocolVersion: Engine3DProtocolVersion, sessionId: "session", requestId: request.requestId };
      output.stdoutLines.push(JSON.stringify({ ...envelope, type: "response", ok: true, result: { sessionId: "session" } }));
      const emit = (reason: "embed" | "drag" | "settle", coords: Float64Array) => output.stdoutLines.push(JSON.stringify({
        ...envelope, type: "event", eventType: "coordinatesChanged", reason,
        coordinateRevision: ++revision, coords3dByAtomId: positionMap(ids, coords)
      }));
      if (request.type === "createSession") {
        const coordinates = request.input.coords3dByAtomId;
        emit("embed", coordinates?.[ids[0]]?.y === settled[1] ? settled : seed);
      }
      if (request.type === "updateDrag") {
        if (blockFirstTug && updates++ === 0) {
          emit("drag", flipped);
          emit("drag", flipped);
        } else {
          emit("drag", settleTimesOut ? settled : seed);
        }
      }
      if (request.type === "dispose" && settleTimesOut) emit("settle", seed);
      if (request.type === "endDrag") {
        if (!delayedOnce) {
          delayedOnce = true;
          if (settleTimesOut) return output;
          if (!blockFirstTug) await new Promise<void>(resolve => { finishSettle = resolve; });
        }
        emit("settle", settled);
      }
      return output;
    });
    await mount(initial);
    await command("structure.openInteractive3d");
    await vi.waitFor(() => expect(status()).toContain(interactive3dPhaseLabel("ready")));
    const svg = overlay()!;
    svg.getBoundingClientRect = () => rectFor(initial);
    await act(async () => {
      pointer(svg, "pointerdown", firstGrab.sx, firstGrab.sy);
      pointer(svg, "pointermove", firstGrab.sx, firstGrab.sy - 5);
      pointer(svg, "pointerup", firstGrab.sx, firstGrab.sy - 5);
    });
    if (blockFirstTug) {
      expect(status()).toContain("would change its Z geometry");
      expect(requests.map(request => request.type)).toEqual(["createSession", "beginDrag", "updateDrag"]);
      await act(async () => {
        pointer(svg, "pointerdown", firstGrab.sx, firstGrab.sy);
        pointer(svg, "pointermove", firstGrab.sx, firstGrab.sy - 4);
        pointer(svg, "pointerup", firstGrab.sx, firstGrab.sy - 4);
      });
      expect(requests.slice(3).map(request => request.type)).toEqual(["createSession", "beginDrag", "updateDrag", "endDrag"]);
      const update = requests[5];
      expect(update).toMatchObject({ type: "updateDrag", atomId: ids[0] });
      if (update.type === "updateDrag") expect(update.target.y).toBeCloseTo(seed[1] + 4 / placement.scale);
      return;
    }
    expect(requests.map(request => request.type)).toEqual(["createSession", "beginDrag", "updateDrag", "endDrag"]);
    if (settleTimesOut) {
      if (grabDuringTimeout) {
        await act(async () => {
          pointer(svg, "pointerdown", secondGrab.sx, secondGrab.sy);
          pointer(svg, "pointermove", secondGrab.sx + 28, secondGrab.sy - 18);
          pointer(svg, "pointerup", secondGrab.sx + 28, secondGrab.sy - 18);
        });
        expect(requests).toHaveLength(4);
      }
      await act(async () => {
        await vi.waitFor(() => expect(requests.at(-1)?.type).toBe("dispose"), { timeout: 3500 });
      });
      expect(requests.map(request => request.type)).toEqual(["createSession", "beginDrag", "updateDrag", "endDrag", "dispose"]);
      expect.soft(status()).toContain("timed out settling the tug");
      expect(overlay()).toBe(svg);
      if (grabDuringTimeout) {
        await act(async () => pointer(svg, "pointerdown", 20, 20));
        await vi.waitFor(() => expect(overlay()).toBeNull());
        const flattened = getSelectedMolecule(snapshot())!;
        const model = validSpin3dModelFor(flattened)!;
        expect(model.orientation).toEqual(orientation);
        expect(spin3dModelCoordsForMolecule(model, flattened)).toEqual(settled);
        return;
      }
      await command("structure.openInteractive3d");
      await vi.waitFor(() => expect(status()).toContain(interactive3dPhaseLabel("ready")));
      const creates = requests.filter(request => request.type === "createSession");
      expect(creates).toHaveLength(2);
      expect(creates[1].input.coords3dByAtomId).toEqual(positionMap(ids, settled));
      await act(async () => {
        pointer(svg, "pointerdown", secondGrab.sx, secondGrab.sy);
        pointer(svg, "pointerup", secondGrab.sx, secondGrab.sy);
      });
      expect(requests.slice(-2).map(request => request.type)).toEqual(["beginDrag", "endDrag"]);
      return;
    }
    const before = snapshot();
    await act(async () => {
      if (action === "outside click") {
        pointer(svg, "pointerdown", 20, 20);
        pointer(svg, "pointerup", 20, 20);
      } else {
        pointer(svg, "pointerdown", secondGrab.sx, secondGrab.sy);
        pointer(svg, "pointermove", secondGrab.sx, secondGrab.sy - 4);
        pointer(svg, "pointerup", secondGrab.sx, secondGrab.sy - 4);
        pointer(svg, "pointermove", secondGrab.sx, secondGrab.sy - 25, 0);
        if (action === "second grab and outside click") {
          pointer(svg, "pointerdown", 20, 20);
          pointer(svg, "pointerup", 20, 20);
        }
      }
    });
    expect(snapshot()).toEqual(before);
    expect(requests).toHaveLength(4);
    await act(async () => finishSettle());
    if (action === "outside click") {
      await vi.waitFor(() => expect(overlay()).toBeNull());
      const flattened = getSelectedMolecule(snapshot())!;
      expect(spin3dModelCoordsForMolecule(validSpin3dModelFor(flattened)!, flattened)).toEqual(settled);
    } else {
      expect(requests.slice(0, 7).map(request => request.type)).toEqual([
        "createSession", "beginDrag", "updateDrag", "endDrag", "beginDrag", "updateDrag", "endDrag"
      ]);
      const secondUpdate = requests[5];
      expect(secondUpdate).toMatchObject({ type: "updateDrag", atomId: ids[0] });
      if (secondUpdate.type === "updateDrag") expect(secondUpdate.target.y).toBeCloseTo(settled[1] + 4 / placement.scale);
      if (action === "second grab and outside click") {
        await vi.waitFor(() => expect(overlay()).toBeNull());
        const flattened = getSelectedMolecule(snapshot())!;
        expect(spin3dModelCoordsForMolecule(validSpin3dModelFor(flattened)!, flattened)).toEqual(settled);
      }
    }
  });
});
