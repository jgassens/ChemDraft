import { useEffect, useReducer, useRef } from "react";
import { createPluginRuntimeOwner, type PluginRuntimeProviders, type PluginRuntimeView } from "./pluginRuntimeOwner";
export { pluginCommandFailure } from "./pluginRuntimeOwner";
export type { PluginRuntimeProviders, PluginRuntimeView } from "./pluginRuntimeOwner";

/** Local embedding compatibility hook. MainWindow uses the broker-only view adapter. */
export function usePluginRuntime(providers: PluginRuntimeProviders): PluginRuntimeView {
  const ownerRef = useRef<ReturnType<typeof createPluginRuntimeOwner> | null>(null);
  if (!ownerRef.current) ownerRef.current = createPluginRuntimeOwner(providers);
  const owner = ownerRef.current;
  owner.updateProviders(providers);
  const [, refresh] = useReducer((value: number) => value + 1, 0);
  useEffect(() => {
    leases.add(owner);
    const stop = owner.subscribe(refresh);
    const disconnectProgress = owner.attachProgress();
    owner.start();
    return () => {
      leases.delete(owner); stop(); disconnectProgress();
      queueMicrotask(() => { if (!leases.has(owner)) owner.dispose(); });
    };
  }, [owner]);
  const next = owner.read();
  const previous = useRef(next);
  for (const key of ["plugins", "pluginMenuItems", "detachedPanels", "cachedPluginUpdateResults"] as const) {
    if (JSON.stringify(previous.current[key]) === JSON.stringify(next[key])) Object.assign(next, { [key]: previous.current[key] });
  }
  previous.current = next;
  return next;
}
const leases = new WeakSet<object>();
