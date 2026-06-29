export const Engine3DProtocolVersion = 1 as const;
export const DefaultEngine3DMaxMessageBytes = 64 * 1024;

export type Engine3DStructureFormat = "molfile-v2000" | "molfile-v3000";

export interface Engine3DCoordinate {
  x: number;
  y: number;
  z: number;
}

export interface Engine3DCameraState {
  viewMatrix: readonly number[];
  projectionMatrix?: readonly number[];
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
  type:
    | "showViewport"
    | "hideViewport"
    | "startAutoOptimize"
    | "stopAutoOptimize"
    | "commit"
    | "dispose"
    | "ping";
  sessionId: string;
}

export interface Engine3DSetCameraRequest extends Engine3DEnvelope {
  type: "setCamera";
  sessionId: string;
  camera: Engine3DCameraState;
}

export interface Engine3DPointerRequest extends Engine3DEnvelope {
  type: "pointer";
  sessionId: string;
  event: {
    kind: "down" | "move" | "up" | "cancel";
    x: number;
    y: number;
    atomId?: string;
    buttons?: number;
  };
}

export type Engine3DRequest =
  | Engine3DCreateSessionRequest
  | Engine3DSessionRequest
  | Engine3DSetCameraRequest
  | Engine3DPointerRequest;

export interface Engine3DResponse extends Engine3DEnvelope {
  type: "response";
  ok: boolean;
  result?: unknown;
  error?: string;
}

export type Engine3DEventType =
  | "ready"
  | "viewportShown"
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
  coordinateRevision?: number;
  coords3dByAtomId?: Readonly<Record<string, Engine3DCoordinate>>;
  camera?: Engine3DCameraState;
  energy?: number;
  selectedAtomIds?: readonly string[];
  message?: string;
}

export interface Engine3DCommitResult {
  sessionId: string;
  coords3dByAtomId: Readonly<Record<string, Engine3DCoordinate>>;
  coordinateRevision: number;
  graphSignature: string;
  bondSignature: string;
  camera: Engine3DCameraState;
  engine: {
    name: string;
    version?: string;
    sourceCommit?: string;
  };
  forceField?: {
    name: string;
    energy?: number;
    status: "running" | "converged" | "not-converged" | "not-run";
  };
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
  let visible = false;
  let autoOptimizing = false;
  let camera: Engine3DCameraState = {
    viewMatrix: [1, 0, 0, 0, 1, 0, 0, 0, 1]
  };
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
  const commit = (): Engine3DCommitResult => ({
    sessionId,
    coords3dByAtomId: { ...coords },
    coordinateRevision,
    graphSignature: input.graphSignature,
    bondSignature: input.bondSignature,
    camera,
    engine: {
      name: "fake-engine3d",
      version: "0.0.0"
    },
    forceField: autoOptimizing
      ? { name: "fake", energy: -1.25, status: "running" }
      : { name: "fake", status: "not-run" },
    warnings: []
  });

  return {
    sessionId,
    send(request) {
      switch (request.type) {
        case "createSession":
          return [response(request, { sessionId }), event(request, "ready", { coordinateRevision, coords3dByAtomId: coords, camera })];
        case "showViewport":
          visible = true;
          return [response(request, { visible }), event(request, "viewportShown")];
        case "hideViewport":
          visible = false;
          return [response(request, { visible })];
        case "startAutoOptimize":
          autoOptimizing = true;
          return [response(request, { autoOptimizing }), event(request, "energyChanged", { energy: -1.25 })];
        case "stopAutoOptimize":
          autoOptimizing = false;
          return [response(request, { autoOptimizing })];
        case "setCamera":
          camera = request.camera;
          return [response(request, { camera })];
        case "pointer":
          if (request.event.kind === "move" && request.event.atomId && coords[request.event.atomId]) {
            const coord = coords[request.event.atomId];
            coords[request.event.atomId] = {
              x: coord.x + request.event.x * 0.01,
              y: coord.y + request.event.y * 0.01,
              z: coord.z
            };
            coordinateRevision += 1;
            return [
              response(request, { coordinateRevision }),
              event(request, "coordinatesChanged", { coordinateRevision, coords3dByAtomId: { ...coords } })
            ];
          }
          return [response(request)];
        case "commit":
          return [response(request, this.commit())];
        case "ping":
          return [response(request), event(request, "heartbeat")];
        case "dispose":
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
