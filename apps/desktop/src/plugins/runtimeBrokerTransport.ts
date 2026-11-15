import { Channel, invoke } from "@tauri-apps/api/core";
import {
  isRuntimeDocumentLabel, parseRuntimeMessage, RUNTIME_BROKER_MAX_BYTES, RUNTIME_HOST_LABEL,
  type RuntimeDelivery, type RuntimeMessage, type RuntimeTransport
} from "./runtimeBrokerProtocol";

// Keep in step with runtime_broker.rs. Base64 keeps escaping/Unicode from exceeding the private
// channel's 8191-byte budget (larger Tauri deliveries use an app-wide fetch queue).
const CHUNK_BYTES = 4096;
const MAX_CHUNKS = RUNTIME_BROKER_MAX_BYTES / CHUNK_BYTES;
const CHANNEL_BYTES = 8191;
const TRANSFER_TTL = 30_000;
interface Chunk { transferId: string; index: number; total: number; bytes: number; data: string }
interface NativeDelivery { sender: string; connection: string; chunk: Chunk }
interface Partial {
  sender: string; id: string; total: number; bytes: Uint8Array; next: number; started: number;
}
export interface NativeRuntimeTransport extends RuntimeTransport { dispose(): Promise<void> }
const encoder = new TextEncoder();
const token = (value: unknown): value is string => typeof value === "string"
  && value.length >= 1 && value.length <= 64 && !/[^A-Za-z0-9_-]/.test(value);

/** Establish the channel before constructing RuntimeBroker. Rust authenticates the actual caller
 * and retains the channel only for that live window/connection. Never listen to generic events. */
export async function connectNativeRuntimeTransport(label: string): Promise<NativeRuntimeTransport> {
  if (label !== RUNTIME_HOST_LABEL && !isRuntimeDocumentLabel(label)) {
    throw new Error("Utilities cannot connect to the plugin runtime broker.");
  }
  let active = true;
  let listener: ((delivery: RuntimeDelivery) => void) | undefined;
  let partial: Partial | undefined;
  let connection: string | undefined;
  // A peer can send immediately after native registration, before invoke resolves/subscription.
  // Retain a bounded first transfer instead of losing a valid startup handshake in that gap.
  const early: NativeDelivery[] = [];
  let queue = Promise.resolve();
  let disposal: Promise<void> | undefined;
  const peerAllowed = (peer: string) => label === RUNTIME_HOST_LABEL
    ? isRuntimeDocumentLabel(peer) : peer === RUNTIME_HOST_LABEL;
  const channel = new Channel<NativeDelivery>();
  channel.onmessage = delivery => {
    if (!active) return;
    if (!listener || connection === undefined) {
      if (early.length < MAX_CHUNKS && encoder.encode(JSON.stringify(delivery)).byteLength <= CHANNEL_BYTES) early.push(delivery);
      return;
    }
    try {
      if (!delivery || typeof delivery !== "object" || delivery.connection !== connection || !peerAllowed(delivery.sender)
        || encoder.encode(JSON.stringify(delivery)).byteLength > CHANNEL_BYTES) throw new Error("Invalid private delivery.");
      const c = delivery.chunk;
      if (!c || !token(c.transferId) || !Number.isInteger(c.bytes) || c.bytes < 1 || c.bytes > RUNTIME_BROKER_MAX_BYTES
        || !Number.isInteger(c.total) || c.total < 1 || c.total > MAX_CHUNKS || c.total !== Math.ceil(c.bytes / CHUNK_BYTES)
        || !Number.isInteger(c.index) || c.index < 0 || c.index >= c.total || typeof c.data !== "string"
        || c.data.length > Math.ceil(CHUNK_BYTES / 3) * 4) throw new Error("Invalid runtime chunk.");
      const decoded = atob(c.data);
      const expected = c.index + 1 === c.total ? c.bytes - c.index * CHUNK_BYTES : CHUNK_BYTES;
      if (decoded.length !== expected || btoa(decoded) !== c.data) throw new Error("Invalid runtime chunk encoding.");
      if (c.index === 0) {
        if (partial && Date.now() - partial.started < TRANSFER_TTL) throw new Error("Overlapping runtime transfer.");
        partial = { sender: delivery.sender, id: c.transferId, total: c.total, bytes: new Uint8Array(c.bytes), next: 0, started: Date.now() };
      }
      if (!partial || Date.now() - partial.started >= TRANSFER_TTL || partial.sender !== delivery.sender
        || partial.id !== c.transferId || partial.total !== c.total || partial.bytes.length !== c.bytes || partial.next !== c.index) {
        throw new Error("Stale or out-of-order runtime chunk.");
      }
      for (let i = 0; i < decoded.length; i++) partial.bytes[c.index * CHUNK_BYTES + i] = decoded.charCodeAt(i);
      partial.next++;
      if (partial.next !== partial.total) return;
      const completed = partial;
      partial = undefined;
      const message = parseRuntimeMessage(JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(completed.bytes)));
      listener({ sender: completed.sender, message });
    } catch { partial = undefined; } // Malformed deliveries cannot settle broker requests.
  };
  connection = await invoke<string>("runtime_broker_connect", { sender: label, channel });
  const dispose = (): Promise<void> => {
    if (disposal) return disposal;
    active = false;
    listener = undefined;
    partial = undefined;
    early.length = 0;
    disposal = invoke<void>("runtime_broker_disconnect", { sender: label, connection });
    return disposal;
  };
  return {
    subscribe(handler) {
      if (!active || listener) throw new Error("Runtime transport is closed or already subscribed.");
      listener = handler;
      for (const delivery of early.splice(0)) channel.onmessage(delivery);
      return () => { if (listener === handler) void dispose().catch(() => undefined); };
    },
    send(recipient: string, message: RuntimeMessage): Promise<void> {
      if (!active || !peerAllowed(recipient)) return Promise.reject(new Error("Invalid runtime transport recipient or closed connection."));
      // Snapshot/validate before queuing: later caller mutation cannot alter a queued message.
      let bytes: Uint8Array;
      try { bytes = encoder.encode(JSON.stringify(parseRuntimeMessage(message))); }
      catch (error) { return Promise.reject(error); }
      const send = queue.then(async () => {
        if (!active) throw new Error("Runtime transport connection is closed.");
        const transferId = crypto.randomUUID();
        const total = Math.ceil(bytes.length / CHUNK_BYTES);
        for (let index = 0; index < total; index++) {
          if (!active) throw new Error("Runtime transport connection is closed.");
          const data = btoa(String.fromCharCode(...bytes.subarray(index * CHUNK_BYTES, (index + 1) * CHUNK_BYTES)));
          await invoke("runtime_broker_send", { sender: label, connection, recipient,
            chunk: { transferId, index, total, bytes: bytes.length, data } satisfies Chunk });
        }
      });
      queue = send.catch(() => undefined);
      return send;
    },
    dispose
  };
}
