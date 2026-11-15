import { readFileSync, readdirSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { RuntimeMessage } from "./runtimeBrokerProtocol";
const native = vi.hoisted(() => ({
  invoke: vi.fn(), channels: [] as { onmessage: (delivery: unknown) => void }[]
}));
vi.mock("@tauri-apps/api/core", () => ({
  invoke: native.invoke,
  Channel: class {
    onmessage = (_delivery: unknown) => {};
    constructor() { native.channels.push(this); }
  }
}));
import { RuntimeBroker } from "./runtimeBroker";
import { connectNativeRuntimeTransport } from "./runtimeBrokerTransport";

const CHUNK_BYTES = 4096;
const MAX_BYTES = 32 * 1024 * 1024;
const request: RuntimeMessage = { version: 1, kind: "request", id: "request", method: "getContributions", payload: {} };
function deliveries(message: unknown, sender = "runtime", id = "transfer") {
  const bytes = new TextEncoder().encode(JSON.stringify(message));
  return Array.from({ length: Math.ceil(bytes.length / CHUNK_BYTES) }, (_, index) => ({ sender, connection: "connection", chunk: {
    transferId: id, index, total: Math.ceil(bytes.length / CHUNK_BYTES), bytes: bytes.length,
    data: btoa(String.fromCharCode(...bytes.subarray(index * CHUNK_BYTES, (index + 1) * CHUNK_BYTES)))
  } }));
}
afterEach(() => { native.invoke.mockReset(); native.channels.length = 0; vi.useRealTimers(); });

describe("private native runtime transport", () => {
  it("connects before broker use and carries duplex calls over private addressed channels", async () => {
    const channels = new Map<string, typeof native.channels[number]>();
    native.invoke.mockImplementation(async (command: string, args: {
      sender: string; recipient?: string; connection?: string; channel?: typeof native.channels[number]; chunk?: unknown;
    }) => {
      if (command === "runtime_broker_connect") { channels.set(args.sender, args.channel!); return `connection-${args.sender}`; }
      expect(args.connection).toBe(`connection-${args.sender}`);
      if (command === "runtime_broker_send") channels.get(args.recipient!)!.onmessage({ sender: args.sender, connection: `connection-${args.recipient}`, chunk: args.chunk });
      if (command === "runtime_broker_disconnect") channels.delete(args.sender);
    });
    const hostTransport = await connectNativeRuntimeTransport("runtime");
    const docTransport = await connectNativeRuntimeTransport("main");
    const runtime = new RuntimeBroker("runtime", hostTransport);
    const document = new RuntimeBroker("main", docTransport);
    runtime.handle("getContributions", () => ({ revision: 7, plugins: [], enabledCommandIds: [] }));
    document.handle("getSelection", () => ({ objectIds: ["selected"], molecules: [] }));
    try {
      await expect(document.call("runtime", "getContributions", {})).resolves.toEqual({ revision: 7, plugins: [], enabledCommandIds: [] });
      await expect(runtime.call("main", "getSelection", {
        id: "invocation", target: { windowId: "main", tabId: "tab" }, documentKey: "drawing", pluginId: "test", commandId: "plugin.test.run"
      })).resolves.toEqual({ objectIds: ["selected"], molecules: [] });
      const receive = vi.fn(); document.subscribeContributions(receive);
      await runtime.broadcastContributions(["main"], { revision: 8, plugins: [], enabledCommandIds: [] });
      expect(receive).toHaveBeenCalledExactlyOnceWith({ revision: 8, plugins: [], enabledCommandIds: [] });
    } finally {
      document.dispose(); runtime.dispose();
      await Promise.all([hostTransport.dispose(), docTransport.dispose()]);
    }
    expect(channels.size).toBe(0);
    expect(new Set(native.invoke.mock.calls.map(call => call[0]))).toEqual(new Set([
      "runtime_broker_connect", "runtime_broker_send", "runtime_broker_disconnect"
    ]));
  });

  it.each(["main", "doc-a", "doc-b"])("chunks, snapshots and serializes overlapping outgoing messages from %s", async label => {
    native.invoke.mockResolvedValue("connection");
    const transport = await connectNativeRuntimeTransport(label);
    const first: RuntimeMessage = { version: 1, kind: "response", id: "first", method: "getDocument", ok: false,
      error: '🧪\\\n\u0001'.repeat(550) };
    const second = { ...request, id: "second" };
    const send = transport.send("runtime", first);
    const next = transport.send("runtime", second);
    second.id = "mutated-after-send";
    await Promise.all([send, next]);
    const calls = native.invoke.mock.calls.filter(call => call[0] === "runtime_broker_send").map(call => call[1]);
    expect(calls.length).toBeGreaterThan(2);
    const ids = [...new Set(calls.map(call => call.chunk.transferId))];
    expect(ids).toHaveLength(2);
    const firstCalls = calls.filter(call => call.chunk.transferId === ids[0]);
    expect(calls.slice(0, firstCalls.length)).toEqual(firstCalls);
    expect(firstCalls.map(call => call.chunk.index)).toEqual(firstCalls.map((_, index) => index));
    for (const call of calls) {
      expect(call).toMatchObject({ sender: label, recipient: "runtime", connection: "connection" });
      expect(new TextEncoder().encode(JSON.stringify({ sender: label, chunk: call.chunk })).length).toBeLessThan(8192);
    }
    const restored = JSON.parse(Buffer.concat(firstCalls.map(call => Buffer.from(call.chunk.data, "base64"))).toString("utf8"));
    expect(restored).toEqual(first);
    expect(JSON.parse(Buffer.from(calls.at(-1)!.chunk.data, "base64").toString("utf8")).id).toBe("second");
    await transport.dispose();
  });

  it("reassembles Unicode/escaped data and only delivers a complete valid message", async () => {
    native.invoke.mockResolvedValue("connection");
    const transport = await connectNativeRuntimeTransport("main"); const receive = vi.fn();
    transport.subscribe(receive);
    const message = { version: 1, kind: "response", id: "result", method: "invokeCommand", ok: true, value: '🧪\\\n\u0001'.repeat(5000) };
    const parts = deliveries(message);
    for (const delivery of parts.slice(0, -1)) native.channels[0]!.onmessage(delivery);
    expect(receive).not.toHaveBeenCalled();
    native.channels[0]!.onmessage(parts.at(-1));
    expect(receive).toHaveBeenCalledExactlyOnceWith({ sender: "runtime", message });
    await transport.dispose();
  });

  it("refuses utilities, foreign document peers, malformed chunks and stale partials", async () => {
    native.invoke.mockResolvedValue("connection");
    for (const label of ["toolset-core-main", "toolset-popover-core-main", "toolset-tooltip", "dialog-main-export-1",
      "plugin-panel-example", "preferences", "spin3d-debugger", "unknown", "runtime-other"]) {
      await expect(connectNativeRuntimeTransport(label)).rejects.toThrow("Utilities");
    }
    expect(native.invoke).not.toHaveBeenCalled();
    const transport = await connectNativeRuntimeTransport("main"); const receive = vi.fn(); transport.subscribe(receive);
    const channel = native.channels[0]!;
    const good = deliveries({ version: 1, kind: "response", id: "x", method: "invokeCommand", ok: true, value: "valid" })[0]!;
    channel.onmessage({ ...good, connection: "stale-connection" });
    for (const sender of ["main", "doc-b", "toolset-core-main", "runtime-other"]) channel.onmessage({ ...good, sender });
    for (const patch of [
      { bytes: MAX_BYTES + 1 }, { bytes: 0 }, { bytes: 0.5 }, { total: 0 }, { total: 8193 },
      { index: -1 }, { index: 1 }, { data: "!" }, { data: "x".repeat(10000) }, { bytes: good.chunk.bytes + 1 },
      { transferId: "x".repeat(65) }, { transferId: "bad\n" }
    ]) channel.onmessage({ ...good, chunk: { ...good.chunk, ...patch } });
    const parts = deliveries({ version: 1, kind: "response", id: "x", method: "invokeCommand", ok: true, value: "x".repeat(5000) });
    channel.onmessage(parts[1]);
    channel.onmessage(parts[0]); channel.onmessage({ ...parts[1], sender: "doc-b" }); channel.onmessage(parts[1]);
    channel.onmessage(parts[0]); channel.onmessage({ ...parts[1], chunk: { ...parts[1]!.chunk, transferId: "changed" } });
    vi.useFakeTimers();
    channel.onmessage(parts[0]); vi.advanceTimersByTime(30_000); channel.onmessage(parts[1]);
    expect(receive).not.toHaveBeenCalled();
    channel.onmessage(good);
    expect(receive).toHaveBeenCalledTimes(1);
    await expect(transport.send("doc-b", request)).rejects.toThrow("recipient");
    await expect(transport.send("preferences", request)).rejects.toThrow("recipient");
    await transport.dispose(); channel.onmessage(good);
    expect(receive).toHaveBeenCalledTimes(1);
  });

  it("propagates native ACL/send failures and makes unsubscribe/disposal final and idempotent", async () => {
    native.invoke.mockRejectedValueOnce(new Error("Native caller refused"));
    await expect(connectNativeRuntimeTransport("main")).rejects.toThrow("Native caller refused");
    native.invoke.mockResolvedValue("new-connection");
    const transport = await connectNativeRuntimeTransport("main");
    const stop = transport.subscribe(vi.fn());
    expect(() => transport.subscribe(vi.fn())).toThrow("already subscribed");
    native.invoke.mockRejectedValueOnce(new Error("Recipient closed"));
    await expect(transport.send("runtime", request)).rejects.toThrow("Recipient closed");
    await expect(transport.send("runtime", request)).resolves.toBeUndefined();
    stop(); stop(); await transport.dispose();
    expect(native.invoke.mock.calls.filter(call => call[0] === "runtime_broker_disconnect")).toEqual([
      ["runtime_broker_disconnect", { sender: "main", connection: "new-connection" }]
    ]);
    await expect(transport.send("runtime", request)).rejects.toThrow("closed");
    expect(() => transport.subscribe(vi.fn())).toThrow("closed");
  });
});

it("grants runtime only the three transport commands and refuses utility access at the ACL", () => {
  const directory = new URL("../../src-tauri/capabilities/", import.meta.url);
  const capabilities = readdirSync(directory).filter(name => name.endsWith(".json")).map(name => ({
    name, ...JSON.parse(readFileSync(new URL(name, directory), "utf8")) as { windows: string[]; permissions: unknown[] }
  }));
  const matches = (pattern: string, label: string) => new RegExp(`^${pattern.replaceAll("*", ".*")}$`).test(label);
  const runtime = capabilities.filter(cap => cap.windows.some(pattern => matches(pattern, "runtime")));
  // A5a-6 adds the separately audited host controller/storage capability. The transport's
  // three-command grant and its utility exclusion remain exactly as before.
  expect(runtime.map(cap => cap.name)).toEqual(["runtime-broker.json", "runtime-host-services.json"]);
  expect(runtime[0]!.windows).toEqual(["runtime", "main", "doc-*"]);
  expect(runtime[0]!.permissions).toEqual(["allow-runtime-broker-connect", "allow-runtime-broker-send", "allow-runtime-broker-disconnect"]);
  for (const label of ["toolset-core-main", "toolset-popover-core-main", "toolset-tooltip", "dialog-main-export-1",
    "plugin-panel-example", "preferences", "spin3d-debugger", "unknown", "runtime-other"]) {
    expect(runtime[0]!.windows.some(pattern => matches(pattern, label)), label).toBe(false);
  }
  for (const permission of runtime[0]!.permissions) {
    expect(capabilities.filter(cap => cap.permissions.includes(permission)).map(cap => cap.name)).toEqual(["runtime-broker.json"]);
  }
});
