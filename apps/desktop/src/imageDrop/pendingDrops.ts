/**
 * Files dropped on the document window wait in Rust (`file_drop_queue.rs`) until this page drains
 * them, so a drop made while the window was still loading is not lost. As with the native open queue
 * (`nativeOpenQueue.ts`), the event only says the queue changed: the page subscribes before its
 * first drain, every drain is a destructive read, and drains never overlap, so each drop is handed
 * over exactly once, in the order it arrived.
 */
import { listenAndDrainNativeOpenQueue } from "../nativeOpenQueue";
import { formatDropBytes } from "./dropFiles";
import type { DocumentFileDropPayload } from "./dropPosition";

/** Rust's notice that the document window's drop queue changed. It carries nothing. */
export const DOCUMENT_FILE_DROPS_CHANGED_EVENT = "chemdraft://document-file-drops-changed";

/** One drop Rust refused for its own size (`OversizedDrop` in `file_drop_queue.rs`). */
export interface OversizedDrop {
  /** Files the drop named. */
  files: number;
  /** The limit it passed: more files than `limit`, or more than `limit` bytes of path text. */
  kind: "files" | "pathText";
  limit: number;
}

/** One drain: `PendingDocumentDrops` in `file_drop_queue.rs`. */
export interface PendingDocumentDrops {
  /** Oldest first, each drop whole. */
  drops: DocumentFileDropPayload[];
  /** Drops Rust refused whole since the last drain because too many were waiting. */
  refusedDrops: number;
  /** Drops Rust refused whole since the last drain because each was too large on its own. */
  oversizedDrops: OversizedDrop[];
}

/** The document window's destructive drain (`take_pending_document_drops` in `file_drop_queue.rs`). */
export async function takePendingDocumentDrops(): Promise<unknown> {
  const { invoke } = await import("@tauri-apps/api/core");
  return invoke("take_pending_document_drops");
}

/** A drain's reply, keeping only well-formed drops. */
export function pendingDocumentDropsFrom(value: unknown): PendingDocumentDrops {
  const reply = typeof value === "object" && value !== null
    ? value as { drops?: unknown; refusedDrops?: unknown; oversizedDrops?: unknown } : {};
  const drops = Array.isArray(reply.drops) ? reply.drops.filter((drop): drop is DocumentFileDropPayload =>
    typeof drop === "object" && drop !== null && Array.isArray((drop as { paths?: unknown }).paths)
    && (drop as { paths: unknown[] }).paths.every(path => typeof path === "string")) : [];
  const refused = reply.refusedDrops;
  const oversizedDrops = Array.isArray(reply.oversizedDrops) ? reply.oversizedDrops.filter(isOversizedDrop) : [];
  return { drops, refusedDrops: typeof refused === "number" && Number.isInteger(refused) && refused > 0 ? refused : 0, oversizedDrops };
}

function isOversizedDrop(value: unknown): value is OversizedDrop {
  if (typeof value !== "object" || value === null) return false;
  const { files, kind, limit } = value as { files?: unknown; kind?: unknown; limit?: unknown };
  const count = (n: unknown): n is number => typeof n === "number" && Number.isInteger(n) && n > 0;
  return count(files) && count(limit) && (kind === "files" || kind === "pathText");
}

/** The status line for drops Rust refused because too many arrived before the window was ready. */
export function refusedDropsStatus(count: number): string {
  return `Couldn't take ${count} more ${count === 1 ? "drop" : "drops"}: too many arrived before the window was ready. `
    + `Drop ${count === 1 ? "it" : "them"} again.`;
}

/** The status line for one drop Rust refused for its own size: the same style as a file's refusal. */
export function oversizedDropStatus(drop: OversizedDrop): string {
  const subject = `Couldn't take a drop of ${drop.files} ${drop.files === 1 ? "file" : "files"}`;
  return drop.kind === "files"
    ? `${subject}: at most ${drop.limit} files per drop.`
    : `${subject}: their paths are too long; at most ${formatDropBytes(drop.limit)} of path text per drop.`;
}

/** Everything a drain refused, as one status: each oversized drop, then the drops that piled up. */
export function refusalsStatus(batch: Pick<PendingDocumentDrops, "refusedDrops" | "oversizedDrops">): string {
  const parts = batch.oversizedDrops.map(oversizedDropStatus);
  if (batch.refusedDrops) parts.push(refusedDropsStatus(batch.refusedDrops));
  return parts.join(" ");
}

/**
 * Subscribes, then drains the drop queue whenever it changes. Each drain first waits for `ready`
 * (the restored session loaded and any question about it answered), so drops made earlier stay in
 * Rust, in order, until the page can take them. A drain that has not started its destructive read
 * when the page goes away leaves the drops where they are.
 */
export function listenAndDrainDocumentDrops(options: {
  subscribe: (changed: () => void) => Promise<() => void>;
  take: () => Promise<unknown>;
  ready: () => Promise<void>;
  consume: (batch: PendingDocumentDrops) => void;
  onError: (error: unknown) => void;
}): () => void {
  let disposed = false;
  const stop = listenAndDrainNativeOpenQueue<PendingDocumentDrops>({
    subscribe: options.subscribe,
    drain: async () => {
      await options.ready();
      if (disposed) return [];
      const batch = pendingDocumentDropsFrom(await options.take());
      return batch.drops.length || batch.refusedDrops || batch.oversizedDrops.length ? [batch] : [];
    },
    consumeBatch: batches => { for (const batch of batches) options.consume(batch); },
    onError: options.onError
  });
  return () => { disposed = true; stop(); };
}
