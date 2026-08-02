// @vitest-environment jsdom

// Regression: a native palette window opened for a PLUGIN toolset must render that plugin's toolbar,
// not the Main toolbar. The palette webview ships only the core manifest, so it learns plugin toolset
// definitions over the definitions IPC channel. Before that broadcast lands the window is "pending"
// (empty, carrying its own id); it must never fall back to core.main — doing so rendered the Main
// tools under the plugin's title and made the window's close button target the real Main window.

import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { PaletteWindow } from "./PaletteWindow";
import { broadcastToolsetDefinitions } from "./window-manager";
import type { ToolsetDefinition } from "@chemdraft/toolset-registry";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const PLUGIN_TOOLSET_ID = "plugin.demo";
const PLUGIN_COMMAND_ID = "plugin.demo.hello";

const pluginToolset: ToolsetDefinition = {
  id: PLUGIN_TOOLSET_ID,
  title: "Demo Plugin Toolbar",
  source: "plugin",
  defaultVisible: true,
  defaultMode: "floating",
  groups: [
    {
      id: "plugin.demo.tools",
      items: [
        {
          id: PLUGIN_COMMAND_ID,
          kind: "button",
          label: "Hello",
          icon: "palette",
          primary: { type: "command", commandId: PLUGIN_COMMAND_ID },
          submenu: null
        }
      ]
    }
  ]
};

describe("PaletteWindow for a plugin toolset", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  async function renderPluginPalette() {
    // No initialRegistry — this is the production path where the window starts core-only and must
    // learn the plugin toolset from the broadcast.
    await act(async () => {
      root.render(createElement(PaletteWindow, { toolsetId: PLUGIN_TOOLSET_ID }));
    });
    await act(async () => {
      await Promise.resolve();
    });
  }

  it("does not masquerade as the Main toolbar before its definition arrives", async () => {
    await renderPluginPalette();

    // The shell is tagged with THIS window's id, not core.main.
    expect(container.querySelector(`[data-toolset-id="${PLUGIN_TOOLSET_ID}"]`)).not.toBeNull();
    expect(container.querySelector('[data-toolset-id="core.main"]')).toBeNull();
    // None of Main's tools leak in while pending.
    expect(container.querySelector('[data-command-id="tool.select"]')).toBeNull();
    expect(container.querySelector(`[data-command-id="${PLUGIN_COMMAND_ID}"]`)).toBeNull();
  });

  it("renders the plugin toolbar once its definition is broadcast", async () => {
    await renderPluginPalette();

    await act(async () => {
      await broadcastToolsetDefinitions([pluginToolset]);
    });

    // The plugin command now renders; still no Main tools, still tagged with the plugin id.
    expect(container.querySelector(`[data-command-id="${PLUGIN_COMMAND_ID}"]`)).not.toBeNull();
    expect(container.querySelector('[data-command-id="tool.select"]')).toBeNull();
    expect(container.querySelector(`[data-toolset-id="${PLUGIN_TOOLSET_ID}"]`)).not.toBeNull();
    expect(container.querySelector('[data-toolset-id="core.main"]')).toBeNull();
  });
});
