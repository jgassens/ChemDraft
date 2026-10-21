import { dialogEnvelope, parseDialogMessage, validateDialogDelivery, type DialogCloseReason, type DialogMessage, type DialogRegistration, type PageSize, type SpacingSnapshot, type ExportDialogResult, SPACING_PREVIEW_CHUNK_SIZE, SPACING_PREVIEW_MAX_CHUNKS } from "./dialogProtocol";
import type { ExportOptions, ExportFrame, ExportPreviewResult } from "./exportOptions";
import type { DialogDelivery, DialogTransport } from "./dialogTransport";

interface Session {
  snapshot: Extract<DialogMessage, { type: "snapshot" }>;
  registration?: DialogRegistration;
  timer: ReturnType<typeof setTimeout>;
  receipts: Map<string, DialogMessage>;
  settled: boolean;
  ready: boolean;
  settledReason?: DialogCloseReason;
  inFlight: Map<string, Promise<void>>;
  terminalRequestId?: string;
  previewRequest?: { requestId: string; percent: number };
  previewing?: boolean;
  previewRequestId?: string;
  pendingFrame?: ExportFrame;
  frameKey?: string;
}
/** Document-owned authority. A future modal kind can acquire an input lease here; pageSize never does. */
export class DialogCoordinator {
  private sessions = new Map<string, Session>();
  private subscription?: Promise<() => void>;
  private stopped = false;
  constructor(private transport: DialogTransport, private owner: {
    applyPageSize(tabId: string, size: PageSize): void | Promise<void>;
    applyArrangementSpacing?(tabId: string, percent: number): void | Promise<void>;
    previewArrangementSpacing?(tabId: string, percent: number): string | Promise<string>;
    onSpacingSettled?(tabId: string): void;
    export?(tabId: string, options: ExportOptions, live: () => boolean, progress: (notice: string) => Promise<void>): Promise<ExportDialogResult>;
    previewExport?(tabId: string, options: ExportOptions, live: () => boolean): Promise<ExportPreviewResult>;
    chooseExportDestination?(tabId: string, options: ExportOptions, live: () => boolean): Promise<ExportDialogResult>;
    onError(message: string): void;
    onSettled?(tabId: string, reason: DialogCloseReason, kind?: "export" | "pageSize"): void;
  }, private options: { readyTimeoutMs?: number } = {}) {}

  cancelExportPreviews(): void {
    for (const session of this.sessions.values()) {
      if (session.snapshot.dialogKind !== "export") continue;
      session.previewRequestId = undefined;
      session.pendingFrame = undefined;
      session.frameKey = undefined;
    }
  }

  async updateExportFrame(tabId: string, frame: ExportFrame): Promise<void> {
    const session = this.sessions.get(`${tabId}:export`);
    if (!session || session.settled) return;
    const frameKey = JSON.stringify(frame);
    if (session.frameKey === frameKey) return;
    const message: DialogMessage = { ...dialogEnvelope(session.snapshot), dialogKind: "export", type: "result", data: { status: "frame", frame } };
    if (!parseDialogMessage(message)) throw new Error("Invalid Export frame");
    session.frameKey = frameKey;
    session.pendingFrame = frame;
    session.previewRequestId = undefined;
    await this.flushExportFrame(session);
  }
  private async flushExportFrame(session: Session): Promise<void> {
    if (session.settled || session.terminalRequestId || !session.ready || !session.registration || !session.pendingFrame) return;
    const frame = session.pendingFrame;
    session.pendingFrame = undefined;
    await this.transport.publish(session.registration.hostId, { ...dialogEnvelope(session.snapshot), dialogKind: "export", type: "result", data: { status: "frame", frame } });
  }
  exportSessionId(tabId: string): string | undefined {
    const session = this.sessions.get(`${tabId}:export`);
    return session && !session.settled ? session.snapshot.sessionId : undefined;
  }

  private ensureSubscription(): Promise<() => void> {
    return this.subscription ??= this.transport.subscribe(delivery => { void this.receive(delivery).catch(e => this.owner.onError(String(e))); })
      .catch(error => { this.subscription = undefined; throw error; });
  }
  async openPageSize(tabId: string, data: PageSize & { title: string }): Promise<void> {
    return this.open(tabId, "pageSize", data);
  }
  async openArrangementSpacing(tabId: string, data: SpacingSnapshot): Promise<void> {
    return this.open(tabId, "arrangementSpacing", data);
  }
  async openExport(tabId: string, data: { title: string; options: ExportOptions; frame?: ExportFrame }): Promise<void> {
    return this.open(tabId, "export", data);
  }
  private async open(tabId: string, kind: DialogMessage["dialogKind"], data: (PageSize & { title: string }) | SpacingSnapshot | { title: string; options: ExportOptions; frame?: ExportFrame }): Promise<void> {
    if (this.stopped) throw new Error("The document window is closing");
    const key = `${tabId}:${kind}`;
    const existing = this.sessions.get(key);
    if (existing) {
      // Reuse the retained snapshot and native window, preserving its local draft and position.
      const receipt = existing.terminalRequestId ? existing.receipts.get(existing.terminalRequestId) : undefined;
      if (existing.registration && (!existing.terminalRequestId || receipt?.type === "result" && receipt.data.status === "exported")) await this.transport.open(existing.snapshot);
      return;
    }
    const snapshot: Session["snapshot"] = { protocolVersion: 1, ownerWindowId: "main", documentTabId: tabId,
      dialogKind: kind, sessionId: crypto.randomUUID(), requestId: crypto.randomUUID(), snapshotRevision: 1, type: "snapshot", data } as Session["snapshot"];
    const title = kind === "export" ? "Export" : kind === "arrangementSpacing" ? "Adjust arrangement spacing" : "Custom Page Size";
    if (!parseDialogMessage(snapshot)) throw new Error(`Invalid ${title} snapshot`);
    const session: Session = { snapshot, receipts: new Map(), inFlight: new Map(), settled: false, ready: false,
      timer: setTimeout(() => { this.owner.onError(`${title} did not become ready. Open it again to try again.`); void this.settle(session, "error"); }, this.options.readyTimeoutMs ?? 10000) };
    this.sessions.set(key, session);
    try {
      // Track the opening before the first await so tab close/dispose can cancel it.
      await this.ensureSubscription();
      if (session.settled || this.stopped) return;
      session.registration = await this.transport.open(snapshot);
      await this.flushExportFrame(session);
      if (session.settled) await this.transport.close(session.registration.hostId, session.settledReason ?? "error");
      else if (session.ready && session.previewRequest) {
        await this.preview(session, session.previewRequest.requestId, session.previewRequest.percent);
      }
    } catch (error) {
      await this.settle(session, "error");
      throw error;
    }
  }
  async receive(delivery: DialogDelivery): Promise<void> {
    const parsed = parseDialogMessage(delivery.message);
    if (!parsed) return;
    const session = this.sessions.get(`${parsed.documentTabId}:${parsed.dialogKind}`);
    if (!session || session.settled) return;
    // Native callbacks can arrive before the open IPC reply. Rust supplies the registered label.
    const label = session.registration?.windowLabel ?? delivery.windowLabel;
    const message = validateDialogDelivery(parsed, delivery.senderWindowId, session.snapshot, label);
    if (!message) return;
    if (message.type === "closed") {
      if (message.data.reason === "error") this.owner.onError(`${parsed.dialogKind === "export" ? "Export" : parsed.dialogKind === "arrangementSpacing" ? "Adjust arrangement spacing" : "Custom Page Size"} could not show its native window. Open it again to try again.`);
      await this.settle(session, message.data.reason, false); return;
    }
    if (message.type === "ready") { clearTimeout(session.timer); session.ready = true; await this.flushExportFrame(session); return; }
    if (message.type === "request") {
      if (session.registration) await this.transport.publish(session.registration.hostId, session.snapshot);
      return;
    }
    if (message.type !== "action" || !session.ready) return;
    if (message.data.action === "preview" && "percent" in message.data) {
      if (!session.registration) { session.previewRequest = { requestId: message.requestId, percent: message.data.percent }; return; }
      await this.preview(session, message.requestId, message.data.percent); return;
    }
    if (!session.registration) return;
    // Cancellation invalidates owner work immediately, even while a receipt is pending.
    if (message.data.action === "cancel") { await this.settle(session, "cancel"); return; }
    if (message.data.action === "preview" && "options" in message.data) {
      if (session.terminalRequestId || !this.owner.previewExport) return;
      session.previewRequestId = message.requestId;
      const live = () => !session.settled && !session.terminalRequestId && session.previewRequestId === message.requestId;
      try {
        const preview = await this.owner.previewExport(message.documentTabId, message.data.options, live);
        const result: DialogMessage = { ...dialogEnvelope(message), type: "result", data: { status: "preview", preview } };
        if (!parseDialogMessage(result)) throw new Error("Preview is too large or invalid. Reduce the content or export size and try again.");
        if (live()) await this.transport.publish(session.registration.hostId, result);
      } catch (error) {
        if (live()) await this.transport.publish(session.registration.hostId, { ...dialogEnvelope(message), type: "result", data: { status: "error", error: String(error).slice(0, 2048) } });
      }
      return;
    }
    const previous = session.receipts.get(message.requestId);
    if (previous) {
      await session.inFlight.get(message.requestId);
      if (!session.settled) await this.transport.publish(session.registration.hostId, previous);
      return;
    }
    if (session.terminalRequestId) return;
    // Reserve the entire session before invoking the owner or awaiting the receipt.
    session.terminalRequestId = message.requestId;
    const receipt: DialogMessage = { ...dialogEnvelope(message), type: "result", data: { status: message.data.action === "apply" ? "applied" : "cancelled" } };
    session.receipts.set(message.requestId, receipt);
    let finished!: () => void;
    session.inFlight.set(message.requestId, new Promise<void>(resolve => { finished = resolve; }));
    try {
      // Acknowledge the validated reservation before any owner flush, picker, or write.
      await this.transport.publish(session.registration.hostId, {
        ...dialogEnvelope(message), type: "result", data: { status: "accepted" }
      });
      if (session.settled) return;
      if (message.data.action === "apply") {
        if ("percent" in message.data) {
          if (!this.owner.applyArrangementSpacing) throw new Error("Spacing is unavailable");
          await this.owner.applyArrangementSpacing(message.documentTabId, message.data.percent);
        } else await this.owner.applyPageSize(message.documentTabId, message.data);
      } else if (message.data.action === "export" || message.data.action === "chooseDestination") {
        const callback = message.data.action === "export" ? this.owner.export : this.owner.chooseExportDestination;
        if (!callback) throw new Error("Export is unavailable in this document window.");
        receipt.data = await callback(message.documentTabId, message.data.options, () => !session.settled, async (notice: string) => {
          if (!session.settled) await this.transport.publish(session.registration!.hostId, {
            ...dialogEnvelope(message), type: "result", data: { status: "progress", notice }
          });
        });
        if (receipt.data.status !== "exported") session.terminalRequestId = undefined;
      }
    } catch (error) {
      session.terminalRequestId = undefined;
      if (session.settled) return;
      receipt.data = { status: "error", error: String(error).slice(0, 2048) };
      await this.transport.publish(session.registration.hostId, receipt);
      await this.flushExportFrame(session);
      return;
    } finally {
      finished();
      session.inFlight.delete(message.requestId);
    }
    if (session.settled) return;
    // Export warnings and success stay in the dialog until Close. Pickers and cancellation of
    // a save panel are nonterminal; a completed export remains reserved against a second write.
    if (message.data.action === "export" || message.data.action === "chooseDestination") {
      await this.transport.publish(session.registration.hostId, receipt);
      await this.flushExportFrame(session);
      return;
    }
    try { await this.transport.publish(session.registration.hostId, receipt); }
    finally { await this.settle(session, message.data.action === "apply" ? "apply" : "cancel"); }
  }
  private async preview(session: Session, requestId: string, percent: number): Promise<void> {
    if (session.terminalRequestId || session.snapshot.dialogKind !== "arrangementSpacing") return;
    session.previewRequest = { requestId, percent };
    if (session.previewing) return;
    session.previewing = true;
    try {
      while (session.previewRequest && !session.settled && !session.terminalRequestId) {
        const request: { requestId: string; percent: number } = session.previewRequest;
        let encoded = "", error: string | undefined;
        try {
          if (!this.owner.previewArrangementSpacing) throw new Error("Spacing preview is unavailable");
          const svg = await this.owner.previewArrangementSpacing(session.snapshot.documentTabId, request.percent);
          const bytes = new TextEncoder().encode(svg);
          if (bytes.length > SPACING_PREVIEW_CHUNK_SIZE * SPACING_PREVIEW_MAX_CHUNKS * 3 / 4) throw new Error("This selection is too large to preview. Select fewer compounds.");
          // Base64 keeps JSON escaping bounded without relaxing the native channel limit.
          const parts: string[] = [];
          for (let i = 0; i < bytes.length; i += 8192) parts.push(String.fromCharCode(...bytes.subarray(i, i + 8192)));
          encoded = btoa(parts.join(""));
        } catch (e) { error = String(e).slice(0, 256); }
        const count = Math.max(1, Math.ceil(encoded.length / SPACING_PREVIEW_CHUNK_SIZE));
        for (let index = 0; index < count; index++) {
          if (session.settled || session.terminalRequestId || session.previewRequest !== request) break;
          await this.transport.publish(session.registration!.hostId, { ...dialogEnvelope(session.snapshot),
            requestId: request.requestId, type: "preview", data: { percent: request.percent, index, count,
              chunk: encoded.slice(index * SPACING_PREVIEW_CHUNK_SIZE, (index + 1) * SPACING_PREVIEW_CHUNK_SIZE), ...(error ? { error } : {}) } });
        }
        if (session.previewRequest === request) session.previewRequest = undefined;
      }
    } finally { session.previewing = false; }
  }
  private async settle(session: Session, reason: DialogCloseReason, close = true): Promise<void> {
    if (session.settled) return;
    session.settled = true;
    session.settledReason = reason;
    clearTimeout(session.timer);
    const key = `${session.snapshot.documentTabId}:${session.snapshot.dialogKind}`;
    if (this.sessions.get(key) === session) this.sessions.delete(key);
    if (session.snapshot.dialogKind === "arrangementSpacing") this.owner.onSpacingSettled?.(session.snapshot.documentTabId);
    // Preserve the existing Page Size callback contract.
    if (session.snapshot.dialogKind === "export") this.owner.onSettled?.(session.snapshot.documentTabId, reason, "export");
    else this.owner.onSettled?.(session.snapshot.documentTabId, reason);
    if (close && session.registration) {
      try { await this.transport.close(session.registration.hostId, reason); }
      catch (error) { this.owner.onError(`Could not close ${session.snapshot.dialogKind}: ${String(error)}`); }
    }
  }
  async closeTab(tabId: string): Promise<void> {
    await Promise.all([...this.sessions.values()].filter(s => s.snapshot.documentTabId === tabId).map(s => this.settle(s, "ownerTabClose")));
  }
  hasArrangementSpacing(tabId: string): boolean { return this.sessions.has(`${tabId}:arrangementSpacing`); }
  async closeArrangementSpacing(): Promise<void> {
    await Promise.all([...this.sessions.values()].filter(s => s.snapshot.dialogKind === "arrangementSpacing").map(s => this.settle(s, "cancel")));
  }
  async dispose(reason: "quit" | "ownerClose" = "ownerClose"): Promise<void> {
    this.stopped = true;
    await Promise.all([...this.sessions.values()].map(s => this.settle(s, reason)));
    const subscription = this.subscription;
    this.subscription = undefined;
    if (subscription) {
      try { (await subscription)(); } catch { /* A failed subscription installed no listener. */ }
    }
  }
}
