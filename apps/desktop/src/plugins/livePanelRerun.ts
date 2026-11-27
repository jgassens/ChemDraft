import type { ChemDraftDocument } from "@chemdraft/chem-core";
import type { PluginManifest } from "@chemdraft/plugin-api";
import { useEffect, useMemo, useRef, useState } from "react";

import { isDocumentWindowCommandId } from "../windowCommands";
import type { OpenPluginPanel } from "./types";

/**
 * Live panel re-run (plugin API 0.1.28): while a panel whose latest report carries
 * `liveRerun: true` is open, every change to the active document re-invokes the report's
 * `rerunCommandId`, 250 ms after the last change. The re-run goes through the same `invoke` path as
 * "Run again", so it lands in the plugin's existing per-plugin command queue and never overlaps a
 * run already in flight.
 */
export const LIVE_PANEL_RERUN_DELAY_MS = 250;

/** Who registered a command: the owning plugin's id, or undefined for a core or unknown command. */
export type CommandOwner = (commandId: string) => string | undefined;

/**
 * The command a live panel re-runs, or undefined when the report does not ask for live re-runs.
 *
 * A report is plugin data, so a live re-run only ever names a command registered by the SAME plugin
 * that produced the report (the check panel controls get), and never one that closes a tab or the
 * document window. `PluginPanelController` already strips any other `liveRerun` when it accepts the
 * report; this repeats the check where the command is about to be scheduled.
 */
export function liveRerunCommandId(panel: OpenPluginPanel | undefined, ownerOf: CommandOwner): string | undefined {
  if (panel?.report.liveRerun !== true) return undefined;
  const commandId = panel.report.rerunCommandId;
  return commandId !== undefined && liveRerunAllowed(panel.pluginId, commandId, ownerOf) ? commandId : undefined;
}

/** Whether `pluginId`'s report may live re-run `commandId`: only its own registered, non-window command. */
export function liveRerunAllowed(pluginId: string, commandId: string, ownerOf: CommandOwner): boolean {
  return !isDocumentWindowCommandId(commandId) && ownerOf(commandId) === pluginId;
}

/** Unique live re-run commands across the in-app panel and every detached panel, in first-seen order. */
export function liveRerunCommandIds(panels: readonly (OpenPluginPanel | undefined)[], ownerOf: CommandOwner): string[] {
  const ids: string[] = [];
  for (const panel of panels) {
    const id = liveRerunCommandId(panel, ownerOf);
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
const PAGE_ARRAYS = new Set(["objects"]);
const NOTHING = new Set<string>();

/**
 * Whether `next` differs from `previous` in anything but its selection.
 *
 * Document patches share every object they did not touch (chem-core `applyPatches`) but always
 * rebuild the page and object arrays, re-parse each page's shell (margins, layout, crossing
 * overrides) and stamp `updatedAt`, even for a selection-only `setSelection`. So page `objects` are
 * compared element by element by identity (an edit replaces at least one element, cheaply); every
 * other field, `crossings` included, by identity and then by value, since the re-parse makes equal
 * copies; and `selection` and `updatedAt` not at all. Viewport state is
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
 * Schedule live re-runs. Same debounce shape as the Molecular Inspector: each content change
 * (re)starts one timer, so a burst of edits makes exactly one re-run per live command, 250 ms after
 * the last edit. Selection-only changes never start a timer and leave a pending one untouched, and
 * opening a panel or receiving the plugin's own report (which does not change the document) never
 * starts one either. Closing every live panel, or replacing its report with one without the flag,
 * cancels the timer.
 *
 * A change committed by a command of the plugin that owns a live command (`authorOf(document)` is
 * `ownerOf(commandId)`, for example the plugin's own `document.write` during its run) does not
 * schedule that command, so a live command that writes never re-triggers itself. The same change
 * still schedules other plugins' live commands, and user edits schedule every one.
 *
 * Authorship belongs to the commit, not to the snapshot: it counts only for the change that first
 * brings a document in. Undo, redo or a tab switch that returns to a plugin-written snapshot later is
 * not that plugin's edit, so it schedules every live command.
 *
 * Returns the live commands with a re-run scheduled but not yet invoked, so a panel can tell a
 * pending re-run from a stale result.
 */
export function useLivePanelRerun(
  document: ChemDraftDocument,
  commandIds: readonly string[],
  invoke: (commandId: string) => void | Promise<void>,
  provenance: { authorOf?: PluginDocumentAuthor; ownerOf?: CommandOwner } = {}
): ReadonlySet<string> {
  // A content key, so a new report with the same live commands does not cancel a pending re-run.
  const commandKey = commandIds.length > 0 ? JSON.stringify(commandIds) : "";
  const previousDocumentRef = useRef(document);
  // Every document this hook has already taken in. A plugin's authorship is spent on its arrival.
  const seenDocumentsRef = useRef(new WeakSet<ChemDraftDocument>([document]));
  const pendingRef = useRef(new Set<string>());
  const liveRef = useRef<readonly string[]>([]);
  const timerRef = useRef<number | undefined>(undefined);
  const invokeRef = useRef(invoke);
  invokeRef.current = invoke;
  const provenanceRef = useRef(provenance);
  provenanceRef.current = provenance;
  const [, setFired] = useState(0);
  // The commands still pending plus those this document change schedules. Read during render too,
  // so the panel that renders with an edited document already knows its re-run is coming and never
  // flashes the banner. `added` is whether this change scheduled anything.
  const scheduledFor = (live: readonly string[]): { pending: Set<string>; added: boolean } => {
    const pending = new Set([...pendingRef.current].filter(commandId => live.includes(commandId)));
    let added = false;
    if (documentContentChanged(previousDocumentRef.current, document)) {
      const author = seenDocumentsRef.current.has(document) ? undefined : provenanceRef.current.authorOf?.(document);
      for (const commandId of live) {
        if (author === undefined || provenanceRef.current.ownerOf?.(commandId) !== author) {
          pending.add(commandId);
          added = true;
        }
      }
    }
    return { pending, added };
  };
  const scheduledKey = commandKey ? [...scheduledFor(JSON.parse(commandKey) as string[]).pending].join("\n") : "";
  useEffect(() => {
    const live: string[] = commandKey ? JSON.parse(commandKey) as string[] : [];
    const { pending, added } = scheduledFor(live);
    pendingRef.current = pending;
    liveRef.current = live;
    previousDocumentRef.current = document;
    seenDocumentsRef.current.add(document);
    if (pending.size === 0) {
      window.clearTimeout(timerRef.current);
      timerRef.current = undefined;
      return;
    }
    // Only an edit that schedules a run restarts the debounce; a selection-only change, a report
    // update or a change the live commands' own plugin made leaves a pending timer as it is.
    if (!added && timerRef.current !== undefined) return;
    window.clearTimeout(timerRef.current);
    timerRef.current = window.setTimeout(() => {
      timerRef.current = undefined;
      const due = liveRef.current.filter(commandId => pendingRef.current.has(commandId));
      pendingRef.current = new Set();
      setFired(count => count + 1);
      for (const commandId of due) void invokeRef.current(commandId);
    }, LIVE_PANEL_RERUN_DELAY_MS);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- `scheduledFor` reads only refs and `document`.
  }, [document, commandKey]);
  useEffect(() => () => {
    window.clearTimeout(timerRef.current);
    timerRef.current = undefined;
  }, []);
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
