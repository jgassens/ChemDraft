// @vitest-environment jsdom

import { invoke } from "@tauri-apps/api/core";
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
import { createTauriAppHandoffTransport, listenForNativeAppHandoffCommands } from "./transport";

const commandId = "plugin.crystalBuilder.sendMolecule";
const pluginId = "org.chemdraft.handoff.crystalBuilder";
const request = { appId: "opaque", fileName: "model", extension: "cif" as const, text: "test data" };
const eventName = "chemdraft:native-handoff-command";

function setup() {
  let armed = false;
  const launch = vi.fn();
  const native = vi.fn<typeof invoke>().mockImplementation(async <Result,>() => {
    if (!armed) throw "Start app handoff from the plugin's native menu.";
    armed = false;
    launch();
    return { status: "sent" } as Result;
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
  return { host, handler, launch, native, nativeMenuClick: () => {
    armed = true;
    window.dispatchEvent(new CustomEvent(eventName, { detail: { commandId } }));
  } };
}

describe("native app handoff relay", () => {
  it("relays a native menu command with exactly the fields Rust accepts", async () => {
    const { host, launch, native, nativeMenuClick } = setup();
    let pending: Promise<unknown> | undefined;
    const remove = listenForNativeAppHandoffCommands(window, id => { pending = host.invokeAppHandoffMenuCommand(id); });
    try {
      nativeMenuClick();
      await expect(pending).resolves.toEqual({ status: "sent" });
      expect(native).toHaveBeenCalledExactlyOnceWith("app_handoff_call", { pluginId, method: "sendFile", request });
      expect(launch).toHaveBeenCalledOnce();
      window.dispatchEvent(new CustomEvent(eventName, { detail: { commandId } }));
      await expect(pending).rejects.toThrow("native menu");
      expect(launch).toHaveBeenCalledOnce();
    } finally {
      remove();
    }
  });

  it("discards extra event fields and lets Rust refuse a synthetic event without an arming", async () => {
    const { host, launch, native } = setup();
    let pending: Promise<unknown> | undefined;
    const remove = listenForNativeAppHandoffCommands(window, id => { pending = host.invokeAppHandoffMenuCommand(id); });
    try {
      for (const field of ["token", "arming", "pluginId", "source", "input"]) {
        window.dispatchEvent(new CustomEvent(eventName, { detail: { commandId, [field]: "copied" } }));
      }
      expect(pending).toBeUndefined();
      expect(native).not.toHaveBeenCalled();
      window.dispatchEvent(new CustomEvent(eventName, { detail: { commandId } }));
      await expect(pending).rejects.toThrow("native menu");
      expect(native).toHaveBeenCalledOnce();
      expect(launch).not.toHaveBeenCalled();
    } finally {
      remove();
    }
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
