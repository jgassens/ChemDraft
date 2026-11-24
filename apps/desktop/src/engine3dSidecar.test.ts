import { describe, expect, it, vi } from "vitest";
import { invoke } from "@tauri-apps/api/core";
import type { MoleculeObject } from "@chemdraft/chem-core";
import { parseMolfileGraph } from "@chemdraft/clipboard-adapter";
import { unresolvableAromaticRing } from "@chemdraft/layout-engine/testing";
import { depictSmiles2D } from "@chemdraft/ocl-adapter";
import { ensureRdkit, resetRdkitForTesting } from "@chemdraft/rdkit-adapter";
import { installNodeRdkitModuleLoader } from "@chemdraft/rdkit-adapter/node";
import {
  Engine3DProtocolVersion,
  formatEngine3DMessage,
  type Engine3DCreateSessionRequest,
  type Engine3DEvent,
  type Engine3DResponse,
  type Engine3DSessionInput
} from "@chemdraft/engine3d-api";
import * as conformerClient from "./conformerClient";
import type { ConformerWorkRequest, ConformerWorkResponse } from "./conformerWorkerShared";
import { Spin3dStereoReference } from "./interaction/spin3dStereo";
import {
  createEngine3dSessionInputFromMolecule,
  describeEngine3dWorkspaceSession,
  engine3dCoordsInAtomOrder,
  initialEngine3dCoordsFromMolecule2d,
  openEngine3dWorkspaceSession,
  reduceEngine3dSidecarOutput,
  type Engine3dSidecarSessionOutput,
  type Engine3dWorkspaceSessionState
} from "./engine3dSidecar";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
vi.mock("./rdkitWasmLoader", () => ({ registerRdkitWasmLoader: vi.fn() }));
vi.mock("./chemistry3d/protocol", () => ({ handleChemistry3dRequest: vi.fn() }));

const molecule: MoleculeObject = {
  id: "mol_1",
  type: "molecule",
  x: 0,
  y: 0,
  width: 120,
  height: 40,
  rotation: 0,
  style: {},
  structureFormat: "molfile-v2000",
  structure: "",
  atoms: [
    { id: "a1", element: "C", x: 0, y: 0, formalCharge: 0 },
    { id: "a2", element: "O", x: 40, y: 0, formalCharge: 0 }
  ],
  bonds: [
    { id: "b1", fromAtomId: "a1", toAtomId: "a2", order: "single" }
  ],
  superatoms: [],
  rGroups: []
};

const realStructureSmiles = String.raw`CCN1/C(=C\C=C\C=C\C=C\C2=[N+](C3=C(C2)C=C(C=C3)S(=O)(=O)[O-])CCCCCC(=O)O)/CC4=C1C=CC(=C4)S(=O)(=O)O`;

function moleculeFromSmiles(smiles: string): MoleculeObject {
  const depiction = depictSmiles2D(smiles);
  return {
    id: "mol_real_structure",
    type: "molecule",
    x: 0,
    y: 0,
    width: 360,
    height: 180,
    rotation: 0,
    style: {},
    structureFormat: "molfile-v2000",
    structure: depiction.molfile,
    atoms: depiction.atoms.map((atom, index) => ({
      id: `atom_${index + 1}`,
      element: atom.element,
      x: atom.x,
      y: atom.y,
      formalCharge: atom.charge
    })),
    bonds: depiction.bonds.map((bond, index) => ({
      id: `bond_${index + 1}`,
      fromAtomId: `atom_${bond.from + 1}`,
      toAtomId: `atom_${bond.to + 1}`,
      order: bond.order
    })),
    superatoms: [],
    rGroups: []
  };
}

function benzeneWithTypedAtom(): MoleculeObject {
  const ids = ["a1", "a2", "a3", "a4", "a5", "a6"];
  return {
    id: "mol_benzene",
    type: "molecule",
    x: 0,
    y: 0,
    width: 100,
    height: 100,
    rotation: 0,
    style: {},
    structureFormat: "molfile-v2000",
    structure: "",
    atoms: ids.map((id, index) => ({
      id,
      element: "C",
      x: Math.cos((index / 6) * 2 * Math.PI) * 50,
      y: Math.sin((index / 6) * 2 * Math.PI) * 50,
      formalCharge: 0,
      ...(index === 0 ? { labelLiteral: true } : {})
    })),
    bonds: ids.map((id, index) => ({
      id: `b${index}`, fromAtomId: id, toAtomId: ids[(index + 1) % 6], order: "aromatic" as const
    })),
    superatoms: [],
    rGroups: []
  };
}

function state(): Engine3dWorkspaceSessionState {
  return {
    processSessionId: "process_1",
    requestSerial: 1,
    coordinateRevision: 0,
    selectedAtomIds: [],
    closed: false,
    exited: false,
    warnings: [],
    errors: []
  };
}

function output(stdoutLines: string[]): Engine3dSidecarSessionOutput {
  return {
    processSessionId: "process_1",
    stdoutLines,
    stderr: "",
    exited: false
  };
}

function response(result: unknown): string {
  const message: Engine3DResponse = {
    protocolVersion: Engine3DProtocolVersion,
    type: "response",
    requestId: "r1",
    sessionId: "session_1",
    ok: true,
    result
  };
  return formatEngine3DMessage(message).trimEnd();
}

function distance3d(
  a: { x: number; y: number; z: number },
  b: { x: number; y: number; z: number }
): number {
  const dx = a.x - b.x;
  const dy = a.y - b.y;
  const dz = a.z - b.z;
  return Math.sqrt(dx * dx + dy * dy + dz * dz);
}

function maxBondLength3d(
  mol: MoleculeObject,
  coords: Readonly<Record<string, { x: number; y: number; z: number }>>
): number {
  return Math.max(0, ...mol.bonds.map((bond) => {
    const from = coords[bond.fromAtomId];
    const to = coords[bond.toAtomId];
    return from && to ? distance3d(from, to) : 0;
  }));
}

describe("engine3d sidecar client", () => {
  it("hands unresolved aromatic bonds to the engine as type 4 with one ring warning", () => {
    const warnings: string[] = [];
    const input = createEngine3dSessionInputFromMolecule({ ...molecule, ...unresolvableAromaticRing() }, { warnings });
    expect(parseMolfileGraph(input.molfile).bonds.map((bond) => bond.order)).toEqual(Array(5).fill("aromatic"));
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("atoms u0, u1, u2, u3, u4");
    expect(warnings[0]).toContain("preserved as type 4");
  });
  it("creates graph-guarded session input from a ChemDraft molecule", () => {
    const input = createEngine3dSessionInputFromMolecule(molecule, {
      selectedAtomIds: ["a2"],
      coords3dByAtomId: {
        a1: { x: 0, y: 0, z: 0 },
        a2: { x: 1.4, y: 0, z: 0 }
      }
    });

    expect(input.atomIdByMolfileIndex).toEqual(["a1", "a2"]);
    expect(input.selectedAtomIds).toEqual(["a2"]);
    expect(input.coords3dByAtomId?.a2).toEqual({ x: 1.4, y: 0, z: 0 });
    expect(input.graphSignature).toContain("a1:C");
    expect(input.bondSignature).toBe("a1-a2:single");
    expect(input.molfile).toContain("V2000");
  });

  it("seeds sidecar sessions from normalized 2D coordinates when no spin model exists", () => {
    const coords = initialEngine3dCoordsFromMolecule2d(molecule);
    const input = createEngine3dSessionInputFromMolecule(molecule);

    expect(input.coords3dByAtomId).toEqual(coords);
    expect(distance3d(coords.a1, coords.a2)).toBeGreaterThan(1.44);
    expect(distance3d(coords.a1, coords.a2)).toBeLessThan(1.47);
    expect(coords.a1.z).not.toBe(coords.a2.z);
  });

  it("creates graph-guarded session input from a real charged large structure", () => {
    const realMolecule = moleculeFromSmiles(realStructureSmiles);
    const input = createEngine3dSessionInputFromMolecule(realMolecule, {
      selectedAtomIds: ["atom_2"]
    });

    expect(realMolecule.atoms.length).toBeGreaterThan(40);
    expect(realMolecule.bonds.length).toBeGreaterThan(40);
    expect(input.atomIdByMolfileIndex).toHaveLength(realMolecule.atoms.length);
    expect(input.selectedAtomIds).toEqual(["atom_2"]);
    expect(input.graphSignature).toContain("atom_1:C");
    expect(input.graphSignature).toContain(":S");
    expect(input.bondSignature.split("|")).toHaveLength(realMolecule.bonds.length);
    expect(input.molfile).toContain("V2000");
    expect(maxBondLength3d(realMolecule, input.coords3dByAtomId ?? {})).toBeLessThan(2.4);
  });

  it("gives a typed atom on an aromatic ring its Kekulé valence in the session molfile", () => {
    const input = createEngine3dSessionInputFromMolecule(benzeneWithTypedAtom());
    const lines = input.molfile.split(/\r?\n/);
    const countsLineIndex = lines.findIndex((line) => /V2000$/.test(line));
    // Each benzene carbon takes one single and one double bond in the Kekulé structure it resolves
    // to (sum 3); without kekuleBondOrders the typed atom's valence field would be omitted, letting
    // a reader add a hydrogen the conformer engine should never place.
    expect(lines[countsLineIndex + 1].slice(48, 51)).toBe("  3");
  });

  it("reduces ready output into workspace state", () => {
    const ready: Engine3DEvent = {
      protocolVersion: Engine3DProtocolVersion,
      type: "event",
      eventType: "ready",
      requestId: "ready",
      sessionId: "session_1",
      capabilities: {
        headlessPhysics: true,
        worldSpaceDrag: true,
        frontendRendering: true,
        autoOptimize: true,
        forceField: "UFF"
      },
      coordinateRevision: 0,
      coords3dByAtomId: {
        a1: { x: 0, y: 0, z: 0 },
        a2: { x: 1.4, y: 0, z: 0 }
      }
    };
    const next = reduceEngine3dSidecarOutput(state(), output([
      response({ sessionId: "session_1" }),
      formatEngine3DMessage(ready).trimEnd()
    ]));

    expect(next.sessionId).toBe("session_1");
    expect(next.capabilities?.headlessPhysics).toBe(true);
    expect(Object.keys(next.coords3dByAtomId ?? {})).toEqual(["a1", "a2"]);
    expect(describeEngine3dWorkspaceSession(next)).toContain("2 atoms");
  });

  it("stores atom-keyed coordinates from coordinate-change events", () => {
    const changed: Engine3DEvent = {
      protocolVersion: Engine3DProtocolVersion,
      type: "event",
      eventType: "coordinatesChanged",
      requestId: "drag",
      sessionId: "session_1",
      coordinateRevision: 3,
      reason: "drag",
      coords3dByAtomId: {
        a1: { x: 0.02, y: 0, z: 0 },
        a2: { x: 1.72, y: -0.1, z: 0.003 }
      }
    };
    const next = reduceEngine3dSidecarOutput(state(), output([formatEngine3DMessage(changed).trimEnd()]));

    expect(next.coordinateRevision).toBe(3);
    expect(next.lastCoordinateReason).toBe("drag");
    expect(next.coords3dByAtomId?.a2).toEqual({ x: 1.72, y: -0.1, z: 0.003 });
  });

  it("stores selection changes and records malformed protocol errors", () => {
    const selection: Engine3DEvent = {
      protocolVersion: Engine3DProtocolVersion,
      type: "event",
      eventType: "selectionChanged",
      requestId: "select",
      sessionId: "session_1",
      selectedAtomIds: ["a2"]
    };
    const withSelection = reduceEngine3dSidecarOutput(state(), output([formatEngine3DMessage(selection).trimEnd()]));
    const invalid = reduceEngine3dSidecarOutput(withSelection, output(["not json"]));

    expect(withSelection.selectedAtomIds).toEqual(["a2"]);
    expect(invalid.errors.at(-1)).toContain("not valid JSON");
  });
});

describe("3D Workspace seeding", () => {
  it.each(["worker error", "timeout"])("opens with the original seed and a warning after %s", async (failure) => {
    vi.useFakeTimers();
    const workerPort = new EventTarget();
    const postMessage = vi.fn<(request: ConformerWorkRequest) => void>();
    const worker = conformerClient.createConformerWorkerClient(() =>
      Object.assign(workerPort, { postMessage }) as unknown as Worker
    )!;
    const refineSeed = vi.spyOn(conformerClient, "refineWorkspaceSeed").mockImplementation(worker.refineWorkspaceSeed);
    const received = mockWorkspaceSeedEcho();
    try {
      const input = createEngine3dSessionInputFromMolecule({
        ...molecule,
        atoms: [{ ...molecule.atoms[0], isotope: 13 }, { ...molecule.atoms[1], formalCharge: -1 }]
      }, {
        selectedAtomIds: ["a2"],
        coords3dByAtomId: { a1: { x: 0, y: 0, z: 0.2 }, a2: { x: 1.4, y: 0, z: -0.1 } }
      });
      const warnings = ["Existing warning"];
      const opening = openEngine3dWorkspaceSession({ input, warnings });
      const [request] = postMessage.mock.calls[0];
      expect(request.kind).toBe("refine-workspace-seed");
      if (failure === "timeout") {
        await vi.advanceTimersByTimeAsync(2_999);
        expect(invoke).not.toHaveBeenCalled();
        await vi.advanceTimersByTimeAsync(1);
        expect(postMessage).toHaveBeenLastCalledWith({ kind: "cancel", id: request.id });
      } else {
        workerPort.dispatchEvent(new MessageEvent<ConformerWorkResponse>("message", {
          data: { id: request.id, stage: "error" }
        }));
      }

      const session = await opening;
      expect(received).toEqual([input]);
      expect(session.coords3dByAtomId).toEqual(input.coords3dByAtomId);
      expect(session.warnings).toEqual([
        "Existing warning", "Could not refine the 3D starting shape. The structure may look bent."
      ]);
      expect(warnings).toEqual(["Existing warning"]);
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      refineSeed.mockRestore();
      vi.mocked(invoke).mockReset();
      vi.useRealTimers();
    }
  });

  it("opens porphine with a planar 24-atom macrocycle and preserves an edited seed", async () => {
    installNodeRdkitModuleLoader();
    const scope = new EventTarget();
    const workerPort = new EventTarget();
    const worker = conformerClient.createConformerWorkerClient(() => Object.assign(workerPort, {
      postMessage: (data: ConformerWorkRequest) => {
        queueMicrotask(() => scope.dispatchEvent(new MessageEvent("message", { data })));
      }
    }) as unknown as Worker)!;
    vi.stubGlobal("addEventListener", scope.addEventListener.bind(scope));
    vi.stubGlobal("postMessage", (data: ConformerWorkResponse) => {
      queueMicrotask(() => workerPort.dispatchEvent(new MessageEvent("message", { data })));
    });
    const refineSeed = vi.spyOn(conformerClient, "refineWorkspaceSeed").mockImplementation(worker.refineWorkspaceSeed);

    try {
      const { startConformerWorker } = await import("./conformerWorkerRuntime");
      startConformerWorker();
      const molecule = moleculeFromSmiles(PORPHINE);
      const ids = molecule.atoms.map(atom => atom.id);
      expect(ids).toHaveLength(24);
      const { molfile } = createEngine3dSessionInputFromMolecule(molecule);
      const stereo = new Spin3dStereoReference(await ensureRdkit(), molecule);
      // Fast Spin publishes only the raw embed. Workspace still needs quality geometry.
      const seed = await new Promise<Float64Array>((resolve, reject) => {
        worker.generate(molfile, ids.length, { optimize: "none", seed: 42 }, "rdkit", {
          onEmbedded: (result) => result.embed.status === "ok"
            ? resolve(result.mapping.coords3dByOriginalAtom)
            : reject(new Error(result.embed.failureReason)),
          onRefined: () => undefined,
          onError: (message) => reject(new Error(message))
        });
      });

      const received = mockWorkspaceSeedEcho();
      const open = (coords: Float64Array) => openEngine3dWorkspaceSession({
        input: createEngine3dSessionInputFromMolecule(molecule, {
          coords3dByAtomId: Object.fromEntries(ids.map((id, i) => [id, {
            x: coords[3 * i], y: coords[3 * i + 1], z: coords[3 * i + 2]
          }]))
        }),
        checkStereo: (positions) => stereo.checkGeometry(engine3dCoordsInAtomOrder(ids, positions)!, true)
      });

      const session = await open(seed);
      expect(session.warnings).toEqual([]);
      expect(received[0].molfile).toBe(molfile);
      expect(received[0].atomIdByMolfileIndex).toEqual(ids);
      const result = engine3dCoordsInAtomOrder(ids, session.coords3dByAtomId!);
      expect(bestFitPlaneRms(result!)).toBeLessThan(0.3);

      const edited = seed.slice();
      edited[2] += 0.5;
      const editedSession = await open(edited);
      expect(editedSession.warnings).toEqual([]);
      expect(engine3dCoordsInAtomOrder(ids, editedSession.coords3dByAtomId!)).toEqual(edited);
    } finally {
      vi.unstubAllGlobals();
      refineSeed.mockRestore();
      vi.mocked(invoke).mockReset();
      resetRdkitForTesting();
    }
  }, 20_000);
});

/** Echo the startup request through the protocol without a platform-specific binary. */
function mockWorkspaceSeedEcho(): Engine3DSessionInput[] {
  const received: Engine3DSessionInput[] = [];
  vi.mocked(invoke).mockImplementation(async (command, args) => {
    expect(command).toBe("engine3d_sidecar_start_session");
    const request = JSON.parse((args as { lines: string[] }).lines[0]) as Engine3DCreateSessionRequest;
    received.push(request.input);
    const frame: Engine3DEvent = {
      protocolVersion: Engine3DProtocolVersion,
      requestId: request.requestId,
      sessionId: "session_1",
      type: "event",
      eventType: "coordinatesChanged",
      reason: "initial-relax",
      coords3dByAtomId: request.input.coords3dByAtomId
    };
    return output([formatEngine3DMessage(frame)]);
  });
  return received;
}

const PORPHINE = "C1=CC2=NC1=CC3=CC=C(N3)C=C4C=CC(=N4)C=C5C=CC(=C2)N5";

/** The smallest principal variance is the mean squared distance to the best-fit plane. */
function bestFitPlaneRms(coords: Float64Array): number {
  const count = coords.length / 3;
  const axes = [0, 1, 2].map((axis) => {
    const values = Array.from({ length: count }, (_, index) => coords[3 * index + axis]);
    const mean = values.reduce((sum, value) => sum + value, 0) / count;
    return values.map((value) => value - mean);
  });
  const covariance = axes.map((a) => axes.map((b) =>
    a.reduce((sum, value, index) => sum + value * b[index], 0) / count
  ));
  // Cyclic Jacobi rotations diagonalize the symmetric 3 × 3 covariance matrix.
  for (let sweep = 0; sweep < 12; sweep += 1) {
    for (const [p, q] of [[0, 1], [0, 2], [1, 2]]) {
      if (Math.abs(covariance[p][q]) < 1e-14) continue;
      const angle = Math.atan2(2 * covariance[p][q], covariance[q][q] - covariance[p][p]) / 2;
      const c = Math.cos(angle);
      const s = Math.sin(angle);
      for (const row of covariance) {
        [row[p], row[q]] = [c * row[p] - s * row[q], s * row[p] + c * row[q]];
      }
      for (let column = 0; column < 3; column += 1) {
        const a = covariance[p][column];
        const b = covariance[q][column];
        covariance[p][column] = c * a - s * b;
        covariance[q][column] = s * a + c * b;
      }
    }
  }
  return Math.sqrt(Math.max(0, Math.min(...covariance.map((row, index) => row[index]))));
}
