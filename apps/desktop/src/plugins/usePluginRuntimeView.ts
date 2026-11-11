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
  const view = useRuntimeView(session.client);
  useEffect(() => { session.start(); }, [session]);
  return view;
}
const browser = isTauriHost() ? undefined : await import("./localPluginRuntime");
function browserSession(providers: RuntimeDocumentProviders) {
  if (!browser) throw new Error("The desktop plugin runtime requires its hidden host.");
  return browser.localPluginRuntimeSession(providers);
}
