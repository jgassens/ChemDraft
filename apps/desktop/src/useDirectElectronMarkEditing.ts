import { useEffect, useState } from "react";
import { loadDirectElectronMarkEditing } from "./electronMarkEditingSettings";
import { listenForElectronMarkEditingSettings } from "./window-manager";

export function useDirectElectronMarkEditing(): boolean {
  const [enabled, setEnabled] = useState(loadDirectElectronMarkEditing);
  useEffect(() => {
    let disposed = false;
    let unlisten: (() => void) | undefined;
    void listenForElectronMarkEditingSettings(setEnabled).then(listener => {
      if (disposed) listener(); else unlisten = listener;
    });
    return () => { disposed = true; unlisten?.(); };
  }, []);
  return enabled;
}
