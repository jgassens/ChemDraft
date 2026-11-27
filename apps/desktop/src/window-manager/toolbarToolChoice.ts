import { listenTauriEvent } from "./tauriEvents";

/**
 * Which toolbar control a tool was chosen through. Toolbars use it so exactly one control shows the
 * active tool: the one the user pressed, never every control that happens to carry the same command.
 *
 * `itemId` names a toolbar item whose face or standalone button was pressed; `flyoutId` names the
 * dropdown whose menu the tool was chosen from (a native flyout knows only its flyout id, which is
 * the item's `submenu.id`). `toolsetId` is the toolbar the control lives in.
 */
export interface ToolbarToolChoice {
  toolsetId: string;
  commandId: string;
  itemId?: string;
  flyoutId?: string;
}

export const TOOLBAR_TOOL_CHOICE_EVENT = "chemdraft://toolbar-tool-choice";

function isDesktopHost(): boolean {
  const candidate = globalThis as typeof globalThis & { __TAURI_INTERNALS__?: unknown; __TAURI__?: unknown };
  return Boolean(candidate.__TAURI_INTERNALS__ || candidate.__TAURI__);
}

function isToolbarToolChoice(value: unknown): value is ToolbarToolChoice {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as Partial<ToolbarToolChoice>;
  return typeof candidate.toolsetId === "string" && typeof candidate.commandId === "string"
    && (candidate.itemId === undefined || typeof candidate.itemId === "string")
    && (candidate.flyoutId === undefined || typeof candidate.flyoutId === "string");
}

/**
 * Tell every toolbar (this window's synchronously, other windows' over the Tauri event bus) which
 * control a tool was chosen through. Call it before the command itself is sent, so the choice is
 * known by the time the new active tool is broadcast back.
 */
export async function announceToolbarToolChoice(choice: ToolbarToolChoice): Promise<void> {
  if (typeof window !== "undefined") {
    window.dispatchEvent(new CustomEvent(TOOLBAR_TOOL_CHOICE_EVENT, { detail: choice }));
  }
  if (!isDesktopHost()) return;
  const { emit } = await import("@tauri-apps/api/event");
  await emit<ToolbarToolChoice>(TOOLBAR_TOOL_CHOICE_EVENT, choice);
}

/**
 * Listen for toolbar tool choices. The window-local listener attaches synchronously; on the desktop a
 * Tauri listener is added too, so a window can see the same choice twice — handlers are idempotent.
 */
export async function listenForToolbarToolChoices(handler: (choice: ToolbarToolChoice) => void): Promise<() => void> {
  const domListener = (event: Event) => {
    const detail = (event as CustomEvent<unknown>).detail;
    if (isToolbarToolChoice(detail)) handler(detail);
  };
  if (typeof window !== "undefined") window.addEventListener(TOOLBAR_TOOL_CHOICE_EVENT, domListener);
  const stopDom = () => {
    if (typeof window !== "undefined") window.removeEventListener(TOOLBAR_TOOL_CHOICE_EVENT, domListener);
  };
  if (!isDesktopHost()) return stopDom;
  try {
    const stopTauri = await listenTauriEvent<unknown>(TOOLBAR_TOOL_CHOICE_EVENT, (event) => {
      if (isToolbarToolChoice(event.payload)) handler(event.payload);
    });
    return () => {
      stopDom();
      stopTauri();
    };
  } catch {
    return stopDom;
  }
}
