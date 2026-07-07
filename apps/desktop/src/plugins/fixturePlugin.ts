import type { RegisterPluginOptions } from "@chemdraft/plugin-host";

export const FIXTURE_PLUGIN_ID = "org.chemdraft.fixture";
export const FIXTURE_PLUGIN_TOOLSET_ID = "plugin.fixture";
export const FIXTURE_PLUGIN_PING_COMMAND_ID = "plugin.fixture.ping";

/**
 * Dev/test-only plugin. It exercises the real plugin runtime end to end — contributing a
 * command and a toolset exactly the way a shipped extension (e.g. the NMR predictor) will,
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
  apiVersion: "^0.1.0",
  entry: "dev:fixture",
  permissions: ["ui.toolbar"],
  contributes: {
    commands: [
      {
        id: FIXTURE_PLUGIN_PING_COMMAND_ID,
        title: "Fixture Ping",
        requiredPermissions: [],
        enabled: true
      }
    ],
    toolsets: [
      {
        id: FIXTURE_PLUGIN_TOOLSET_ID,
        title: "Fixture Plugin Toolbar",
        defaultVisible: false,
        groups: [
          {
            items: [{ commandId: FIXTURE_PLUGIN_PING_COMMAND_ID, title: "Ping" }]
          }
        ]
      }
    ]
  }
};

export function createFixturePluginOptions(onPing?: () => void): RegisterPluginOptions {
  return {
    commandHandlers: {
      [FIXTURE_PLUGIN_PING_COMMAND_ID]: async () => {
        onPing?.();
        return { ok: true, commandId: FIXTURE_PLUGIN_PING_COMMAND_ID };
      }
    }
  };
}
