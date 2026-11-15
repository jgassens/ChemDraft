import {
  isRuntimeDocumentLabel, parseRuntimeMessage, RUNTIME_BROKER_VERSION, RUNTIME_HOST_LABEL, runtimeMethods,
  type RuntimeContributions, type RuntimeDelivery, type RuntimeMessage, type RuntimeMethod,
  type RuntimeRequest, type RuntimeResponse, type RuntimeTransport
} from "./runtimeBrokerProtocol";

type Handler<M extends RuntimeMethod> = (request: RuntimeRequest<M>, sender: string) => RuntimeResponse<M> | Promise<RuntimeResponse<M>>;
interface Pending {
  sender: string;
  method: RuntimeMethod;
  resolve(value: unknown): void;
  reject(error: Error): void;
  timer: ReturnType<typeof setTimeout>;
}

/** Duplex request/reply endpoint. Re-entrant by design: an invocation can await document capabilities
 * while another document invokes another command. No mutable "current window" slot exists. */
export class RuntimeBroker {
  private readonly pending = new Map<string, Pending>();
  private readonly handlers = new Map<RuntimeMethod, (payload: unknown, sender: string) => unknown>();
  private readonly contributions = new Set<(snapshot: RuntimeContributions) => void>();
  private readonly views = new Set<(topic: string, snapshot: unknown) => void>();
  private readonly stop: () => void;
  private disposed = false;

  constructor(readonly label: string, private readonly transport: RuntimeTransport, private readonly timeoutMs = 300_000,
    onError: (error: unknown) => void = () => {}) {
    if (label !== RUNTIME_HOST_LABEL && !isRuntimeDocumentLabel(label)) throw new Error("Utilities cannot connect to the plugin runtime broker.");
    this.stop = transport.subscribe(delivery => { void this.receive(delivery).catch(onError); });
  }

  get supportsImmediate(): boolean { return !!this.transport.immediate; }

  handle<M extends RuntimeMethod>(method: M, handler: Handler<M>): () => void {
    const destination = runtimeMethods[method].destination;
    if ((this.label === RUNTIME_HOST_LABEL) !== (destination === "runtime")) throw new Error(`Wrong broker destination for ${method}.`);
    if (this.handlers.has(method)) throw new Error(`Plugin runtime handler already registered: ${method}.`);
    const erased = (payload: unknown, sender: string) => handler(runtimeMethods[method].request.parse(payload) as RuntimeRequest<M>, sender);
    this.handlers.set(method, erased);
    return () => { if (this.handlers.get(method) === erased) this.handlers.delete(method); };
  }

  async call<M extends RuntimeMethod>(recipient: string, method: M, request: RuntimeRequest<M>, timeoutMs = this.timeoutMs): Promise<RuntimeResponse<M>> {
    if (this.disposed) throw new Error("The plugin runtime connection is closed.");
    this.authorizePeer(recipient);
    if ((recipient === RUNTIME_HOST_LABEL) !== (runtimeMethods[method].destination === "runtime")) throw new Error(`Wrong broker recipient for ${method}.`);
    const message = parseRuntimeMessage({ version: RUNTIME_BROKER_VERSION, kind: "request", id: crypto.randomUUID(), method, payload: request });
    if (message.kind !== "request") throw new Error("Invalid plugin runtime request.");
    return new Promise<RuntimeResponse<M>>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(message.id);
        reject(new Error(`Plugin runtime ${method} timed out; its result is unavailable.`));
      }, timeoutMs);
      this.pending.set(message.id, { sender: recipient, method, timer, reject,
        resolve: value => resolve(value as RuntimeResponse<M>) });
      void this.transport.send(recipient, message).catch(cause => {
        const pending = this.pending.get(message.id);
        if (!pending) return;
        clearTimeout(pending.timer);
        this.pending.delete(message.id);
        reject(cause);
      });
    });
  }

  subscribeContributions(listener: (snapshot: RuntimeContributions) => void): () => void {
    this.contributions.add(listener);
    return () => { this.contributions.delete(listener); };
  }

  /** A5a-4 keeps the owner in this webview. Refuse this path on native transports: remaining
   * synchronous document adapters must be migrated before the hidden-host cutover. */
  callImmediate<M extends RuntimeMethod>(recipient: string, method: M, request: RuntimeRequest<M>): RuntimeResponse<M> {
    if (!this.transport.immediate) throw new Error("This runtime action requires the in-process channel.");
    let settled = false;
    let result: RuntimeResponse<M> | undefined;
    let error: unknown;
    // The JSON channel delivers both messages before send() returns. Keep the same authenticated
    // sender/id/method receipt checks as asynchronous calls.
    const id = crypto.randomUUID();
    if (this.disposed) throw new Error("The plugin runtime connection is closed.");
    this.authorizePeer(recipient);
    if ((recipient === RUNTIME_HOST_LABEL) !== (runtimeMethods[method].destination === "runtime")) throw new Error(`Wrong broker recipient for ${method}.`);
    const message = parseRuntimeMessage({ version: RUNTIME_BROKER_VERSION, kind: "request", id, method, payload: request });
    const timer = setTimeout(() => {}, 0);
    this.pending.set(id, { sender: recipient, method, timer,
      resolve: value => { settled = true; result = value as RuntimeResponse<M>; },
      reject: cause => { settled = true; error = cause; } });
    void this.transport.send(recipient, message).catch(() => undefined);
    clearTimeout(timer);
    this.pending.delete(id);
    if (!settled) throw new Error(`Runtime action ${method} did not complete synchronously.`);
    if (error) throw error;
    return result as RuntimeResponse<M>;
  }

  subscribeView(listener: (topic: string, snapshot: unknown) => void): () => void {
    this.views.add(listener);
    return () => { this.views.delete(listener); };
  }

  async broadcastView(recipients: readonly string[], topic: string, payload: unknown): Promise<void> {
    if (this.label !== RUNTIME_HOST_LABEL || this.disposed) throw new Error("Only the running runtime host can publish views.");
    const message = parseRuntimeMessage({ version: RUNTIME_BROKER_VERSION, kind: "runtimeView", topic, payload });
    for (const recipient of recipients) this.authorizePeer(recipient);
    await Promise.all(recipients.map(recipient => this.transport.send(recipient, message)));
  }

  async broadcastContributions(recipients: readonly string[], snapshot: RuntimeContributions): Promise<void> {
    if (this.label !== RUNTIME_HOST_LABEL || this.disposed) throw new Error("Only the running runtime host can broadcast contributions.");
    const message = parseRuntimeMessage({ version: RUNTIME_BROKER_VERSION, kind: "contributions", payload: snapshot });
    // Validate the complete destination list before sending anything.
    for (const recipient of recipients) this.authorizePeer(recipient);
    await Promise.all(recipients.map(recipient => this.transport.send(recipient, message)));
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.stop();
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(new Error("The plugin runtime connection closed before the request completed."));
    }
    this.pending.clear();
    this.handlers.clear();
    this.contributions.clear();
    this.views.clear();
  }

  private authorizePeer(peer: string): void {
    const allowed = this.label === RUNTIME_HOST_LABEL ? isRuntimeDocumentLabel(peer) : peer === RUNTIME_HOST_LABEL;
    if (!allowed) throw new Error("Plugin runtime messages require a runtime host and a document window.");
  }

  private async receive(delivery: RuntimeDelivery): Promise<void> {
    if (this.disposed) return;
    let message: RuntimeMessage;
    try {
      this.authorizePeer(delivery.sender);
      message = parseRuntimeMessage(delivery.message);
    } catch { return; } // Unauthenticated/malformed input can never settle a legitimate request.
    if (message.kind === "contributions") {
      if (delivery.sender === RUNTIME_HOST_LABEL) for (const listener of this.contributions) listener(message.payload);
      return;
    }
    if (message.kind === "runtimeView") {
      if (delivery.sender === RUNTIME_HOST_LABEL) for (const listener of this.views) listener(message.topic, message.payload);
      return;
    }
    if (message.kind === "response") {
      const pending = this.pending.get(message.id);
      if (!pending || pending.sender !== delivery.sender || pending.method !== message.method) return;
      clearTimeout(pending.timer);
      this.pending.delete(message.id);
      if (message.ok) pending.resolve(message.value);
      else pending.reject(new Error(message.error));
      return;
    }
    if ((this.label === RUNTIME_HOST_LABEL) !== (runtimeMethods[message.method].destination === "runtime")) return;
    let response: RuntimeMessage;
    try {
      const handler = this.handlers.get(message.method);
      if (!handler) throw new Error(`Plugin runtime method unavailable: ${message.method}.`);
      const handled = handler(message.payload, delivery.sender);
      const value = handled instanceof Promise ? await handled : handled;
      response = parseRuntimeMessage({ version: RUNTIME_BROKER_VERSION, kind: "response", id: message.id, method: message.method, ok: true, value });
    } catch (cause) {
      response = { version: RUNTIME_BROKER_VERSION, kind: "response", id: message.id, method: message.method, ok: false,
        error: (cause instanceof Error ? cause.message : String(cause)).slice(0, 4000) };
    }
    if (!this.disposed) await this.transport.send(delivery.sender, response).catch(() => undefined);
  }
}
