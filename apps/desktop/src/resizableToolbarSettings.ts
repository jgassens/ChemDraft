import { isDesktopRuntime } from "./window-manager";
import { listenTauriEvent } from "./window-manager/tauriEvents";

export interface ResizableToolbarSettings { enabled: boolean }
export type PaletteFrameResetScope = "all" | readonly string[];
const STORAGE_KEY = "chemdraft.resizable-toolbars.v1";
const FRAME_PREFIX = "chemdraft.palette.frame.v1.";
const SETTINGS_EVENT = "chemdraft://resizable-toolbar-settings";
const RESET_EVENT = "chemdraft://palette-frame-reset";

export function loadResizableToolbarSettings(): ResizableToolbarSettings {
  try {
    const value: unknown = JSON.parse(globalThis.localStorage?.getItem(STORAGE_KEY) ?? "null");
    if (isSettings(value)) return value;
  } catch { /* Unavailable or corrupt storage uses the default. */ }
  return { enabled: false };
}

export function saveResizableToolbarSettings(settings: ResizableToolbarSettings): void {
  try { globalThis.localStorage?.setItem(STORAGE_KEY, JSON.stringify(settings)); }
  catch { /* Persistence is best effort. */ }
}

function isSettings(value: unknown): value is ResizableToolbarSettings {
  return typeof value === "object" && value !== null && typeof (value as ResizableToolbarSettings).enabled === "boolean";
}
function isScope(value: unknown): value is PaletteFrameResetScope {
  return value === "all" || (Array.isArray(value) && value.every((id) => typeof id === "string"));
}
async function broadcast<T>(name: string, value: T): Promise<void> {
  globalThis.window?.dispatchEvent(new CustomEvent(name, { detail: value }));
  if (isDesktopRuntime()) {
    const { emit } = await import("@tauri-apps/api/event");
    await emit(name, value);
  }
}
async function listen<T>(name: string, validate: (value: unknown) => value is T, handler: (value: T) => void): Promise<() => void> {
  const onDom = (event: Event) => {
    const value: unknown = (event as CustomEvent<unknown>).detail;
    if (validate(value)) handler(value);
  };
  globalThis.window?.addEventListener(name, onDom);
  let unlisten: (() => void) | undefined;
  try {
    if (isDesktopRuntime()) unlisten = await listenTauriEvent<unknown>(name, (event) => {
      if (validate(event.payload)) handler(event.payload);
    });
  } catch (error) {
    globalThis.window?.removeEventListener(name, onDom);
    throw error;
  }
  return () => { globalThis.window?.removeEventListener(name, onDom); unlisten?.(); };
}
export function broadcastResizableToolbarSettings(settings: ResizableToolbarSettings): Promise<void> {
  return broadcast(SETTINGS_EVENT, settings);
}
export function listenForResizableToolbarSettings(handler: (settings: ResizableToolbarSettings) => void): Promise<() => void> {
  return listen(SETTINGS_EVENT, isSettings, handler);
}
export async function resetPaletteFrames(scope: PaletteFrameResetScope): Promise<void> {
  try {
    const storage = globalThis.localStorage;
    const ids = scope === "all"
      ? Array.from({ length: storage?.length ?? 0 }, (_, index) => storage.key(index))
          .filter((key): key is string => key !== null && key.startsWith(FRAME_PREFIX))
      : scope.map((id) => `${FRAME_PREFIX}${id}`);
    for (const key of ids) storage?.removeItem(key);
  } catch { /* Live palettes must still reset when storage is unavailable. */ }
  await broadcast(RESET_EVENT, scope);
}
export function listenForPaletteFrameResets(handler: (scope: PaletteFrameResetScope) => void): Promise<() => void> {
  return listen(RESET_EVENT, isScope, handler);
}
