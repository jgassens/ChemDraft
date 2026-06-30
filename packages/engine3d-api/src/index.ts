export const Engine3DProtocolVersion = 2 as const;
export const DefaultEngine3DMaxMessageBytes = 4 * 1024 * 1024;

export type Engine3DStructureFormat = "molfile-v2000" | "molfile-v3000";
export type Engine3DCoordinateReason = "embed" | "initial-relax" | "drag" | "settle" | "commit";

export interface Engine3DCoordinate {
  x: number;
  y: number;
  z: number;
}

export interface Engine3DAtomSignatureInput {
  id: string;
  element: string;
}

export interface Engine3DBondSignatureInput {
  id?: string;
  fromAtomId: string;
  toAtomId: string;
  order?: number | string;
}

export interface Engine3DGraphSignatureInput {
  atoms: readonly Engine3DAtomSignatureInput[];
  bonds: readonly Engine3DBondSignatureInput[];
}

export interface Engine3DSessionInput {
  molfile: string;
  format: Engine3DStructureFormat;
  atomIdByMolfileIndex: readonly string[];
  graphSignature: string;
  bondSignature: string;
  selectedAtomIds?: readonly string[];
  coords3dByAtomId?: Readonly<Record<string, Engine3DCoordinate>>;
}

export interface Engine3DReadyCapabilities {
  headlessPhysics: true;
  worldSpaceDrag: true;
  frontendRendering: true;
  autoOptimize: true;
  forceField: "UFF" | "protocol-scout";
}

export type Engine3DForceFieldStatus =
  | "running"
  | "converged"
  | "not-converged"
  | "not-run"
  | "optimized"
  | "skipped"
  | "unsupported-element"
  | "failed";

export interface Engine3DForceFieldReport {
  name: string;
  energy?: number;
  energyUnits?: string;
  status: Engine3DForceFieldStatus;
  avogadroBacked?: boolean;
  warning?: string;
}

export interface Engine3DEnvelope {
  protocolVersion: typeof Engine3DProtocolVersion;
  type: string;
  requestId: string;
  sessionId?: string;
}

export interface Engine3DCreateSessionRequest extends Engine3DEnvelope {
  type: "createSession";
  input: Engine3DSessionInput;
}

export interface Engine3DSessionRequest extends Engine3DEnvelope {
  type: "commit" | "dispose" | "ping";
  sessionId: string;
}

export interface Engine3DBeginDragRequest extends Engine3DEnvelope {
  type: "beginDrag";
  sessionId: string;
  atomId: string;
}

export interface Engine3DUpdateDragRequest extends Engine3DEnvelope {
  type: "updateDrag";
  sessionId: string;
  atomId: string;
  target: Engine3DCoordinate;
}

export interface Engine3DEndDragRequest extends Engine3DEnvelope {
  type: "endDrag";
  sessionId: string;
  atomId: string;
  cancelled?: boolean;
}

export type Engine3DRequest =
  | Engine3DCreateSessionRequest
  | Engine3DSessionRequest
  | Engine3DBeginDragRequest
  | Engine3DUpdateDragRequest
  | Engine3DEndDragRequest;

export interface Engine3DResponse extends Engine3DEnvelope {
  type: "response";
  ok: boolean;
  result?: unknown;
  error?: string;
}

export type Engine3DEventType =
  | "ready"
  | "coordinatesChanged"
  | "energyChanged"
  | "selectionChanged"
  | "warning"
  | "error"
  | "heartbeat"
  | "closed";

export interface Engine3DEvent extends Engine3DEnvelope {
  type: "event";
  eventType: Engine3DEventType;
  sessionId: string;
  capabilities?: Engine3DReadyCapabilities;
  coordinateRevision?: number;
  coords3dByAtomId?: Readonly<Record<string, Engine3DCoordinate>>;
  reason?: Engine3DCoordinateReason;
  energy?: number;
  forceField?: Engine3DForceFieldReport;
  selectedAtomIds?: readonly string[];
  message?: string;
}

export interface Engine3DCommitResult {
  sessionId: string;
  coords3dByAtomId: Readonly<Record<string, Engine3DCoordinate>>;
  coordinateRevision: number;
  graphSignature: string;
  bondSignature: string;
  engine: {
    name: string;
    version?: string;
    sourceCommit?: string;
  };
  forceField?: Engine3DForceFieldReport;
  warnings: readonly string[];
}

export type Engine3DMessage = Engine3DRequest | Engine3DResponse | Engine3DEvent;

export type Engine3DParseResult =
  | { ok: true; message: Engine3DMessage }
  | { ok: false; error: string };

export interface Engine3DCommitValidationResult {
  ok: boolean;
  errors: string[];
}

export const DefaultEngine3DReadyCapabilities: Engine3DReadyCapabilities = {
  headlessPhysics: true,
  worldSpaceDrag: true,
  frontendRendering: true,
  autoOptimize: true,
  forceField: "UFF"
};

export function formatEngine3DMessage(message: Engine3DMessage): string {
  return `${JSON.stringify(message)}\n`;
}

export function parseEngine3DMessageLine(
  line: string,
  maxBytes = DefaultEngine3DMaxMessageBytes
): Engine3DParseResult {
  if (new TextEncoder().encode(line).byteLength > maxBytes) {
    return { ok: false, error: `Engine 3D message exceeds ${maxBytes} bytes.` };
  }
  let value: unknown;
  try {
    value = JSON.parse(line);
  } catch {
    return { ok: false, error: "Engine 3D message is not valid JSON." };
  }
  if (!isRecord(value)) {
    return { ok: false, error: "Engine 3D message must be a JSON object." };
  }
  if (value.protocolVersion !== Engine3DProtocolVersion) {
    return { ok: false, error: `Unsupported Engine 3D protocol version "${String(value.protocolVersion)}".` };
  }
  if (typeof value.type !== "string" || value.type.length === 0) {
    return { ok: false, error: "Engine 3D message is missing type." };
  }
  if (typeof value.requestId !== "string" || value.requestId.length === 0) {
    return { ok: false, error: "Engine 3D message is missing requestId." };
  }
  if (requiresSessionId(value.type) && (typeof value.sessionId !== "string" || value.sessionId.length === 0)) {
    return { ok: false, error: `Engine 3D "${value.type}" message is missing sessionId.` };
  }
  return { ok: true, message: value as unknown as Engine3DMessage };
}

export function createEngine3DBondSignature(bonds: readonly Engine3DBondSignatureInput[]): string {
  return bonds
    .map((bond) => {
      const [a, b] = [bond.fromAtomId, bond.toAtomId].sort();
      return `${a}-${b}:${bond.order ?? "unknown"}`;
    })
    .sort()
    .join("|");
}

export function createEngine3DGraphSignature(input: Engine3DGraphSignatureInput): string {
  const atomPart = input.atoms
    .map((atom) => `${atom.id}:${atom.element}`)
    .join("|");
  return `atoms=${atomPart};bonds=${createEngine3DBondSignature(input.bonds)}`;
}

export function validateEngine3DCommit(
  sessionInput: Engine3DSessionInput,
  commit: Engine3DCommitResult
): Engine3DCommitValidationResult {
  const errors: string[] = [];
  if (commit.graphSignature !== sessionInput.graphSignature) {
    errors.push("Graph signature changed.");
  }
  if (commit.bondSignature !== sessionInput.bondSignature) {
    errors.push("Bond signature changed.");
  }
  if (!Number.isInteger(commit.coordinateRevision) || commit.coordinateRevision < 0) {
    errors.push("Coordinate revision must be a non-negative integer.");
  }

  const expectedAtomIds = new Set(sessionInput.atomIdByMolfileIndex);
  const actualAtomIds = new Set(Object.keys(commit.coords3dByAtomId));
  for (const atomId of expectedAtomIds) {
    if (!actualAtomIds.has(atomId)) {
      errors.push(`Missing coordinates for atom "${atomId}".`);
    }
  }
  for (const atomId of actualAtomIds) {
    if (!expectedAtomIds.has(atomId)) {
      errors.push(`Unexpected coordinates for atom "${atomId}".`);
    }
  }
  for (const [atomId, coord] of Object.entries(commit.coords3dByAtomId)) {
    if (!isFiniteCoordinate(coord)) {
      errors.push(`Coordinates for atom "${atomId}" must be finite x/y/z values.`);
    }
  }

  return { ok: errors.length === 0, errors };
}

export interface FakeEngine3DSession {
  readonly sessionId: string;
  send(request: Engine3DRequest): Engine3DMessage[];
  commit(): Engine3DCommitResult;
}

export function createFakeEngine3DSession(input: Engine3DSessionInput, sessionId = "fake-engine3d-session"): FakeEngine3DSession {
  let coordinateRevision = 0;
  let draggedAtomId: string | undefined;
  const coords: Record<string, Engine3DCoordinate> = {};
  input.atomIdByMolfileIndex.forEach((atomId, index) => {
    coords[atomId] = input.coords3dByAtomId?.[atomId] ?? { x: index * 1.5, y: 0, z: 0 };
  });

  const response = (request: Engine3DRequest, result?: unknown): Engine3DResponse => ({
    protocolVersion: Engine3DProtocolVersion,
    type: "response",
    requestId: request.requestId,
    sessionId,
    ok: true,
    result
  });
  const errorResponse = (request: Engine3DRequest, error: string): Engine3DResponse => ({
    protocolVersion: Engine3DProtocolVersion,
    type: "response",
    requestId: request.requestId,
    sessionId,
    ok: false,
    error
  });
  const event = (
    request: Engine3DRequest,
    eventType: Engine3DEventType,
    extras: Partial<Engine3DEvent> = {}
  ): Engine3DEvent => ({
    protocolVersion: Engine3DProtocolVersion,
    type: "event",
    requestId: request.requestId,
    sessionId,
    eventType,
    ...extras
  });
  const coordinatesChanged = (
    request: Engine3DRequest,
    reason: Engine3DCoordinateReason
  ): Engine3DEvent => event(request, "coordinatesChanged", {
    coordinateRevision,
    coords3dByAtomId: { ...coords },
    reason
  });
  const forceField: Engine3DForceFieldReport = {
    name: "fake",
    energy: -1.25,
    energyUnits: "kJ/mol",
    status: "running"
  };
  const commit = (): Engine3DCommitResult => ({
    sessionId,
    coords3dByAtomId: { ...coords },
    coordinateRevision,
    graphSignature: input.graphSignature,
    bondSignature: input.bondSignature,
    engine: {
      name: "fake-engine3d",
      version: "0.0.0"
    },
    forceField,
    warnings: []
  });

  return {
    sessionId,
    send(request) {
      switch (request.type) {
        case "createSession":
          return [
            response(request, { sessionId }),
            event(request, "ready", {
              capabilities: DefaultEngine3DReadyCapabilities,
              coordinateRevision,
              coords3dByAtomId: { ...coords }
            }),
            coordinatesChanged(request, "embed")
          ];
        case "beginDrag":
          if (!coords[request.atomId]) {
            return [errorResponse(request, `Unknown atom "${request.atomId}".`)];
          }
          draggedAtomId = request.atomId;
          return [
            response(request, { draggedAtomId }),
            event(request, "selectionChanged", { selectedAtomIds: [draggedAtomId] })
          ];
        case "updateDrag":
          if (!coords[request.atomId]) {
            return [errorResponse(request, `Unknown atom "${request.atomId}".`)];
          }
          draggedAtomId = request.atomId;
          coords[draggedAtomId] = request.target;
          coordinateRevision += 1;
          return [
            response(request, { coordinateRevision }),
            coordinatesChanged(request, "drag"),
            event(request, "energyChanged", { energy: forceField.energy, forceField })
          ];
        case "endDrag":
          if (!coords[request.atomId]) {
            return [errorResponse(request, `Unknown atom "${request.atomId}".`)];
          }
          draggedAtomId = undefined;
          coordinateRevision += 1;
          return [
            response(request, { coordinateRevision, cancelled: request.cancelled === true }),
            coordinatesChanged(request, "settle"),
            event(request, "energyChanged", { energy: forceField.energy, forceField })
          ];
        case "commit":
          return [response(request, commit())];
        case "ping":
          return [response(request), event(request, "heartbeat")];
        case "dispose":
          draggedAtomId = undefined;
          return [response(request), event(request, "closed")];
      }
    },
    commit
  };
}

function requiresSessionId(type: string): boolean {
  return !["createSession", "response"].includes(type);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isFiniteCoordinate(value: unknown): value is Engine3DCoordinate {
  return isRecord(value) &&
    Number.isFinite(value.x) &&
    Number.isFinite(value.y) &&
    Number.isFinite(value.z);
}
