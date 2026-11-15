import { documentWindowId } from "../documentIdentity";

export interface PaletteTarget { windowId: string; tabId: string; documentRevision?: number }
export interface PaletteMessage { target: PaletteTarget }
export const ACTIVE_DOCUMENT_EVENT = "chemdraft://active-document-window";
export const PALETTE_SNAPSHOT_EVENTS = new Set([
  "chemdraft://toolset-active-tool", "chemdraft://toolset-text-style",
  "chemdraft://toolset-command-specs", "chemdraft://toolset-definitions",
  "chemdraft://toolset-layout-state", "chemdraft://toolset-customize-mode"
]);
const requests = new Set([...PALETTE_SNAPSHOT_EVENTS].map(name => `${name}-request`));
const actions = new Set([
  "chemdraft://palette-command", "chemdraft://palette-command-preview",
  "chemdraft://palette-command-commit", "chemdraft://palette-command-cancel",
  "chemdraft://palette-inspector-action", "chemdraft://toolset-layout-edit"
]);
interface DocumentBinding {
  getTarget: () => PaletteTarget;
  hasTab: (tabId: string) => boolean;
  getRevision?: (tabId: string) => number;
  onRefused?: (reason: "closed" | "revision") => void;
}
let documentBinding: DocumentBinding | undefined;
let activeWindowId: string | undefined;
let paletteTarget: PaletteTarget | undefined;
let gestureTarget: PaletteTarget | undefined;
let browserTarget: PaletteTarget | undefined;
let bindingRevision = 0;

export function isPaletteTarget(value: unknown): value is PaletteTarget {
  const target = value as Partial<PaletteTarget> | null;
  return !!target && typeof target.windowId === "string" && target.windowId.length > 0 &&
    typeof target.tabId === "string" && target.tabId.length > 0 &&
    (target.documentRevision === undefined || (Number.isSafeInteger(target.documentRevision) && target.documentRevision >= 0));
}
export function samePaletteTarget(a: PaletteTarget | undefined, b: PaletteTarget | undefined): boolean {
  return !!a && !!b && a.windowId === b.windowId && a.tabId === b.tabId;
}

/** Each document webview binds its live tab lookup, never a snapshot of React state. */
export function bindPaletteDocument(binding: DocumentBinding): () => void {
  documentBinding = binding;
  return () => { if (documentBinding === binding) documentBinding = undefined; };
}
export function setActivePaletteWindow(windowId: string | undefined): boolean {
  const changed = activeWindowId !== windowId;
  if (changed) bindingRevision++;
  activeWindowId = windowId;
  if (paletteTarget?.windowId !== windowId) paletteTarget = undefined;
  return changed;
}
export function paletteDocumentIsActive(): boolean {
  return !documentBinding || activeWindowId === undefined || documentBinding.getTarget().windowId === activeWindowId;
}
export function currentPaletteTarget(): PaletteTarget {
  const target = documentBinding?.getTarget() ?? paletteTarget;
  if (target) return { ...target };
  // Browser preview has one document and no native registry. Desktop palettes wait for a snapshot.
  if (typeof window === "undefined" || !("__TAURI_INTERNALS__" in window)) {
    browserTarget ??= { windowId: documentWindowId(), tabId: crypto.randomUUID() };
    return { ...browserTarget };
  }
  throw new Error("The palette has no active document target yet.");
}
export function paletteTargetRevision(): number { return bindingRevision; }
export function bindPaletteSnapshot(target: PaletteTarget): void {
  if (!samePaletteTarget(paletteTarget, target) || paletteTarget?.documentRevision !== target.documentRevision) bindingRevision++;
  paletteTarget = { ...target };
}

/** Capture synchronously, before imports/IPC or a later activation can change the binding. */
export function paletteGestureTarget(phase: "preview" | "commit" | "cancel"): PaletteTarget {
  const target = gestureTarget ?? currentPaletteTarget();
  gestureTarget = phase === "preview" ? target : undefined;
  return { ...target };
}

/** Used by BOTH global Tauri listeners and the DOM fallback, before any handler is called. */
export function acceptsPaletteEvent(eventName: string, payload: unknown): boolean {
  const snapshot = PALETTE_SNAPSHOT_EVENTS.has(eventName);
  const request = requests.has(eventName);
  const action = actions.has(eventName);
  // Native menu/keyboard commands share this DOM channel, but do not originate in a palette.
  const nativeCommand = eventName === "chemdraft:native-command";
  if (!snapshot && !request && !action && !nativeCommand) return true;
  const target = (payload as Partial<PaletteMessage> | null)?.target;
  if (nativeCommand && target === undefined) return true;
  if (!isPaletteTarget(target)) return refuse(eventName, "missing or malformed target");
  if (documentBinding && !snapshot) {
    const current = documentBinding.getTarget();
    if (target.windowId !== current.windowId) return refuse(eventName, "foreign window");
    if (!documentBinding.hasTab(target.tabId)) {
      if (!request) documentBinding.onRefused?.("closed");
      return refuse(eventName, "stale tab");
    }
    if (target.documentRevision !== undefined && documentBinding.getRevision &&
        target.documentRevision !== documentBinding.getRevision(target.tabId)) {
      if (!request) documentBinding.onRefused?.("revision");
      return refuse(eventName, "document revision");
    }
    // Actions retain their captured tab. Requests still describe only the visible tab.
    if (request && (target.tabId !== current.tabId || !paletteDocumentIsActive())) return false;
    return true;
  }
  if (snapshot) {
    if (activeWindowId !== undefined && target.windowId !== activeWindowId) return false;
    if (documentBinding && !samePaletteTarget(target, documentBinding.getTarget())) return false;
    bindPaletteSnapshot(target);
    return true;
  }
  // Standalone browser transport has one document. Native palettes never consume document actions.
  if (typeof window !== "undefined" && "__TAURI_INTERNALS__" in window) return false;
  return samePaletteTarget(target, currentPaletteTarget());
}
function refuse(event: string, reason: string): false {
  console.debug(`Ignoring palette message ${event}: ${reason}`);
  return false;
}
