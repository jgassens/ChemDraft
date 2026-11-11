// @vitest-environment jsdom
import { createEmptyDocument } from "@chemdraft/chem-core";
import type { PluginCommandContext } from "@chemdraft/plugin-api";
import { CommandRegistry } from "@chemdraft/plugin-host";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import { RuntimeTestChannels } from "../testSupport/runtimeBrokerChannels";
import { MemoryStorage } from "../testSupport/memoryStorage";
import { createPluginRuntimeOwner } from "./pluginRuntimeOwner";
import { ImageSourceRegistry } from "./ImageSourceProvider";
import { RuntimeBroker } from "./runtimeBroker";
import { RuntimeBrokerHost } from "./runtimeBrokerHost";
import { RuntimeBrokerDocument, type RuntimeDocumentPort } from "./runtimeBrokerDocument";
import { bindRuntimeViewOwner } from "./runtimeViewOwner";
import { RuntimeViewClient } from "./runtimeViewClient";
import { decodeRuntimeView } from "./runtimeViewProtocol";
import type { RuntimeMessage, RuntimeTransport } from "./runtimeBrokerProtocol";
import type { PluginPackageInspection } from "./installPluginPackage";
import { PluginManagerDialog } from "./PluginManagerDialog";

// Only the machine's recognition engine/validator are substituted. Acquisition, preparation,
// held-patch substitution, proposal ownership, broker actions and both view clients are production.
vi.mock("./createPluginRuntime", async original => {
  const actual = await original<typeof import("./createPluginRuntime")>();
  return { ...actual, createPluginRuntime: (options: Parameters<typeof actual.createPluginRuntime>[0]) => actual.createPluginRuntime({
    ...options,
    structureRecognitionEngine: {
      status: async () => ({ state: "installed", requiredDiskBytes: 0, freeDiskBytes: 0 }),
      install: async () => ({ state: "installed", requiredDiskBytes: 0, freeDiskBytes: 0 }),
      cancelInstall: async () => {}, uninstall: async () => ({ state: "notInstalled", requiredDiskBytes: 0, freeDiskBytes: 0 }),
      recognizeImage: async () => ({ status: "recognized", smiles: "C=O",
        molfile: ["Recognition fixture", "  ChemDraft", "", "  2  1  0  0  0  0            999 V2000",
          "   -0.7500    0.0000    0.0000 C   0  0  0  0  0  0  0  0  0  0  0  0",
          "    0.7500    0.0000    0.0000 O   0  0  0  0  0  0  0  0  0  0  0  0", "  1  2  2  0  0  0  0", "M  END"].join("\n"),
        confidence: 0.9, atoms: [], bonds: [], elapsedMs: 1,
        agreement: { runs: 5, agreeing: 5, invalidRuns: 0, scalesPx: [800, 900, 1000, 1100, 1200] },
        engine: { name: "MolScribe", molscribeCommit: "fixture", modelSha256: "a".repeat(64) } })
    },
    recognitionStructureValidator: async () => ({ valid: true, errors: [], warnings: [] })
  }) };
});

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const stops: Array<() => void> = [];
afterEach(() => { for (const stop of stops.splice(0).reverse()) stop(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });
class AsyncChannels extends RuntimeTestChannels {
  hold?: (sender: string, recipient: string, message: RuntimeMessage) => boolean;
  override transport(label: string): RuntimeTransport {
    const transport = super.transport(label);
    return { ...transport, immediate: false, send: (recipient, message) => {
      if (this.hold?.(label, recipient, structuredClone(message))) return Promise.resolve();
      return Promise.resolve().then(() => transport.send(recipient, message));
    } };
  }
}

async function fixture() {
  vi.stubGlobal("localStorage", new MemoryStorage());
  const channels = new AsyncChannels();
  const broker = new RuntimeBroker("runtime", channels.transport("runtime"));
  const owner = createPluginRuntimeOwner({ dataOnly: true, getActiveDocument: () => undefined,
    getSelection: () => ({ objectIds: [], molecules: [] }),
    imageSourceRegistry: new ImageSourceRegistry([{ id: "file", label: "Fixture image", isAvailable: async () => true,
      acquire: async () => ({ mediaType: "image/png", bytes: new Uint8Array(525_000).fill(65),
        width: 100, height: 100, source: "file" }) }]) });
  owner.runtime.registerPlugin({ id: "org.test.review", name: "Review", version: "1", apiVersion: "^0.1.25", entry: "test.js",
    permissions: ["image.read", "ml.inference", "model.load", "native.execute", "document.proposePatch"],
    contributes: { commands: [{ id: "plugin.review.recognize", title: "Recognize" }] } },
  { commandHandlers: { "plugin.review.recognize": async (context: PluginCommandContext) => {
    const image = await context.images!.requestImage({ title: "Choose image" });
    if (image.status !== "provided") throw new Error("No fixture image");
    const result = await context.recognition!.recognizeStructure(image.image);
    if (result.status !== "recognized") throw new Error(JSON.stringify(result));
    await context.documents.proposePatch(result.result.proposedPatch!);
  } } });
  // Installation is an external filesystem boundary; receipt retention and metadata authentication
  // run through the real owner adapter before this boundary is reached.
  const install = vi.fn(async (_inspection: PluginPackageInspection) => {});
  const read = owner.read;
  const inspection: PluginPackageInspection = { manifest: owner.runtime.host.listPlugins().find(p => p.id === "org.test.review")!,
    provenance: { sdk: "@chemdraft/plugin-api", sdkVersion: "0.1.25", sourceCommit: "a".repeat(40), sourceTree: "clean", licenseFile: "LICENSE", packagedAt: "2026-11-11T00:00:00Z" },
    sourceChecksum: "a".repeat(64), unpackedBytes: 3,
    entries: [{ path: "test.js", bytes: new Uint8Array([1, 2, 3]) }] };
  owner.read = () => ({ ...read(), installPackage: install,
    pickPackage: async () => ({ inspection, sourcePath: "fixture.zip", checksumVerified: true }) });
  const host = new RuntimeBrokerHost(broker, () => owner.runtime, () => ["main", "doc-b"]);
  const view = bindRuntimeViewOwner(owner, broker, () => ["main", "doc-b"]);
  owner.start();
  stops.push(() => { view(); host.dispose(); owner.dispose(); broker.dispose(); });
  const clients = ["main", "doc-b"].map(windowId => {
    const documentBroker = new RuntimeBroker(windowId, channels.transport(windowId));
    const drawing = createEmptyDocument();
    const port: RuntimeDocumentPort = { windowId, commandRegistry: new CommandRegistry(), activeTabId: () => "same-tab",
      read: () => ({ document: drawing, documentKey: `${windowId}:drawing` }), selection: () => ({ objectIds: [], molecules: [] }),
      runWrite: async (_tab, commit) => commit(), commit: () => { throw new Error("No direct writes in this fixture"); } };
    const document = new RuntimeBrokerDocument(documentBroker, port);
    const client = new RuntimeViewClient(documentBroker, (id, options) => document.invokeCommand(id, options?.input, options));
    stops.push(() => { client.dispose(); document.dispose(); documentBroker.dispose(); });
    return { client, broker: documentBroker, document, drawing };
  });
  await Promise.all(clients.map(async ({ client, document, broker: documentBroker }) => {
    await document.refreshContributions();
    await documentBroker.call("runtime", "setDocumentMetadata", { target: { windowId: documentBroker.label, tabId: "same-tab" },
      documentKey: `${documentBroker.label}:drawing`, titles: [{ id: "same-tab", title: documentBroker.label }] });
    await client.ready;
  }));
  async function recognize(index: number) {
    const client = clients[index]!.client;
    const pending = client.runtime.invokeCommand("plugin.review.recognize");
    void pending.catch(() => undefined);
    await vi.waitFor(() => expect(client.read().openImageRequest).toBeDefined());
    await client.read().acquireImage(client.read().openImageRequest!.id, "file");
    await pending;
    return owner.runtime.host.listProposedPatches("pending").at(-1)!;
  }
  return { clients, channels, owner, view, install, inspection, recognize };
}

const caches = (client: RuntimeViewClient) => client as unknown as {
  previews: Map<string, string>; pendingPreviews: Map<string, Promise<string>>;
};

it("keeps proposals, previews and rejection in the captured window after focus changes", async () => {
  const f = await fixture(), [a, b] = f.clients;
  const proposal = await f.recognize(0);
  await vi.waitFor(() => expect(a!.client.runtime.host.listProposedPatches()).toHaveLength(1));
  expect(b!.client.runtime.host.listProposedPatches()).toHaveLength(0);
  expect(b!.client.runtime.proposalDocumentTab(proposal.id)).toBeUndefined();
  const token = [...caches(a!.client).previews.keys()][0]!;
  const reply = await b!.broker.call("runtime", "runtimeViewAction", { action: "previewImageChunk", args: [token, 0] });
  expect(reply).toMatchObject({ ok: false, error: { message: expect.stringMatching(/another document window/) } });
  await expect(b!.client.runtime.host.rejectProposedPatch(proposal.id)).rejects.toThrow(/another document window/);
  expect(f.owner.runtime.host.listProposedPatches("pending").map(p => p.id)).toContain(proposal.id);
  const other = await f.recognize(1);
  await vi.waitFor(() => expect(b!.client.runtime.host.listProposedPatches().map(p => p.id)).toEqual([other.id]));
  await a!.client.runtime.host.rejectProposedPatch(proposal.id);
  expect(f.owner.runtime.host.listProposedPatches("pending").map(p => p.id)).toEqual([other.id]);
  expect(caches(b!.client).previews.size).toBe(1);
});

it("retains a proposal's captured window when its tab title is unavailable", async () => {
  const f = await fixture(), [a, b] = f.clients;
  const proposal = await f.recognize(1);
  await vi.waitFor(() => expect(b!.client.runtime.host.listProposedPatches()).toHaveLength(1));
  f.owner.runtime.updateDocumentTabTitles([], "doc-b");
  expect(f.owner.runtime.proposalDocumentTab(proposal.id)).toBeUndefined();
  f.view.publish();
  await vi.waitFor(() => expect(a!.client.runtime.host.listProposedPatches()).toHaveLength(0));
  await expect(a!.client.runtime.host.rejectProposedPatch(proposal.id)).rejects.toThrow(/another document window/);
  await b!.client.runtime.host.rejectProposedPatch(proposal.id);
});

it("prunes resolved async previews on each state, including the empty final state", async () => {
  const f = await fixture(), client = f.clients[0]!.client;
  for (let i = 0; i < 3; i++) {
    const proposal = await f.recognize(0);
    await vi.waitFor(() => expect(client.runtime.host.listProposedPatches()).toHaveLength(1));
    expect(caches(client).previews.size).toBe(1);
    await client.runtime.host.rejectProposedPatch(proposal.id);
    await vi.waitFor(() => expect(client.runtime.host.listProposedPatches()).toHaveLength(0));
    expect(caches(client).previews.size).toBe(0);
    expect(caches(client).pendingPreviews.size).toBe(0);
  }
});

it("does not resurrect an obsolete preview when a pending chunk arrives after rejection", async () => {
  const f = await fixture(), client = f.clients[0]!.client;
  let held: RuntimeMessage | undefined;
  f.channels.hold = (sender, recipient, message) => {
    if (!held && sender === "runtime" && recipient === "main" && message.kind === "response" && message.method === "runtimeViewAction" &&
      message.ok && typeof decodeRuntimeView<{ value?: unknown }>(message.value).value === "string" &&
      (decodeRuntimeView<{ value: string }>(message.value).value.length < 256 * 1024)) {
      held = message; return true;
    }
    return false;
  };
  const proposal = await f.recognize(0);
  await vi.waitFor(() => expect(held).toBeDefined());
  // Capture the in-flight work only to await its settlement; it still uses the broker's chunk path.
  const pending = [...caches(client).pendingPreviews.values()][0]!;
  await client.runtime.host.rejectProposedPatch(proposal.id);
  expect(caches(client).pendingPreviews.size).toBe(0);
  f.channels.deliver("main", "runtime", held!);
  await pending.catch(() => undefined);
  expect(caches(client).previews.size).toBe(0);
  expect(client.runtime.host.listProposedPatches()).toHaveLength(0);
});

it.each(["initial reply", "initial preview"])("keeps readiness and an empty cache when review resolves during the %s", async stage => {
  const f = await fixture(), a = f.clients[0]!;
  const proposal = await f.recognize(0);
  await vi.waitFor(() => expect(a.client.runtime.host.listProposedPatches()).toHaveLength(1));
  a.client.dispose();
  let held: RuntimeMessage | undefined;
  f.channels.hold = (sender, recipient, message) => {
    if (!held && sender === "runtime" && recipient === "main" && message.kind === "response" &&
      message.method === (stage === "initial reply" ? "getRuntimeView" : "runtimeViewAction")) {
      held = message; return true;
    }
    return false;
  };
  const client = new RuntimeViewClient(a.broker);
  stops.push(() => client.dispose());
  await vi.waitFor(() => expect(held).toBeDefined());
  const rejection = await a.broker.call("runtime", "runtimeViewAction", { action: "rejectProposal", args: [proposal.id] });
  expect(rejection).toMatchObject({ ok: true });
  f.channels.deliver("main", "runtime", held!);
  await expect(client.ready).resolves.toBeUndefined();
  expect(client.runtime.host.listProposedPatches()).toHaveLength(0);
  expect(caches(client).previews.size).toBe(0);
  expect(caches(client).pendingPreviews.size).toBe(0);
  expect(client.read().diagnostics.some(d => d.code === "runtime-host-startup-failed")).toBe(false);
});

it("closing B's manager preserves A's review and discards only B's receipts", async () => {
  const f = await fixture(), [a, b] = f.clients;
  const pickedB = (await b!.client.read().pickPackage!())!;
  const container = document.createElement("div"), rootA = createRoot(container), rootB = createRoot(document.createElement("div"));
  document.body.append(container);
  let bMounted = true;
  stops.push(() => { act(() => { rootA.unmount(); if (bMounted) rootB.unmount(); }); container.remove(); });
  await act(async () => {
    const aView = a!.client.read();
    rootA.render(createElement(PluginManagerDialog, { runtime: aView.runtime, bundledPlugins: [], onClose: () => {},
      onPickPackage: aView.pickPackage, onInstallPackage: aView.installPackage }));
    rootB.render(createElement(PluginManagerDialog, { runtime: b!.client.runtime, bundledPlugins: [], onClose: () => {} }));
  });
  await act(async () => document.querySelector<HTMLButtonElement>('[data-action="add-plugin-package"]')!.click());
  expect(document.querySelector('[data-testid="plugin-package-review"]')).not.toBeNull();
  await act(async () => { rootB.unmount(); bMounted = false; });
  await act(async () => document.querySelector<HTMLButtonElement>('[data-action="confirm-install-package"]')!.click());
  expect(document.querySelector('[data-testid="plugin-package-review"]')).toBeNull();
  expect(f.install).toHaveBeenCalledWith(f.inspection);
  await expect(b!.client.read().installPackage!(pickedB.inspection)).rejects.toThrow(/review has expired/);
});

it("refuses another window's package receipt even if its handle is known", async () => {
  const { clients, install } = await fixture(), [a, b] = clients;
  const picked = (await a!.client.read().pickPackage!())!;
  await expect(b!.client.read().installPackage!(picked.inspection)).rejects.toThrow(/another document window/);
  expect(install).not.toHaveBeenCalled();
  await a!.client.read().installPackage!(picked.inspection);
  expect(install).toHaveBeenCalledTimes(1);
});
