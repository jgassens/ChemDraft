import { useEffect } from "react";
import { connectNativeRuntimeTransport } from "./runtimeBrokerTransport";
import { RuntimeBroker } from "./runtimeBroker";
import { bindRuntimeHostSession } from "./runtimeHostSession";

// A host service belongs to the webview lifetime, including StrictMode effect replay.
let service: Promise<void> | undefined;
export function startRuntimeHostWindow(): Promise<void> {
  return service ??= connectNativeRuntimeTransport("runtime").then(transport => {
    const broker = new RuntimeBroker("runtime", transport);
    const dispose = bindRuntimeHostSession(broker);
    window.addEventListener("pagehide", () => { dispose(); broker.dispose(); }, { once: true });
  });
}

export function RuntimeHostWindow(): null {
  useEffect(() => { void startRuntimeHostWindow().catch(error => console.error("Plugin runtime host startup failed:", error)); }, []);
  return null;
}
