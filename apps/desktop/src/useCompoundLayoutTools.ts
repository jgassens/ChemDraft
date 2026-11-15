import { useEffect, useState } from "react";
import { loadCompoundLayoutSettings } from "./compoundLayoutSettings";
import { listenForCompoundLayoutSettings } from "./window-manager";

export function useCompoundLayoutSettings() {
  const [settings, setSettings] = useState(loadCompoundLayoutSettings);
  useEffect(() => {
    let disposed = false;
    let unlisten: (() => void) | undefined;
    void listenForCompoundLayoutSettings(setSettings).then(listener => {
      if (disposed) listener(); else unlisten = listener;
    });
    return () => { disposed = true; unlisten?.(); };
  }, []);
  return settings;
}

export function useCompoundLayoutTools(): boolean { return useCompoundLayoutSettings().enabled; }
