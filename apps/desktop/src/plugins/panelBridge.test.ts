// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  PLUGIN_PANEL_ACTION_TIMEOUT_MS,
  listenForPluginPanelActions,
  requestPluginPanelAction,
  respondToPluginPanelAction
} from "./panelBridge";

describe("plugin panel action bridge", () => {
  afterEach(() => vi.useRealTimers());

  it("round-trips an action through CustomEvents", async () => {
    const unlisten = listenForPluginPanelActions((id, request) => {
      expect(request).toEqual({ panelId: "panel.example.chat", sectionId: "composer", control: "prompt", text: "draw water" });
      void respondToPluginPanelAction(id, { ok: true });
    });

    await expect(requestPluginPanelAction({ panelId: "panel.example.chat", sectionId: "composer", control: "prompt", text: "draw water" }))
      .resolves.toEqual({ ok: true });
    unlisten();
  });

  it("times out when the document window does not answer", async () => {
    vi.useFakeTimers();
    const pending = requestPluginPanelAction({ panelId: "panel.example.chat", sectionId: "composer", control: "prompt", text: "draw" });
    await vi.advanceTimersByTimeAsync(PLUGIN_PANEL_ACTION_TIMEOUT_MS);
    await expect(pending).resolves.toEqual({ ok: false, reason: "timeout" });
  });

  it("stops delivering CustomEvent requests after unlisten", async () => {
    const handler = vi.fn();
    const unlisten = listenForPluginPanelActions(handler);
    unlisten();
    const pending = requestPluginPanelAction({ panelId: "panel.example.chat", sectionId: "composer", control: "prompt", text: "draw" }, 0);
    await expect(pending).resolves.toEqual({ ok: false, reason: "timeout" });
    expect(handler).not.toHaveBeenCalled();
  });
});
