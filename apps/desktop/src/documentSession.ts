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
      (viewport.scale as number) < (viewport.minZoom as number) || (viewport.scale as number) > (viewport.maxZoom as number) ||
      !finite(raw.scrollLeft) || raw.scrollLeft < 0 || !finite(raw.scrollTop) || raw.scrollTop < 0 ||
      !["inch", "centimeter", "pixel"].includes(unit.kind as string) ||
      typeof unit.label !== "string" || !finite(unit.pixelsPerUnit) || unit.pixelsPerUnit <= 0 ||
      !finite(unit.subdivisions) || unit.subdivisions <= 0) return undefined;
  return { viewport: viewport as unknown as ViewportState, scrollLeft: raw.scrollLeft, scrollTop: raw.scrollTop };
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

/** Structural validation of a loaded envelope; anything unexpected restores nothing (the blank
 *  document stands) rather than throwing at startup. */
export function parseDocumentSessionEnvelope(raw: unknown, nested = false): DocumentSessionEnvelope | undefined {
  if (typeof raw !== "object" || raw === null) {
    return undefined;
  }
  const candidate = raw as Record<string, unknown>;
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
  if ((candidate.view !== undefined && !view) || (candidate.openWarnings !== undefined && !warnings) ||
      (candidate.pristine !== undefined && typeof candidate.pristine !== "boolean")) return undefined;
  let tabs: DocumentSessionEnvelope[] | undefined;
  if (candidate.tabs !== undefined) {
    if (nested || !Array.isArray(candidate.tabs) || candidate.tabs.length === 0 ||
        !Number.isInteger(candidate.activeTabIndex) || typeof candidate.activeTabIndex !== "number" ||
        candidate.activeTabIndex < 0 || candidate.activeTabIndex >= candidate.tabs.length) return undefined;
    tabs = [];
    for (const rawTab of candidate.tabs) {
      const tab = parseDocumentSessionEnvelope(rawTab, true);
      if (!tab) return undefined;
      tabs.push(tab);
    }
  }
  return {
    version: DOCUMENT_SESSION_VERSION,
    contents: candidate.contents,
    payloadHash: candidate.payloadHash,
    blank: candidate.blank,
    ...(candidate.path !== undefined ? { path: candidate.path } : {}),
    displayName: candidate.displayName,
    dirty: candidate.dirty,
    savedAt: candidate.savedAt,
    ...(tabs ? { tabs, activeTabIndex: candidate.activeTabIndex as number } : {}),
    ...(typeof candidate.pristine === "boolean" ? { pristine: candidate.pristine } : {}),
    ...(view ? { view } : {}),
    ...(warnings ? { openWarnings: warnings } : {})
  };
}

/** An old single-document empty canvas restores nothing — otherwise every fresh launch would announce
 *  "Restored last session" over the identical blank it starts with anyway. A blank canvas still
 *  restores when it IS a file (reopen it) or carries unsaved edits (e.g. the user erased
 *  everything and that erasure is the unsaved state). Explicit tab lists keep pristine Untitled tabs. */
export function shouldRestoreDocumentSession(envelope: DocumentSessionEnvelope): boolean {
  return envelope.tabs !== undefined || envelope.path !== undefined || envelope.dirty || !envelope.blank;
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
