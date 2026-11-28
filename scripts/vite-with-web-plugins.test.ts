import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { webPluginsLaunch } from "./vite-with-web-plugins.mjs";

describe("vite-with-web-plugins launcher", () => {
  it("leaves the startup command and toolbar profile unset without their flags", () => {
    const { env, args } = webPluginsLaunch(["build"], {});
    expect(args).toEqual(["build"]);
    expect(env.CHEMDRAFT_WEB_STARTUP_COMMAND).toBeUndefined();
    expect(env.CHEMDRAFT_TOOLBAR_PROFILE).toBeUndefined();
    expect(env.CHEMDRAFT_WEB_PLUGINS_DIR).toMatch(/\.web-plugins$/);
  });

  it("turns leading flags, in either order, into variables and passes the rest to Vite", () => {
    for (const argv of [
      ["--toolbar-profile=molecule-drawing", "--startup-command=plugin.nmrGame.play", "--host", "127.0.0.1"],
      ["--startup-command=plugin.nmrGame.play", "--toolbar-profile=molecule-drawing", "--host", "127.0.0.1"]
    ]) {
      const { env, args } = webPluginsLaunch(argv, { CHEMDRAFT_WEB_PLUGINS_DIR: "/staged" });
      expect(args).toEqual(["--host", "127.0.0.1"]);
      expect(env.CHEMDRAFT_TOOLBAR_PROFILE).toBe("molecule-drawing");
      expect(env.CHEMDRAFT_WEB_STARTUP_COMMAND).toBe("plugin.nmrGame.play");
      expect(env.CHEMDRAFT_WEB_PLUGINS_DIR).toBe("/staged");
    }
  });

  it("is what the game scripts run, with the Spectrum Match board as the startup command", () => {
    const pkg = JSON.parse(readFileSync(join(__dirname, "..", "apps", "desktop", "package.json"), "utf8")) as { scripts: Record<string, string> };
    for (const name of ["dev:web:game", "build:web:game"]) {
      expect(pkg.scripts[name]).toContain("--startup-command=plugin.nmrGame.play");
    }
    for (const name of ["dev:web", "build:web", "dev:web:plugins", "build:web:plugins"]) {
      expect(pkg.scripts[name]).not.toContain("--startup-command");
    }
  });
});
