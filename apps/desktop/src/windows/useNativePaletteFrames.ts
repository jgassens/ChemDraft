import { useEffect, useState } from "react";
import { listenTauriEvent } from "../window-manager/tauriEvents";
import type { OverlayRect } from "../plugins/overlayPlacement";

export type NativePaletteFrames = {
  frames: readonly OverlayRect[];
  documentOrigin: { x: number; y: number };
  scale: number;
};

const FRAME_INTERVAL_MS = 250;

/** Shared by macOS and Windows: Tauri positions and sizes are physical screen pixels. */
export async function readNativePaletteFrames(): Promise<NativePaletteFrames> {
  const { getAllWindows, getCurrentWindow } = await import("@tauri-apps/api/window");
  const main = getCurrentWindow();
  const [documentOrigin, scale, windows] = await Promise.all([main.innerPosition(), main.scaleFactor(), getAllWindows()]);
  const frames = await Promise.all(windows.filter(win => win.label !== main.label
    && win.label !== "toolset-tooltip"
    && (win.label.startsWith("toolset-") || win.label.startsWith("plugin-panel-")
      || win.label.startsWith("dialog-main-") || win.label === "preferences" || win.label === "spin3d-debugger"))
    .map(async win => {
      // Prewarmed popovers and hidden palettes still exist; minimized frames aren't obstructions.
      // A window can close between enumeration and any of these calls.
      try {
        if (!await win.isVisible() || await win.isMinimized()) return undefined;
        const [position, size] = await Promise.all([win.outerPosition(), win.outerSize()]);
        return { x: position.x, y: position.y, width: size.width, height: size.height };
      } catch { return undefined; }
    }));
  return { documentOrigin, scale, frames: frames.filter((frame): frame is OverlayRect => frame !== undefined) };
}

/** One sampler for all overlays, with no overlapping reads and at most four reads per second. */
export function observeNativePaletteFrames(publish: (frames: NativePaletteFrames) => void,
  read = readNativePaletteFrames, sampling = false) {
  let stopped = false;
  let reading = false;
  let requested = false;
  let trailingTimer: ReturnType<typeof setTimeout> | undefined;
  let lastRead = -Infinity;
  let previous = "";
  const drain = () => {
    if (stopped || reading || trailingTimer !== undefined || !requested) return;
    const delay = FRAME_INTERVAL_MS - (Date.now() - lastRead);
    if (delay > 0) {
      trailingTimer = setTimeout(() => { trailingTimer = undefined; drain(); }, delay);
      return;
    }
    requested = false;
    reading = true;
    lastRead = Date.now();
    void read().then(snapshot => {
      const key = JSON.stringify(snapshot);
      if (!stopped && key !== previous) { previous = key; publish(snapshot); }
    }).catch(() => { /* Closing/minimizing the document can temporarily prevent frame reads. */ })
      .finally(() => { reading = false; drain(); });
  };
  const refresh = () => {
    if (stopped) return;
    requested = true;
    drain();
  };
  refresh();
  // show()/hide() do not emit Tauri frame events (notably warm popovers). Sample visibility too.
  const timer = sampling ? setInterval(refresh, FRAME_INTERVAL_MS) : undefined;
  return { refresh, stop: () => {
    stopped = true;
    if (timer !== undefined) clearInterval(timer);
    if (trailingTimer !== undefined) clearTimeout(trailingTimer);
  } };
}

export function useNativePaletteFrames(enabled: boolean, sampling: boolean): NativePaletteFrames | undefined {
  const [snapshot, setSnapshot] = useState<NativePaletteFrames>();
  useEffect(() => {
    if (!enabled || !("__TAURI_INTERNALS__" in window)) return;
    const observer = observeNativePaletteFrames(setSnapshot, readNativePaletteFrames, sampling);
    let stopped = false;
    const unlisteners: (() => void)[] = [];
    // Reuse the window manager's safe event path, including native move/resize/scale and lifecycle.
    for (const event of ["tauri://move", "tauri://resize", "tauri://scale-change", "tauri://created",
      "tauri://destroyed", "chemdraft://toolset-window-state"]) {
      void listenTauriEvent(event, observer.refresh).then(stop => {
        if (stopped) stop(); else unlisteners.push(stop);
      }).catch(() => undefined);
    }
    window.addEventListener("resize", observer.refresh);
    return () => {
      stopped = true;
      observer.stop();
      window.removeEventListener("resize", observer.refresh);
      unlisteners.forEach(stop => stop());
    };
  }, [enabled, sampling]);
  return snapshot;
}
