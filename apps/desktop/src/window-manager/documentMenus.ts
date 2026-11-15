import type { NativePluginMenuItem } from "../plugins/nativePluginMenu";
import type { ToolbarMenuEntry } from "./index";

export interface MenuCommandState { commandId: string; enabled: boolean; checked?: boolean }
export interface DocumentMenuWindow { windowId: string; title: string; active: boolean }
export interface NativeMenuSnapshot {
  entries: readonly ToolbarMenuEntry[];
  view: { rulersVisible: boolean; crosshairsVisible: boolean; hasMultipleDocumentTabs: boolean };
  pluginItems: readonly NativePluginMenuItem[];
  commands: readonly MenuCommandState[];
  title: string;
}

/** One publisher per document webview. Merge the effects in a commit into one complete snapshot;
 * serialize IPC so a slower publication cannot overwrite newer state. Hidden documents use tasks,
 * since animation frames may be suspended. Unchanged snapshots do not cross the native bridge. */
export function createMenuSnapshotPublisher(send: (snapshot: NativeMenuSnapshot) => Promise<unknown>) {
  let current: NativeMenuSnapshot = {
    entries: [], view: { rulersVisible: true, crosshairsVisible: true, hasMultipleDocumentTabs: false },
    pluginItems: [], commands: [], title: "Untitled"
  };
  let scheduled = false;
  let inFlight = false;
  let sent = "";
  const flush = async () => {
    scheduled = false;
    if (inFlight) return;
    const snapshot = current;
    const key = JSON.stringify(snapshot);
    if (key === sent) return;
    inFlight = true;
    try { await send(snapshot); sent = key; }
    catch (error) { console.warn("Could not publish document menu:", error); }
    finally {
      inFlight = false;
      if (current !== snapshot) schedule();
    }
  };
  const schedule = () => {
    if (scheduled) return;
    scheduled = true;
    queueMicrotask(() => { void flush(); });
  };
  return (patch: Partial<NativeMenuSnapshot>) => { current = { ...current, ...patch }; schedule(); };
}

const windowListeners = new Set<(windows: readonly DocumentMenuWindow[]) => void>();
let latestWindows: readonly DocumentMenuWindow[] | undefined;

/** The publication response also supplies the list: startup cannot lose its initial state while
 * the asynchronous native event subscription is still attaching. */
export function subscribeNativeMenuWindows(listener: (windows: readonly DocumentMenuWindow[]) => void): () => void {
  windowListeners.add(listener);
  if (latestWindows) listener(latestWindows);
  return () => { windowListeners.delete(listener); };
}

const publish = createMenuSnapshotPublisher(async snapshot => {
  const { invoke } = await import("@tauri-apps/api/core");
  const windows = await invoke<readonly DocumentMenuWindow[]>("publish_menu_snapshot", { snapshot });
  if (Array.isArray(windows)) {
    latestWindows = windows;
    for (const listener of windowListeners) listener(windows);
  }
});

export function stageNativeMenuSnapshot(patch: Partial<NativeMenuSnapshot>): void { publish(patch); }

export async function runWindowMenuCommand(commandId: string): Promise<void> {
  const { invoke } = await import("@tauri-apps/api/core");
  await invoke("run_window_menu_command", { commandId });
}
