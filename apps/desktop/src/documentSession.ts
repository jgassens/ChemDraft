/**
 * Working-document autosave ("document session").
 *
 * The envelope carries every open tab, its file association and view, and the active tab index so a
 * relaunch resumes the working drawings — including unsaved changes — with no explicit save involved.
 * Version-1 fields remain at the top level for compatibility with old single-document sessions.
 * MainWindow writes it (debounced) on every document/file-state change and restores it at startup;
 * `document-session.json` in the app data dir is the Rust-persisted storage.
 *
 * Blankness is an explicit flag captured from the live document's object count at save time —
 * serialized bytes are NOT comparable across launches (fresh documents get new ids/timestamps),
 * so hash equality can never recognize "this is just an empty canvas".
 *
 * Everything here is pure so the envelope contract is unit-testable; the effects live in
 * MainWindow.
 */

import type { ViewportState } from "@chemdraft/viewport-engine";
import type { OpenWarningsReport } from "./openWarnings";

export const DOCUMENT_SESSION_VERSION = 1;
export const DOCUMENT_SESSION_SAVE_DEBOUNCE_MS = 800;

export interface DocumentSessionEnvelope {
  version: typeof DOCUMENT_SESSION_VERSION;
  /** Full serialized document (the same payload File > Save writes). */
  contents: string;
  /**
   * SHA-256 of the native document JSON embedded in `contents` (the envelope's native-payload hash),
   * not of `contents` itself; kept for debugging and future retention policies.
   */
  payloadHash: string;
  /** True when the document had no drawable objects on any page at save time. */
  blank: boolean;
  /** Absolute path of the associated file, when the document has ever been saved/opened. */
  path?: string;
  /** Name shown in the restore status line (file basename, or the document's save filename). */
  displayName: string;
  /** True when the session holds edits that were never written to `path`. */
  dirty: boolean;
  /** ISO timestamp of the autosave, for debugging and future retention policies. */
  savedAt: string;
  /** Additive multi-tab extension. Top-level fields still describe the active document. */
  tabs?: DocumentSessionEnvelope[];
  activeTabIndex?: number;
  /** Raw envelopes we could not restore; retained verbatim on every autosave. */
  unrestoredTabs?: unknown[];
  /** Once edited or saved, an Untitled can never be replaced by Open. */
  pristine?: boolean;
  view?: DocumentSessionView;
  openWarnings?: OpenWarningsReport;
}

export interface DocumentSessionView {
  viewport: ViewportState;
  scrollLeft: number;
  scrollTop: number;
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
function finite(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}
function parseSessionView(raw: unknown): DocumentSessionView | undefined {
  if (!record(raw) || !record(raw.viewport) || !record(raw.viewport.rulerUnit)) return undefined;
  const viewport = raw.viewport;
  const unit = viewport.rulerUnit as Record<string, unknown>;
  const numberKeys = ["scale", "translateX", "translateY", "scrollOriginX", "scrollOriginY",
    "pageOriginX", "pageOriginY", "minZoom", "maxZoom"] as const;
  if (!numberKeys.every((key) => finite(viewport[key])) ||
      (viewport.minZoom as number) <= 0 || (viewport.maxZoom as number) < (viewport.minZoom as number) ||
      !finite(raw.scrollLeft) || !finite(raw.scrollTop) ||
      !["inch", "centimeter", "pixel"].includes(unit.kind as string) ||
      typeof unit.label !== "string" || !finite(unit.pixelsPerUnit) || unit.pixelsPerUnit <= 0 ||
      !finite(unit.subdivisions) || unit.subdivisions <= 0) return undefined;
  return {
    viewport: { ...viewport, scale: Math.min(viewport.maxZoom as number, Math.max(viewport.minZoom as number, viewport.scale as number)) } as unknown as ViewportState,
    scrollLeft: Math.max(0, raw.scrollLeft), scrollTop: Math.max(0, raw.scrollTop)
  };
}

function parseSessionWarnings(raw: unknown): OpenWarningsReport | undefined {
  const stringList = (value: unknown) => value === undefined ||
    (Array.isArray(value) && value.every((entry) => typeof entry === "string"));
  if (!record(raw) || typeof raw.displayName !== "string" || typeof raw.sourceLabel !== "string" ||
      !Array.isArray(raw.warnings) || !raw.warnings.every((warning) => record(warning) &&
        typeof warning.code === "string" && typeof warning.message === "string" &&
        (warning.sourceObjectId === undefined || typeof warning.sourceObjectId === "string") &&
        stringList(warning.atomIds) && stringList(warning.bondIds))) return undefined;
  return raw as unknown as OpenWarningsReport;
}

export function buildDocumentTabsSession(
  tabs: DocumentSessionEnvelope[], activeTabIndex: number
): DocumentSessionEnvelope {
  const active = tabs[activeTabIndex];
  if (!active) throw new Error("The active document tab is missing");
  return { ...active, tabs, activeTabIndex };
}

export interface DocumentSessionSource {
  contents: string;
  payloadHash: string;
  /** The serializer's suggested filename (used when no file is associated). */
  filename: string;
}

/** No drawable objects on any page. Structural parameter type so this module stays free of the
 *  document schema import. */
export function documentIsBlank(document: {
  pages: ReadonlyArray<{ objects: ReadonlyArray<unknown> }>;
}): boolean {
  return document.pages.every((page) => page.objects.length === 0);
}

export function buildDocumentSessionEnvelope(
  payload: DocumentSessionSource,
  fileState: { path?: string; dirty: boolean },
  displayName: string,
  blank: boolean,
  savedAt: Date = new Date()
): DocumentSessionEnvelope {
  return {
    version: DOCUMENT_SESSION_VERSION,
    contents: payload.contents,
    payloadHash: payload.payloadHash,
    blank,
    ...(fileState.path !== undefined ? { path: fileState.path } : {}),
    displayName,
    dirty: fileState.dirty,
    savedAt: savedAt.toISOString()
  };
}

// Keep the original envelope even when optional display metadata was normalized by the parser.
const rawSessionTabs = new WeakMap<DocumentSessionEnvelope, unknown>();
export function rawDocumentSessionTab(tab: DocumentSessionEnvelope): unknown {
  return rawSessionTabs.get(tab) ?? tab;
}

/** Retry carried envelopes through the current parser without normalizing away recovery data. */
export function documentSessionRestoreCandidates(envelope: DocumentSessionEnvelope): unknown[] {
  return [...(envelope.tabs ?? [envelope]).map(rawDocumentSessionTab), ...(envelope.unrestoredTabs ?? [])];
}

export function unrestoredTabDisplayName(raw: unknown, index: number): string {
  return record(raw) && typeof raw.displayName === "string" && raw.displayName.trim()
    ? raw.displayName : `Kept drawing ${index + 1}`;
}

export function unrestoredTabsNotice(count: number): string {
  return count
    ? `; ${count} ${count === 1 ? "drawing is" : "drawings are"} kept for later`
    : "";
}

/** Saved bytes need not be readable by this version in order to rescue them. */
export function unrestoredTabContents(raw: unknown): string {
  if (!record(raw) || typeof raw.contents !== "string") {
    throw new Error("The saved tab has no document text; it remains in the session");
  }
  return raw.contents;
}

/** Validate each tab independently, retaining unreadable envelopes for the next autosave. */
export function parseDocumentSessionEnvelope(raw: unknown, nested = false): DocumentSessionEnvelope | undefined {
  if (typeof raw !== "object" || raw === null) {
    return undefined;
  }
  const candidate = raw as Record<string, unknown>;
  if (candidate.tabs !== undefined) {
    if (nested || candidate.version !== DOCUMENT_SESSION_VERSION || !Array.isArray(candidate.tabs) ||
        candidate.tabs.length === 0 || !Number.isInteger(candidate.activeTabIndex) ||
        typeof candidate.activeTabIndex !== "number" || candidate.activeTabIndex < 0 ||
        candidate.activeTabIndex >= candidate.tabs.length ||
        (candidate.unrestoredTabs !== undefined && !Array.isArray(candidate.unrestoredTabs))) return undefined;
    const tabs: DocumentSessionEnvelope[] = [];
    const unrestoredTabs: unknown[] = [...(candidate.unrestoredTabs as unknown[] ?? [])];
    let activeTabIndex = 0;
    candidate.tabs.forEach((rawTab, index) => {
      const tab = parseDocumentSessionEnvelope(rawTab, true);
      if (tab) {
        if (index === candidate.activeTabIndex) activeTabIndex = tabs.length;
        tabs.push(tab);
      } else unrestoredTabs.push(rawTab);
    });
    if (!tabs.length) return undefined;
    return { ...buildDocumentTabsSession(tabs, activeTabIndex),
      ...(unrestoredTabs.length ? { unrestoredTabs } : {}) };
  }
  if (
    candidate.version !== DOCUMENT_SESSION_VERSION ||
    typeof candidate.contents !== "string" ||
    candidate.contents.length === 0 ||
    typeof candidate.payloadHash !== "string" ||
    typeof candidate.blank !== "boolean" ||
    typeof candidate.displayName !== "string" ||
    typeof candidate.dirty !== "boolean" ||
    typeof candidate.savedAt !== "string" ||
    (candidate.path !== undefined && typeof candidate.path !== "string")
  ) {
    return undefined;
  }
  const view = candidate.view === undefined ? undefined : parseSessionView(candidate.view);
  const warnings = candidate.openWarnings === undefined ? undefined : parseSessionWarnings(candidate.openWarnings);
  if (candidate.pristine !== undefined && typeof candidate.pristine !== "boolean") return undefined;
  if (candidate.unrestoredTabs !== undefined && !Array.isArray(candidate.unrestoredTabs)) return undefined;
  const parsed: DocumentSessionEnvelope = {
    version: DOCUMENT_SESSION_VERSION,
    contents: candidate.contents,
    payloadHash: candidate.payloadHash,
    blank: candidate.blank,
    ...(candidate.path !== undefined ? { path: candidate.path } : {}),
    displayName: candidate.displayName,
    dirty: candidate.dirty,
    savedAt: candidate.savedAt,
    ...(Array.isArray(candidate.unrestoredTabs) ? { unrestoredTabs: candidate.unrestoredTabs } : {}),
    ...(typeof candidate.pristine === "boolean" ? { pristine: candidate.pristine } : {}),
    ...(view ? { view } : {}),
    ...(warnings ? { openWarnings: warnings } : {})
  };
  rawSessionTabs.set(parsed, raw);
  return parsed;
}

/** An old single-document empty canvas restores nothing — otherwise every fresh launch would announce
 *  "Restored last session" over the identical blank it starts with anyway. A blank canvas still
 *  restores when it IS a file (reopen it) or carries unsaved edits (e.g. the user erased
 *  everything and that erasure is the unsaved state). Multiple tabs keep pristine Untitled tabs. */
export function shouldRestoreDocumentSession(envelope: DocumentSessionEnvelope): boolean {
  return (envelope.tabs?.length ?? 0) > 1 || (envelope.unrestoredTabs?.length ?? 0) > 0 ||
    envelope.path !== undefined || envelope.dirty || !envelope.blank || envelope.pristine === false;
}

/**
 * Why a flush that must not silently skip (the app updater's, whose installer ends the process)
 * cannot run now, or undefined when it can proceed — either because saving is open, or because
 * skipping it loses nothing (a blank canvas, or a file saved with no edits since).
 */
export function strictSessionFlushRefusal(state: {
  hydrated: boolean;
  saveEnabled: boolean;
  blank: boolean;
  fileState: { path?: string; dirty: boolean };
}): string | undefined {
  if (state.hydrated && state.saveEnabled) {
    return undefined;
  }
  if (state.blank || (state.fileState.path !== undefined && !state.fileState.dirty)) {
    return undefined;
  }
  return state.hydrated
    ? "autosave is off for this session, so the drawing could not be saved automatically. Save it with File ▸ Save, then check for updates again."
    : "the last session is still loading. Try again in a moment.";
}
