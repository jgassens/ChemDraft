import { describe, expect, it } from "vitest";
import type { MoleculeObject } from "@chemdraft/chem-core";
import { depictSmiles2D } from "@chemdraft/ocl-adapter";
import {
  Engine3DProtocolVersion,
  formatEngine3DMessage,
  type Engine3DEvent,
  type Engine3DResponse
} from "@chemdraft/engine3d-api";
import {
  createEngine3dSessionInputFromMolecule,
  describeEngine3dWorkspaceSession,
  initialEngine3dCoordsFromMolecule2d,
  reduceEngine3dSidecarOutput,
  type Engine3dSidecarSessionOutput,
  type Engine3dWorkspaceSessionState
} from "./engine3dSidecar";

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
