/**
 * Unit tests for the worker-boundary protocol (ADR-0029, M34): the version-compatibility rules and
 * handshake check, plus the worker-side runtime's message handling in isolation (announcement,
 * capability request/response correlation, permission-gated context shape, panel-close forwarding).
 */
import { describe, expect, it } from "vitest";

import { parsePluginManifest, type PluginManifest } from "./index";
import {
  PLUGIN_WORKER_PROTOCOL_VERSION,
  PluginWorkerErrorCodes,
  checkWorkerHandshake,
  isPluginApiVersionCompatible,
  type HostToWorkerMessage,
  type PluginWorkerEndpoint,
  type WorkerToHostMessage
} from "./workerProtocol";
import { runPluginWorker } from "./workerRuntime";

const flush = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));
const commandId = "plugin.runtime.run";

/** A controllable worker-side endpoint: captures what the runtime posts, and lets a test deliver
 *  host→worker messages synchronously. */
class ControlledEndpoint implements PluginWorkerEndpoint {
  readonly sent: WorkerToHostMessage[] = [];
  private listener: ((event: { data: unknown }) => void) | undefined;

  postMessage(message: unknown): void {
    this.sent.push(message as WorkerToHostMessage);
  }

  addEventListener(_type: "message", listener: (event: { data: unknown }) => void): void {
    this.listener = listener;
  }

  deliver(message: HostToWorkerMessage): void {
    this.listener?.({ data: message });
  }

  /** Deliver an arbitrary payload, to exercise the runtime's tolerance of non-protocol frames. */
  deliverRaw(data: unknown): void {
    this.listener?.({ data });
  }
}

/** Mirrors the browser's structured-clone check, including synchronous DataCloneError failures. */
class CloneCheckingEndpoint extends ControlledEndpoint {
  override postMessage(message: unknown): void {
    structuredClone(message);
    super.postMessage(message);
  }
}

function manifest(permissions: PluginManifest["permissions"]): PluginManifest {
  return parsePluginManifest({
    id: "org.test.rt",
    name: "Runtime Test",
    version: "0",
    apiVersion: "^0.1.0",
    entry: "x",
    permissions,
    contributes: {
      commands: [{ id: commandId, title: "C", requiredPermissions: permissions.filter((p) => p === "selection.read") }]
    }
  });
}

describe("isPluginApiVersionCompatible", () => {
  it("accepts a caret range the host satisfies and rejects one it does not", () => {
    expect(isPluginApiVersionCompatible("^0.1.0", "0.1.0")).toBe(true);
    expect(isPluginApiVersionCompatible("^0.1.0", "0.1.5")).toBe(true); // 0.x caret locks the minor
    expect(isPluginApiVersionCompatible("^0.1.0", "0.2.0")).toBe(false);
    expect(isPluginApiVersionCompatible("^0.2.0", "0.1.0")).toBe(false); // host predates the minimum
    expect(isPluginApiVersionCompatible("^9.9.9", "0.1.0")).toBe(false);
  });

  it("handles exact and tilde ranges", () => {
    expect(isPluginApiVersionCompatible("0.1.0", "0.1.0")).toBe(true);
    expect(isPluginApiVersionCompatible("0.1.0", "0.1.1")).toBe(false);
    expect(isPluginApiVersionCompatible("~0.1.0", "0.1.9")).toBe(true);
    expect(isPluginApiVersionCompatible("~0.1.0", "0.2.0")).toBe(false);
  });

  it("rejects unparseable versions", () => {
    expect(isPluginApiVersionCompatible("not-a-version", "0.1.0")).toBe(false);
    expect(isPluginApiVersionCompatible("^0.1.0", "garbage")).toBe(false);
  });
});

describe("checkWorkerHandshake", () => {
  it("passes a matching handshake", () => {
    expect(checkWorkerHandshake({ protocolVersion: PLUGIN_WORKER_PROTOCOL_VERSION, apiVersion: "^0.1.0" }, "0.1.0")).toBeUndefined();
  });

  it("reports a protocol-version mismatch", () => {
    const message = checkWorkerHandshake({ protocolVersion: PLUGIN_WORKER_PROTOCOL_VERSION + 1, apiVersion: "^0.1.0" }, "0.1.0");
    expect(message).toMatch(/protocol version/i);
  });

  it("reports an apiVersion mismatch", () => {
    const message = checkWorkerHandshake({ protocolVersion: PLUGIN_WORKER_PROTOCOL_VERSION, apiVersion: "^9.9.9" }, "0.1.0");
    expect(message).toMatch(/api version/i);
  });
});

describe("runPluginWorker", () => {
  it("announces readiness with the protocol version and the plugin's apiVersion", () => {
    const endpoint = new ControlledEndpoint();
    runPluginWorker({ manifest: manifest(["selection.read"]), commandHandlers: {} }, endpoint);
    expect(endpoint.sent).toEqual([{ kind: "ready", protocolVersion: PLUGIN_WORKER_PROTOCOL_VERSION, apiVersion: "^0.1.0" }]);
  });

  it("runs a command against capability stubs that request/await across the boundary", async () => {
    const endpoint = new ControlledEndpoint();
    runPluginWorker(
      { manifest: manifest(["selection.read"]), commandHandlers: { [commandId]: async (context) => context.selection?.getSelection() } },
      endpoint
    );
    endpoint.sent.length = 0;

    endpoint.deliver({ kind: "invokeCommand", commandRequestId: 7, commandId });
    await flush();

    const request = endpoint.sent.find((m): m is Extract<WorkerToHostMessage, { kind: "capabilityRequest" }> => m.kind === "capabilityRequest");
    expect(request).toMatchObject({ commandRequestId: 7, namespace: "selection", method: "getSelection", args: [] });

    endpoint.deliver({ kind: "capabilityResult", requestId: request!.requestId, ok: true, value: { objectIds: ["x"], molecules: [] } });
    await flush();

    const settled = endpoint.sent.find((m): m is Extract<WorkerToHostMessage, { kind: "commandSettled" }> => m.kind === "commandSettled");
    expect(settled).toMatchObject({ commandRequestId: 7, ok: true, value: { objectIds: ["x"], molecules: [] } });
  });

  it("omits a capability object the manifest does not grant (mirrors the host's optional context)", async () => {
    const endpoint = new ControlledEndpoint();
    let sawSelection = true;
    runPluginWorker(
      {
        manifest: manifest([]),
        commandHandlers: {
          [commandId]: async (context) => {
            sawSelection = context.selection !== undefined;
            return { ok: true };
          }
        }
      },
      endpoint
    );
    endpoint.deliver({ kind: "invokeCommand", commandRequestId: 1, commandId });
    await flush();
    expect(sawSelection).toBe(false);
  });

  it("reports an unknown command instead of hanging", async () => {
    const endpoint = new ControlledEndpoint();
    runPluginWorker({ manifest: manifest([]), commandHandlers: {} }, endpoint);
    endpoint.sent.length = 0;
    endpoint.deliver({ kind: "invokeCommand", commandRequestId: 3, commandId: "nope" });
    await flush();
    expect(endpoint.sent[0]).toMatchObject({ kind: "commandSettled", commandRequestId: 3, ok: false });
  });

  it("reports a clone-safe failure when a command result cannot cross the worker boundary", async () => {
    const endpoint = new CloneCheckingEndpoint();
    runPluginWorker(
      {
        manifest: manifest([]),
        commandHandlers: { [commandId]: async () => ({ callback: () => undefined }) }
      },
      endpoint
    );
    endpoint.sent.length = 0;

    endpoint.deliver({ kind: "invokeCommand", commandRequestId: 4, commandId });
    await flush();

    expect(endpoint.sent).toEqual([
      expect.objectContaining({
        kind: "commandSettled",
        commandRequestId: 4,
        ok: false,
        error: expect.objectContaining({ code: "PLUGIN_WORKER_UNCLONEABLE_RESULT" })
      })
    ]);
  });

  it("aborts only capability calls belonging to the selected command", async () => {
    const endpoint = new ControlledEndpoint();
    runPluginWorker(
      {
        manifest: manifest(["selection.read"]),
        commandHandlers: { [commandId]: async (context) => context.selection?.getSelection() }
      },
      endpoint
    );
    endpoint.sent.length = 0;

    endpoint.deliver({ kind: "invokeCommand", commandRequestId: 10, commandId });
    endpoint.deliver({ kind: "invokeCommand", commandRequestId: 11, commandId });
    await flush();

    const requests = endpoint.sent.filter(
      (message): message is Extract<WorkerToHostMessage, { kind: "capabilityRequest" }> =>
        message.kind === "capabilityRequest"
    );
    expect(requests).toHaveLength(2);

    endpoint.deliver({ kind: "abort", commandRequestId: 10 });
    await flush();
    endpoint.deliver({
      kind: "capabilityResult",
      requestId: requests.find((request) => request.commandRequestId === 11)!.requestId,
      ok: true,
      value: { objectIds: ["still-running"], molecules: [] }
    });
    await flush();

    expect(endpoint.sent).toContainEqual(
      expect.objectContaining({
        kind: "commandSettled",
        commandRequestId: 11,
        ok: true,
        value: { objectIds: ["still-running"], molecules: [] }
      })
    );
    expect(
      endpoint.sent.some(
        (message) => message.kind === "commandSettled" && message.commandRequestId === 10
      )
    ).toBe(false);
  });

  it("forwards a panel-close signal to the plugin's onPanelClosed hook", () => {
    const endpoint = new ControlledEndpoint();
    let closed: string | undefined;
    runPluginWorker({ manifest: manifest([]), commandHandlers: {}, onPanelClosed: (panelId) => (closed = panelId) }, endpoint);
    endpoint.deliver({ kind: "panelClosed", panelId: "panel.review" });
    expect(closed).toBe("panel.review");
  });

  // A failure frame whose `error` payload is missing/!string must still settle the pending capability.
  // Building the rejection eagerly used to throw *before* the reject ran, and because the pending entry
  // was already removed from the map nothing could ever settle it: the handler — and the host
  // invocation waiting on it — hung forever.
  it("settles a capability call even when the host's failure payload is malformed", async () => {
    const endpoint = new ControlledEndpoint();
    runPluginWorker(
      {
        manifest: manifest(["selection.read"]),
        commandHandlers: {
          [commandId]: async (context) => {
            try {
              await context.selection?.getSelection();
              return "unexpectedly-resolved";
            } catch (error: unknown) {
              return `rejected:${(error as { code?: string }).code}`;
            }
          }
        }
      },
      endpoint
    );
    endpoint.sent.length = 0;

    endpoint.deliver({ kind: "invokeCommand", commandRequestId: 20, commandId });
    await flush();
    const request = endpoint.sent.find(
      (message): message is Extract<WorkerToHostMessage, { kind: "capabilityRequest" }> => message.kind === "capabilityRequest"
    );
    expect(request).toBeDefined();

    // `error` omitted entirely — a host bug, but the worker must not hang on it.
    endpoint.deliver({ kind: "capabilityResult", requestId: request!.requestId, ok: false } as unknown as HostToWorkerMessage);
    await flush();

    expect(endpoint.sent).toContainEqual(
      expect.objectContaining({
        kind: "commandSettled",
        commandRequestId: 20,
        ok: true,
        value: `rejected:${PluginWorkerErrorCodes.MalformedMessage}`
      })
    );
  });

  it("ignores a non-protocol message instead of throwing inside the listener", async () => {
    const endpoint = new ControlledEndpoint();
    runPluginWorker({ manifest: manifest([]), commandHandlers: { [commandId]: async () => "ok" } }, endpoint);
    endpoint.sent.length = 0;

    // `event.data` is only as trustworthy as the sender; dereferencing `.kind` on these used to throw.
    for (const hostile of [null, undefined, 42, "invokeCommand", { kind: "invokeCommand" }, { kind: "nope" }]) {
      expect(() => endpoint.deliverRaw(hostile), JSON.stringify(hostile ?? null)).not.toThrow();
    }
    expect(endpoint.sent).toEqual([]);

    // A well-formed message still works after the bad frames.
    endpoint.deliver({ kind: "invokeCommand", commandRequestId: 21, commandId });
    await flush();
    expect(endpoint.sent).toContainEqual(expect.objectContaining({ kind: "commandSettled", commandRequestId: 21, ok: true }));
  });
});
