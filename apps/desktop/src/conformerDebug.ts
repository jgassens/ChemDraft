import { isDesktopRuntime } from "./window-manager";

export const SPIN3D_DEBUGGER_WINDOW_KIND = "spin3d-debugger";
export const SPIN3D_DEBUGGER_COMMAND_ID = "view.toggle3dDebugger";
export const SPIN3D_TRACE_EVENT = "chemdraft://spin3d-trace";
export const DOM_SPIN3D_TRACE_EVENT = "chemdraft:spin3d-trace";
export const SPIN3D_TRACE_STALE_MS = 1500;
export const SPIN3D_TRACE_HUNG_MS = 5000;
export const SPIN3D_TRACE_LOG_LIMIT = 200;

export type Spin3dTraceKind = "spin" | "worker-client" | "worker" | "ocl";
export type Spin3dTracePath = "worker" | "in-page";
export type Spin3dTraceStatus = "started" | "completed" | "failed" | "info";
export type Spin3dTraceCacheStatus = "hit" | "miss" | "stored" | "skipped" | "pending";
export type Spin3dTraceComputedStatus = Spin3dTraceStatus | "running" | "still-running" | "likely-hung";

export interface Spin3dTraceEvent {
  eventId: string;
  spanId: string;
  sessionId: string;
  requestId?: string;
  kind: Spin3dTraceKind;
  stage: string;
  status: Spin3dTraceStatus;
  startedAt: number;
  endedAt?: number;
  durationMs?: number;
  atomCount?: number;
  cacheStatus?: Spin3dTraceCacheStatus;
  queueDepth?: number;
  path?: Spin3dTracePath;
  message?: string;
  warningCount?: number;
  error?: string;
}

export interface Spin3dTraceEventInput {
  eventId?: string;
  spanId?: string;
  sessionId: string;
  requestId?: string | number;
  kind: Spin3dTraceKind;
  stage: string;
  status: Spin3dTraceStatus;
  startedAt?: number;
  endedAt?: number;
  durationMs?: number;
  atomCount?: number;
  cacheStatus?: Spin3dTraceCacheStatus;
  queueDepth?: number;
  path?: Spin3dTracePath;
  message?: string;
  warningCount?: number;
  error?: string;
}

export interface Spin3dTraceRow extends Spin3dTraceEvent {
  lastEventId: string;
}

export interface OclTraceLike {
  spanId?: string;
  stage: string;
  status: Spin3dTraceStatus;
  startedAt?: number;
  endedAt?: number;
  durationMs?: number;
  atomCount?: number;
  message?: string;
  warningCount?: number;
  error?: string;
}

type Unlisten = () => void;

let traceCounter = 0;

export function spin3dTraceNow(): number {
  return Date.now();
}

export function createSpin3dTraceEvent(input: Spin3dTraceEventInput, now = spin3dTraceNow()): Spin3dTraceEvent {
  const startedAt = input.startedAt ?? now;
  const endedAt = input.endedAt;
  const requestId = input.requestId === undefined ? undefined : String(input.requestId);
  const spanId = input.spanId ?? [
    input.sessionId,
    requestId ?? "none",
    input.kind,
    input.stage,
    startedAt,
    traceCounter + 1
  ].join(":");
  const durationMs = input.durationMs ?? (
    endedAt === undefined ? undefined : Math.max(0, endedAt - startedAt)
  );
  const eventId = input.eventId ?? `${spanId}:${input.status}:${++traceCounter}`;

  return pruneUndefined({
    eventId,
    spanId,
    sessionId: input.sessionId,
    requestId,
    kind: input.kind,
    stage: input.stage,
    status: input.status,
    startedAt,
    endedAt,
    durationMs,
    atomCount: input.atomCount,
    cacheStatus: input.cacheStatus,
    queueDepth: input.queueDepth,
    path: input.path,
    message: input.message,
    warningCount: input.warningCount,
    error: input.error
  });
}

export function createSpin3dTraceEventFromOcl(
  event: OclTraceLike,
  context: {
    sessionId: string;
    requestId?: string | number;
    path: Spin3dTracePath;
  }
): Spin3dTraceEvent {
  return createSpin3dTraceEvent({
    sessionId: context.sessionId,
    requestId: context.requestId,
    kind: "ocl",
    stage: `ocl.${event.stage}`,
    status: event.status,
    spanId: event.spanId ? `${context.sessionId}:${context.requestId ?? "none"}:ocl:${event.spanId}` : undefined,
    startedAt: event.startedAt,
    endedAt: event.endedAt,
    durationMs: event.durationMs,
    atomCount: event.atomCount,
    path: context.path,
    message: event.message,
    warningCount: event.warningCount,
    error: event.error
  });
}

export function startSpin3dTraceSpan(
  input: Omit<Spin3dTraceEventInput, "status" | "startedAt" | "endedAt" | "durationMs" | "eventId">,
  emit: (event: Spin3dTraceEvent) => void,
  now: () => number = spin3dTraceNow
) {
  const startedAt = now();
  const started = createSpin3dTraceEvent({ ...input, status: "started", startedAt }, startedAt);
  emit(started);

  return {
    spanId: started.spanId,
    startedAt,
    complete(extra: Partial<Spin3dTraceEventInput> = {}) {
      const endedAt = now();
      emit(createSpin3dTraceEvent({
        ...input,
        ...extra,
        status: "completed",
        spanId: started.spanId,
        startedAt,
        endedAt
      }, endedAt));
    },
    fail(error: unknown, extra: Partial<Spin3dTraceEventInput> = {}) {
      const endedAt = now();
      emit(createSpin3dTraceEvent({
        ...input,
        ...extra,
        status: "failed",
        spanId: started.spanId,
        startedAt,
        endedAt,
        error: error instanceof Error ? error.message : String(error)
      }, endedAt));
    }
  };
}

export function appendSpin3dTraceEvent(
  events: readonly Spin3dTraceEvent[],
  event: Spin3dTraceEvent,
  limit = SPIN3D_TRACE_LOG_LIMIT
): Spin3dTraceEvent[] {
  const next = [...events, event];
  return next.length > limit ? next.slice(next.length - limit) : next;
}

export function mergeSpin3dTraceRows(events: readonly Spin3dTraceEvent[]): Spin3dTraceRow[] {
  const rows = new Map<string, Spin3dTraceRow>();
  for (const event of events) {
    const previous = rows.get(event.spanId);
    rows.set(event.spanId, {
      ...(previous ?? event),
      ...event,
      startedAt: previous?.startedAt ?? event.startedAt,
      lastEventId: event.eventId
    });
  }
  return [...rows.values()].sort((a, b) => b.startedAt - a.startedAt);
}

export function computedSpin3dTraceStatus(row: Spin3dTraceRow, now = spin3dTraceNow()): Spin3dTraceComputedStatus {
  if (row.status !== "started") return row.status;
  const elapsed = Math.max(0, now - row.startedAt);
  if (elapsed >= SPIN3D_TRACE_HUNG_MS) return "likely-hung";
  if (elapsed >= SPIN3D_TRACE_STALE_MS) return "still-running";
  return "running";
}

export function spin3dTraceDuration(row: Pick<Spin3dTraceRow, "durationMs" | "endedAt" | "startedAt">, now = spin3dTraceNow()): number {
  if (typeof row.durationMs === "number") return row.durationMs;
  return Math.max(0, (row.endedAt ?? now) - row.startedAt);
}

export function broadcastSpin3dTraceEvent(event: Spin3dTraceEvent): void {
  if (typeof window !== "undefined") {
    window.dispatchEvent(new CustomEvent(DOM_SPIN3D_TRACE_EVENT, { detail: event }));
  }
  if (!isDesktopRuntime()) {
    return;
  }

  void import("@tauri-apps/api/event")
    .then(({ emit }) => emit<Spin3dTraceEvent>(SPIN3D_TRACE_EVENT, event))
    .catch(() => undefined);
}

export async function listenForSpin3dTraceEvents(handler: (event: Spin3dTraceEvent) => void): Promise<Unlisten> {
  const unlistenDom = listenForDomSpin3dTraceEvents(handler);
  if (!isDesktopRuntime()) {
    return unlistenDom;
  }

  const { listen } = await import("@tauri-apps/api/event");
  const unlistenTauri = await listen<Spin3dTraceEvent>(SPIN3D_TRACE_EVENT, (event) => {
    if (isSpin3dTraceEvent(event.payload)) {
      handler(event.payload);
    }
  });
  return () => {
    unlistenDom();
    unlistenTauri();
  };
}

function listenForDomSpin3dTraceEvents(handler: (event: Spin3dTraceEvent) => void): Unlisten {
  if (typeof window === "undefined") {
    return () => undefined;
  }

  const listener = (event: Event) => {
    const payload = (event as CustomEvent<unknown>).detail;
    if (isSpin3dTraceEvent(payload)) {
      handler(payload);
    }
  };
  window.addEventListener(DOM_SPIN3D_TRACE_EVENT, listener);
  return () => window.removeEventListener(DOM_SPIN3D_TRACE_EVENT, listener);
}

export function isSpin3dTraceEvent(value: unknown): value is Spin3dTraceEvent {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as Partial<Spin3dTraceEvent>;
  return (
    typeof candidate.eventId === "string" &&
    typeof candidate.spanId === "string" &&
    typeof candidate.sessionId === "string" &&
    typeof candidate.kind === "string" &&
    typeof candidate.stage === "string" &&
    typeof candidate.status === "string" &&
    typeof candidate.startedAt === "number"
  );
}

function pruneUndefined<T extends Record<string, unknown>>(value: T): T {
  return Object.fromEntries(
    Object.entries(value).filter(([, entry]) => entry !== undefined)
  ) as T;
}
