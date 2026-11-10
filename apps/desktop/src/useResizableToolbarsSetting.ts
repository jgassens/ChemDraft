import { useEffect, useState } from "react";
import { loadResizableFloatingToolbars } from "./toolbarResizeSettings";
import { listenForResizableToolbars } from "./window-manager";

export function useResizableToolbarsSetting(): boolean {
  const [enabled, setEnabled] = useState(loadResizableFloatingToolbars);
  useEffect(() => {
    let disposed = false;
    let unlisten: (() => void) | undefined;
    void listenForResizableToolbars(setEnabled).then(listener => {
      if (disposed) listener(); else unlisten = listener;
    });
    return () => { disposed = true; unlisten?.(); };
  }, []);
  return enabled;
}
