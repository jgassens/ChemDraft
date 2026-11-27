import type { ChemDraftDocument } from "@chemdraft/chem-core";
import type { PluginManifest } from "@chemdraft/plugin-api";
import { useEffect, useMemo, useRef, useState } from "react";

import type { OpenPluginPanel } from "./types";

/**
 * Live panel re-run (plugin API 0.1.30): while a panel whose latest report carries
 * `liveRerun: true` is open, every change to the active document re-invokes the report's
 * `rerunCommandId`, 250 ms after the last change. The re-run goes through the same `invoke` path as
 * "Run again", so it lands in the plugin's existing per-plugin command queue and never overlaps a
 * run already in flight.
 */
export const LIVE_PANEL_RERUN_DELAY_MS = 250;

/** The command a live panel re-runs, or undefined when the report does not ask for live re-runs. */
export function liveRerunCommandId(panel: OpenPluginPanel | undefined): string | undefined {
  return panel?.report.liveRerun === true ? panel.report.rerunCommandId : undefined;
}

/** Unique live re-run commands across the in-app panel and every detached panel, in first-seen order. */
export function liveRerunCommandIds(panels: readonly (OpenPluginPanel | undefined)[]): string[] {
  const ids: string[] = [];
  for (const panel of panels) {
    const id = liveRerunCommandId(panel);
    if (id !== undefined && !ids.includes(id)) ids.push(id);
  }
  return ids;
}

function sameElements(previous: readonly unknown[], next: readonly unknown[]): boolean {
  return previous.length === next.length && next.every((value, index) => value === previous[index]);
}

/** Identity first; small shell values (page margins, layout, styles) may be re-parsed into equal copies. */
function sameValue(previous: unknown, next: unknown): boolean {
  return previous === next || JSON.stringify(previous) === JSON.stringify(next);
}

function changedFields(
  previous: Record<string, unknown>,
  next: Record<string, unknown>,
  ignored: ReadonlySet<string>,
  byElement: ReadonlySet<string>
): boolean {
  for (const key of new Set([...Object.keys(previous), ...Object.keys(next)])) {
    if (ignored.has(key)) continue;
    const a = previous[key];
    const b = next[key];
    if (byElement.has(key) && Array.isArray(a) && Array.isArray(b) ? !sameElements(a, b) : !sameValue(a, b)) return true;
  }
  return false;
}

const DOCUMENT_IGNORED = new Set(["selection", "pages", "updatedAt"]);
const PAGE_ARRAYS = new Set(["objects", "crossings"]);
const NOTHING = new Set<string>();

/**
 * Whether `next` differs from `previous` in anything but its selection.
 *
 * Document patches share every object they did not touch (chem-core `applyPatches`) but always
 * rebuild the page and object arrays, re-parse each page's shell (margins, layout) and stamp
 * `updatedAt`, even for a selection-only `setSelection`. So page `objects` and `crossings` are
 * compared element by element by identity (an edit replaces at least one element, cheaply), other
 * fields by identity and then by value, and `selection` and `updatedAt` not at all. Viewport state is
 * not part of the document. A false positive only costs one extra re-run.
 */
export function documentContentChanged(previous: ChemDraftDocument | undefined, next: ChemDraftDocument): boolean {
  if (previous === next) return false;
  if (!previous || previous.pages.length !== next.pages.length) return true;
  if (changedFields(previous as unknown as Record<string, unknown>, next as unknown as Record<string, unknown>, DOCUMENT_IGNORED, NOTHING)) {
    return true;
  }
  return next.pages.some((page, index) => {
    const before = previous.pages[index]!;
    return before !== page &&
      changedFields(before as unknown as Record<string, unknown>, page as unknown as Record<string, unknown>, NOTHING, PAGE_ARRAYS);
  });
}

/**
 * The plugin that contributes `commandId`, and the key of the command queue it runs in: analyzers
 * share one queue per plugin, other commands get one each. Mirrors the plugin command dispatch in
 * `MainWindow`, so a live panel can tell when its command is queued or running.
 */
export function pluginCommandQueue(
  plugins: readonly PluginManifest[],
  commandId: string
): { ownerId: string | undefined; queueKey: string } {
  const owner = plugins.find(manifest => manifest.contributes.commands.some(command => command.id === commandId));
  const analyzerOwned = owner?.contributes.analyzers.some(analyzer => analyzer.commandId === commandId) ?? false;
  return { ownerId: owner?.id, queueKey: analyzerOwned && owner ? `analyzer:${owner.id}` : `command:${commandId}` };
}

/** Who committed a document, when a plugin did: the id of the plugin whose command wrote it. */
export type PluginDocumentAuthor = (document: ChemDraftDocument) => string | undefined;

/**
 * Schedule live re-runs. Same cancel-and-debounce shape as the Molecular Inspector: each document
 * change cancels the pending timer and starts a new one, so a burst of edits makes exactly one
 * re-run per live command, 250 ms after the last edit. Selection-only changes never start a timer,
 * and opening a panel or receiving the plugin's own report (which does not change the document)
 * never does either. Closing every live panel, or replacing its report with one without the flag,
 * cancels the timer.
 *
 * A change committed by a command of the plugin that owns a live command (`authorOf(document)` is
 * `ownerOf(commandId)`, for example the plugin's own `document.write` during its run) does not
 * schedule that command, so a live command that writes never re-triggers itself. The same change
 * still schedules other plugins' live commands, and user edits schedule every one.
 *
 * Returns the live commands with a re-run scheduled but not yet invoked, so a panel can tell a
 * pending re-run from a stale result.
 */
export function useLivePanelRerun(
  document: ChemDraftDocument,
  commandIds: readonly string[],
  invoke: (commandId: string) => void | Promise<void>,
  provenance: { authorOf?: PluginDocumentAuthor; ownerOf?: (commandId: string) => string | undefined } = {}
): ReadonlySet<string> {
  // A content key, so a new report with the same live commands does not cancel a pending re-run.
  const commandKey = commandIds.length > 0 ? JSON.stringify(commandIds) : "";
  const previousDocumentRef = useRef(document);
  const pendingRef = useRef(new Set<string>());
  const invokeRef = useRef(invoke);
  invokeRef.current = invoke;
  const provenanceRef = useRef(provenance);
  provenanceRef.current = provenance;
  const [, setFired] = useState(0);
  // The commands this document change schedules. Read during render too, so the panel that renders
  // with an edited document already knows its re-run is coming and never flashes the banner.
  const scheduledFor = (live: readonly string[]): Set<string> => {
    const next = new Set([...pendingRef.current].filter(commandId => live.includes(commandId)));
    if (documentContentChanged(previousDocumentRef.current, document)) {
      const author = provenanceRef.current.authorOf?.(document);
      for (const commandId of live) {
        if (author === undefined || provenanceRef.current.ownerOf?.(commandId) !== author) next.add(commandId);
      }
    }
    return next;
  };
  const scheduledKey = commandKey ? [...scheduledFor(JSON.parse(commandKey) as string[])].join("\n") : "";
  useEffect(() => {
    const live: string[] = commandKey ? JSON.parse(commandKey) as string[] : [];
    const pending = scheduledFor(live);
    pendingRef.current = pending;
    previousDocumentRef.current = document;
    if (pending.size === 0) return;
    const timer = window.setTimeout(() => {
      const due = live.filter(commandId => pending.has(commandId));
      pending.clear();
      setFired(count => count + 1);
      for (const commandId of due) void invokeRef.current(commandId);
    }, LIVE_PANEL_RERUN_DELAY_MS);
    return () => window.clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- `scheduledFor` reads only refs and `document`.
  }, [document, commandKey]);
  return useMemo(() => new Set(scheduledKey ? scheduledKey.split("\n") : []), [scheduledKey]);
}

/**
 * Whether an open panel shows the "out of date" banner (D-09). `sourceStale` is the fingerprint
 * check against the report's source. A live panel is flagged like any other when its result is out
 * of date, and also when its last run failed; the flag is held back only while a re-run of its
 * command is scheduled or running, since that run is about to replace the result.
 */
export function pluginPanelOutOfDate(options: {
  sourceStale: boolean;
  live: boolean;
  lastRunFailed: boolean;
  rerunPending: boolean;
}): boolean {
  if (!options.live) return options.sourceStale;
  if (options.rerunPending) return false;
  return options.sourceStale || options.lastRunFailed;
}

/** `set` with `value` present or absent; the same set when nothing changes. */
export function withSetMember<T>(set: ReadonlySet<T>, value: T, present: boolean): ReadonlySet<T> {
  if (set.has(value) === present) return set;
  const next = new Set(set);
  if (present) next.add(value); else next.delete(value);
  return next;
}
