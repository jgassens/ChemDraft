// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import type { Generate3DConformerResult } from "@chemdraft/chemistry-adapter";
import { createEmptyDocument, moleculeToMolfileV2000, UnknownBondOrderError, type MoleculeObject } from "@chemdraft/chem-core";
import { parseMolfileGraph } from "@chemdraft/clipboard-adapter";
import { depictSmiles2D, perceiveStereoCentersFromMolfile, relayoutMolfile2D } from "@chemdraft/ocl-adapter";
import { testMoleculeFromSmiles } from "@chemdraft/layout-engine/testing";
import { createSmilesMolecule, stereoPerceptionMolfile } from "@chemdraft/document-workflow-core";
import { analysisFacingStructure, copyAsMolfile, applyNativeMoleculeEngineRelayout, flattenSpunMolecule, buildSpin3dModel, SPIN3D_MODEL_KEY } from "./documentWorkflow";
import { MainWindow, spin3dPrefetchMolfile } from "./MainWindow";
import { AGENT_BRIDGE_GLOBAL_NAME, type ChemDraftAgentBridge } from "./agentBridge";
import * as flattenStereoPolicy from "./spin3dFlattenStereoPolicy";
import { createEngine3dSessionInputFromMolecule } from "./engine3dSidecar";
import { pluginFacingStructure } from "./plugins/selectionSnapshot";

const conformer = vi.hoisted(() => ({ generate: vi.fn(), prefetch: vi.fn(), warmup: vi.fn() }));
const analysisWorkerFactory = vi.hoisted(() => vi.fn(() => { throw new Error("Refused analysis attempted to create a worker."); }));
vi.mock("./conformerClient", () => ({ getConformerWorkerClient: () => conformer }));
vi.mock("./analysisClient", async (importOriginal) => {
  const original = await importOriginal<typeof import("./analysisClient")>();
  const client = original.createAnalysisClient(analysisWorkerFactory);
  return { ...original, analysisClient: () => client };
});
vi.mock("@scena/react-ruler", () => ({ default: () => null }));

function unknownMolecule(): MoleculeObject {
  return { id: "unknown-molecule", type: "molecule", x: 100, y: 100, width: 100, height: 100,
    rotation: 0, style: {}, structure: "CCO", structureFormat: "smiles", superatoms: [], rGroups: [],
    ...testMoleculeFromSmiles("CCO"),
    bonds: [
      { id: "b3", fromAtomId: "a0", toAtomId: "a1", order: "unknown" },
      { id: "b7", fromAtomId: "a1", toAtomId: "a2", order: "unknown" }
    ]
  };
}

function selectedDocument(molecule: MoleculeObject) {
  const source = createEmptyDocument();
  source.pages[0]!.objects = [molecule];
  source.selection.objectIds = [molecule.id];
  return source;
}

describe("unknown-order bonds at app boundaries", () => {
  it("skips speculative Spin work and refuses sidecar input with the bond ids", () => {
    const molecule = unknownMolecule();
    expect(spin3dPrefetchMolfile(molecule)).toBeUndefined();
    expect(() => createEngine3dSessionInputFromMolecule(molecule)).toThrow(UnknownBondOrderError);
    expect(() => createEngine3dSessionInputFromMolecule(molecule)).toThrow("Bonds b3, b7 have an unknown bond order.");
  });

  it("returns an analysis refusal instead of an engine input, even with a stored known-order SMILES", () => {
    expect(analysisFacingStructure(unknownMolecule())).toEqual({ structureFormat: "molfile-v3000", structure: "", refusalReason: "Bonds b3, b7 have an unknown bond order." });
  });

  it("also refuses a stored query molfile when no native atom graph is available", () => {
    const molecule = unknownMolecule();
    const structure = moleculeToMolfileV2000(molecule, { kekuleBondOrders: new Map() }).contents;
    expect(analysisFacingStructure({ ...molecule, structureFormat: "molfile-v2000", structure, atoms: [], bonds: [] })).toEqual({
      structureFormat: "molfile-v2000", structure: "", refusalReason: "Bonds bond_001, bond_002 have an unknown bond order."
    });
  });

  it("preserves unknown orders and their warning in stored structure and the protected plugin hand-off", () => {
    const molecule = unknownMolecule();
    const warnings: string[] = [];
    expect(parseMolfileGraph(pluginFacingStructure(molecule, warnings).structure).bonds.every((bond) => bond.order === "unknown")).toBe(true);
    expect(warnings).toEqual([expect.stringContaining("Bonds b3, b7 have an unknown bond order; written as bond type 8 (any)")]);
    const stored = createSmilesMolecule(createEmptyDocument(), { x: 50, y: 50 }, {
      atoms: [{ element: "C", x: 0, y: 0, charge: 0 }, { element: "C", x: 1, y: 0, charge: 0 }],
      bonds: [{ from: 0, to: 1, order: "unknown", wedge: null }]
    }, "C~C");
    expect(stored.type).toBe("molecule");
    if (stored.type !== "molecule") throw new Error("Expected a stored molecule.");
    expect(parseMolfileGraph(stored.structure).bonds[0]!.order).toBe("unknown");
    expect(stored.compatibility?.warnings).toContainEqual(expect.objectContaining({ code: "molfile.stored_structure_lossy", message: expect.stringContaining("Bond b0 has an unknown bond order") }));
  });

  it.each(["v2000", "v3000"] as const)("copies unknown orders as type 8 with a warning (%s)", (flavor) => {
    const warnings: string[] = [];
    const output = copyAsMolfile(selectedDocument(unknownMolecule()), flavor, warnings)!;
    expect(parseMolfileGraph(output).bonds.map((bond) => bond.order)).toEqual(["unknown", "unknown"]);
    expect(warnings).toEqual(["Bonds b3, b7 have an unknown bond order; written as bond type 8 (any), which readers treat as a query bond with no chemical order."]);
  });

  it("cleans up unknown bonds without wedges when the real stereo perceiver is supplied", () => {
    const molecule = unknownMolecule();
    const document = selectedDocument(molecule);
    const warnings: string[] = [];
    const perceiveStereo = vi.fn(perceiveStereoCentersFromMolfile);
    const cleaned = applyNativeMoleculeEngineRelayout(document, molecule.id, relayoutMolfile2D, { warnings, perceiveStereo });
    expect(cleaned).not.toBe(document);
    const updated = cleaned.pages[0]!.objects.find((object): object is MoleculeObject => object.type === "molecule")!;
    expect(updated.bonds.map((bond) => [bond.id, bond.order])).toEqual(molecule.bonds.map((bond) => [bond.id, bond.order]));
    expect(updated.atoms.map((atom) => [atom.x, atom.y])).not.toEqual(molecule.atoms.map((atom) => [atom.x, atom.y]));
    expect(perceiveStereo).not.toHaveBeenCalled();
    expect(warnings).toContainEqual(expect.stringContaining("Bonds b3, b7 have an unknown bond order; written as bond type 8 (any)"));
  });

  it.each(["wedge", "hashed"] as const)("refuses cleanup of unknown bonds with a %s, naming the unknown bond ids", (bondStyle) => {
    const molecule = unknownMolecule();
    molecule.atoms.push({ id: "a3", element: "F", x: 100, y: 150, formalCharge: 0 });
    molecule.bonds.push({ id: "stereo", fromAtomId: "a0", toAtomId: "a3", order: "single", display: { bondStyle } });
    const document = selectedDocument(molecule);
    const before = JSON.stringify(document);
    const cleanup = () => applyNativeMoleculeEngineRelayout(document, molecule.id, relayoutMolfile2D, {
      perceiveStereo: perceiveStereoCentersFromMolfile
    });
    expect(cleanup).toThrow(UnknownBondOrderError);
    expect(cleanup).toThrow("Bonds b3, b7 have an unknown bond order.");
    expect(JSON.stringify(document)).toBe(before);
  });

  it("stores type 8 and surfaces its warning when flattening already supplied coordinates", () => {
    const molecule = unknownMolecule();
    const perceiveStereo = vi.fn(perceiveStereoCentersFromMolfile);
    const outcome = flattenSpunMolecule(selectedDocument(molecule), molecule.id, [0, 0, 0, 1, 1, 0, 2, 0, 0], [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1], { perceiveStereo });
    expect(outcome.status).toBe("committed");
    expect(perceiveStereo).not.toHaveBeenCalled();
    const stored = outcome.document.pages[0]!.objects.find((object): object is MoleculeObject => object.type === "molecule")!;
    expect(parseMolfileGraph(stored.structure).bonds.map((bond) => bond.order)).toEqual(["unknown", "unknown"]);
    expect(outcome.warnings).toContainEqual(expect.objectContaining({ code: "stored-structure-lossy", message: expect.stringContaining("Bonds b3, b7 have an unknown bond order; written as bond type 8 (any)") }));
  });

  it.each(["structure.spin3d", "analyze.molecularProperties"])("shows the %s action's named failure without invoking an engine", async (command) => {
    (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    class TestResizeObserver { observe() {} unobserve() {} disconnect() {} }
    window.ResizeObserver ??= TestResizeObserver;
    globalThis.ResizeObserver ??= TestResizeObserver;
    window.requestAnimationFrame ??= (callback) => window.setTimeout(() => callback(Date.now()), 0);
    window.cancelAnimationFrame ??= (id) => window.clearTimeout(id);
    window.history.replaceState({}, "", "/?agentBridge=1");
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    conformer.generate.mockClear();
    conformer.prefetch.mockClear();
    analysisWorkerFactory.mockClear();
    try {
      await act(async () => root.render(createElement(MainWindow, { initialDocument: selectedDocument(unknownMolecule()), initialPaletteMode: "hidden", initialRulersVisible: false, nativePalette: true })));
      const bridge = window[AGENT_BRIDGE_GLOBAL_NAME];
      expect(bridge).toBeDefined();
      await act(async () => { await bridge!.command(command); });
      expect(container.querySelector('[role="status"]')?.textContent).toContain(`${command === "structure.spin3d" ? "3D spin unavailable: " : ""}Bonds b3, b7 have an unknown bond order.`);
      expect(conformer.generate).not.toHaveBeenCalled();
      expect(conformer.prefetch).not.toHaveBeenCalled();
      expect(analysisWorkerFactory).not.toHaveBeenCalled();
    } finally {
      await act(async () => root.unmount());
      container.remove();
      window.history.replaceState({}, "", "/");
    }
  });
});

describe("persisted Spin models at rotation boundaries", () => {
  function withModel(molecule: MoleculeObject): MoleculeObject {
    return {
      ...molecule,
      compatibility: { warnings: [], unknown: { [SPIN3D_MODEL_KEY]: buildSpin3dModel({
        molecule, coords3d: [0, 0, 0, 1, 1, 0.3, 2, 0, -0.3],
        orientation: { x: 0, y: 0, z: 0, w: 1 }
      }) } }
    };
  }

  async function withRotationWindow(
    molecule: MoleculeObject,
    run: (container: HTMLDivElement, bridge: ChemDraftAgentBridge) => Promise<void>
  ) {
    (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    class TestResizeObserver { observe() {} unobserve() {} disconnect() {} }
    window.ResizeObserver ??= TestResizeObserver;
    globalThis.ResizeObserver ??= TestResizeObserver;
    window.requestAnimationFrame ??= (callback) => window.setTimeout(() => callback(Date.now()), 0);
    window.cancelAnimationFrame ??= (id) => window.clearTimeout(id);
    const pointerMethods = ["setPointerCapture", "releasePointerCapture", "hasPointerCapture"] as const;
    const descriptors = pointerMethods.map((method) => Object.getOwnPropertyDescriptor(HTMLElement.prototype, method));
    HTMLElement.prototype.setPointerCapture = () => {};
    HTMLElement.prototype.releasePointerCapture = () => {};
    HTMLElement.prototype.hasPointerCapture = () => false;
    window.history.replaceState({}, "", "/?agentBridge=1");
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    try {
      await act(async () => root.render(createElement(MainWindow, {
        initialDocument: selectedDocument(molecule), initialPaletteMode: "hidden", initialRulersVisible: false, nativePalette: true
      })));
      const page = container.querySelector<HTMLElement>(".page")!;
      page.getBoundingClientRect = () => ({ x: 0, y: 0, left: 0, top: 0, right: 792, bottom: 612,
        width: 792, height: 612, toJSON: () => ({}) });
      await act(async () => {
        window.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, key: "Shift", shiftKey: true }));
      });
      await run(container, window[AGENT_BRIDGE_GLOBAL_NAME]!);
    } finally {
      await act(async () => root.unmount());
      container.remove();
      window.history.replaceState({}, "", "/");
      delete window[AGENT_BRIDGE_GLOBAL_NAME];
      pointerMethods.forEach((method, index) => {
        const descriptor = descriptors[index];
        if (descriptor) Object.defineProperty(HTMLElement.prototype, method, descriptor);
        else Reflect.deleteProperty(HTMLElement.prototype, method);
      });
    }
  }

  async function rotate(container: HTMLDivElement, axis: "xy" | "z", method: "typed" | "drag") {
    const handle = container.querySelector<HTMLButtonElement>(axis === "xy"
      ? '[data-selection-tilt3d-handle="true"]' : '[data-selection-rotate-handle="true"]');
    expect(handle).not.toBeNull();
    if (method === "typed") {
      await act(async () => { handle!.dispatchEvent(new MouseEvent("dblclick", { bubbles: true })); });
      const input = container.querySelector<HTMLInputElement>(axis === "xy"
        ? '[aria-label="X rotation degrees"]' : '[aria-label="Z rotation degrees"]')!;
      expect(input).not.toBeNull();
      await act(async () => {
        Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, "25");
        input.dispatchEvent(new Event("input", { bubbles: true }));
      });
      await act(async () => {
        container.querySelector('[data-rotation-input-popover="true"]')!
          .dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
      });
    } else {
      const page = container.querySelector<HTMLElement>(".page")!;
      for (const [type, target, x, y] of [
        ["pointerdown", handle!, 160, 100], ["pointermove", page, 180, 130], ["pointerup", page, 180, 130]
      ] as const) {
        await act(async () => {
          const event = new MouseEvent(type, { bubbles: true, cancelable: true, button: 0,
            buttons: type === "pointerup" ? 0 : 1, clientX: x, clientY: y });
          Object.defineProperties(event, { pointerId: { value: 1 }, pointerType: { value: "mouse" }, isPrimary: { value: true } });
          target.dispatchEvent(event);
        });
      }
    }
  }

  it.each([ ["xy", "typed"], ["z", "typed"], ["xy", "drag"], ["z", "drag"] ] as const)(
    "uses the same non-model path for unknown bonds during %s %s rotation", async (axis, method) => {
      const outcomes: unknown[] = [];
      for (const molecule of [unknownMolecule(), withModel(unknownMolecule())]) {
        await withRotationWindow(molecule, async (container, bridge) => {
          const before = bridge.snapshot().document.pages[0]!.objects[0]!;
          const beforeModel = before.compatibility?.unknown?.[SPIN3D_MODEL_KEY];
          await rotate(container, axis, method);
          const after = bridge.snapshot().document.pages[0]!.objects[0]!;
          const { compatibility: _beforeCompatibility, ...beforeWithoutCompatibility } = before;
          const { compatibility: _afterCompatibility, ...afterWithoutCompatibility } = after;
          expect(afterWithoutCompatibility).not.toEqual(beforeWithoutCompatibility);
          if (axis === "z" && beforeModel) {
            expect(JSON.stringify(after.compatibility?.unknown?.[SPIN3D_MODEL_KEY]))
              .toBe(JSON.stringify(beforeModel));
          }
          outcomes.push(afterWithoutCompatibility);
        });
      }
      expect(outcomes[1]).toEqual(outcomes[0]);
    }
  );

  it("refuses an overlay flatten when stereo perception reports unknown bond orders", async () => {
    const molecule = unknownMolecule();
    molecule.bonds = molecule.bonds.map((bond) => ({ ...bond, order: "single" }));
    const policy = vi.spyOn(flattenStereoPolicy, "buildSpin3dFlattenStereoOptions").mockImplementation(() => {
      throw new UnknownBondOrderError(["b3", "b7"]);
    });
    let onEmbedded: ((result: Generate3DConformerResult) => void) | undefined;
    conformer.generate.mockImplementation((_molfile, _atomCount, _options, _engine, handlers) => {
      onEmbedded = handlers.onEmbedded;
      return () => {};
    });
    try {
      await withRotationWindow(molecule, async (container, bridge) => {
        const before = bridge.snapshot().document;
        await act(async () => { await bridge.command("structure.spin3d"); });
        await act(async () => {
          onEmbedded?.({
            mapping: {
              coords3dByOriginalAtom: new Float64Array([0, 0, 0, 1, 0.5, 0.25, 2, 0, -0.25]),
              originalToEngineAtom: [0, 1, 2], engineToOriginalAtom: [0, 1, 2], generatedHydrogenEngineAtoms: []
            },
            originalAtomCount: 3, generatedAtomCount: 3,
            hydrogens: { added: false, explicitInputHydrogensPreserved: false },
            embed: { status: "ok" }, forceField: { name: "UFF", status: "converged", iterations: 1 },
            engine: { name: "openchemlib", version: "test", parameters: {} }, unsupportedFeatures: [], warnings: []
          });
          await new Promise((resolve) => setTimeout(resolve, 0));
        });
        const overlay = container.querySelector<SVGSVGElement>('[data-spin3d-overlay="true"]');
        expect(overlay).not.toBeNull();
        const originalElementFromPoint = document.elementFromPoint;
        Object.defineProperty(document, "elementFromPoint", { configurable: true, value: vi.fn(() => overlay) });
        try {
          await act(async () => {
            bridge.pointerDown({ page: { x: 1, y: 1 } }, { pointerId: 91, buttons: 1 });
            await bridge.waitForIdle();
          });
        } finally {
          if (originalElementFromPoint) {
            Object.defineProperty(document, "elementFromPoint", { configurable: true, value: originalElementFromPoint });
          } else {
            Reflect.deleteProperty(document, "elementFromPoint");
          }
        }
        expect(policy).toHaveBeenCalled();
        expect(container.querySelector('[role="status"]')?.textContent)
          .toContain("Cannot flatten this view: Bonds b3, b7 have an unknown bond order.");
        expect(bridge.snapshot().document).toEqual(before);
        expect(bridge.snapshot().file.dirty).toBe(false);
        expect(container.querySelector('[data-spin3d-overlay="true"]')).not.toBeNull();
      });
    } finally {
      policy.mockRestore();
      conformer.generate.mockReset();
    }
  });

  it.each(["typed", "drag"] as const)("reports an unknown-order guard error and commits nothing during %s rotation", async (method) => {
    const molecule = unknownMolecule();
    molecule.bonds = molecule.bonds.map((bond) => ({ ...bond, order: "single" }));
    const policy = vi.spyOn(flattenStereoPolicy, "buildSpin3dFlattenStereoOptions").mockImplementation(() => {
      throw new UnknownBondOrderError(["b3", "b7"]);
    });
    try {
      await withRotationWindow(withModel(molecule), async (container, bridge) => {
        const before = bridge.snapshot().document;
        await rotate(container, "xy", method);
        expect(policy).toHaveBeenCalled();
        expect(container.querySelector('[role="status"]')?.textContent)
          .toContain("3D rotation not applied: Bonds b3, b7 have an unknown bond order.");
        expect(bridge.snapshot().document).toEqual(before);
        expect(bridge.snapshot().file.dirty).toBe(false);
        await act(async () => { await bridge.command("edit.undo"); });
        expect(bridge.snapshot().document).toEqual(before);
      });
    } finally {
      policy.mockRestore();
    }
  });
});

describe("OpenChemLib type-8 stereo and geometry evidence", () => {
  it("loses a distant tetrahedral label on type 8, so CIP input refuses it", () => {
    const graph = parseMolfileGraph(depictSmiles2D("F[C@H](Cl)CCCC").molfile);
    const known: MoleculeObject = { id: "ocl-evidence", type: "molecule", x: 0, y: 0, width: 100, height: 100,
      rotation: 0, style: {}, structure: "", structureFormat: "molfile-v2000", superatoms: [], rGroups: [],
      ...testMoleculeFromSmiles("FC(Cl)CCCC"),
      atoms: graph.atoms.map((atom) => ({ ...atom, y: -atom.y })),
      bonds: graph.bonds.map(({ bondStyle, ...bond }) => ({ ...bond, ...(bondStyle ? { display: { bondStyle } } : {}) }))
    };
    const unknown = { ...known, bonds: known.bonds.map((bond, index) => index === known.bonds.length - 1 ? { ...bond, order: "unknown" as const } : bond) };
    const singleMolfile = stereoPerceptionMolfile(known);
    const warnings: string[] = [];
    const anyMolfile = moleculeToMolfileV2000(unknown, { fromDocFrame: true, kekuleBondOrders: new Map(), warnings }).contents;
    expect(anyMolfile).toMatch(/^.{6}  8/m);
    const before = perceiveStereoCentersFromMolfile(singleMolfile);
    expect(before.some((atom) => atom.isStereoCenter)).toBe(true);
    expect(before[1]).toEqual({ isStereoCenter: true, descriptor: "R" });
    expect(perceiveStereoCentersFromMolfile(anyMolfile)[1]).toEqual({ isStereoCenter: true, descriptor: "unspecified" });
    expect(() => stereoPerceptionMolfile(unknown)).toThrow(UnknownBondOrderError);
    const write = (target: typeof known) => moleculeToMolfileV2000(target, { fromDocFrame: true, kekuleBondOrders: new Map() }).contents;
    const layoutBefore = relayoutMolfile2D(write(known));
    const layoutAfter = relayoutMolfile2D(write(unknown));
    expect(layoutAfter.atoms).toEqual(layoutBefore.atoms);
    expect(layoutAfter.bonds).toEqual(layoutBefore.bonds);
    const relayoutWarnings: string[] = [];
    const laidOut = applyNativeMoleculeEngineRelayout(selectedDocument(unknown), unknown.id, relayoutMolfile2D, { warnings: relayoutWarnings });
    const updated = laidOut.pages[0]!.objects.find((object): object is MoleculeObject => object.id === unknown.id && object.type === "molecule")!;
    expect(updated.bonds.map((bond) => bond.order)).toEqual(unknown.bonds.map((bond) => bond.order));
    expect(relayoutWarnings).toEqual([expect.stringContaining("bond type 8 (any)")]);
    expect(warnings).toEqual([expect.stringContaining("bond type 8 (any)")]);
  });
});
