import { useEffect, useState } from "react";
import { loadExportPreviewEnabled } from "../exportPreviewSettings";
import { listenForExportPreviewSettings } from "../window-manager";

/** Subscribe in every window using Export, including the browser fallback. */
export function useExportPreviewEnabled(nativeEvents = false): boolean {
  const [enabled, setEnabled] = useState(loadExportPreviewEnabled);
  useEffect(() => {
    let disposed = false;
    let stop: (() => void) | undefined;
    void listenForExportPreviewSettings(value => { if (!disposed) setEnabled(value); }, nativeEvents).then(unlisten => {
      if (disposed) unlisten();
      else { stop = unlisten; setEnabled(loadExportPreviewEnabled()); }
    }).catch(() => { /* Storage and DOM notifications remain available if native listen fails. */ });
    return () => { disposed = true; stop?.(); };
  }, [nativeEvents]);
  return enabled;
}
