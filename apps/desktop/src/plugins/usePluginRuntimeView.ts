import { useEffect, useReducer } from "react";
import type { RuntimeDocumentProviders } from "./localPluginRuntime";
import { runtimeDocumentSession } from "./runtimeDocumentSession";
import { isTauriHost } from "./pluginStagingFs";
import { RuntimeViewClient } from "./runtimeViewClient";
import { recognitionInstallProgressStore } from "./structureRecognitionInstallProgress";

/** The document renders data and sends actions. Its subscription lifetime does not own the service. */
export function useRuntimeView(client: RuntimeViewClient) {
  const [, refresh] = useReducer((value: number) => value + 1, 0);
  useEffect(() => client.subscribe("state", refresh), [client]);
  useEffect(() => recognitionInstallProgressStore.connect(client.runtime.recognition), [client]);
  return client.read();
}

export function usePluginRuntimeView(providers: RuntimeDocumentProviders) {
  // The browser preview is an explicit local embedding, never a desktop startup fallback.
  const session = isTauriHost() ? runtimeDocumentSession(providers) : browserSession(providers);
  if (!isTauriHost()) {
    if (!browserHook || !providers.documentPort) throw new Error("The browser document runtime requires its document port.");
    const port = providers.documentPort;
    return browserHook.usePluginRuntime({ ...providers, documentPort: port,
      getActiveDocument: () => port.read(port.activeTabId())?.document,
      getSelection: warnings => port.selection(port.activeTabId(), warnings) });
  }
  const view = useRuntimeView(session.client);
  useEffect(() => { session.start(); }, [session]);
  return view;
}
const browser = isTauriHost() ? undefined : await import("./localPluginRuntime");
const browserHook = isTauriHost() ? undefined : await import("./usePluginRuntime");
function browserSession(providers: RuntimeDocumentProviders) {
  if (!browser) throw new Error("The desktop plugin runtime requires its hidden host.");
  return browser.localPluginRuntimeSession(providers);
}
