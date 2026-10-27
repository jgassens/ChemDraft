/**
 * Unit tests for the worker-boundary protocol (ADR-0029, M34): the version-compatibility rules and
 * handshake check, plus the worker-side runtime's message handling in isolation (announcement,
 * capability request/response correlation, permission-gated context shape, panel-close forwarding).
 */
import { describe, expect, it } from "vitest";

import { AssistantCapabilityPermissions, PluginApiVersion, parsePluginManifest, type PluginManifest } from "./index";
import {
  PLUGIN_WORKER_CAPABILITY_METHODS,
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

  it("keeps already-published plugins installable across an additive API release", () => {
    // The NMR predictor ships from its own repository against a vendored SDK and declares `^0.1.0`.
    // Because a 0.x caret locks the MINOR, releasing an additive method as 0.2.0 would have made that
    // plugin — already downloadable, already installed — refuse to load against this host. Adding to
    // the patch instead is what keeps it working, and this test is here so a future bump has to
    // confront that rather than discover it.
    expect(isPluginApiVersionCompatible("^0.1.0", PluginApiVersion)).toBe(true);

    // And a plugin that genuinely needs the newer capability can still say so: `^0.1.1` is satisfied
    // here and correctly refused by a host that predates the method.
    expect(isPluginApiVersionCompatible("^0.1.1", PluginApiVersion)).toBe(true);
    expect(isPluginApiVersionCompatible("^0.1.1", "0.1.0")).toBe(false);
    expect(isPluginApiVersionCompatible("^0.1.2", PluginApiVersion)).toBe(true);
    expect(isPluginApiVersionCompatible("^0.1.3", "0.1.2")).toBe(false);
    expect(isPluginApiVersionCompatible("^0.1.4", PluginApiVersion)).toBe(true);
    expect(isPluginApiVersionCompatible("^0.1.4", "0.1.3")).toBe(false);
    expect(isPluginApiVersionCompatible("^0.1.5", PluginApiVersion)).toBe(true);
    expect(isPluginApiVersionCompatible("^0.1.5", "0.1.4")).toBe(false);
    expect(isPluginApiVersionCompatible("^0.1.6", PluginApiVersion)).toBe(true);
    expect(isPluginApiVersionCompatible("^0.1.6", "0.1.5")).toBe(false);
    expect(isPluginApiVersionCompatible("^0.1.7", PluginApiVersion)).toBe(true);
    expect(isPluginApiVersionCompatible("^0.1.7", "0.1.6")).toBe(false);
    expect(isPluginApiVersionCompatible("^0.1.8", PluginApiVersion)).toBe(true);
    expect(isPluginApiVersionCompatible("^0.1.8", "0.1.7")).toBe(false);
    expect(isPluginApiVersionCompatible("^0.1.9", PluginApiVersion)).toBe(true);
    expect(isPluginApiVersionCompatible("^0.1.9", "0.1.8")).toBe(false);
    expect(isPluginApiVersionCompatible("^0.1.10", PluginApiVersion)).toBe(true);
    expect(isPluginApiVersionCompatible("^0.1.10", "0.1.9")).toBe(false);
    expect(isPluginApiVersionCompatible("^0.1.11", PluginApiVersion)).toBe(true);
    expect(isPluginApiVersionCompatible("^0.1.11", "0.1.10")).toBe(false);
    expect(isPluginApiVersionCompatible("^0.1.12", PluginApiVersion)).toBe(true);
    expect(isPluginApiVersionCompatible("^0.1.12", "0.1.11")).toBe(false);
    expect(isPluginApiVersionCompatible("^0.1.13", PluginApiVersion)).toBe(true);
    expect(isPluginApiVersionCompatible("^0.1.13", "0.1.12")).toBe(false);
    expect(isPluginApiVersionCompatible("^0.1.14", PluginApiVersion)).toBe(true);
    expect(isPluginApiVersionCompatible("^0.1.14", "0.1.13")).toBe(false);
    expect(isPluginApiVersionCompatible("^0.1.15", PluginApiVersion)).toBe(true);
    expect(isPluginApiVersionCompatible("^0.1.15", "0.1.14")).toBe(false);
  });
});

describe("chemistry worker capability allowlist", () => {
  it("includes all optional API 0.1.15 methods", () => {
    expect(PLUGIN_WORKER_CAPABILITY_METHODS.chemistry).toEqual([
      "isotopeEnvelope", "nameToStructure", "structureFromSmiles", "structureToName", "embed3d", "minimize3d", "flatten3d"
    ]);
  });
  it("includes structureToName", () => {
    expect(PLUGIN_WORKER_CAPABILITY_METHODS.chemistry).toContain("structureToName");
  });
});

describe("tools worker capability allowlist", () => {
  it("includes every external-tools method", () => {
    expect(PLUGIN_WORKER_CAPABILITY_METHODS.tools).toEqual([
      "status", "install", "signIn", "run", "poll", "cancel", "clearConversation"
    ]);
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
  it("correlates concurrent 3D replies by id even when the second command finishes first", async () => {
    const endpoint = new ControlledEndpoint();
    runPluginWorker({ manifest: manifest(["chemistry.compute"]), commandHandlers: {
      [commandId]: ctx => ctx.chemistry!.embed3d!({ components: [{ smiles: "C" }] })
    } }, endpoint);
    endpoint.deliver({ kind: "invokeCommand", commandRequestId: 10, commandId });
    endpoint.deliver({ kind: "invokeCommand", commandRequestId: 11, commandId });
    await flush();
    const requests = endpoint.sent.filter(message => message.kind === "capabilityRequest");
    expect(requests).toHaveLength(2);
    expect(requests[0].requestId).not.toBe(requests[1].requestId);
    endpoint.deliver({ kind: "capabilityResult", requestId: requests[1].requestId, ok: true, value: { from: "second" } });
    endpoint.deliver({ kind: "capabilityResult", requestId: requests[0].requestId, ok: true, value: { from: "first" } });
    await flush();
    expect(endpoint.sent.filter(message => message.kind === "commandSettled")).toEqual([
      { kind: "commandSettled", commandRequestId: 11, ok: true, value: { from: "second" } },
      { kind: "commandSettled", commandRequestId: 10, ok: true, value: { from: "first" } }
    ]);
  });
  it("ignores late 3D success/error replies from an aborted command after the next command starts", async () => {
    const endpoint = new ControlledEndpoint();
    runPluginWorker({ manifest: manifest(["chemistry.compute"]), commandHandlers: {
      [commandId]: ctx => ctx.chemistry!.embed3d!({ components: [{ smiles: "C" }] })
    } }, endpoint);
    endpoint.deliver({ kind: "invokeCommand", commandRequestId: 10, commandId });
    await flush();
    const old = endpoint.sent.find(message => message.kind === "capabilityRequest")!;
    endpoint.deliver({ kind: "abort", commandRequestId: 10 });
    endpoint.deliver({ kind: "invokeCommand", commandRequestId: 11, commandId });
    await flush();
    const current = endpoint.sent.filter(message => message.kind === "capabilityRequest")[1];
    expect(current.requestId).not.toBe(old.requestId);
    endpoint.deliver({ kind: "capabilityResult", requestId: old.requestId, ok: true, value: { from: "cancelled" } });
    endpoint.deliver({ kind: "capabilityResult", requestId: old.requestId, ok: false, error: { code: "OLD", message: "cancelled error" } });
    endpoint.deliver({ kind: "capabilityResult", requestId: current.requestId, ok: true, value: { from: "current" } });
    await flush();
    expect(endpoint.sent.filter(message => message.kind === "commandSettled")).toEqual([
      { kind: "commandSettled", commandRequestId: 11, ok: true, value: { from: "current" } }
    ]);
  });
  it.each([false, true])("exposes all three 3D stubs only with chemistry.compute (%s)", async enabled => {
    const endpoint = new ControlledEndpoint();
    let methods: unknown[] = [];
    runPluginWorker({ manifest: manifest(enabled ? ["chemistry.compute"] : []), commandHandlers: {
      [commandId]: ctx => { methods = [ctx.chemistry?.embed3d, ctx.chemistry?.minimize3d, ctx.chemistry?.flatten3d]; }
    } }, endpoint);
    endpoint.deliver({ kind: "invokeCommand", commandRequestId: 1, commandId });
    await flush();
    for (const method of methods) expect(typeof method).toBe(enabled ? "function" : "undefined");
  });
  it("drops malformed command input before invoking plugin code", async () => {
    const endpoint = new ControlledEndpoint();
    let calls = 0;
    runPluginWorker({ manifest: manifest([]), commandHandlers: { [commandId]: () => { calls++; } } }, endpoint);
    endpoint.deliverRaw({ kind: "invokeCommand", commandRequestId: 1, commandId, input: {
      source: "panel", panelId: "panel.chat.main", sectionId: "composer", control: "prompt", text: "x".repeat(20001)
    } });
    await flush();
    expect(calls).toBe(0);
  });

  it.each([undefined, ...AssistantCapabilityPermissions])("gates the assistant stub when missing %s", async missing => {
    const permissions = AssistantCapabilityPermissions.filter(p => p !== missing && !(missing === "native.execute" && p === "assistant.run"));
    const endpoint = new ControlledEndpoint();
    let present: boolean | undefined;
    runPluginWorker({ manifest: manifest(permissions), commandHandlers: {
      [commandId]: context => { present = context.assistant !== undefined; }
    } }, endpoint);
    endpoint.deliver({ kind: "invokeCommand", commandRequestId: 1, commandId });
    await flush();
    expect(present).toBe(missing === undefined);
    expect(PLUGIN_WORKER_CAPABILITY_METHODS.assistant).toEqual([
      "listTools", "callTool", "beginRequest", "endRequest", "createToolSession", "closeToolSession"
    ]);
  });
  it.each<{ permissions: PluginManifest["permissions"]; present: boolean }>([
    { permissions: [], present: false },
    { permissions: ["assistant.run"], present: false },
    { permissions: ["native.execute"], present: false },
    { permissions: ["assistant.run", "native.execute"], present: true }
  ])("exposes tools stubs with $permissions only when both permissions are declared", async ({ permissions, present }) => {
    const endpoint = new ControlledEndpoint();
    let toolsPresent: boolean | undefined;
    runPluginWorker({
      // Exercise the runtime gate even for an unvalidated manifest with assistant.run alone.
      manifest: { ...manifest([]), permissions },
      commandHandlers: { [commandId]: (context) => { toolsPresent = context.tools !== undefined; } }
    }, endpoint);
    endpoint.deliver({ kind: "invokeCommand", commandRequestId: 1, commandId });
    await flush();
    expect(toolsPresent).toBe(present);
  });

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

  it("omits selection and dialogs stubs when the manifest grants neither permission", async () => {
    const endpoint = new ControlledEndpoint();
    let sawSelection = true;
    let sawDialogs = true;
    runPluginWorker(
      {
        manifest: manifest([]),
        commandHandlers: {
          [commandId]: async (context) => {
            sawSelection = context.selection !== undefined;
            sawDialogs = context.dialogs !== undefined;
            return { ok: true };
          }
        }
      },
      endpoint
    );
    endpoint.deliver({ kind: "invokeCommand", commandRequestId: 1, commandId });
    await flush();
    expect(sawSelection).toBe(false);
    expect(sawDialogs).toBe(false);
  });

  it("omits structureToName without each of chemistry.compute, native.execute, or selection.read", async () => {
    for (const permissions of [
      ["native.execute", "selection.read"],
      ["chemistry.compute", "selection.read"],
      ["chemistry.compute", "native.execute"]
    ] as const) {
      const endpoint = new ControlledEndpoint();
      let hasMethod = true;
      runPluginWorker(
        {
          manifest: manifest([...permissions]),
          commandHandlers: {
            [commandId]: async (context) => {
              hasMethod = context.chemistry?.structureToName !== undefined;
              return { ok: true };
            }
          }
        },
        endpoint
      );
      endpoint.deliver({ kind: "invokeCommand", commandRequestId: 1, commandId });
      await flush();
      expect(hasMethod, permissions.join(", ")).toBe(false);
    }
  });

  it("offers structureToName only with all three required permissions", async () => {
    const endpoint = new ControlledEndpoint();
    let hasMethod = false;
    runPluginWorker(
      {
        manifest: manifest(["chemistry.compute", "native.execute", "selection.read"]),
        commandHandlers: {
          [commandId]: async (context) => {
            hasMethod = context.chemistry?.structureToName !== undefined;
            return { ok: true };
          }
        }
      },
      endpoint
    );
    endpoint.deliver({ kind: "invokeCommand", commandRequestId: 1, commandId });
    await flush();
    expect(hasMethod).toBe(true);
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
