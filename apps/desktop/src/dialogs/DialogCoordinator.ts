import { dialogEnvelope, parseDialogMessage, validateDialogDelivery, type DialogCloseReason, type DialogMessage, type DialogPlatform, type DialogRegistration, type PageSize } from "./dialogProtocol";
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
}
/** Document-owned authority. A future modal kind can acquire an input lease here; pageSize never does. */
export class DialogCoordinator {
  private sessions = new Map<string, Session>();
  private subscription?: Promise<() => void>;
  private stopped = false;
  constructor(private transport: DialogTransport, private owner: {
    applyPageSize(tabId: string, size: PageSize): void | Promise<void>;
    onError(message: string): void;
    onSettled?(tabId: string, reason: DialogCloseReason): void;
  }, private options: { readyTimeoutMs?: number; platform?: DialogPlatform } = {}) {}

  private ensureSubscription(): Promise<() => void> {
    return this.subscription ??= this.transport.subscribe(delivery => { void this.receive(delivery).catch(e => this.owner.onError(String(e))); })
      .catch(error => { this.subscription = undefined; throw error; });
  }
  async openPageSize(tabId: string, data: PageSize & { title: string }): Promise<void> {
    if (this.stopped) throw new Error("The document window is closing");
    await this.ensureSubscription(); // Owner subscribes before creation/request/ready can arrive.
    if (this.stopped) return;
    const existing = this.sessions.get(tabId);
    if (existing) return; // One opening per originating tab. Never replace its local draft.
    const snapshot: Session["snapshot"] = { protocolVersion: 1, ownerWindowId: "main", documentTabId: tabId,
      dialogKind: "pageSize", sessionId: crypto.randomUUID(), requestId: crypto.randomUUID(), snapshotRevision: 1, type: "snapshot", data };
    if (!parseDialogMessage(snapshot)) throw new Error("Invalid Custom Page Size snapshot");
    const session: Session = { snapshot, receipts: new Map(), inFlight: new Map(), settled: false, ready: false,
      timer: setTimeout(() => { this.owner.onError("Custom Page Size did not become ready. Open it again to try again."); void this.settle(session, "error"); }, this.options.readyTimeoutMs ?? 10000) };
    this.sessions.set(tabId, session);
    try {
      session.registration = await this.transport.open(snapshot);
      if (session.settled) await this.transport.close(session.registration.hostId, session.settledReason ?? "error");
    } catch (error) {
      await this.settle(session, "error");
      throw error;
    }
  }
  async receive(delivery: DialogDelivery): Promise<void> {
    const parsed = parseDialogMessage(delivery.message);
    if (!parsed) return;
    const session = this.sessions.get(parsed.documentTabId);
    if (!session || session.settled) return;
    // Native callbacks can arrive before the open IPC reply. Rust supplies the registered label.
    const label = session.registration?.windowLabel ?? delivery.windowLabel;
    const message = validateDialogDelivery(parsed, delivery.senderWindowId, session.snapshot, label, this.options.platform);
    if (!message) return;
    if (message.type === "closed") {
      if (message.data.reason === "error") this.owner.onError("Custom Page Size could not show its native window. Open it again to try again.");
      await this.settle(session, message.data.reason, false); return;
    }
    if (message.type === "ready") { clearTimeout(session.timer); session.ready = true; return; }
    if (message.type === "request") {
      if (session.registration) await this.transport.publish(session.registration.hostId, session.snapshot);
      return;
    }
    if (message.type !== "action" || !session.ready || !session.registration) return;
    const previous = session.receipts.get(message.requestId);
    if (previous) {
      await session.inFlight.get(message.requestId);
      if (!session.settled) await this.transport.publish(session.registration.hostId, previous);
      return;
    }
    // Reserve before invoking the owner, including when it yields asynchronously.
    const receipt: DialogMessage = { ...dialogEnvelope(message), type: "result", data: { status: message.data.action === "apply" ? "applied" : "cancelled" } };
    session.receipts.set(message.requestId, receipt);
    let finished!: () => void;
    session.inFlight.set(message.requestId, new Promise<void>(resolve => { finished = resolve; }));
    try {
      if (message.data.action === "apply") await this.owner.applyPageSize(message.documentTabId, message.data);
    } catch (error) {
      receipt.data = { status: "error", error: String(error).slice(0, 2048) };
      await this.transport.publish(session.registration.hostId, receipt);
      return;
    } finally {
      finished();
      session.inFlight.delete(message.requestId);
    }
    if (session.settled) return;
    try { await this.transport.publish(session.registration.hostId, receipt); }
    finally { await this.settle(session, message.data.action === "apply" ? "apply" : "cancel"); }
  }
  private async settle(session: Session, reason: DialogCloseReason, close = true): Promise<void> {
    if (session.settled) return;
    session.settled = true;
    session.settledReason = reason;
    clearTimeout(session.timer);
    this.sessions.delete(session.snapshot.documentTabId);
    this.owner.onSettled?.(session.snapshot.documentTabId, reason);
    if (close && session.registration) {
      try { await this.transport.close(session.registration.hostId, reason); }
      catch (error) { this.owner.onError(`Could not close Custom Page Size: ${String(error)}`); }
    }
  }
  async closeTab(tabId: string): Promise<void> {
    const session = this.sessions.get(tabId);
    if (session) await this.settle(session, "ownerTabClose");
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
