import {
  applyPatch,
  type ApplyPatchOptions,
  type ChemDraftDocument,
  type DocumentObject,
  type DocumentPatch
} from "@chemdraft/chem-core";
import {
  AppliedPatchReceiptSchema,
  type AppliedPatchReceipt,
  type NormalizedProposedDocumentPatch
} from "@chemdraft/plugin-api";

export interface AppliedPluginDocumentPatch {
  document: ChemDraftDocument;
  receipt: AppliedPatchReceipt;
}

/**
 * Apply a validated plugin patch through chem-core, then select every object that the patch inserted.
 * Both patch operations are assembled before the caller commits the returned document, so the desktop
 * records exactly one history entry for the command.
 */
export function applyPluginDocumentPatch(
  document: ChemDraftDocument,
  proposed: NormalizedProposedDocumentPatch,
  options: ApplyPatchOptions = {}
): AppliedPluginDocumentPatch {
  const now = options.now ?? new Date();
  const beforeIds = new Set(document.pages.flatMap((page) => page.objects.map((object) => object.id)));
  const patched = applyPatch(document, proposed.patch, { ...options, now });
  const objectIds = patched.pages.flatMap((page) =>
    page.objects.filter((object) => !beforeIds.has(object.id)).map((object) => object.id)
  );

  let selected = patched;
  if (objectIds.length > 0) {
    const page = patched.pages.find((candidate) =>
      objectIds.every((objectId) => candidate.objects.some((object) => object.id === objectId))
    );
    if (page) {
      selected = applyPatch(
        patched,
        { op: "setSelection", pageId: page.id, objectIds },
        { ...options, now }
      );
    }
  }

  return {
    document: selected,
    receipt: AppliedPatchReceiptSchema.parse({ applied: true, objectIds })
  };
}

/**
 * One plain sentence for why a plugin patch could not be applied. A schema failure arrives as a Zod
 * error whose message is its whole issue list in JSON — unreadable in a one-line status — so name the
 * first issue by its path instead.
 */
export function describePatchFailure(error: unknown): string {
  const issues = (error as { issues?: unknown } | null)?.issues;
  if (Array.isArray(issues) && issues.length > 0) {
    const [first] = issues as { path?: unknown; message?: unknown }[];
    const path = Array.isArray(first?.path) ? first.path.join(".") : "";
    const detail = typeof first?.message === "string" ? first.message : "invalid value";
    return `the proposed structure is not valid (${path ? `${path}: ` : ""}${detail})`;
  }
  const message = error instanceof Error ? error.message : String(error);
  return message.split("\n")[0]!.replace(/\.$/, "") || "unknown error";
}

/**
 * A USER-accepted proposal, laid onto the document it is accepted into. A proposal is laid out against
 * the document that was active when it was made — its page id, its object id, a position centred on that
 * page — and the user may accept it later, in another document. Applied verbatim, it then fails forever
 * ("object mol_ocsr_004 already exists") or names a page that does not exist here.
 *
 * So an insertion whose object id is taken gets a fresh one, and an insertion onto a page this document
 * does not have goes onto its first page, a molecule re-centred there. Nothing else changes: atoms,
 * bonds, charges, stereo and every other chemical field are carried over exactly (AGENTS.md §10). This
 * is for the user's accept only — a plugin's own direct write was built from the live document it read,
 * and a collision there is the plugin's error to see.
 */
export function applyAcceptedPluginProposal(
  document: ChemDraftDocument,
  proposed: NormalizedProposedDocumentPatch,
  options: ApplyPatchOptions = {}
): AppliedPluginDocumentPatch {
  return applyPluginDocumentPatch(document, rebaseProposedInsertion(document, proposed), options);
}

/** The proposal with its insertion re-targeted at `document` (see `applyAcceptedPluginProposal`). */
export function rebaseProposedInsertion(
  document: ChemDraftDocument,
  proposed: NormalizedProposedDocumentPatch
): NormalizedProposedDocumentPatch {
  const patch = proposed.patch as DocumentPatch;
  if (patch.op !== "addObject" && patch.op !== "addAnnotation") return proposed;
  const object: DocumentObject = patch.op === "addObject" ? patch.object : patch.annotation;
  const fallbackPage = document.pages[0];
  const pageExists = document.pages.some((page) => page.id === patch.pageId);
  // No page at all: nothing to re-target onto; chem-core's own error says so.
  if (!pageExists && !fallbackPage) return proposed;

  const existingIds = new Set(document.pages.flatMap((page) => page.objects.map((candidate) => candidate.id)));
  let rebased: DocumentObject = object;
  if (existingIds.has(object.id)) rebased = { ...rebased, id: freshObjectId(existingIds, object.id) };
  const pageId = pageExists ? patch.pageId : fallbackPage!.id;
  if (!pageExists) rebased = centredOnPage(rebased, fallbackPage!);
  if (rebased === object && pageId === patch.pageId) return proposed;

  const nextPatch: DocumentPatch =
    patch.op === "addObject"
      ? { op: "addObject", pageId, object: rebased }
      : { op: "addAnnotation", pageId, annotation: rebased as typeof patch.annotation };
  return { ...proposed, patch: nextPatch as NormalizedProposedDocumentPatch["patch"] };
}

/**
 * The first free `<prefix>_NNN` id, counting up from the document's object count — the same scheme the
 * document workflow's object-id allocator uses (`nextObjectId` in documentWorkflow.ts, not exported), so
 * an accepted structure reads like every other object in the file.
 */
function freshObjectId(existingIds: ReadonlySet<string>, collidingId: string): string {
  const prefix = collidingId.replace(/_\d+$/, "") || "object";
  let index = existingIds.size + 1;
  let id = `${prefix}_${String(index).padStart(3, "0")}`;
  while (existingIds.has(id)) {
    index += 1;
    id = `${prefix}_${String(index).padStart(3, "0")}`;
  }
  return id;
}

/**
 * A molecule moved, as a whole, so its box is centred on `page` — the placement it was given on the page
 * it was proposed for. A molecule's atoms carry page coordinates, so they move with its box; only
 * positions change. Other objects keep their coordinates (a recognition proposal is always a molecule).
 */
function centredOnPage(object: DocumentObject, page: ChemDraftDocument["pages"][number]): DocumentObject {
  if (object.type !== "molecule") return object;
  const dx = page.width / 2 - (object.x + object.width / 2);
  const dy = page.height / 2 - (object.y + object.height / 2);
  if (!Number.isFinite(dx) || !Number.isFinite(dy) || (dx === 0 && dy === 0)) return object;
  return {
    ...object,
    x: object.x + dx,
    y: object.y + dy,
    atoms: object.atoms.map((atom) => ({ ...atom, x: atom.x + dx, y: atom.y + dy }))
  };
}

/**
 * Plugin document writes that must wait for a canvas gesture to finish. A drag (and every gesture like
 * it) previews from a snapshot taken when it started and commits `snapshot → result` as one undo entry;
 * a write committed in the middle is overwritten by the next preview frame and dropped from the history
 * by the commit, while the plugin was told it was applied. Deferring the write until the gesture has
 * committed or cancelled keeps both: the gesture's entry, then the write's own entry on top of it.
 *
 * The gate asks `isGestureActive` rather than being told when each of the many gestures ends, so a new
 * gesture needs no wiring here. It re-checks after every `flush()` (the host calls it on pointer and key
 * release) and on a short timer while anything is waiting, and runs nothing when idle.
 */
export interface PluginWriteGate {
  /** Runs `apply` now when no gesture is active; otherwise queues it, in order, until one is not. The
   *  promise settles with `apply`'s result (or its error) only once it has actually run. */
  run<T>(apply: () => T): Promise<T>;
  /** Runs what is queued if no gesture is active any more. */
  flush(): void;
  /** How many writes are waiting. */
  pending(): number;
  /** Stops the timer; queued writes are rejected (the window is going away). */
  dispose(): void;
}

/** How long a write waits for the canvas before it is refused rather than left hanging. A typed rotate or
 *  resize entry can stay open as long as the user likes, and a session whose end was never delivered
 *  would otherwise hold the plugin's command open for good. */
export const PLUGIN_WRITE_MAX_WAIT_MS = 60_000;

export function createPluginWriteGate({
  isGestureActive,
  pollMs = 50,
  maxWaitMs = PLUGIN_WRITE_MAX_WAIT_MS,
  now = Date.now,
  setTimer = (callback, ms) => setTimeout(callback, ms),
  clearTimer = (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>)
}: {
  isGestureActive: () => boolean;
  pollMs?: number;
  maxWaitMs?: number;
  now?: () => number;
  setTimer?: (callback: () => void, ms: number) => unknown;
  clearTimer?: (handle: unknown) => void;
}): PluginWriteGate {
  const queue: Array<{ write: () => void; abandon: (error: Error) => void; queuedAt: number }> = [];
  let timer: unknown;
  let disposed = false;

  const schedule = (): void => {
    if (timer !== undefined || queue.length === 0 || disposed) return;
    timer = setTimer(() => {
      timer = undefined;
      flush();
    }, pollMs);
  };

  const flush = (): void => {
    // In order, and each against the document the one before it left.
    while (queue.length > 0 && !isGestureActive()) queue.shift()!.write();
    // Still busy: refuse what has waited too long, plainly, rather than apply it into the session.
    while (queue.length > 0 && now() - queue[0]!.queuedAt >= maxWaitMs) {
      queue.shift()!.abandon(new Error("The canvas stayed busy with another edit; nothing was inserted. Try again."));
    }
    schedule();
  };

  return {
    run<T>(apply: () => T): Promise<T> {
      if (disposed) return Promise.reject(new Error("The document window closed; nothing was inserted."));
      return new Promise<T>((resolve, reject) => {
        queue.push({
          write: () => {
            try {
              resolve(apply());
            } catch (error) {
              reject(error);
            }
          },
          abandon: reject,
          queuedAt: now()
        });
        flush();
      });
    },
    flush,
    pending: () => queue.length,
    dispose() {
      disposed = true;
      if (timer !== undefined) clearTimer(timer);
      timer = undefined;
      for (const entry of queue.splice(0)) {
        entry.abandon(new Error("The document window closed; nothing was inserted."));
      }
    }
  };
}
