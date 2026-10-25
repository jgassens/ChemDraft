import { PluginPanelReportSchema, type PluginCommandContext } from "@chemdraft/plugin-api";
import type { RegisterPluginOptions } from "@chemdraft/plugin-host";

export const FIXTURE_PLUGIN_ID = "org.chemdraft.fixture";
export const FIXTURE_PLUGIN_TOOLSET_ID = "plugin.fixture";
export const FIXTURE_PLUGIN_PING_COMMAND_ID = "plugin.fixture.ping";
export const FIXTURE_PLUGIN_CHAT_PANEL_ID = "panel.fixture.chat";
export const FIXTURE_PLUGIN_CHAT_COMMAND_ID = "plugin.fixture.chat";
export const FIXTURE_PLUGIN_SUBMIT_COMMAND_ID = "plugin.fixture.submit";
export const FIXTURE_PLUGIN_CLEAR_COMMAND_ID = "plugin.fixture.clear";

/**
 * Dev/test-only plugin. It exercises the real plugin runtime end to end — contributing a
 * command and a toolset exactly the way a shipped extension (e.g. the mass analyzer) will,
 * so the same pipeline is proven before any real extension exists. Registered only under
 * import.meta.env.DEV; never present in production builds.
 *
 * Left as a plain object (not typed PluginManifest) so the host applies contribution
 * defaults at registration; the runtime validates it like any untrusted candidate.
 */
export const fixturePluginManifest = {
  id: FIXTURE_PLUGIN_ID,
  name: "Fixture Plugin",
  version: "0.0.0",
  apiVersion: "^0.1.10",
  entry: "dev:fixture",
  permissions: ["ui.toolbar", "ui.panel"],
  contributes: {
    commands: [
      {
        id: FIXTURE_PLUGIN_PING_COMMAND_ID,
        title: "Fixture Ping",
        requiredPermissions: [],
        enabled: true
      },
      { id: FIXTURE_PLUGIN_CHAT_COMMAND_ID, title: "Fixture Chat" },
      { id: FIXTURE_PLUGIN_SUBMIT_COMMAND_ID, title: "Send Fixture Message" },
      { id: FIXTURE_PLUGIN_CLEAR_COMMAND_ID, title: "Clear Fixture Chat" }
    ],
    panels: [{
      id: FIXTURE_PLUGIN_CHAT_PANEL_ID,
      title: "Fixture Chat",
      commandId: FIXTURE_PLUGIN_CHAT_COMMAND_ID,
      preferredWindowSize: { width: 420, height: 560 }
    }],
    toolsets: [
      {
        id: FIXTURE_PLUGIN_TOOLSET_ID,
        title: "Fixture Plugin Toolbar",
        defaultVisible: false,
        groups: [
          {
            items: [
              { commandId: FIXTURE_PLUGIN_PING_COMMAND_ID, title: "Ping" },
              { commandId: FIXTURE_PLUGIN_CHAT_COMMAND_ID, title: "Chat" }
            ]
          }
        ]
      }
    ]
  }
};

export function createFixturePluginOptions(onPing?: () => void): RegisterPluginOptions {
  const transcript: string[] = [];
  const showChat = (context: PluginCommandContext) => context.panels!.showReport(
    FIXTURE_PLUGIN_CHAT_PANEL_ID,
    PluginPanelReportSchema.parse({
      title: "Fixture Chat",
      sections: [
        { kind: "text", title: "Transcript", body: transcript.join("\n") || "Send a message to try panel input." },
        { kind: "actions", id: "actions", buttons: [{
          id: "clear", label: "Clear", commandId: FIXTURE_PLUGIN_CLEAR_COMMAND_ID
        }] },
        { kind: "prompt", id: "message", label: "Message", commandId: FIXTURE_PLUGIN_SUBMIT_COMMAND_ID }
      ]
    })
  );
  return {
    commandHandlers: {
      [FIXTURE_PLUGIN_PING_COMMAND_ID]: async () => {
        onPing?.();
        return { ok: true, commandId: FIXTURE_PLUGIN_PING_COMMAND_ID };
      },
      [FIXTURE_PLUGIN_CHAT_COMMAND_ID]: showChat,
      [FIXTURE_PLUGIN_SUBMIT_COMMAND_ID]: async context => {
        if (context.input?.control === "prompt" && context.input.text !== undefined) {
          transcript.push(context.input.text);
        }
        await showChat(context);
      },
      [FIXTURE_PLUGIN_CLEAR_COMMAND_ID]: async context => {
        transcript.length = 0;
        await showChat(context);
      }
    }
  };
}
