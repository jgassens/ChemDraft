import { describe, expect, it, vi } from "vitest";
import {
  PluginApiVersion, type PluginAppsAPI, type PluginCommandHandler, type PluginCommandInput
} from "@chemdraft/plugin-api";
import { PluginHost, type PluginAppHandoffProvenance, type PluginHostOptions } from "./index";

const pluginId = "org.chemdraft.handoff.crystalBuilder";
const commandId = "plugin.crystalBuilder.buildMof";
const invocation = { commandId, pluginId, nonce: "1".repeat(32) };
const version = "1.0.0";
const official: PluginAppHandoffProvenance = {
  source: "catalog", repository: "jgassens/ChemDraft-CrystalBuilder-Plugin", checksumVerified: true
};
const sideload: PluginAppHandoffProvenance = { ...official, source: "sideload" };
const manifest = {
  id: pluginId, name: "Crystal Builder", version, apiVersion: PluginApiVersion, entry: "worker.js",
  permissions: ["apps.handoff", "native.execute", "ui.panel", "ui.canvas"],
  contributes: {
    commands: [{ id: commandId, title: "Build" }],
    menus: [{ id: "menu.crystalBuilder.buildMof", title: "Build", commandId }],
    panels: [{ id: "panel.crystalBuilder.build", title: "Build" }],
    canvasOverlays: [{
      id: "overlay.crystalBuilder.build", title: "Build", icon: "data:image/png;base64,AAAA", commandId,
      prompt: { kind: "prompt", id: "build", commandId, label: "Build", maxLength: 100 }
    }]
  },
  companions: [{
    id: "mofBuild", tool: { macos: "Contents/MacOS/xtal", windows: "xtal.exe" }, testedVersions: ["1.0.0"],
    steps: [
      { id: "preflight", args: ["capabilities", "--json"], timeoutSeconds: 5 },
      { id: "build", args: ["node={combination.node}"], timeoutSeconds: 10 }
    ],
    combinations: { pcu: { node: "N16" } }
  }]
};
const status = { appId: "opaque" };
const run = { ...status, pipeline: "mofBuild", combination: "pcu" };
const send = { ...status, fileName: "model", extension: "cif" as const, text: "test data" };

function setup(options: PluginHostOptions = {}) {
  let installed: PluginAppHandoffProvenance | undefined = official;
  const forCall = vi.fn(() => installed);
  const transport = vi.fn(async (_invocation: typeof invocation, method: string, _request: unknown): Promise<unknown> => {
    if (method === "status") return { available: true };
    if (method === "chooseApp") return { status: "chosen", app: { appId: "opaque", displayName: "Crystal Builder" } };
    if (method === "runCompanion") return { status: "done", steps: [], opened: false };
    return { status: "sent" };
  });
  const host = new PluginHost({
    appHandoffProvenance: { forRegistration: () => installed, forCall },
    appHandoffTransport: transport,
    ...options
  });
  const register = (handler: PluginCommandHandler) =>
    host.registerPlugin(manifest, { execution: "worker", commandHandlers: { [commandId]: handler } });
  return { host, transport, forCall, register, setInstalled: (value?: PluginAppHandoffProvenance) => { installed = value; } };
}

describe("PluginHost app handoff", () => {
  it("refuses in-process registration and leaves the registry untouched", () => {
    const { host } = setup();
    expect(() => host.registerPlugin(manifest)).toThrow("must run in a Worker");
    expect(host.commands.has(commandId)).toBe(false);
  });

  it.each([
    ["no record", undefined],
    ["legacy record", {}],
    ["sideload with a valid checksum", sideload],
    ["wrong repository", { ...official, repository: "other/repo" }],
    ["unverified checksum", { ...official, checksumVerified: false }]
  ] as const)("denies %s at registration", (_label, record) => {
    const { host, register, setInstalled } = setup();
    setInstalled(record);
    expect(() => register(vi.fn())).toThrow("checksum-verified install");
    expect(host.commands.has(commandId)).toBe(false);
  });

  it.each([false, true])("denies unlisted plugins with dev sideloads %s", appHandoffAllowSideload => {
    const { host, setInstalled } = setup({ appHandoffAllowSideload });
    for (const record of [official, sideload]) {
      setInstalled(record);
      expect(() => host.registerPlugin({ ...manifest, id: "org.test.impostor" }, { execution: "worker" }))
        .toThrow("outside the official app handoff catalog");
    }
  });

  it.each([false, true])("accepts verified catalog installs with dev sideloads %s", async appHandoffAllowSideload => {
    const { host, register, transport } = setup({ appHandoffAllowSideload });
    register(({ apps }) => apps!.status(status));
    await expect(host.invokeAppHandoffMenuCommand(invocation)).resolves.toEqual({ available: true });
    expect(transport).toHaveBeenCalledExactlyOnceWith(invocation, "status", status);
  });

  it("accepts explicit sideload and legacy records on dev while still requiring verified catalog records", async () => {
    const { host, register, setInstalled, transport } = setup({ appHandoffAllowSideload: true });
    setInstalled(sideload);
    register(async ({ apps }) => {
      await expect(apps!.status(status)).resolves.toEqual({ available: true });
      setInstalled({});
      await expect(apps!.status(status)).resolves.toEqual({ available: true });
      setInstalled({ ...official, repository: "other/repo" });
      await expect(apps!.status(status)).rejects.toThrow("checksum-verified install");
      setInstalled(undefined);
      await expect(apps!.status(status)).rejects.toThrow("checksum-verified install");
    });
    await host.invokeAppHandoffMenuCommand(invocation);
    expect(transport).toHaveBeenCalledTimes(2);
  });

  it("requires both permissions and provides no capability outside an active command", async () => {
    const { host, register } = setup();
    const ordinary = "org.test.native-only";
    const ordinaryCommand = "plugin.ordinary.run";
    host.registerPlugin({
      ...manifest, id: ordinary, permissions: ["native.execute"], companions: undefined,
      contributes: { commands: [{ id: ordinaryCommand, title: "Read" }] }
    }, { commandHandlers: { [ordinaryCommand]: context => Object.hasOwn(context, "apps") } });
    await expect(host.invokeCommand(ordinaryCommand)).resolves.toBe(false);
    expect(() => host.registerPlugin({ ...manifest, permissions: ["apps.handoff"] }, { execution: "worker" }))
      .toThrow(/without "native.execute"/);
    let retained: PluginAppsAPI;
    register(context => { retained = context.apps!; });
    expect(Object.hasOwn(host.createCommandContext(pluginId), "apps")).toBe(false);
    await host.invokeAppHandoffMenuCommand(invocation);
    await expect(retained!.sendFile(send)).rejects.toThrow("only while its command is executing");
  });

  it("allows status, choose and one pipeline, then rejects a send in the same command", async () => {
    const { host, register, transport, forCall } = setup();
    register(async ({ apps }) => {
      await expect(apps!.status(status)).resolves.toEqual({ available: true });
      const choice = await apps!.chooseApp({ purpose: "Choose Crystal Builder" });
      expect(choice).toEqual({ status: "chosen", app: { appId: run.appId, displayName: "Crystal Builder" } });
      if (choice.status !== "chosen") throw new Error("Expected the app to be chosen.");
      await expect(apps!.runCompanion({ ...run, appId: choice.app.appId })).resolves.toMatchObject({ status: "done" });
      await expect(apps!.sendFile(send)).rejects.toThrow("one file or run one companion pipeline");
    });
    await host.invokeAppHandoffMenuCommand(invocation);
    expect(transport.mock.calls).toEqual([
      [invocation, "status", status], [invocation, "chooseApp", { purpose: "Choose Crystal Builder" }],
      [invocation, "runCompanion", run]
    ]);
    expect(forCall).toHaveBeenCalledWith(pluginId, version);
  });

  it("keeps overlapping clicks for the same menu command bound to their own relay", async () => {
    const { host, register, transport } = setup();
    let finishFirst!: () => void;
    const firstWait = new Promise<void>(resolve => { finishFirst = resolve; });
    let first = true;
    register(async ({ apps }) => {
      if (first) {
        first = false;
        await firstWait;
      }
      return apps!.status(status);
    });
    const next = { ...invocation, nonce: "2".repeat(32) };
    const previous = host.invokeAppHandoffMenuCommand(invocation);
    try {
      await host.invokeAppHandoffMenuCommand(next);
    } finally { finishFirst(); }
    await previous;
    expect(transport.mock.calls).toEqual([[next, "status", status], [invocation, "status", status]]);
  });

  it("permits another submission after a refusal before presentation and counts a declined send", async () => {
    const { host, register, transport } = setup();
    transport.mockRejectedValueOnce(new Error("The request was refused before the box."));
    transport.mockResolvedValueOnce({ status: "failed", code: "app-missing", message: "Choose the app again." });
    transport.mockResolvedValueOnce({ status: "declined" });
    register(async ({ apps }) => {
      await expect(apps!.sendFile(send)).rejects.toThrow("refused before the box");
      await expect(apps!.sendFile(send)).resolves.toMatchObject({ code: "app-missing" });
      await expect(apps!.sendFile(send)).resolves.toEqual({ status: "declined" });
      await expect(apps!.runCompanion(run)).rejects.toThrow("one file or run one companion pipeline");
    });
    await host.invokeAppHandoffMenuCommand(invocation);
    expect(transport).toHaveBeenCalledTimes(3);
  });

  it("relays both pending contenders so Rust can refuse both before launch", async () => {
    const { host, register, transport } = setup();
    let rejectFirst: (error: Error) => void;
    const race = new Error("App handoff refused because two requests claimed one menu click.");
    transport.mockImplementationOnce(() => new Promise((_, reject) => { rejectFirst = reject; }));
    transport.mockImplementationOnce(async () => { rejectFirst(race); throw race; });
    register(async ({ apps }) => {
      const results = await Promise.allSettled([apps!.sendFile(send), apps!.runCompanion(run)]);
      expect(results).toEqual([{ status: "rejected", reason: race }, { status: "rejected", reason: race }]);
    });
    await host.invokeAppHandoffMenuCommand(invocation);
    expect(transport).toHaveBeenCalledTimes(2);
  });

  it("rechecks committed provenance on all four capability calls", async () => {
    const { host, register, transport, setInstalled } = setup();
    register(async ({ apps }) => {
      await apps!.status(status);
      setInstalled({ ...official, checksumVerified: false });
      for (const call of [
        () => apps!.status(status), () => apps!.chooseApp({ purpose: "Build" }),
        () => apps!.runCompanion(run), () => apps!.sendFile(send)
      ]) {
        await expect(call()).rejects.toThrow("checksum-verified install");
      }
      setInstalled(sideload);
      await expect(apps!.status(status)).rejects.toThrow("checksum-verified install");
    });
    await host.invokeAppHandoffMenuCommand(invocation);
    expect(transport).toHaveBeenCalledExactlyOnceWith(invocation, "status", status);
  });

  it("refuses non-menu dispatch from declared panel and overlay controls before running the handler", async () => {
    const { host, register, transport } = setup();
    const handler = vi.fn();
    register(handler);
    const inputs: PluginCommandInput[] = [
      { source: "panel", panelId: "panel.crystalBuilder.build", sectionId: "build", control: "prompt" },
      { source: "overlay", overlayId: "overlay.crystalBuilder.build", sectionId: "build", control: "prompt" }
    ];
    for (const input of inputs) {
      await expect(host.invokeCommand(commandId, { input })).rejects.toThrow("native menu");
      await expect(host.invokeCommand(commandId, { input: { ...input, token: "copied" } } as never))
        .rejects.toThrow(/unrecognized key/i);
    }
    expect(handler).not.toHaveBeenCalled();
    expect(transport).not.toHaveBeenCalled();
  });

  it("validates handoff requests and replies before crossing the plugin boundary", async () => {
    const { host, register, transport } = setup();
    register(async ({ apps }) => {
      for (const key of ["token", "nonce", "invocation", "arming", "commandId", "source", "pluginId"]) {
        await expect(apps!.sendFile({ ...send, [key]: "spoofed" })).rejects.toThrow(/^Invalid apps\.sendFile request\.$/);
      }
      await expect(apps!.sendFile({ ...send, extension: "Injected text" as never }))
        .rejects.toThrow(/^Invalid apps\.sendFile request at extension\.$/);
      await expect(apps!.runCompanion({ ...run, input: { extension: "Injected text", text: "input" } as never }))
        .rejects.toThrow(/^Invalid apps\.runCompanion request at input\.extension\.$/);
      await expect(apps!.runCompanion({ ...run, combination: "unknown" })).rejects.toThrow("declared by the plugin");
      expect(transport).not.toHaveBeenCalled();
      transport.mockResolvedValueOnce({ available: true, appPath: "/host/path" });
      await expect(apps!.status(status)).rejects.toThrow("invalid apps.status result");
    });
    await host.invokeAppHandoffMenuCommand(invocation);
  });

  it("returns an explicit error on hosts that lack a native handoff transport", async () => {
    const { host, register } = setup({ appHandoffTransport: undefined });
    register(({ apps }) => apps!.sendFile(send));
    await expect(host.invokeAppHandoffMenuCommand(invocation)).rejects.toThrow("requires the desktop app");
  });
});
