import type { RuntimeDelivery, RuntimeMessage, RuntimeTransport } from "./runtimeBrokerProtocol";

/** Addressed JSON channel used by the single-webview owner and simulated clients. No objects,
 * callbacks, controllers or host references are shared between endpoints. */
export class RuntimeInProcessChannels {
  private readonly listeners = new Map<string, Set<(delivery: RuntimeDelivery) => void>>();
  transport(label: string): RuntimeTransport {
    return {
      immediate: true,
      subscribe: listener => {
        const listeners = this.listeners.get(label) ?? new Set();
        listeners.add(listener);
        this.listeners.set(label, listeners);
        return () => { listeners.delete(listener); };
      },
      send: async (recipient, message) => this.deliver(recipient, label, JSON.parse(JSON.stringify(message)))
    };
  }
  protected deliver(recipient: string, sender: string, message: RuntimeMessage): void {
    for (const listener of this.listeners.get(recipient) ?? []) listener({ sender, message });
  }
}
