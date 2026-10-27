import { CHEMISTRY3D_STARTUP_TIMEOUT_MS, registerChemistry3dStartupPause } from "./chemistry3dDeadline";

/** Command-owned 3D admission. At most one running request and eight waiting per plugin. */
export class Chemistry3dQueue {
  private readonly plugins = new Map<string, { running: boolean; waiting: { start(): void; cancel(): void }[] }>();

  cancelQueued(pluginId: string): void {
    for (const task of [...(this.plugins.get(pluginId)?.waiting ?? [])]) task.cancel();
  }

  run<T>(pluginId: string, method: string, controller: AbortController, timeoutMs: number,
    work: (signal: AbortSignal) => Promise<T>): Promise<T> {
    const state = this.plugins.get(pluginId) ?? { running: false, waiting: [] };
    if (state.running && state.waiting.length >= 8) {
      return Promise.reject(new Error(`Plugin "${pluginId}" 3D chemistry is busy: at most 1 running call and 8 queued calls are allowed.`));
    }
    this.plugins.set(pluginId, state);
    return new Promise<T>((resolve, reject) => {
      let running = false;
      let finished = false;
      let unregisterStartup = () => {};
      const finish = (result?: T, error?: unknown) => {
        if (finished) return;
        finished = true;
        clearTimeout(timer);
        unregisterStartup();
        controller.signal.removeEventListener("abort", abort);
        const index = state.waiting.indexOf(task);
        if (index >= 0) state.waiting.splice(index, 1);
        if (running) state.running = false;
        if (error !== undefined) reject(error); else resolve(result!);
        if (!state.running) {
          const next = state.waiting.shift();
          if (next) next.start(); else this.plugins.delete(pluginId);
        }
      };
      const abort = () => finish(undefined, controller.signal.reason instanceof Error && controller.signal.reason.name !== "AbortError" ? controller.signal.reason :
        new Error(`chemistry.${method} cancelled because the plugin command ended.`));
      let remaining = timeoutMs;
      let armedAt = Date.now();
      const expire = () => controller.abort(new Error(
        `${method} timed out after ${timeoutMs / 1000} seconds including queue time.`));
      let timer = setTimeout(expire, remaining);
      let startupUsed = false;
      unregisterStartup = registerChemistry3dStartupPause(controller.signal, () => {
        if (finished || startupUsed) return () => {};
        startupUsed = true;
        remaining -= Date.now() - armedAt;
        clearTimeout(timer);
        timer = setTimeout(() => controller.abort(new Error(
          `${method} worker startup timed out after ${CHEMISTRY3D_STARTUP_TIMEOUT_MS / 1000} seconds.`)), CHEMISTRY3D_STARTUP_TIMEOUT_MS);
        let resumed = false;
        return () => {
          if (resumed || finished) return;
          resumed = true;
          clearTimeout(timer);
          armedAt = Date.now();
          timer = setTimeout(expire, Math.max(0, remaining));
        };
      });
      const task = { cancel: () => controller.abort(), start: () => {
        running = true;
        state.running = true;
        try { void work(controller.signal).then(result => finish(result), error => finish(undefined, error)); }
        catch (error) { finish(undefined, error); }
      } };
      controller.signal.addEventListener("abort", abort, { once: true });
      if (controller.signal.aborted) abort();
      else if (state.running) state.waiting.push(task);
      else task.start();
    });
  }
}
