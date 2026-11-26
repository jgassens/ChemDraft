import { invoke } from "@tauri-apps/api/core";
import type { MoleculeObject } from "@chemdraft/chem-core";
import { Engine3DProtocolVersion, type Engine3DCoordinate, type Engine3DRequest } from "@chemdraft/engine3d-api";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  beginEngine3dWorkspaceDrag,
  createEngine3dSessionInputFromMolecule,
  describeEngine3dWorkspaceSession,
  endEngine3dWorkspaceDrag,
  logEngine3dDiagnostic,
  openEngine3dWorkspaceSession,
  readEngine3dSidecarStatus,
  updateEngine3dWorkspaceDrag
} from "./engine3dSidecar";
import { interactive3dPhaseLabel, interactive3dSessionStatus, spin3dViewCanceledStatus } from "./interactive3dStatus";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));

// Ethanol, the molecule of the Linux 1.2.2 B8 report.
const ethanol: MoleculeObject = {
  id: "mol_ethanol",
  type: "molecule",
  x: 0,
  y: 0,
  width: 52,
  height: 15,
  rotation: 0,
  style: {},
  structureFormat: "molfile-v2000",
  structure: "",
  atoms: [
    { id: "c1", element: "C", x: 0, y: 15, formalCharge: 0 },
    { id: "c2", element: "C", x: 26, y: 0, formalCharge: 0 },
    { id: "o3", element: "O", x: 52, y: 15, formalCharge: 0 }
  ],
  bonds: [
    { id: "b1", fromAtomId: "c1", toAtomId: "c2", order: "single" },
    { id: "b2", fromAtomId: "c2", toAtomId: "o3", order: "single" }
  ],
  superatoms: [],
  rGroups: []
};

const relaxed: Record<string, Engine3DCoordinate> = {
  c1: { x: -1.27, y: -0.42, z: 0 }, c2: { x: 0, y: 0.35, z: 0.02 }, o3: { x: 1.2, y: -0.4, z: -0.01 }
};
const pulled: Record<string, Engine3DCoordinate> = { ...relaxed, o3: { x: 1.6, y: 0.3, z: 0.4 } };
const settled: Record<string, Engine3DCoordinate> = { ...relaxed, o3: { x: 1.15, y: -0.35, z: 0.3 } };

/** The sidecar's side of the protocol, as the shell hands it to the webview (one batch per call). */
function fakeSidecar(failDrag = false) {
  const requests: Engine3DRequest[] = [];
  let revision = 0;
  vi.mocked(invoke).mockImplementation(async (name, args) => {
    if (name === "engine3d_sidecar_status") return { available: true, source: "bundled", logEnabled: false };
    const line = (args as { lines?: string[] } | undefined)?.lines?.[0];
    const request = line ? JSON.parse(line) as Engine3DRequest : undefined;
    if (request) requests.push(request);
    const reply = (message: object) => JSON.stringify({
      protocolVersion: Engine3DProtocolVersion, sessionId: "session", requestId: request?.requestId ?? "poll", ...message
    });
    const coordinates = (reason: string, coords3dByAtomId: Record<string, Engine3DCoordinate>) =>
      reply({ type: "event", eventType: "coordinatesChanged", reason, coordinateRevision: ++revision, coords3dByAtomId });
    const stdoutLines: string[] = [];
    if (request?.type === "createSession") {
      stdoutLines.push(
        reply({ type: "response", ok: true, result: { sessionId: "session" } }),
        reply({ type: "event", eventType: "ready", coordinateRevision: 0, coords3dByAtomId: request.input.coords3dByAtomId,
          capabilities: { headlessPhysics: true, worldSpaceDrag: true, frontendRendering: true, autoOptimize: true, forceField: "UFF" } }),
        coordinates("initial-relax", relaxed)
      );
    } else if (request?.type === "beginDrag") {
      stdoutLines.push(reply({ type: "response", ok: true, result: { draggedAtomId: request.atomId } }));
    } else if (request?.type === "updateDrag") {
      stdoutLines.push(failDrag
        ? reply({ type: "response", ok: false, error: "Unknown dragged atom id." })
        : reply({ type: "response", ok: true }), coordinates("drag", pulled));
    } else if (request?.type === "endDrag") {
      stdoutLines.push(reply({ type: "response", ok: true }), coordinates("settle", settled));
    }
    return { processSessionId: "process", stdoutLines, stderr: "", exited: false };
  });
  return requests;
}

function openEthanol() {
  return openEngine3dWorkspaceSession({
    input: createEngine3dSessionInputFromMolecule(ethanol),
    checkStereo: () => undefined
  });
}

const ready = interactive3dPhaseLabel("ready");
const rawStatus = /tug-ready|attaching|coord rev|beginDrag|updateDrag|endDrag/;

describe("Interactive 3D status line", () => {
  beforeEach(() => {
    vi.mocked(invoke).mockReset();
  });

  it("reads as instructions once the fake sidecar session is ready, during a pull and after it settles", async () => {
    const requests = fakeSidecar();
    let session = await openEthanol();
    expect(interactive3dSessionStatus(session)).toBe(ready);
    expect(ready).toContain("Drag empty space to rotate");
    expect(ready).toContain("click outside to flatten");

    session = await beginEngine3dWorkspaceDrag(session, "o3");
    session = await updateEngine3dWorkspaceDrag(session, "o3", { x: 1.6, y: 0.3, z: 0.4 });
    expect(interactive3dSessionStatus(session, "pulling")).toBe(interactive3dPhaseLabel("pulling"));
    session = await endEngine3dWorkspaceDrag(session, "o3");
    expect(requests.map(request => request.type)).toEqual(["createSession", "beginDrag", "updateDrag", "endDrag"]);
    expect(session.coords3dByAtomId).toEqual(settled);

    // What the status line used to show after a release; it now goes only to the diagnostic log.
    expect(describeEngine3dWorkspaceSession(session)).toBe("3 atoms · coord rev 3 · settle");
    const status = interactive3dSessionStatus(session);
    expect(status).toBe(ready);
    expect(status).not.toMatch(rawStatus);
  });

  it("shows the sidecar's error instead of the instructions", async () => {
    fakeSidecar(true);
    let session = await openEthanol();
    session = await beginEngine3dWorkspaceDrag(session, "o3");
    session = await updateEngine3dWorkspaceDrag(session, "o3", { x: 1.6, y: 0.3, z: 0.4 });
    expect(interactive3dSessionStatus(session, "pulling")).toBe("Unknown dragged atom id.");
  });

  it("names the view Esc closes", () => {
    // Linux 1.2.2 retest: Esc in Interactive 3D said "Spin canceled".
    expect(spin3dViewCanceledStatus(true)).toBe("Interactive 3D canceled");
    expect(spin3dViewCanceledStatus(false)).toBe("Spin canceled");
  });
});

describe("CHEMDRAFT_ENGINE3D_LOG diagnostic from the webview", () => {
  beforeEach(() => {
    vi.mocked(invoke).mockReset();
  });

  it("sends nothing unless the shell reported the log enabled", async () => {
    vi.mocked(invoke).mockResolvedValue({ available: true, source: "bundled", logEnabled: false });
    await readEngine3dSidecarStatus();
    logEngine3dDiagnostic("press 1 at 10.0, 10.0: rotate");
    await new Promise(resolve => setTimeout(resolve, 20));
    expect(invoke).toHaveBeenCalledTimes(1);
    expect(invoke).toHaveBeenCalledWith("engine3d_sidecar_status");

    vi.mocked(invoke).mockResolvedValue({ available: true, source: "bundled", logEnabled: true });
    await readEngine3dSidecarStatus();
    logEngine3dDiagnostic("press 1 at 10.0, 10.0: rotate");
    await vi.waitFor(() => expect(invoke).toHaveBeenCalledWith(
      "engine3d_sidecar_status", { diagnostic: "press 1 at 10.0, 10.0: rotate" }));
  });
});
