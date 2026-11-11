import { createEmptyDocument } from "@chemdraft/chem-core";
import { CommandRegistry } from "@chemdraft/plugin-host";
import { ProposedDocumentPatchSchema } from "@chemdraft/plugin-api";
import { afterEach, expect, it, vi } from "vitest";
import { RuntimeBroker } from "./runtimeBroker";
import { RuntimeTestChannels } from "../testSupport/runtimeBrokerChannels";
import { createPluginRuntimeOwner } from "./pluginRuntimeOwner";
import { bindRuntimeViewOwner } from "./runtimeViewOwner";
import { RuntimeViewClient } from "./runtimeViewClient";
import { bindRuntimeCoreCommands, RuntimeCoreCommandRegistry } from "./runtimeCoreCommands";
import type { RuntimeTransport } from "./runtimeBrokerProtocol";
import { MemoryStorage } from "../testSupport/memoryStorage";

const stops: Array<() => void> = [];
afterEach(() => { for (const stop of stops.splice(0).reverse()) stop(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });
class AsyncChannels extends RuntimeTestChannels {
  override transport(label: string): RuntimeTransport {
    const transport = super.transport(label);
    return { ...transport, immediate: false, send: (recipient, message) => Promise.resolve().then(() => transport.send(recipient, message)) };
  }
}

it("initializes views, declarations and exact bounded recognition previews without immediate calls", async () => {
  vi.stubGlobal("localStorage", new MemoryStorage());
  const channels = new AsyncChannels(), runtime = new RuntimeBroker("runtime", channels.transport("runtime")),
    document = new RuntimeBroker("main", channels.transport("main"));
  const registry = new CommandRegistry();
  registry.register({ id: "core.test", title: "Test" }, () => "core result");
  const ownerRegistry = new RuntimeCoreCommandRegistry(runtime, "main");
  const core = bindRuntimeCoreCommands(document, registry);
  const owner = createPluginRuntimeOwner({ dataOnly: true, commandRegistry: ownerRegistry,
    getActiveDocument: () => createEmptyDocument(), getSelection: () => ({ objectIds: [], molecules: [] }) });
  const source = `data:image/png;base64,${"A".repeat(700_000)}`;
  vi.spyOn(owner.runtime.host, "listProposedPatches").mockReturnValue([{
    id: "proposal", pluginId: "org.test", status: "pending", createdAt: "2026-11-10T00:00:00Z",
    proposal: ProposedDocumentPatchSchema.parse({ reason: "Recognition fixture", patch: { op: "addObject" },
      recognition: { sourceImageRef: source, proposedMolfile: "mock", confidenceTier: "low" } })
  }]);
  const view = bindRuntimeViewOwner(owner, runtime, () => ["main"]);
  const immediate = vi.spyOn(document, "callImmediate");
  const client = new RuntimeViewClient(document);
  stops.push(() => runtime.dispose(), () => document.dispose(), ownerRegistry.dispose, core, () => owner.dispose(), view, () => client.dispose());
  await client.ready;
  expect(client.runtime.host.listProposedPatches()[0]?.proposal.recognition?.sourceImageRef).toBe(source);
  expect(client.runtime.listCanvasOverlays()).toEqual(owner.runtime.listCanvasOverlays());
  expect(client.runtime.proposalDocumentTab("missing")).toBeUndefined();
  expect(await client.runtime.host.recognitionScreenCaptureOf("missing")).toBe(false);
  expect(ownerRegistry.get("core.test")?.title).toBe("Test");
  await expect(ownerRegistry.invoke("core.test")).resolves.toBe("core result");
  expect(immediate).not.toHaveBeenCalled();
  expect(channels.deliveries.filter(({ message }) => message.kind === "request" && message.method === "runtimeViewAction" &&
    (message.payload as { action: string }).action === "previewImageChunk")).toHaveLength(3);
  expect(channels.deliveries.every(({ message }) => JSON.stringify(message).length < 300_000)).toBe(true);
});
