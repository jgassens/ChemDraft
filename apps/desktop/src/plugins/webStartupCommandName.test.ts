import { describe, expect, it, vi } from "vitest";

import { parseWebStartupCommand, webStartupCommandForBuild } from "./webStartupCommandName";

const BOARD_COMMAND = "plugin.nmrGame.play";

describe("CHEMDRAFT_WEB_STARTUP_COMMAND", () => {
  it("parses unset or blank as no startup command, and trims a value", () => {
    expect(parseWebStartupCommand(undefined)).toBeUndefined();
    expect(parseWebStartupCommand("")).toBeUndefined();
    expect(parseWebStartupCommand("  ")).toBeUndefined();
    expect(parseWebStartupCommand(` ${BOARD_COMMAND} `)).toBe(BOARD_COMMAND);
  });

  it("is refused inside a Tauri build and allowed in the browser build", () => {
    expect(() => webStartupCommandForBuild(BOARD_COMMAND, true)).toThrow(/inside a Tauri build.*browser build only/);
    expect(webStartupCommandForBuild(undefined, true)).toBeUndefined();
    expect(webStartupCommandForBuild("", true)).toBeUndefined();
    expect(webStartupCommandForBuild("  ", true)).toBeUndefined();
    expect(webStartupCommandForBuild(BOARD_COMMAND, false)).toBe(BOARD_COMMAND);
  });

  it("fails vite.config.ts itself when tauri runs Vite with a startup command inherited", async () => {
    vi.stubEnv("TAURI_ENV_PLATFORM", "darwin");
    vi.stubEnv("CHEMDRAFT_TOOLBAR_PROFILE", "");
    vi.stubEnv("CHEMDRAFT_WEB_STARTUP_COMMAND", BOARD_COMMAND);
    vi.resetModules();
    try {
      await expect(import("../../vite.config")).rejects.toThrow(/CHEMDRAFT_WEB_STARTUP_COMMAND.*inside a Tauri build/);
      vi.stubEnv("CHEMDRAFT_WEB_STARTUP_COMMAND", "");
      vi.resetModules();
      await expect(import("../../vite.config")).resolves.toBeDefined();
    } finally {
      vi.unstubAllEnvs();
      vi.resetModules();
    }
  }, 30_000);
});
