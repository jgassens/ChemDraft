import type { RuntimeDocumentPort } from "./runtimeBrokerDocument";
import type { PluginRuntimeClient } from "./runtimeViewClient";

/** Authorize against the live owner without letting the new IPC wait retarget Send or widen its
 * selection. A changed source must be retried explicitly before an invocation is opened. */
export function readRuntimeOverlayDeclaration(port: RuntimeDocumentPort,
  runtime: Pick<PluginRuntimeClient, "readCanvasOverlays">, pluginId: string, overlayId: string) {
  const tabId = port.activeTabId(), source = port.read(tabId);
  const selection = source && JSON.stringify(source.document.selection.objectIds);
  const declarations = runtime.readCanvasOverlays();
  const authorize = (entries: Awaited<typeof declarations>) => {
    const current = port.read(tabId);
    if (!source || !current || port.activeTabId() !== tabId || source.documentKey !== current.documentKey ||
      selection !== JSON.stringify(current.document.selection.objectIds)) {
      throw new Error("The source drawing or selection changed before the overlay action could start. Send it again.");
    }
    return entries.find(entry => entry.pluginId === pluginId && entry.overlay.id === overlayId);
  };
  return declarations instanceof Promise ? declarations.then(authorize) : authorize(declarations);
}
