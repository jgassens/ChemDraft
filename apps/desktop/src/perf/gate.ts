import { agentBridgeRequestedFromLocation } from "../agentBridge";

export function probeRequested(desktop: boolean, nativeAllowed: boolean, search: string, storage?: string | null): boolean {
  return desktop ? nativeAllowed : Boolean(agentBridgeRequestedFromLocation(search, storage)?.enabled);
}
export function perfProbeRequestedFromWindow(): boolean {
  const native = window as Window & { __TAURI_INTERNALS__?: unknown; __TAURI__?: unknown; __CHEMDRAFT_PERF_ALLOWED__?: boolean };
  if (native.__TAURI_INTERNALS__ || native.__TAURI__) return native.__CHEMDRAFT_PERF_ALLOWED__ === true;
  let storage: string | null = null;
  try { storage = window.localStorage.getItem("chemdraft.agentBridge"); } catch { /* Same bridge gate. */ }
  return probeRequested(false, false, window.location.search, storage);
}
