import { moleculeToMolfileV2000, type MoleculeObject } from "@chemdraft/chem-core";
import {
  Engine3DProtocolVersion,
  createEngine3DBondSignature,
  createEngine3DGraphSignature,
  formatEngine3DMessage,
  parseEngine3DMessageLine,
  type Engine3DBeginDragRequest,
  type Engine3DCoordinate,
  type Engine3DCoordinateReason,
  type Engine3DCreateSessionRequest,
  type Engine3DEndDragRequest,
  type Engine3DEvent,
  type Engine3DForceFieldReport,
  type Engine3DReadyCapabilities,
  type Engine3DRequest,
  type Engine3DSessionInput,
  type Engine3DSessionRequest,
  type Engine3DUpdateDragRequest
} from "@chemdraft/engine3d-api";

export interface Engine3dSidecarStatus {
  available: boolean;
  protocolVersion: number;
  source: "environment" | "bundled" | "missing" | string;
  envVar: string;
  envOverridePath?: string;
  resolvedPath?: string;
  bundledBinaryName: string;
  targetTriple: string;
}

export interface Engine3dSidecarSessionOutput {
  processSessionId: string;
  stdoutLines: string[];
  stderr: string;
  exited: boolean;
  exitCode?: number;
}

export interface Engine3dWorkspaceSessionState {
  processSessionId: string;
  sessionId?: string;
  requestSerial: number;
  capabilities?: Engine3DReadyCapabilities;
  coords3dByAtomId?: Readonly<Record<string, Engine3DCoordinate>>;
  coordinateRevision: number;
  lastCoordinateReason?: Engine3DCoordinateReason;
  energy?: number;
  forceField?: Engine3DForceFieldReport;
  stderr?: string;
  closed: boolean;
  exited: boolean;
  exitCode?: number;
  selectedAtomIds: readonly string[];
  warnings: string[];
  errors: string[];
}

export interface Engine3dWorkspaceStartOptions {
  input: Engine3DSessionInput;
}

export interface Engine3dMoleculeSessionOptions {
  selectedAtomIds?: readonly string[];
  coords3dByAtomId?: Readonly<Record<string, Engine3DCoordinate>>;
}

const Engine3dWorkspaceReadyTimeoutMs = 12_000;
const Engine3dWorkspaceReadyPollMs = 80;

export async function readEngine3dSidecarStatus(): Promise<Engine3dSidecarStatus | undefined> {
  try {
    const { invoke } = await import("@tauri-apps/api/core");
    return await invoke<Engine3dSidecarStatus>("engine3d_sidecar_status");
  } catch {
    return undefined;
  }
}

export async function startEngine3dSidecarSession(lines: string[] = []): Promise<Engine3dSidecarSessionOutput> {
  const { invoke } = await import("@tauri-apps/api/core");
  return await invoke<Engine3dSidecarSessionOutput>("engine3d_sidecar_start_session", { lines });
}

export async function sendEngine3dSidecarSession(
  processSessionId: string,
  lines: string[]
): Promise<Engine3dSidecarSessionOutput> {
  const { invoke } = await import("@tauri-apps/api/core");
  return await invoke<Engine3dSidecarSessionOutput>("engine3d_sidecar_send_session", { processSessionId, lines });
}

export async function pollEngine3dSidecarSession(processSessionId: string): Promise<Engine3dSidecarSessionOutput> {
  const { invoke } = await import("@tauri-apps/api/core");
  return await invoke<Engine3dSidecarSessionOutput>("engine3d_sidecar_poll_session", { processSessionId });
}

export async function stopEngine3dSidecarSession(processSessionId: string): Promise<Engine3dSidecarSessionOutput> {
  const { invoke } = await import("@tauri-apps/api/core");
  return await invoke<Engine3dSidecarSessionOutput>("engine3d_sidecar_stop_session", { processSessionId });
}

export function createEngine3dSessionInputFromMolecule(
  molecule: MoleculeObject,
  options: Engine3dMoleculeSessionOptions = {}
): Engine3DSessionInput {
  const atomIdByMolfileIndex = molecule.atoms.map((atom) => atom.id);
  const bonds = molecule.bonds.map((bond) => ({
    id: bond.id,
    fromAtomId: bond.fromAtomId,
    toAtomId: bond.toAtomId,
    order: bond.order
  }));

  return {
    molfile: moleculeToMolfileV2000(molecule, { fromDocFrame: true }),
    format: "molfile-v2000",
    atomIdByMolfileIndex,
    graphSignature: createEngine3DGraphSignature({
      atoms: molecule.atoms.map((atom) => ({ id: atom.id, element: atom.element })),
      bonds
    }),
    bondSignature: createEngine3DBondSignature(bonds),
    selectedAtomIds: options.selectedAtomIds,
    coords3dByAtomId: options.coords3dByAtomId ?? initialEngine3dCoordsFromMolecule2d(molecule)
  };
}

export async function openEngine3dWorkspaceSession(
  options: Engine3dWorkspaceStartOptions
): Promise<Engine3dWorkspaceSessionState> {
  const createRequest: Engine3DCreateSessionRequest = {
    protocolVersion: Engine3DProtocolVersion,
    type: "createSession",
    requestId: "engine3d-1",
    input: options.input
  };
  const started = await startEngine3dSidecarSession([engine3dProtocolLine(createRequest)]);
  let state = reduceEngine3dSidecarOutput(createInitialEngine3dWorkspaceSessionState(started.processSessionId), started);
  if (engine3dWorkspaceSessionSettled(state)) {
    return finalizeEngine3dWorkspaceSession(state);
  }

  const deadline = Date.now() + Engine3dWorkspaceReadyTimeoutMs;
  while (Date.now() < deadline) {
    await sleepEngine3dWorkspaceReadyPoll();
    state = reduceEngine3dSidecarOutput(state, await pollEngine3dSidecarSession(state.processSessionId));
    if (engine3dWorkspaceSessionSettled(state)) {
      return finalizeEngine3dWorkspaceSession(state);
    }
  }

  try {
    state = reduceEngine3dSidecarOutput(state, await stopEngine3dSidecarSession(state.processSessionId));
  } catch {
    // The session may have exited while the renderer was waiting for startup output.
  }
  throw new Error(`Interactive 3D sidecar did not become ready within ${Engine3dWorkspaceReadyTimeoutMs / 1000} seconds.`);
}

export async function pollEngine3dWorkspaceSessionState(
  state: Engine3dWorkspaceSessionState
): Promise<Engine3dWorkspaceSessionState> {
  if (state.closed || state.exited) {
    return state;
  }
  return reduceEngine3dSidecarOutput(state, await pollEngine3dSidecarSession(state.processSessionId));
}

export async function beginEngine3dWorkspaceDrag(
  state: Engine3dWorkspaceSessionState,
  atomId: string
): Promise<Engine3dWorkspaceSessionState> {
  if (!state.sessionId || state.closed || state.exited) {
    return state;
  }
  const request: Engine3DBeginDragRequest = {
    protocolVersion: Engine3DProtocolVersion,
    type: "beginDrag",
    requestId: nextEngine3dRequestId(state),
    sessionId: state.sessionId,
    atomId
  };
  return sendEngine3dWorkspaceRequest(state, request);
}

export async function updateEngine3dWorkspaceDrag(
  state: Engine3dWorkspaceSessionState,
  atomId: string,
  target: Engine3DCoordinate
): Promise<Engine3dWorkspaceSessionState> {
  if (!state.sessionId || state.closed || state.exited) {
    return state;
  }
  const request: Engine3DUpdateDragRequest = {
    protocolVersion: Engine3DProtocolVersion,
    type: "updateDrag",
    requestId: nextEngine3dRequestId(state),
    sessionId: state.sessionId,
    atomId,
    target
  };
  return sendEngine3dWorkspaceRequest(state, request);
}

export async function endEngine3dWorkspaceDrag(
  state: Engine3dWorkspaceSessionState,
  atomId: string,
  cancelled = false
): Promise<Engine3dWorkspaceSessionState> {
  if (!state.sessionId || state.closed || state.exited) {
    return state;
  }
  const request: Engine3DEndDragRequest = {
    protocolVersion: Engine3DProtocolVersion,
    type: "endDrag",
    requestId: nextEngine3dRequestId(state),
    sessionId: state.sessionId,
    atomId,
    cancelled
  };
  return sendEngine3dWorkspaceRequest(state, request);
}

export async function closeEngine3dWorkspaceSession(
  state: Engine3dWorkspaceSessionState
): Promise<Engine3dWorkspaceSessionState> {
  let nextState = state;
  if (state.sessionId && !state.closed && !state.exited) {
    const request: Engine3DSessionRequest = {
      protocolVersion: Engine3DProtocolVersion,
      type: "dispose",
      requestId: nextEngine3dRequestId(state),
      sessionId: state.sessionId
    };
    nextState = { ...nextState, requestSerial: nextState.requestSerial + 1 };
    try {
      nextState = reduceEngine3dSidecarOutput(
        nextState,
        await sendEngine3dSidecarSession(state.processSessionId, [engine3dProtocolLine(request)])
      );
    } catch (error) {
      nextState = appendEngine3dSessionError(nextState, String(error));
    }
  }
  try {
    return reduceEngine3dSidecarOutput(nextState, await stopEngine3dSidecarSession(state.processSessionId));
  } catch (error) {
    return appendEngine3dSessionError({ ...nextState, closed: true }, String(error));
  }
}

export function reduceEngine3dSidecarOutput(
  state: Engine3dWorkspaceSessionState,
  output: Engine3dSidecarSessionOutput
): Engine3dWorkspaceSessionState {
  let nextState: Engine3dWorkspaceSessionState = {
    ...state,
    processSessionId: output.processSessionId,
    stderr: output.stderr ? appendEngine3dText(state.stderr, output.stderr) : state.stderr,
    exited: output.exited,
    exitCode: output.exitCode
  };

  for (const line of output.stdoutLines) {
    const parsed = parseEngine3DMessageLine(line);
    if (!parsed.ok) {
      nextState = appendEngine3dSessionError(nextState, parsed.error);
      continue;
    }
    nextState = reduceEngine3dMessage(nextState, parsed.message);
  }

  return nextState;
}

export function describeEngine3dWorkspaceSession(state: Engine3dWorkspaceSessionState): string {
  if (state.errors.length > 0) {
    return state.errors.at(-1) ?? "Engine 3D protocol error";
  }
  if (state.coords3dByAtomId) {
    const reason = state.lastCoordinateReason ? ` · ${state.lastCoordinateReason}` : "";
    return `${Object.keys(state.coords3dByAtomId).length} atoms · coord rev ${state.coordinateRevision}${reason}`;
  }
  if (state.capabilities?.headlessPhysics) {
    return "Sidecar ready for headless physics";
  }
  return state.sessionId ? "Sidecar session ready" : "Starting sidecar session";
}

export function initialEngine3dCoordsFromMolecule2d(
  molecule: MoleculeObject
): Readonly<Record<string, Engine3DCoordinate>> {
  if (molecule.atoms.length === 0) {
    return {};
  }
  const centroid = molecule.atoms.reduce((acc, atom) => ({
    x: acc.x + atom.x,
    y: acc.y + atom.y
  }), { x: 0, y: 0 });
  centroid.x /= molecule.atoms.length;
  centroid.y /= molecule.atoms.length;

  const medianBondLength = medianEngine3dBondLength2d(molecule);
  const scale = medianBondLength > 1e-6 && Number.isFinite(medianBondLength)
    ? 1.45 / medianBondLength
    : 1;

  return Object.fromEntries(molecule.atoms.map((atom, index) => [
    atom.id,
    {
      x: (atom.x - centroid.x) * scale,
      y: -(atom.y - centroid.y) * scale,
      z: ((index % 7) - 3) * 0.045
    }
  ]));
}

function reduceEngine3dMessage(
  state: Engine3dWorkspaceSessionState,
  message: Engine3DRequest | Engine3DEvent | { type: "response"; ok: boolean; result?: unknown; error?: string; sessionId?: string }
): Engine3dWorkspaceSessionState {
  if (message.sessionId && !state.sessionId) {
    state = { ...state, sessionId: message.sessionId };
  }

  if (message.type === "response") {
    if (!message.ok) {
      return appendEngine3dSessionError(state, message.error ?? "Engine 3D sidecar returned an error.");
    }
    const result = isRecord(message.result) ? message.result : {};
    const sessionId = typeof result?.sessionId === "string" ? result.sessionId : state.sessionId;
    return {
      ...state,
      sessionId
    };
  }

  if (message.type !== "event") {
    return state;
  }

  switch (message.eventType) {
    case "ready":
      return {
        ...state,
        capabilities: message.capabilities ?? state.capabilities,
        coords3dByAtomId: message.coords3dByAtomId ?? state.coords3dByAtomId,
        coordinateRevision: message.coordinateRevision ?? state.coordinateRevision
      };
    case "coordinatesChanged":
      return {
        ...state,
        coords3dByAtomId: message.coords3dByAtomId ?? state.coords3dByAtomId,
        coordinateRevision: message.coordinateRevision ?? state.coordinateRevision,
        lastCoordinateReason: message.reason ?? state.lastCoordinateReason
      };
    case "energyChanged":
      return {
        ...state,
        // Preserve the last known energy when a frame omits it (a non-finite UFF energy is emitted
        // without the field) instead of clearing the readout, matching the ?? merge used elsewhere.
        energy: message.energy ?? state.energy,
        forceField: message.forceField ?? state.forceField
      };
    case "selectionChanged":
      return {
        ...state,
        selectedAtomIds: message.selectedAtomIds ?? state.selectedAtomIds
      };
    case "warning":
      return {
        ...state,
        warnings: message.message ? [...state.warnings, message.message] : state.warnings
      };
    case "error":
      return appendEngine3dSessionError(state, message.message ?? "Engine 3D sidecar emitted an error.");
    case "closed":
      return {
        ...state,
        closed: true
      };
    case "heartbeat":
      return state;
    default:
      // Fail closed on an unknown/typoed event variant (protocol drift) rather than falling off
      // the switch and returning undefined, which would corrupt the session state to undefined.
      return state;
  }
}

function createInitialEngine3dWorkspaceSessionState(processSessionId: string): Engine3dWorkspaceSessionState {
  return {
    processSessionId,
    requestSerial: 2,
    coordinateRevision: 0,
    selectedAtomIds: [],
    closed: false,
    exited: false,
    warnings: [],
    errors: []
  };
}

/**
 * The startup poll stops once the session has SETTLED: either it produced coordinates (usable) or
 * it reached a terminal failure (error / closed / exited). "Settled" is not the same as "usable" —
 * see finalizeEngine3dWorkspaceSession, which decides success vs. failure.
 */
function engine3dWorkspaceSessionSettled(state: Engine3dWorkspaceSessionState): boolean {
  return Boolean(
    state.coords3dByAtomId ||
    state.errors.length > 0 ||
    state.closed ||
    state.exited
  );
}

/**
 * Resolve a settled session ONLY when it is actually usable — coordinates arrived and the native
 * process is still alive. Otherwise throw, so the caller reports a clean startup failure instead of
 * marking a dead/errored session tug-ready (a later drag would then no-op against a gone process).
 */
function finalizeEngine3dWorkspaceSession(
  state: Engine3dWorkspaceSessionState
): Engine3dWorkspaceSessionState {
  if (state.coords3dByAtomId && state.errors.length === 0 && !state.exited && !state.closed) {
    return state;
  }
  const detail = state.errors.at(-1)
    ?? (state.exited
      ? "the sidecar process exited before sending coordinates"
      : state.closed
        ? "the sidecar session closed before sending coordinates"
        : "the sidecar produced no coordinates");
  throw new Error(`Interactive 3D sidecar failed to start: ${detail}`);
}

function sleepEngine3dWorkspaceReadyPoll(): Promise<void> {
  return new Promise((resolve) => globalThis.setTimeout(resolve, Engine3dWorkspaceReadyPollMs));
}

async function sendEngine3dWorkspaceRequest(
  state: Engine3dWorkspaceSessionState,
  request: Engine3DRequest
): Promise<Engine3dWorkspaceSessionState> {
  const nextState = { ...state, requestSerial: state.requestSerial + 1 };
  const output = await sendEngine3dSidecarSession(state.processSessionId, [engine3dProtocolLine(request)]);
  return reduceEngine3dSidecarOutput(nextState, output);
}

function nextEngine3dRequestId(state: Engine3dWorkspaceSessionState): string {
  return `engine3d-${state.requestSerial}`;
}

function engine3dProtocolLine(message: Engine3DRequest): string {
  return formatEngine3DMessage(message).trimEnd();
}

function appendEngine3dSessionError(
  state: Engine3dWorkspaceSessionState,
  error: string
): Engine3dWorkspaceSessionState {
  return {
    ...state,
    errors: [...state.errors, error]
  };
}

function appendEngine3dText(previous: string | undefined, next: string): string {
  return previous ? `${previous}\n${next}` : next;
}

function medianEngine3dBondLength2d(molecule: MoleculeObject): number {
  const atomById = new Map(molecule.atoms.map((atom) => [atom.id, atom]));
  const lengths = molecule.bonds
    .map((bond) => {
      const from = atomById.get(bond.fromAtomId);
      const to = atomById.get(bond.toAtomId);
      if (!from || !to) {
        return undefined;
      }
      const dx = from.x - to.x;
      const dy = from.y - to.y;
      const length = Math.sqrt(dx * dx + dy * dy);
      return Number.isFinite(length) && length > 1e-6 ? length : undefined;
    })
    .filter((length): length is number => length !== undefined)
    .sort((left, right) => left - right);
  if (lengths.length === 0) {
    return 1;
  }
  const middle = Math.floor(lengths.length / 2);
  return lengths.length % 2 === 0
    ? (lengths[middle - 1] + lengths[middle]) / 2
    : lengths[middle];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
