import { invoke } from "@tauri-apps/api/core";
import { listenCurrentWindowEvent } from "../window-manager/tauriEvents";
import { DIALOG_HOST_EVENT, DIALOG_OWNER_EVENT, parseDialogMessage, type DialogMessage, type DialogRegistration, type DialogCloseReason } from "./dialogProtocol";

export interface DialogDelivery { senderWindowId: string; windowLabel: string; message: unknown }
export interface DialogTransport {
  subscribe(handler: (delivery: DialogDelivery) => void): Promise<() => void>;
  open(snapshot: DialogMessage): Promise<DialogRegistration>;
  publish(hostId: string, message: DialogMessage): Promise<void>;
  close(hostId: string, reason: DialogCloseReason): Promise<void>;
}
export const nativeDialogTransport: DialogTransport = {
  subscribe: handler => listenCurrentWindowEvent<DialogDelivery>(DIALOG_OWNER_EVENT, e => handler(e.payload)),
  open: snapshot => invoke("dialog_open", { message: snapshot }),
  publish: (hostId, message) => invoke("dialog_publish", { hostId, message }),
  close: (hostId, reason) => invoke("dialog_close", { hostId, reason })
};
/** Listener is attached before bootstrap, and bootstrap replays the retained owner snapshot. */
export async function subscribeDialogHost(hostId: string, handler: (message: DialogMessage) => void): Promise<() => void> {
  const stop = await listenCurrentWindowEvent<DialogDelivery>(DIALOG_HOST_EVENT, e => {
    const message = parseDialogMessage(e.payload.message);
    if (message && e.payload.senderWindowId === message.ownerWindowId) handler(message);
  });
  try {
    await invoke("dialog_request", { hostId, protocolVersion: 1, requestId: crypto.randomUUID() });
    return stop;
  } catch (error) { stop(); throw error; }
}
export async function sendDialogMessage(hostId: string, message: DialogMessage): Promise<void> {
  if (!parseDialogMessage(message)) throw new Error("Invalid dialog message");
  await invoke("dialog_send", { hostId, message });
}
