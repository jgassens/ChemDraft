import type { RuntimeMessage, RuntimeTransport } from "../plugins/runtimeBrokerProtocol";
import { RuntimeInProcessChannels } from "../plugins/runtimeInProcessChannels";

/** Simulated authenticated, addressed private channels, with JSON serialization in both directions. */
export class RuntimeTestChannels extends RuntimeInProcessChannels {
  readonly deliveries: Array<{ sender: string; recipient: string; message: RuntimeMessage }> = [];
  override transport(label: string): RuntimeTransport {
    const channel = super.transport(label);
    return {
      ...channel,
      send: async (recipient, message) => {
        this.deliveries.push({ sender: label, recipient, message: structuredClone(message) });
        await channel.send(recipient, message);
      }
    };
  }
  override deliver(recipient: string, sender: string, message: unknown): void {
    super.deliver(recipient, sender, message as RuntimeMessage);
  }
}
