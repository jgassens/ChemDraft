import { Channel, invoke } from "@tauri-apps/api/core";
import { DIALOG_PREVIEW_MAX_BYTES, parseDialogMessage, type DialogMessage, type DialogRegistration, type DialogCloseReason } from "./dialogProtocol";

/** Only the per-invoke IPC channel supplies these deliveries; never subscribe to the event bus. */
export interface DialogDelivery { senderWindowId: string; windowLabel: string; message: unknown }
export interface DialogTransport {
  subscribe(handler: (delivery: DialogDelivery) => void): Promise<() => void>;
  open(snapshot: DialogMessage): Promise<DialogRegistration>;
  publish(hostId: string, message: DialogMessage): Promise<void>;
  close(hostId: string, reason: DialogCloseReason): Promise<void>;
}
// Keep in step with Rust: larger JSON enters Tauri's app-wide fetch queue.
const PREVIEW_CHUNK_TEXT_BYTES = 7168;
const PREVIEW_CHANNEL_BYTES = 8191;
let ownerHandler: ((delivery: DialogDelivery) => void) | undefined;
export const nativeDialogTransport: DialogTransport = {
  subscribe: async handler => {
    ownerHandler = handler;
    return () => { if (ownerHandler === handler) ownerHandler = undefined; };
  },
  open: snapshot => {
    const handler = ownerHandler;
    if (!handler) return Promise.reject(new Error("Dialog owner is not subscribed"));
    const channel = new Channel<DialogDelivery>();
    channel.onmessage = delivery => { if (ownerHandler === handler) handler(delivery); };
    return invoke("dialog_open", { message: snapshot, channel });
  },
  publish: (hostId, message) => invoke("dialog_publish", { hostId, message }),
  close: (hostId, reason) => invoke("dialog_close", { hostId, reason })
};
/** Rust authenticates the calling window before retaining this channel or replaying a snapshot. */
export async function subscribeDialogHost(hostId: string, handler: (message: DialogMessage) => void): Promise<() => void> {
  let active = true;
  const channel = new Channel<DialogDelivery | { previewChunk: { requestId: string; index: number; total: number; text: string } }>();
  let partial: { id: string; total: number; next: number; text: string } | undefined;
  channel.onmessage = delivery => {
    if (!active || !delivery || typeof delivery !== "object" || Array.isArray(delivery)) return;
    if ("previewChunk" in delivery) {
      const c = delivery.previewChunk;
      if (!c || typeof c.requestId !== "string" || !/^[A-Za-z0-9_-]{1,128}$/.test(c.requestId) || !Number.isInteger(c.total) || c.total < 1 || c.total > Math.ceil((DIALOG_PREVIEW_MAX_BYTES + 1024) * 6 / PREVIEW_CHUNK_TEXT_BYTES) + 8 || !Number.isInteger(c.index) || typeof c.text !== "string" || new TextEncoder().encode(JSON.stringify(c.text)).byteLength - 2 > PREVIEW_CHUNK_TEXT_BYTES || new TextEncoder().encode(JSON.stringify(delivery)).byteLength > PREVIEW_CHANNEL_BYTES) { partial = undefined; return; }
      if (c.index === 0) partial = { id: c.requestId, total: c.total, next: 0, text: "" };
      if (!partial || partial.id !== c.requestId || partial.total !== c.total || partial.next !== c.index) { partial = undefined; return; }
      partial.text += c.text;
      partial.next++;
      if (partial.text.length > DIALOG_PREVIEW_MAX_BYTES + 1024) { partial = undefined; return; }
      if (partial.next !== partial.total) return;
      const serialized = partial.text;
      const requestId = partial.id;
      partial = undefined;
      try { delivery = JSON.parse(serialized) as DialogDelivery; } catch { return; }
      if (!delivery || typeof delivery !== "object" || Array.isArray(delivery) || "previewChunk" in delivery) return;
      const preview = parseDialogMessage(delivery.message);
      if (!preview || preview.requestId !== requestId || preview.type !== "result" || preview.data.status !== "preview") return;
    }
    const message = parseDialogMessage(delivery.message);
    if (active && message && delivery.senderWindowId === message.ownerWindowId) handler(message);
  };
  const stop = () => { active = false; partial = undefined; };
  try {
    await invoke("dialog_request", { hostId, protocolVersion: 1, requestId: crypto.randomUUID(), channel });
    return stop;
  } catch (error) { stop(); throw error; }
}
export async function sendDialogMessage(hostId: string, message: DialogMessage): Promise<void> {
  if (!parseDialogMessage(message)) throw new Error("Invalid dialog message");
  await invoke("dialog_send", { hostId, message });
}
