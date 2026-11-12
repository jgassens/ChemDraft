import { afterEach, expect, it, vi } from "vitest";
const native = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: native.invoke, Channel: class { onmessage = (_message: unknown) => {}; } }));
import { connectNativeRuntimeTransport } from "./runtimeBrokerTransport";

afterEach(() => vi.resetAllMocks());
it("retains a private startup delivery arriving before connect resolves and before the broker subscribes", async () => {
  const message = { version: 1, kind: "request", id: "startup", method: "initializeRuntime", payload: {} };
  const bytes = new TextEncoder().encode(JSON.stringify(message));
  native.invoke.mockImplementation(async (command: string, args: { channel: { onmessage(value: unknown): void } }) => {
    if (command !== "runtime_broker_connect") return;
    args.channel.onmessage({ sender: "main", connection: "connection", chunk: {
      transferId: "early", index: 0, total: 1, bytes: bytes.length, data: btoa(String.fromCharCode(...bytes))
    } });
    return "connection";
  });
  const transport = await connectNativeRuntimeTransport("runtime");
  const receive = vi.fn();
  const stop = transport.subscribe(receive);
  expect(receive).toHaveBeenCalledExactlyOnceWith({ sender: "main", message });
  stop(); await transport.dispose();
});

it("validates connection generations on buffered startup deliveries before passing them to a broker", async () => {
  const message = { version: 1, kind: "request", id: "stale", method: "initializeRuntime", payload: {} };
  const bytes = new TextEncoder().encode(JSON.stringify(message));
  native.invoke.mockImplementation(async (command: string, args: { channel: { onmessage(value: unknown): void } }) => {
    if (command !== "runtime_broker_connect") return;
    args.channel.onmessage({ sender: "main", connection: "old-generation", chunk: {
      transferId: "early", index: 0, total: 1, bytes: bytes.length, data: btoa(String.fromCharCode(...bytes))
    } });
    return "new-generation";
  });
  const transport = await connectNativeRuntimeTransport("runtime");
  const receive = vi.fn();
  transport.subscribe(receive);
  expect(receive).not.toHaveBeenCalled();
  await transport.dispose();
});
