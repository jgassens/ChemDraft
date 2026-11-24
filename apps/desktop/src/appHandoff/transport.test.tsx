// @vitest-environment jsdom

import type { invoke } from "@tauri-apps/api/core";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { describe, expect, it, vi } from "vitest";
import { createEmptyDocument } from "@chemdraft/chem-core";
import { PluginApiVersion, type PluginCommandContext } from "@chemdraft/plugin-api";
import { PluginHost } from "@chemdraft/plugin-host";
import { createShortcutRegistry } from "@chemdraft/shortcut-engine";
import {
  createChemDraftAgentBridge, dispatchAgentPointerEvent, type AgentResolvedPoint, type AgentSnapshot
} from "../agentBridge";
import { ToolbarTextButton } from "../toolbars/toolbarCells";
import { appHandoffCommandStatus, createTauriAppHandoffTransport, reportAppHandoffTransportResult } from "./transport";
import { installNativeAppHandoffReceiver } from "./nativeMenu";
import type { AppHandoffMenuInvocation } from "@chemdraft/plugin-host";

const commandId = "plugin.crystalBuilder.sendMolecule";
const pluginId = "org.chemdraft.handoff.crystalBuilder";
const request = { appId: "opaque", fileName: "model", extension: "cif" as const, text: "test data" };
const invocation = { pluginId, commandId, nonce: "3".repeat(32) };
const eventName = "chemdraft:native-handoff-command";

function setup() {
  const launch = vi.fn();
  const native = vi.fn<typeof invoke<unknown>>().mockImplementation(async () => {
    launch();
    return { status: "sent" };
  });
  const installed = () => ({
    source: "catalog" as const, repository: "jgassens/ChemDraft-CrystalBuilder-Plugin", checksumVerified: true
  });
  const host = new PluginHost({
    appHandoffProvenance: { forRegistration: installed, forCall: installed },
    appHandoffTransport: createTauriAppHandoffTransport(native)
  });
  const handler = vi.fn((context: PluginCommandContext) => context.apps!.sendFile(request));
  host.registerPlugin({
    id: pluginId, name: "Crystal Builder", version: "1.0.0", apiVersion: PluginApiVersion, entry: "worker.js",
    permissions: ["apps.handoff", "native.execute"],
    contributes: {
      commands: [{ id: commandId, title: "Send" }],
      menus: [{ id: "menu.crystalBuilder.sendMolecule", title: "Send", commandId }]
    }
  }, { execution: "worker", commandHandlers: { [commandId]: handler } });
  return { host, handler, launch, native };
}

describe("native app handoff relay", () => {
  it("reports authoritative launch results without displaying native diagnostics", async () => {
    const native = vi.fn<typeof invoke<unknown>>();
    const status = vi.fn();
    const transport = createTauriAppHandoffTransport(native);
    const relay = (method: Parameters<typeof transport>[1], payload: Parameters<typeof transport>[2]) =>
      reportAppHandoffTransportResult(transport(invocation, method, payload), method, payload,
        result => status(result.message));
    native.mockResolvedValueOnce({ status: "sent" });
    await relay("sendFile", request);
    expect(status).toHaveBeenLastCalledWith("Opened the handoff file in the chosen app.");
    const build = { appId: "opaque", pipeline: "mofBuild", combination: "pcu-N16-2x2x2" };
    native.mockResolvedValueOnce({ status: "done", opened: false, steps: [] });
    await relay("runCompanion", build);
    expect(status).toHaveBeenLastCalledWith("Build completed.");
    native.mockResolvedValueOnce({ status: "done", opened: false, steps: [] });
    await relay("runCompanion", { ...build, openOutput: true });
    expect(status).toHaveBeenLastCalledWith("Build completed, but the chosen app could not open it.");
    native.mockResolvedValueOnce({ status: "failed", code: "timeout", message: "Companion step build timed out.",
      diagnostic: { step: "build", stderrTail: "private diagnostic" } });
    await relay("runCompanion", build);
    expect(status).toHaveBeenLastCalledWith("Companion build failed: Companion step build timed out.");
    native.mockResolvedValueOnce({ status: "declined" });
    await relay("runCompanion", build);
    expect(status).toHaveBeenLastCalledWith("Companion build cancelled.");
    native.mockResolvedValueOnce({ status: "cancelled" });
    await relay("chooseApp", { purpose: "Choose an app" });
    expect(status).toHaveBeenLastCalledWith("App selection cancelled.");
    const refusal = "App handoff refused because two requests claimed one menu click.";
    native.mockRejectedValueOnce(refusal);
    await expect(relay("runCompanion", build)).rejects.toThrow(refusal);
    expect(status).toHaveBeenLastCalledWith(refusal);
  });

  it("uses only a string status on a successful command, sanitizing and bounding by code point", () => {
    const name = "Send to Crystal Builder";
    const status = (value: unknown) => appHandoffCommandStatus({ ok: true, data: { status: value } }, name);
    expect(status(" \u202eMOF\u2069\u0000-5\r\nmatched\u0085here\u2028today\u0007 ")).toBe(`Plugin (${name}): MOF-5 matched here today`);
    const text = "🧪".repeat(500);
    expect(status(text)).toBe(`Plugin (${name}): ${text}`);
    expect(status(text + "🧪")).toBe(`Plugin (${name}): ${text}…`);
    for (const value of [null, 15, ["done"], { text: "done" }, " \u202c\n "]) expect(status(value)).toBeUndefined();
    expect(appHandoffCommandStatus({ ok: false, data: { status: "done" } }, name)).toBeUndefined();
    expect(appHandoffCommandStatus({ ok: true }, name)).toBeUndefined();
  });

  it("authenticates the direct receiver before dispatch and finishes after the Worker relay returns", async () => {
    const { host, launch, native, handler } = setup();
    const target = new EventTarget() as Window & { __CHEMDRAFT_NATIVE_HANDOFF__: (payload: unknown) => Promise<void> };
    let begun = false;
    const lifecycle = vi.fn(async (_: string, args: { invocation: AppHandoffMenuInvocation; phase: string }) => {
      if (args.invocation.nonce !== invocation.nonce || (args.phase === "begin" && begun)) throw "Refused";
      begun = true;
    });
    const listen = installNativeAppHandoffReceiver(target, lifecycle);
    const remove = listen(async proof => { await host.invokeAppHandoffMenuCommand(proof); });
    try {
      expect(() => listen(vi.fn())).toThrow("already has");
      expect(Object.getOwnPropertyDescriptor(target, "__CHEMDRAFT_NATIVE_HANDOFF__")).toMatchObject({
        writable: false, configurable: false, enumerable: false
      });
      target.dispatchEvent(new CustomEvent(eventName, { detail: invocation }));
      await target.__CHEMDRAFT_NATIVE_HANDOFF__({ commandId, pluginId });
      await target.__CHEMDRAFT_NATIVE_HANDOFF__({ ...invocation, nonce: "0".repeat(32) });
      expect(handler).not.toHaveBeenCalled();
      expect(native).not.toHaveBeenCalled();
      await target.__CHEMDRAFT_NATIVE_HANDOFF__(invocation);
      expect(native).toHaveBeenCalledExactlyOnceWith("app_handoff_call", { invocation, method: "sendFile", request });
      expect(lifecycle.mock.calls.slice(-2)).toEqual([
        ["app_handoff_menu_invocation", { invocation, phase: "begin" }],
        ["app_handoff_menu_invocation", { invocation, phase: "finish" }]
      ]);
      await target.__CHEMDRAFT_NATIVE_HANDOFF__(invocation);
      expect(handler).toHaveBeenCalledOnce();
      expect(launch).toHaveBeenCalledOnce();
    } finally { remove(); }
  });

  it.each(["macos", "windows"] as const)("blocks bridge.command, bridge.click and synthetic shortcuts on %s", async platform => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    const { host, handler, launch, native } = setup();
    const drawing = createEmptyDocument();
    const page = { ...drawing.pages[0], objectCount: 0 };
    const snapshot = (): AgentSnapshot => ({
      bridgeVersion: 1, build: "test", runtime: { desktop: true, source: "test" }, document: drawing,
      activeToolCommandId: "tool.select", page, pages: [page], selection: drawing.selection,
      viewport: {}, file: { dirty: false }, objects: []
    });
    const point = { x: 10, y: 10 };
    const target = { page: point };
    const resolved: AgentResolvedPoint = { page: point, client: point, target, source: "page" };
    const activePointerTargets = new Map<number, EventTarget>();
    const mount = document.createElement("div");
    document.body.append(mount);
    const root = createRoot(mount);
    const refused: string[] = [];
    const dispatch = vi.fn(async (id: string) => {
      try { await host.invokeCommand(id); }
      catch (error) { refused.push((error as Error).message); }
    });
    const agent = createChemDraftAgentBridge({
      snapshot, command: dispatch, resolvePoint: () => resolved, hitTest: () => ({ point: resolved }),
      pointer: (type, _target, options) => dispatchAgentPointerEvent({
        type, options, ownerDocument: document, activePointerTargets, resolvedPoint: resolved,
        pageElement: mount.querySelector("button")!
      }),
      waitForIdle: async () => { await Promise.all(dispatch.mock.results.map(result => result.value)); return snapshot(); }
    });
    const shortcut = createShortcutRegistry([{ commandId, keys: ["F8"] }], { platform });
    const onKey = (event: KeyboardEvent) => {
      const id = shortcut.resolve(event);
      if (id) void dispatch(id);
    };
    window.addEventListener("keydown", onKey);
    try {
      await act(async () => root.render(<ToolbarTextButton active={false} commandId={commandId}
        label="Send" onInvoke={id => { void dispatch(id); }}>Send</ToolbarTextButton>));
      await agent.command(commandId);
      await agent.click(target);
      window.dispatchEvent(new KeyboardEvent("keydown", { key: "F8", bubbles: true }));
      await agent.waitForIdle();
      expect(dispatch.mock.calls).toEqual([[commandId], [commandId], [commandId]]);
      expect(refused).toEqual(Array(3).fill("Start app handoff from the plugin's native menu."));
      expect(handler).not.toHaveBeenCalled();
      expect(native).not.toHaveBeenCalled();
      expect(launch).not.toHaveBeenCalled();
    } finally {
      window.removeEventListener("keydown", onKey);
      await act(async () => root.unmount());
      mount.remove();
      vi.unstubAllGlobals();
    }
  });
});
