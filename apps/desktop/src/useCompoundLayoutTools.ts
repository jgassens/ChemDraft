import { useEffect, useState } from "react";
import { loadCompoundLayoutSettings } from "./compoundLayoutSettings";
import { listenForCompoundLayoutSettings } from "./window-manager";

export function useCompoundLayoutTools(): boolean {
  const [enabled, setEnabled] = useState(() => loadCompoundLayoutSettings().enabled);
  useEffect(() => {
    let disposed = false;
    let unlisten: (() => void) | undefined;
    void listenForCompoundLayoutSettings(settings => setEnabled(settings.enabled)).then(listener => {
      if (disposed) listener(); else unlisten = listener;
    });
    return () => { disposed = true; unlisten?.(); };
  }, []);
  return enabled;
}
