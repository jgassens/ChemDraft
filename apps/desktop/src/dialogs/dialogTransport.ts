import { Channel, invoke } from "@tauri-apps/api/core";
import { parseDialogMessage, type DialogMessage, type DialogRegistration, type DialogCloseReason } from "./dialogProtocol";

/** Only the per-invoke IPC channel supplies these deliveries; never subscribe to the event bus. */
export interface DialogDelivery { senderWindowId: string; windowLabel: string; message: unknown }
export interface DialogTransport {
  subscribe(handler: (delivery: DialogDelivery) => void): Promise<() => void>;
  open(snapshot: DialogMessage): Promise<DialogRegistration>;
  publish(hostId: string, message: DialogMessage): Promise<void>;
  close(hostId: string, reason: DialogCloseReason): Promise<void>;
}
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
  const channel = new Channel<DialogDelivery>();
  channel.onmessage = delivery => {
    const message = parseDialogMessage(delivery.message);
    if (active && message && delivery.senderWindowId === message.ownerWindowId) handler(message);
  };
  const stop = () => { active = false; };
  try {
    await invoke("dialog_request", { hostId, protocolVersion: 1, requestId: crypto.randomUUID(), channel });
    return stop;
  } catch (error) { stop(); throw error; }
}
export async function sendDialogMessage(hostId: string, message: DialogMessage): Promise<void> {
  if (!parseDialogMessage(message)) throw new Error("Invalid dialog message");
  await invoke("dialog_send", { hostId, message });
}
