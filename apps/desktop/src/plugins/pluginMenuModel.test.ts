import type { PluginMenuContribution } from "@chemdraft/plugin-api";
import type { RegisteredContribution } from "@chemdraft/plugin-host";
import { describe, expect, it } from "vitest";

import { buildPluginMenuItems } from "./pluginMenuModel";

describe("plugin menu model", () => {
  it("inherits the registered command's disabled state", () => {
    const contribution: RegisteredContribution<PluginMenuContribution> = {
      pluginId: "org.test.disabled",
      contribution: {
        id: "menu.disabled.run",
        title: "Unavailable analysis",
        commandId: "plugin.disabled.run",
        location: "analyze",
        requiredPermissions: []
      }
    };

    const items = buildPluginMenuItems([contribution], () => false);

    expect(items[0].command.enabled).toBe(false);
  });
});
