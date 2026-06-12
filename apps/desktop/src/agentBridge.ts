import type { ChemDraftDocument } from "@chemdraft/chem-core";

export const AGENT_BRIDGE_GLOBAL_NAME = "__CHEMDRAFT_AGENT__";
export const AGENT_BRIDGE_ENV_VAR = "CHEMDRAFT_AGENT_BRIDGE";
export const AGENT_BRIDGE_CLI_ARG = "--chemdraft-agent-bridge";

export interface AgentPoint {
  x: number;
  y: number;
}

export type AgentObjectAnchor =
  | "center"
  | "topLeft"
  | "topRight"
  | "bottomLeft"
  | "bottomRight";

export type AgentPointTarget =
  | { page: AgentPoint }
  | { client: AgentPoint }
  | { objectId: string; anchor?: AgentObjectAnchor }
  | { atom: { objectId: string; atomId: string } }
  | { bond: { objectId: string; bondId: string; anchor?: "midpoint" | "from" | "to" } };

export interface AgentResolvedPoint {
  page: AgentPoint;
  client: AgentPoint;
  target: AgentPointTarget;
  source: "page" | "client" | "object" | "atom" | "bond";
}

export interface AgentHitResult {
  point: AgentResolvedPoint;
  target?: unknown;
}

export interface AgentPointerOptions {
  pointerId?: number;
  button?: number;
  buttons?: number;
  detail?: number;
  shiftKey?: boolean;
  altKey?: boolean;
  metaKey?: boolean;
  ctrlKey?: boolean;
}

export type AgentPointerEventType = "pointerdown" | "pointermove" | "pointerup" | "pointercancel";

export interface AgentPointerDispatchResult {
  type: AgentPointerEventType;
  point: AgentResolvedPoint;
  targetLabel: string;
  defaultPrevented: boolean;
}

export interface AgentDragRequest extends AgentPointerOptions {
  from: AgentPointTarget;
  to: AgentPointTarget;
  steps?: number;
}

export interface AgentSnapshot {
  bridgeVersion: 1;
  build: string;
  runtime: {
    desktop: boolean;
    source: string;
  };
  document: ChemDraftDocument;
  activeToolCommandId: string;
  selection: ChemDraftDocument["selection"];
  selectedNativeMoleculePart?: unknown;
  hoveredNativeTarget?: unknown;
  viewport: unknown;
  page: {
    id: string;
    width: number;
    height: number;
    objectCount: number;
  };
  file: {
    dirty: boolean;
    path?: string;
  };
  objects: readonly AgentObjectSummary[];
}

export interface AgentObjectSummary {
  id: string;
  type: string;
  x: number;
  y: number;
  width: number;
  height: number;
  atomCount?: number;
  bondCount?: number;
}

export interface ChemDraftAgentBridge {
  readonly version: 1;
  snapshot(): AgentSnapshot;
  command(commandId: string): Promise<AgentSnapshot>;
  resolvePoint(target: AgentPointTarget): AgentResolvedPoint;
  hitTest(target: AgentPointTarget): AgentHitResult;
  pointerDown(target: AgentPointTarget, options?: AgentPointerOptions): AgentPointerDispatchResult;
  pointerMove(target: AgentPointTarget, options?: AgentPointerOptions): AgentPointerDispatchResult;
  pointerUp(target: AgentPointTarget, options?: AgentPointerOptions): AgentPointerDispatchResult;
  pointerCancel(target: AgentPointTarget, options?: AgentPointerOptions): AgentPointerDispatchResult;
  click(target: AgentPointTarget, options?: AgentPointerOptions): Promise<AgentSnapshot>;
  drag(request: AgentDragRequest): Promise<AgentSnapshot>;
  waitForIdle(): Promise<AgentSnapshot>;
}

export interface AgentBridgeHost {
  snapshot(): AgentSnapshot;
  command(commandId: string): void | Promise<void>;
  resolvePoint(target: AgentPointTarget): AgentResolvedPoint;
  hitTest(target: AgentPointTarget): AgentHitResult;
  pointer(
    type: AgentPointerEventType,
    target: AgentPointTarget,
    options?: AgentPointerOptions
  ): AgentPointerDispatchResult;
  waitForIdle(): Promise<AgentSnapshot>;
}

export interface NativeAgentBridgeStatus {
  enabled: boolean;
  source: "environment" | "argument" | "disabled";
  envVar: string;
  cliArg: string;
}

export interface AgentBridgePermission {
  enabled: boolean;
  source: "url" | "local-storage" | NativeAgentBridgeStatus["source"] | "unavailable";
  detail: string;
}

export function createChemDraftAgentBridge(host: AgentBridgeHost): ChemDraftAgentBridge {
  const pointer = (
    type: AgentPointerEventType,
    target: AgentPointTarget,
    options?: AgentPointerOptions
  ) => host.pointer(type, target, options);

  return {
    version: 1,
    snapshot: () => host.snapshot(),
    async command(commandId) {
      await host.command(commandId);
      return host.waitForIdle();
    },
    resolvePoint: (target) => host.resolvePoint(target),
    hitTest: (target) => host.hitTest(target),
    pointerDown: (target, options) => pointer("pointerdown", target, options),
    pointerMove: (target, options) => pointer("pointermove", target, options),
    pointerUp: (target, options) => pointer("pointerup", target, options),
    pointerCancel: (target, options) => pointer("pointercancel", target, options),
    async click(target, options) {
      pointer("pointerdown", target, { ...options, buttons: 1 });
      pointer("pointerup", target, { ...options, buttons: 0 });
      return host.waitForIdle();
    },
    async drag(request) {
      const pointerId = request.pointerId ?? 1;
      const button = request.button ?? 0;
      const from = host.resolvePoint(request.from);
      const to = host.resolvePoint(request.to);
      const steps = normalizedDragSteps(request.steps);
      const baseOptions = {
        pointerId,
        button,
        shiftKey: request.shiftKey,
        altKey: request.altKey,
        metaKey: request.metaKey,
        ctrlKey: request.ctrlKey
      };

      pointer("pointerdown", { page: from.page }, { ...baseOptions, buttons: 1 });
      for (let step = 1; step <= steps; step += 1) {
        const fraction = step / steps;
        pointer("pointermove", {
          page: interpolatePoint(from.page, to.page, fraction)
        }, { ...baseOptions, buttons: 1 });
      }
      pointer("pointerup", { page: to.page }, { ...baseOptions, buttons: 0 });
      return host.waitForIdle();
    },
    waitForIdle: () => host.waitForIdle()
  };
}

export function agentBridgeRequestedFromLocation(
  search: string | URLSearchParams,
  storageValue?: string | null
): AgentBridgePermission | undefined {
  const params = typeof search === "string" ? new URLSearchParams(search) : search;
  const urlFlag = params.get("agentBridge") ?? params.get("agent") ?? params.get("chemdraft-agent");
  if (agentBridgeFlagEnabled(urlFlag)) {
    return { enabled: true, source: "url", detail: "URL flag requested ChemDraft agent bridge." };
  }

  if (agentBridgeFlagEnabled(storageValue)) {
    return {
      enabled: true,
      source: "local-storage",
      detail: "Local storage requested ChemDraft agent bridge."
    };
  }

  return undefined;
}

export async function resolveAgentBridgePermission(): Promise<AgentBridgePermission> {
  const browserPermission = browserAgentBridgePermission();
  if (browserPermission) {
    return browserPermission;
  }

  if (!isDesktopRuntime()) {
    return { enabled: false, source: "unavailable", detail: "Not running in the Tauri desktop runtime." };
  }

  try {
    const { invoke } = await import("@tauri-apps/api/core");
    const status = await invoke<NativeAgentBridgeStatus>("agent_bridge_status");
    return {
      enabled: status.enabled,
      source: status.source,
      detail: status.enabled
        ? `Native wrapper allowed ChemDraft agent bridge through ${status.source}.`
        : `Set ${status.envVar}=1 or pass ${status.cliArg} to enable the ChemDraft agent bridge.`
    };
  } catch {
    return {
      enabled: false,
      source: "unavailable",
      detail: "Native agent bridge permission command is unavailable."
    };
  }
}

export function dispatchAgentPointerEvent({
  activePointerTargets,
  ownerDocument,
  pageElement,
  resolvedPoint,
  type,
  options
}: {
  activePointerTargets: Map<number, EventTarget>;
  ownerDocument: Document;
  pageElement: HTMLElement;
  resolvedPoint: AgentResolvedPoint;
  type: AgentPointerEventType;
  options?: AgentPointerOptions;
}): AgentPointerDispatchResult {
  const pointerId = options?.pointerId ?? 1;
  const target = pointerTargetForEvent({
    activePointerTargets,
    ownerDocument,
    pageElement,
    pointerId,
    point: resolvedPoint.client,
    type
  });
  const event = createSyntheticPointerEvent(ownerDocument.defaultView ?? globalThis, type, resolvedPoint.client, {
    ...options,
    pointerId
  });

  target.dispatchEvent(event);
  if (type === "pointerdown") {
    activePointerTargets.set(pointerId, stablePointerTarget(target, pageElement));
  }
  if (type === "pointerup" || type === "pointercancel") {
    activePointerTargets.delete(pointerId);
  }

  return {
    type,
    point: resolvedPoint,
    targetLabel: targetLabel(target),
    defaultPrevented: event.defaultPrevented
  };
}

export function waitForAnimationFrames(count = 2): Promise<void> {
  const safeCount = Math.max(0, Math.floor(count));
  if (safeCount === 0) {
    return Promise.resolve();
  }

  return new Promise((resolve) => {
    const requestFrame =
      typeof window !== "undefined" && typeof window.requestAnimationFrame === "function"
        ? window.requestAnimationFrame.bind(window)
        : (callback: FrameRequestCallback) => globalThis.setTimeout(() => callback(Date.now()), 0);
    let remaining = safeCount;
    const tick = () => {
      remaining -= 1;
      if (remaining <= 0) {
        resolve();
        return;
      }
      requestFrame(tick);
    };
    requestFrame(tick);
  });
}

function browserAgentBridgePermission(): AgentBridgePermission | undefined {
  if (typeof window === "undefined") {
    return undefined;
  }

  let storageValue: string | null | undefined;
  try {
    storageValue = window.localStorage?.getItem("chemdraft.agentBridge");
  } catch {
    storageValue = undefined;
  }

  return agentBridgeRequestedFromLocation(window.location.search, storageValue);
}

function isDesktopRuntime(): boolean {
  const candidate = globalThis as typeof globalThis & {
    __TAURI_INTERNALS__?: unknown;
    __TAURI__?: unknown;
  };

  return Boolean(candidate.__TAURI_INTERNALS__ || candidate.__TAURI__);
}

function agentBridgeFlagEnabled(value: string | null | undefined): boolean {
  if (value === null || value === undefined) {
    return false;
  }
  return ["1", "true", "yes", "on", "enabled"].includes(value.trim().toLowerCase());
}

function normalizedDragSteps(steps: number | undefined): number {
  if (steps === undefined || !Number.isFinite(steps)) {
    return 8;
  }
  return Math.min(120, Math.max(1, Math.floor(steps)));
}

function interpolatePoint(from: AgentPoint, to: AgentPoint, fraction: number): AgentPoint {
  return {
    x: from.x + (to.x - from.x) * fraction,
    y: from.y + (to.y - from.y) * fraction
  };
}

function pointerTargetForEvent({
  activePointerTargets,
  ownerDocument,
  pageElement,
  pointerId,
  point,
  type
}: {
  activePointerTargets: Map<number, EventTarget>;
  ownerDocument: Document;
  pageElement: HTMLElement;
  pointerId: number;
  point: AgentPoint;
  type: AgentPointerEventType;
}): EventTarget {
  if (type !== "pointerdown") {
    const captured = activePointerTargets.get(pointerId);
    if (targetIsConnected(captured)) {
      return captured;
    }
  }

  const elementFromPoint = typeof ownerDocument.elementFromPoint === "function"
    ? ownerDocument.elementFromPoint.bind(ownerDocument)
    : undefined;
  return elementFromPoint?.(point.x, point.y) ?? pageElement;
}

function stablePointerTarget(target: EventTarget, pageElement: HTMLElement): EventTarget {
  if (typeof Element !== "undefined" && target instanceof Element) {
    return target.closest("[data-object-id]") ?? target.closest(".page") ?? target;
  }

  return pageElement;
}

function targetIsConnected(target: EventTarget | undefined): target is EventTarget {
  if (!target) {
    return false;
  }
  if (typeof Node !== "undefined" && target instanceof Node) {
    return target.isConnected;
  }
  return true;
}

function createSyntheticPointerEvent(
  view: Window | typeof globalThis,
  type: AgentPointerEventType,
  point: AgentPoint,
  options: AgentPointerOptions & { pointerId: number }
): Event {
  const buttons = options.buttons ?? (type === "pointerup" || type === "pointercancel" ? 0 : 1);
  const init: PointerEventInit = {
    bubbles: true,
    cancelable: true,
    composed: true,
    pointerId: options.pointerId,
    pointerType: "mouse",
    isPrimary: true,
    clientX: point.x,
    clientY: point.y,
    screenX: point.x,
    screenY: point.y,
    button: options.button ?? 0,
    buttons,
    detail: options.detail ?? 1,
    shiftKey: options.shiftKey ?? false,
    altKey: options.altKey ?? false,
    metaKey: options.metaKey ?? false,
    ctrlKey: options.ctrlKey ?? false
  };
  const PointerEventConstructor = "PointerEvent" in view
    ? (view as Window & typeof globalThis).PointerEvent
    : undefined;
  if (typeof PointerEventConstructor === "function") {
    return new PointerEventConstructor(type, init);
  }

  const event = new MouseEvent(type, init);
  Object.defineProperties(event, {
    pointerId: { value: options.pointerId },
    pointerType: { value: "mouse" },
    isPrimary: { value: true },
    buttons: { value: buttons }
  });
  return event;
}

function targetLabel(target: EventTarget): string {
  if (typeof Element === "undefined" || !(target instanceof Element)) {
    return "unknown";
  }

  const objectId = target.closest("[data-object-id]")?.getAttribute("data-object-id");
  const hitTarget = target.closest("[data-hit-target]")?.getAttribute("data-hit-target");
  if (objectId && hitTarget) {
    return `${objectId}:${hitTarget}`;
  }
  if (objectId) {
    return objectId;
  }
  return target.className?.toString() || target.tagName.toLowerCase();
}

declare global {
  interface Window {
    __CHEMDRAFT_AGENT__?: ChemDraftAgentBridge;
  }
}
