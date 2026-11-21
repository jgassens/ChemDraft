import { useEffect, useRef } from "react";
import { isDesktopRuntime } from "../window-manager";
import { desktopPreferences } from "../desktopPreferences";

const WEB_SEEN_KEY = "chemdraft.guidedTourSeen";
const IDLE_DELAY_MS = 800;
export const TOUR_WAITING_FOR_IDLE = "Guided tour is waiting for the document window to be idle";
export type TourMode = "automatic" | "force" | "suppress";

export async function loadTourSeen(): Promise<boolean> {
  if (isDesktopRuntime()) return (await desktopPreferences())?.guidedTourSeen === true;
  return localStorage.getItem(WEB_SEEN_KEY) === "true";
}

export async function saveTourSeen(): Promise<void> {
  if (isDesktopRuntime()) await desktopPreferences({ guidedTourSeen: true });
  else localStorage.setItem(WEB_SEEN_KEY, "true");
}

/** Require an idle interval before asking the native host to admit the automatic tour. */
export function useAutomaticTour(options: {
  mode?: TourMode;
  retry: number;
  idle: () => boolean;
  open: () => Promise<void>;
  onError: (error: unknown) => void;
}): void {
  const current = useRef(options);
  current.current = options;
  const mode = options.mode ?? (import.meta.env.MODE === "test" ? "suppress" : "automatic");
  useEffect(() => {
    if (mode === "suppress") return;
    let stopped = false;
    let timer: ReturnType<typeof setTimeout>;
    let idleSince: number | undefined;
    const check = async () => {
      if (stopped) return;
      const now = Date.now();
      if (!current.current.idle()) idleSince = undefined;
      else {
        idleSince ??= now;
        if (now - idleSince >= IDLE_DELAY_MS) {
          try { await current.current.open(); return; }
          catch (error) {
            if (String(error) !== TOUR_WAITING_FOR_IDLE) {
              if (!stopped) current.current.onError(error);
              return;
            }
            idleSince = undefined;
          }
        }
      }
      if (!stopped) timer = setTimeout(check, 200);
    };
    void (mode === "force" ? Promise.resolve(false) : loadTourSeen()).then(seen => {
      if (!seen) void check();
    }).catch(error => { if (!stopped) current.current.onError(error); });
    return () => { stopped = true; clearTimeout(timer); };
  }, [mode, options.retry]);
}
