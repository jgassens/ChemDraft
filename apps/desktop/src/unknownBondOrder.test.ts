// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { createEmptyDocument, moleculeToMolfileV2000, UnknownBondOrderError, type MoleculeObject } from "@chemdraft/chem-core";
import { parseMolfileGraph } from "@chemdraft/clipboard-adapter";
import { depictSmiles2D, perceiveStereoCentersFromMolfile, relayoutMolfile2D } from "@chemdraft/ocl-adapter";
import { testMoleculeFromSmiles } from "@chemdraft/layout-engine/testing";
import { createSmilesMolecule, stereoPerceptionMolfile } from "@chemdraft/document-workflow-core";
import { analysisFacingStructure, copyAsMolfile, applyNativeMoleculeEngineRelayout, flattenSpunMolecule } from "./documentWorkflow";
import { MainWindow, spin3dPrefetchMolfile } from "./MainWindow";
import { AGENT_BRIDGE_GLOBAL_NAME } from "./agentBridge";
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

  it("stores type 8 and surfaces its warning when flattening already supplied coordinates", () => {
    const molecule = unknownMolecule();
    const outcome = flattenSpunMolecule(selectedDocument(molecule), molecule.id, [0, 0, 0, 1, 1, 0, 2, 0, 0], [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);
    expect(outcome.status).toBe("committed");
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
