// @vitest-environment jsdom
import { createEmptyDocument } from "@chemdraft/chem-core";
import { parsePluginManifest, ProposedDocumentPatchSchema, type PluginCommandContext, type PluginPermission } from "@chemdraft/plugin-api";
import { CommandRegistry, PluginHost } from "@chemdraft/plugin-host";
import { act, createElement, StrictMode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { RuntimeTestChannels } from "../testSupport/runtimeBrokerChannels";
import { MemoryStorage } from "../testSupport/memoryStorage";
import { createLocalPluginRuntimeSession } from "./localPluginRuntime";
import { createPluginRuntimeOwner, type PluginRuntimeOwner, type PluginRuntimeProviders } from "./pluginRuntimeOwner";
import { useRuntimeView } from "./usePluginRuntimeView";
import { encodeRuntimeView, decodeRuntimeView, RuntimeViewActionSchema } from "./runtimeViewProtocol";
import { RuntimeViewClient, type BrokerPluginRuntimeView } from "./runtimeViewClient";
import { RuntimeBroker } from "./runtimeBroker";
import { recognitionInstallProgressStore } from "./structureRecognitionInstallProgress";
import type { PluginPackageInspection } from "./installPluginPackage";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const cleanup: Array<() => void> = [];
afterEach(() => { for (const stop of cleanup.splice(0).reverse()) stop(); vi.unstubAllGlobals(); });

function setup(run: (context: PluginCommandContext) => unknown = () => "done", permissions: PluginPermission[] = [], configure?: (owner: PluginRuntimeOwner) => void) {
  vi.stubGlobal("localStorage", new MemoryStorage());
  const document = createEmptyDocument();
  const channels = new RuntimeTestChannels();
  let owner!: PluginRuntimeOwner;
  let ownerServices!: PluginRuntimeProviders;
  const notifications = { name: vi.fn(), update: vi.fn(), proposals: vi.fn() };
  const manifest = parsePluginManifest({ id: "org.test.owner", name: "Owner test", version: "1.0.0", apiVersion: "^0.1.25", entry: "test.js", permissions,
    contributes: { commands: [{ id: "plugin.owner.run", title: "Run" }] } });
  const factory = vi.fn((providers: PluginRuntimeProviders) => {
    ownerServices = providers;
    owner = createPluginRuntimeOwner(providers);
    owner.runtime.registerPlugin(manifest, { commandHandlers: { "plugin.owner.run": run } });
    configure?.(owner);
    return owner;
  });
  const session = createLocalPluginRuntimeSession({
    commandRegistry: new CommandRegistry(), getActiveDocument: () => document,
    getActiveDocumentKey: () => "drawing", getActiveDocumentTab: () => ({ id: "tab-a" }),
    onNameResolutionStatus: notifications.name, onPluginUpdateStatus: notifications.update,
    onProposedPatchesChanged: notifications.proposals,
    getSelection: warnings => { warnings?.push("selection warning"); return { objectIds: [], molecules: [] }; }
  }, factory, channels);
  act(() => session.start());
  cleanup.push(() => act(() => session.dispose()));
  return { session, factory, owner, channels, document, notifications, ownerServices };
}

describe("the single-webview runtime owner and broker view", () => {
  it.each([false, true])("guards unknown plugin commands during startup and keeps core commands local (startup fails: %s)", async fails => {
    const { channels } = setup();
    const broker = new RuntimeBroker("doc-startup", channels.transport("doc-startup"));
    const registry = new CommandRegistry();
    const core = vi.fn(() => "core result");
    registry.register({ id: "plugin.core.draw", title: "Core drawing command" }, core);
    let resolve!: () => void, reject!: (error: Error) => void;
    const startup = new Promise<void>((yes, no) => { resolve = yes; reject = no; });
    const invoke = vi.fn(async () => "fallback result");
    const prepare = vi.fn(() => invoke);
    const client = new RuntimeViewClient(broker, invoke, true, startup, prepare, registry);
    cleanup.push(() => { client.dispose(); broker.dispose(); });
    expect(client.read().isPluginCommand("plugin.unknown.run")).toBe(true);
    expect(client.read().isPluginCommand("plugin.core.draw")).toBe(false);
    await expect(client.runtime.invokeCommand("plugin.unknown.run")).rejects.toThrow("Plugin runtime host is starting");
    await expect(client.runtime.prepareCommand!("plugin.unknown.run")()).rejects.toThrow("Plugin runtime host is starting");
    await expect(client.runtime.prepareCommand!("plugin.core.draw")()).resolves.toBe("core result");
    await expect(client.runtime.invokeCommand("document.missing")).rejects.toThrow("not registered");
    expect(invoke).not.toHaveBeenCalled();
    expect(prepare).not.toHaveBeenCalled();
    if (fails) {
      reject(new Error("Plugin runtime host failed to start: startup refused."));
      await expect(client.ready).rejects.toThrow("startup refused");
      await expect(client.runtime.prepareCommand!("plugin.unknown.run")()).rejects.toThrow("startup refused");
      expect(invoke).not.toHaveBeenCalled();
      expect(prepare).not.toHaveBeenCalled();
    } else {
      resolve();
      await client.ready;
      expect(client.read().isPluginCommand("plugin.unknown.run")).toBe(false);
      expect(client.read().isPluginCommand("plugin.owner.run")).toBe(true);
      await expect(client.runtime.prepareCommand!("plugin.unknown.run")()).resolves.toBe("fallback result");
      expect(invoke).toHaveBeenCalledExactlyOnceWith("plugin.unknown.run", undefined);
      expect(prepare).not.toHaveBeenCalled();
    }
    await expect(client.runtime.invokeCommand("plugin.core.draw")).resolves.toBe("core result");
    expect(core).toHaveBeenCalledTimes(2);
  });

  it("constructs the owner once across StrictMode view remounts and keeps host objects out of the view", async () => {
    const { session, owner, factory, channels } = setup();
    const container = document.createElement("div");
    document.body.appendChild(container);
    let root: Root | undefined = createRoot(container);
    cleanup.push(() => { act(() => root?.unmount()); container.remove(); });
    let view!: BrokerPluginRuntimeView;
    function Probe() { view = useRuntimeView(session.client); return null; }
    await act(async () => root!.render(createElement(StrictMode, {}, createElement(Probe))));
    expect(view.runtime.host).not.toBeInstanceOf(PluginHost);
    expect(view.runtime.host).not.toBe(owner.runtime.host);
    const getPlugin = vi.spyOn(owner.runtime.host, "getPlugin");
    expect(view.runtime.host.getPlugin("org.test.owner")?.manifest.name).toBe("Owner test");
    expect(getPlugin).not.toHaveBeenCalled();
    const isPluginCommand = view.isPluginCommand;
    act(() => owner.runtime.panels.reportDiagnostic("test", "Unrelated view update"));
    expect(session.client.read().isPluginCommand).toBe(isPluginCommand);
    act(() => root!.unmount());
    expect(recognitionInstallProgressStore.getSnapshot()).toBeUndefined();
    root = createRoot(container);
    await act(async () => root!.render(createElement(StrictMode, {}, createElement(Probe))));
    expect(factory).toHaveBeenCalledTimes(1);
    const invoke = vi.spyOn(owner.runtime, "invokeCommand");
    await act(async () => expect(view.invokePluginCommand("plugin.owner.run")).resolves.toBe("done"));
    expect(invoke).toHaveBeenCalledTimes(1);
    expect(channels.deliveries.some(({ message }) => message.kind === "request" && message.method === "runtimeViewAction")).toBe(true);
    expect(JSON.stringify(channels.deliveries)).not.toMatch(/commandHandlers|"resolve"|"signal"/);
  });

  it("transfers a prompt as data and settles it only through its explicit broker action", async () => {
    const { session, channels, owner } = setup(context => context.dialogs!.promptText({ title: "Name", label: "Name" }), ["ui.panel"]);
    const invocation = session.client.read().invokePluginCommand("plugin.owner.run");
    await vi.waitFor(() => expect(session.client.read().openTextPrompt).toBeDefined());
    const prompt = session.client.read().openTextPrompt!;
    expect(Object.keys(prompt).sort()).toEqual(["id", "pluginId", "pluginName", "request"]);
    expect(prompt).not.toBe(owner.runtime.prompts.getOpenPrompt());
    await session.client.read().submitTextPrompt(prompt.id, "ethanol");
    await expect(invocation).resolves.toEqual({ status: "submitted", value: "ethanol" });
    expect(session.client.read().openTextPrompt).toBeUndefined();
    expect(channels.deliveries.some(({ message }) => message.kind === "request" && message.method === "runtimeViewAction" &&
      (message.payload as { action: string }).action === "submitTextPrompt")).toBe(true);
  });

  it("forwards status and proposal notifications through broker data messages", () => {
    const { ownerServices, channels, notifications } = setup();
    ownerServices.onNameResolutionStatus!("Resolved name");
    ownerServices.onPluginUpdateStatus!("Update available");
    ownerServices.onProposedPatchesChanged!();
    expect(notifications.name).toHaveBeenCalledWith("Resolved name");
    expect(notifications.update).toHaveBeenCalledWith("Update available");
    expect(notifications.proposals).toHaveBeenCalledOnce();
    expect(channels.deliveries.filter(({ message }) => message.kind === "runtimeView").map(({ message }) =>
      message.kind === "runtimeView" && message.topic)).toEqual(expect.arrayContaining(["nameResolutionStatus", "pluginUpdateStatus", "proposalsChanged"]));
  });

  it("retains invocation-specific selection collectors and permission gates", async () => {
    const { session } = setup(async context => {
      expect(context.documents.applyPatch).toBeUndefined();
      return context.selection!.getSelection();
    }, ["selection.read"]);
    const first: string[] = [], second: string[] = [];
    await Promise.all([
      session.client.read().invokePluginCommand("plugin.owner.run", { selectionWarnings: first }),
      session.client.read().invokePluginCommand("plugin.owner.run", { selectionWarnings: second })
    ]);
    expect(first).toEqual(["selection warning"]);
    expect(second).toEqual(["selection warning"]);
    await session.client.read().invokePluginCommand("plugin.owner.run");
    expect(first).toHaveLength(1);
    expect(second).toHaveLength(1);
  });

  it("returns collected selection warnings even when the command rejects", async () => {
    const { session } = setup(async context => {
      await context.selection!.getSelection();
      throw new Error("Command refused");
    }, ["selection.read"]);
    const warnings: string[] = [];
    await expect(session.client.read().invokePluginCommand("plugin.owner.run", { selectionWarnings: warnings })).rejects.toThrow("Command refused");
    expect(warnings).toEqual(["selection warning"]);
  });

  it("acknowledges acceptance while proposal preparation and commit stay in the document", async () => {
    const { session, document, owner, channels } = setup(context => context.documents.proposePatch({
      reason: "Test proposal", patch: { op: "addObject", pageId: "page_001", object: {
        id: "label", type: "text", x: 0, y: 0, width: 20, height: 10, rotation: 0, style: {}, text: "Label", spans: []
      } }
    }), ["document.proposePatch"]);
    await session.client.read().invokePluginCommand("plugin.owner.run");
    const proposal = session.client.read().runtime.host.listProposedPatches("pending")[0]!;
    const prepared = { ...document, title: "Prepared locally" };
    const apply = vi.fn(() => prepared);
    expect(session.client.runtime.host.acceptProposedPatch(proposal.id, document, { apply })).toEqual(prepared);
    expect(apply).toHaveBeenCalledTimes(1);
    expect(owner.runtime.host.listProposedPatches("pending")).toEqual([]);
    expect(JSON.stringify(channels.deliveries)).not.toContain('"apply":');
  });

  it("validates explicit actions and refuses executable data", () => {
    expect(RuntimeViewActionSchema.safeParse({ action: "host.unregisterPlugin", args: ["org.test.owner"] }).success).toBe(false);
    expect(RuntimeViewActionSchema.safeParse({ action: "submitTextPrompt", args: ["wrong id", "value"] }).success).toBe(false);
    expect(RuntimeViewActionSchema.safeParse({ action: "acceptProposal", args: ["proposal", {}, {}] }).success).toBe(false);
    expect(() => encodeRuntimeView({ callback: () => {} })).toThrow("data only");
    expect(decodeRuntimeView(encodeRuntimeView([undefined, new Uint8Array([0, 255])]))).toEqual([undefined, new Uint8Array([0, 255])]);
    const literalPayload = { a: { runtimeUndefined: true }, b: { runtimeBytes: [0, 255] }, c: { runtimeEntries: [["key", "value"]] } };
    expect(decodeRuntimeView(JSON.parse(JSON.stringify(encodeRuntimeView(literalPayload))))).toEqual(literalPayload);
  });

  it("keeps React click events out of zero-argument actions", async () => {
    const { session, channels } = setup();
    const event: Record<string, unknown> = {};
    event.target = event;
    await (session.client.read().closePanel as (...args: unknown[]) => unknown)(event);
    const request = channels.deliveries.find(({ message }) => message.kind === "request" && message.method === "runtimeViewAction");
    expect(request?.message).toMatchObject({ payload: { action: "closePanel", args: [] } });
  });

  it("retains package bytes with the owner and installs the reviewed receipt's original inspection", async () => {
    let inspection!: PluginPackageInspection;
    const install = vi.fn(async (_inspection: PluginPackageInspection) => {});
    const { session, channels } = setup(undefined, [], owner => {
      inspection = {
        manifest: owner.runtime.host.getPlugin("org.test.owner")!.manifest,
        provenance: { sdk: "@chemdraft/plugin-api", sdkVersion: "0.1.25", sourceCommit: "a".repeat(40), sourceTree: "clean", licenseFile: "LICENSE", packagedAt: "2026-11-10T00:00:00.000Z" },
        sourceChecksum: "a".repeat(64), unpackedBytes: 33 * 1024 * 1024,
        entries: [{ path: "data.bin", bytes: new Uint8Array(33 * 1024 * 1024) }]
      };
      const read = owner.read;
      owner.read = () => ({ ...read(), pickPackage: async () => ({ inspection, sourcePath: "test.zip", checksumVerified: true }), installPackage: install });
    });
    const picked = (await session.client.read().pickPackage!())!;
    expect(picked.inspection.entries).toEqual([]);
    expect(picked.inspection.unpackedBytes).toBe(inspection.unpackedBytes);
    await session.client.read().installPackage!({ ...picked.inspection, manifest: { ...picked.inspection.manifest, name: "Changed view metadata" } });
    expect(install).toHaveBeenCalledWith(inspection);
    expect(install.mock.calls[0]?.[0]).toBe(inspection);
    expect(JSON.stringify(channels.deliveries).length).toBeLessThan(100_000);
    session.client.runtime.discardPreparedPackages();
    await expect(session.client.read().installPackage!(picked.inspection)).rejects.toThrow("review has expired");
  });

  it("reconstructs large recognition previews exactly through bounded broker data reads", () => {
    const source = `data:image/png;base64,${"A".repeat(700_000)}`;
    const { session, channels, owner } = setup(undefined, [], owner => {
      vi.spyOn(owner.runtime.host, "listProposedPatches").mockReturnValue([{
        id: "proposal", pluginId: "org.test.owner", status: "pending", createdAt: "2026-11-10T00:00:00.000Z",
        proposal: ProposedDocumentPatchSchema.parse({ reason: "Mock recognition preview", patch: { op: "addObject" },
          recognition: { sourceImageRef: source, proposedMolfile: "mock fixture", confidenceTier: "low" } })
      }]);
    });
    expect(session.client.runtime.host.listProposedPatches()[0]?.proposal.recognition?.sourceImageRef).toBe(source);
    const chunks = () => channels.deliveries.filter(({ message }) => message.kind === "request" && message.method === "runtimeViewAction" &&
      (message.payload as { action: string }).action === "previewImageChunk");
    expect(chunks()).toHaveLength(3);
    expect(channels.deliveries.every(({ message }) => JSON.stringify(message).length < 300_000)).toBe(true);
    owner.runtime.panels.reportDiagnostic("test", "Unrelated notification");
    expect(chunks()).toHaveLength(3);
    expect(session.client.runtime.host.listProposedPatches()[0]?.proposal.recognition?.sourceImageRef).toBe(source);
  });
});
