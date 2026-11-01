/** Cold module/worker/WASM loading has its own bounded budget. Work deadlines still
 * include both queues; only the assigned worker's actual startup is excluded. */
export const CHEMISTRY3D_STARTUP_TIMEOUT_MS = 30_000;

const startupPauses = new WeakMap<AbortSignal, () => () => void>();

/** Internal embedding-host hook, never exposed to plugins. The desktop pool pauses the
 * outer admission timer while its assigned worker loads; arbitrary providers still time out. */
export function pauseChemistry3dDeadlineForStartup(signal: AbortSignal): () => void {
  return startupPauses.get(signal)?.() ?? (() => undefined);
}

export function registerChemistry3dStartupPause(signal: AbortSignal, pause: () => () => void): () => void {
  startupPauses.set(signal, pause);
  return () => startupPauses.delete(signal);
}

/** One work budget including both the per-plugin and app-wide worker queues. */
export function chemistry3dTimeoutMs(method: "embed3d" | "minimize3d" | "flatten3d", components = 1): number {
  return method === "embed3d" ? 15000 * components : method === "minimize3d" ? 60000 : 5000;
}
