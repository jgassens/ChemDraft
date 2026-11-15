import { useEffect, useState } from "react";
import { CUSTOM_SWATCH_STORAGE_KEY, loadCustomSwatches, saveCustomSwatches, type CustomSwatchState } from "../customColorSwatches";
import { isDesktopRuntime } from "../window-manager";
import { listenTauriEvent } from "../window-manager/tauriEvents";

const CHANGE_EVENT = "chemdraft://custom-color-swatches";

/** The document owner writes settings; other webviews reload them, never accepting command data. */
export function persistCustomSwatches(state: CustomSwatchState): void {
  saveCustomSwatches(state);
  window.dispatchEvent(new Event(CHANGE_EVENT));
  if (isDesktopRuntime()) void import("@tauri-apps/api/event").then(({ emit }) => emit(CHANGE_EVENT)).catch(() => undefined);
}

export function useCustomSwatches(): CustomSwatchState {
  const [state, setState] = useState(loadCustomSwatches);
  useEffect(() => {
    const reload = () => setState(loadCustomSwatches());
    const storage = (event: StorageEvent) => { if (event.key === null || event.key === CUSTOM_SWATCH_STORAGE_KEY) reload(); };
    window.addEventListener(CHANGE_EVENT, reload);
    window.addEventListener("storage", storage);
    let stopped = false;
    let stop: (() => void) | undefined;
    if (isDesktopRuntime()) void listenTauriEvent(CHANGE_EVENT, reload).then(cleanup => {
      if (stopped) cleanup(); else { stop = cleanup; reload(); }
    }).catch(() => undefined);
    reload();
    return () => { stopped = true; stop?.(); window.removeEventListener(CHANGE_EVENT, reload); window.removeEventListener("storage", storage); };
  }, []);
  return state;
}
