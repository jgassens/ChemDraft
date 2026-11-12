import type { RuntimeBroker } from "./runtimeBroker";
import type { RuntimeDelivery, RuntimeTransport } from "./runtimeBrokerProtocol";

export const RUNTIME_STARTUP_MS = 15_000;
export const runtimeStartupError = (cause: unknown) => new Error(
  `Plugin runtime host failed to start: ${cause instanceof Error ? cause.message : String(cause)} Drawing remains available.`);

/** Connect asynchronously without delaying the document renderer or losing its reply handlers. */
export function deferredRuntimeTransport(connection: Promise<RuntimeTransport>): RuntimeTransport {
  let listener: ((delivery: RuntimeDelivery) => void) | undefined;
  let stop: (() => void) | undefined;
  let closed = false;
  const ready = connection.then(transport => {
    if (closed) {
      transport.subscribe(() => {})();
      throw new Error("The plugin runtime connection is closed.");
    }
    stop = transport.subscribe(delivery => listener?.(delivery));
    return transport;
  });
  void ready.catch(() => undefined);
  return {
    subscribe(handler) {
      if (listener || closed) throw new Error("Runtime transport is closed or already subscribed.");
      listener = handler;
      return () => { closed = true; listener = undefined; stop?.(); };
    },
    send: async (recipient, message) => (await ready).send(recipient, message)
  };
}

/** Only readiness is retried. Commands and writes are never replayed. */
export async function initializeRuntimeHost(broker: RuntimeBroker, timeoutMs = RUNTIME_STARTUP_MS): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  try {
    for (;;) {
      try { await broker.call("runtime", "initializeRuntime", {}, Math.max(1, deadline - Date.now())); return; }
      catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (Date.now() >= deadline || !/recipient (?:is not connected|window no longer exists)|method unavailable: initializeRuntime/.test(message)) throw error;
        await new Promise(resolve => setTimeout(resolve, 50));
      }
    }
  } catch (error) { throw runtimeStartupError(error); }
}
