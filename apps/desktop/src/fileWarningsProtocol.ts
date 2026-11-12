import type { ChemDraftDocument } from "@chemdraft/chem-core";
import { Channel, invoke } from "@tauri-apps/api/core";
import { describeOpenWarningTarget, openWarningsHeading, type OpenWarningsReport, type OpenWarningSelection } from "./openWarnings";

export interface FileWarningRow {
  code: string;
  message: string;
  target: string;
  missing: boolean;
  canShow: boolean;
}
export interface FileWarningsSnapshot {
  sessionId: string;
  revision: number;
  reports: { heading: string; rows: FileWarningRow[] }[];
}
export type FileWarningsAction = { sessionId: string; revision: number } & (
  { kind: "close" } | { kind: "show"; reportIndex: number; warningIndex: number }
  | { kind: "command"; commandId: "edit.undo" | "edit.redo" | "edit.selectAll" }
  | { kind: "unavailable"; message: string }
);
export interface FileWarningsChunk {
  sessionId: string;
  revision: number;
  index: number;
  total: number;
  json: string;
}

/** Only display data crosses into the transient webview; selections stay with the document. */
export function fileWarningsSnapshot(sessionId: string, revision: number, reports: readonly OpenWarningsReport[], document: ChemDraftDocument): FileWarningsSnapshot {
  return { sessionId, revision, reports: reports.map(report => ({
    heading: openWarningsHeading(report),
    rows: report.warnings.map(warning => {
      const target = describeOpenWarningTarget(document, warning);
      return { code: warning.code, message: warning.message, target: target.label, missing: target.missing, canShow: !!target.selection };
    })
  })) };
}

/** Re-resolve the row against the current drawing, including atoms/bonds deleted since opening. */
export function routeFileWarningsAction(action: FileWarningsAction, snapshot: FileWarningsSnapshot,
  reports: readonly OpenWarningsReport[], document: ChemDraftDocument,
  show: (selection: OpenWarningSelection, label: string) => void, close: () => void): void {
  if (action.sessionId !== snapshot.sessionId) return;
  if (action.kind === "close") { close(); return; }
  if (action.kind === "command" || action.kind === "unavailable") return;
  if (action.revision !== snapshot.revision) return;
  if (!Number.isInteger(action.reportIndex) || !Number.isInteger(action.warningIndex)) return;
  const warning = reports[action.reportIndex]?.warnings[action.warningIndex];
  if (!warning || !snapshot.reports[action.reportIndex]?.rows[action.warningIndex]?.canShow) return;
  const target = describeOpenWarningTarget(document, warning);
  if (target.selection) show(target.selection, target.label);
}

/** Private IPC deliveries stay below Tauri's app-wide large-message fetch threshold. */
export function fileWarningsAssembler(receive: (snapshot: FileWarningsSnapshot) => void): (chunk: FileWarningsChunk) => void {
  let pending: { sessionId: string; revision: number; total: number; parts: string[]; length: number } | undefined;
  return chunk => {
    if (chunk.index === 0) pending = { ...chunk, parts: [], length: 0 };
    if (!pending || chunk.sessionId !== pending.sessionId || chunk.revision !== pending.revision
      || chunk.total !== pending.total || chunk.index !== pending.parts.length || chunk.total < 1 || chunk.total > 8192) { pending = undefined; return; }
    pending.parts.push(chunk.json);
    pending.length += chunk.json.length;
    if (pending.length > 4 * 1024 * 1024) { pending = undefined; return; }
    if (pending.parts.length === pending.total) {
      try {
        const snapshot = JSON.parse(pending.parts.join("")) as FileWarningsSnapshot;
        if (snapshot.sessionId === pending.sessionId && snapshot.revision === pending.revision && Array.isArray(snapshot.reports)) receive(snapshot);
      } catch { /* Incomplete/malformed deliveries never replace the last complete snapshot. */ }
      finally { pending = undefined; }
    }
  };
}

export interface FileWarningsAnchor { x: number; y: number }
export interface FileWarningsTransport {
  open(snapshot: FileWarningsSnapshot, anchor: FileWarningsAnchor, focus: boolean, action: (action: FileWarningsAction) => void): Promise<void>;
  publish(snapshot: FileWarningsSnapshot): Promise<void>;
  close(sessionId: string): Promise<void>;
}
export const nativeFileWarningsTransport: FileWarningsTransport = {
  async open(snapshot, anchor, focus, action) {
    const onAction = new Channel<FileWarningsAction>();
    onAction.onmessage = action;
    await invoke("file_warnings_open", { snapshot, anchor, focus, onAction });
  },
  publish: snapshot => invoke("file_warnings_publish", { snapshot }),
  close: sessionId => invoke("file_warnings_close", { sessionId })
};

// Shared by successive openings: a slow native build from a disposed session must
// finish and close before a newer session can reuse the single transient window.
let fileWarningsQueue = Promise.resolve();

/** Serialize open/update/close so cold creation and fast toggles cannot strand a window. */
export function createFileWarningsSession(initial: FileWarningsSnapshot, anchor: FileWarningsAnchor, focus: boolean,
  action: (action: FileWarningsAction) => void, error: (error: unknown) => void,
  transport = nativeFileWarningsTransport) {
  let disposed = false;
  let queue = fileWarningsQueue;
  const enqueue = (operation: () => Promise<void>) => {
    queue = fileWarningsQueue = fileWarningsQueue.then(operation).catch(reason => { if (!disposed) error(reason); });
  };
  enqueue(() => disposed ? Promise.resolve() : transport.open(initial, anchor, focus, message => { if (!disposed) action(message); }));
  return {
    publish(snapshot: FileWarningsSnapshot) { enqueue(() => disposed ? Promise.resolve() : transport.publish(snapshot)); },
    dispose() { disposed = true; enqueue(() => transport.close(initial.sessionId)); },
    settled: () => queue
  };
}
