import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { expect, vi } from "vitest";
import type { ChemDraftDocument } from "@chemdraft/chem-core";
import { ToolPalette } from "../ToolPalette";
import { createArtInspectorModel, selectedGraphicObjectsForArtInspector } from "../artInspectorModel";
import { getToolsetItemGroups } from "../toolsets";
import * as transport from "../window-manager";

type Message = { from: "document" | "toolbar"; phase: "preview" | "commit" | "cancel"; commandId: string; gestureId?: string };

/** Separate DOM/lifetime for the toolbar. Only delivery is controlled: both endpoints use their
 * production listeners, send functions and slider handlers; in particular, acks are never invented. */
export function paletteGestureTransport(snapshot: () => ChemDraftDocument, platform: "macos" | "windows") {
  const documentWindow = window;
  const documentNavigator = navigator;
  const send = {
    preview: transport.sendPaletteCommandPreview,
    commit: transport.sendPaletteCommandCommit,
    cancel: transport.sendPaletteCommandCancel
  };
  const messages: Message[] = [];
  let frame: HTMLIFrameElement | undefined;
  let toolbar: (Window & typeof globalThis) | undefined;
  let root: Root | undefined;
  let reject: ((message: Message) => boolean) | undefined;
  const enqueue = (phase: Message["phase"], commandId: string, gestureId?: string) => {
    const message: Message = { from: window === documentWindow ? "document" : "toolbar", phase, commandId, gestureId };
    if (reject?.(message)) return Promise.reject(new Error("Transport unavailable"));
    messages.push(message);
    return Promise.resolve();
  };
  vi.spyOn(transport, "sendPaletteCommandPreview").mockImplementation((id, gesture) => enqueue("preview", id, gesture));
  vi.spyOn(transport, "sendPaletteCommandCommit").mockImplementation((id, options) => enqueue("commit", id, options?.gestureId));
  vi.spyOn(transport, "sendPaletteCommandCancel").mockImplementation((id, gesture) => enqueue("cancel", id, gesture));

  async function inToolbar(action: () => void | Promise<void>) {
    if (!toolbar) throw new Error("Toolbar is destroyed");
    vi.stubGlobal("window", toolbar);
    vi.stubGlobal("document", toolbar.document);
    vi.stubGlobal("navigator", toolbar.navigator);
    try { await act(action); }
    finally {
      vi.stubGlobal("window", documentWindow);
      vi.stubGlobal("document", documentWindow.document);
      vi.stubGlobal("navigator", documentNavigator);
    }
  }
  const slider = (setting = "height") => {
    const input = toolbar?.document.querySelector<HTMLInputElement>(`[aria-label="Wave ${setting}"]`);
    if (!input) throw new Error(`Missing toolbar slider: ${setting}`);
    return input;
  };
  return {
    messages,
    slider,
    rejectWhen(predicate?: (message: Message) => boolean) { reject = predicate; },
    async open() {
      const drawing = snapshot();
      frame = documentWindow.document.createElement("iframe");
      documentWindow.document.body.append(frame);
      toolbar = frame.contentWindow as Window & typeof globalThis;
      Object.defineProperty(toolbar.navigator, "platform", { value: platform === "macos" ? "MacIntel" : "Win32", configurable: true });
      await inToolbar(() => {
        root = createRoot(toolbar!.document.body);
        root.render(<ToolPalette mode="floating" orientation="horizontal"
          itemGroups={[getToolsetItemGroups("core.art").flat().filter(item => item.primary.type === "control")]}
          onInvoke={() => { throw new Error("Pointer edits must use the preview/commit protocol"); }}
          widgetState={{
            onInvoke: () => { throw new Error("Pointer edits must use the preview/commit protocol"); },
            currentObjectColor: "#111111", currentArtStyleTarget: "stroke",
            currentArtStyle: createArtInspectorModel({ document: drawing,
              selectedGraphicObjects: selectedGraphicObjectsForArtInspector(drawing), requestedPaintTarget: "stroke" }),
            onArtStylePreview: (id, gesture) => { void transport.sendPaletteCommandPreview(id, gesture); },
            onArtStyleCommit: (id, gesture) => { void transport.sendPaletteCommandCommit(id, { gestureId: gesture }); },
            onArtStyleCancel: gesture => { void transport.sendPaletteCommandCancel("palette.preview.cancel", gesture).catch(() => undefined); }
          }} />);
      });
      for (const input of toolbar!.document.querySelectorAll<HTMLInputElement>('input[type="range"]')) {
        vi.spyOn(input, "getBoundingClientRect").mockReturnValue({ x: 0, y: 0, left: 0, top: 0,
          right: 100, bottom: 20, width: 100, height: 20, toJSON: () => ({}) });
      }
    },
    async destroy() {
      if (!toolbar) return;
      await inToolbar(() => { root!.unmount(); });
      frame!.remove();
      expect(frame!.isConnected).toBe(false);
      toolbar = undefined; frame = undefined; root = undefined;
    },
    async pointer(type: "pointerdown" | "pointermove" | "pointerup", setting = "height", x = 50) {
      await inToolbar(() => {
        const event = new toolbar!.MouseEvent(type, { bubbles: true, clientX: x, buttons: type === "pointerup" ? 0 : 1 });
        Object.defineProperty(event, "pointerId", { value: 1 });
        slider(setting).dispatchEvent(event);
      });
    },
    async escapeToolbar() {
      await inToolbar(() => { toolbar!.dispatchEvent(new toolbar!.KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true })); });
    },
    async deliver(index = 0) {
      const [message] = messages.splice(index, 1);
      if (!message) throw new Error("No queued message");
      const deliver = async () => {
        if (message.phase === "commit") await send.commit(message.commandId, { gestureId: message.gestureId });
        else await send[message.phase](message.commandId, message.gestureId);
      };
      if (message.from === "document") {
        if (toolbar) await inToolbar(deliver);
      } else await act(deliver);
    },
    async flush() {
      for (let count = 0; messages.length; count++) {
        if (count > 100) throw new Error("Transport did not settle");
        await this.deliver();
      }
    }
  };
}
