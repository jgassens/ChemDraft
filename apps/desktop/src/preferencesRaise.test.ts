import { readFileSync } from "node:fs";
import { expect, it } from "vitest";

it.each(["macos", "windows"] as const)("raises existing Preferences on %s", _platform => {
  const source = readFileSync(new URL("../src-tauri/src/lib.rs", import.meta.url), "utf8");
  const command = source.split("async fn toggle_preferences_window")[1]!.split("fn ensure_preferences_window")[0]!;
  const ensure = source.split("fn ensure_preferences_window")[1]!.split("async fn agent_bridge_status")[0]!;
  expect(command).toContain("ensure_preferences_window(&app)");
  expect(command).not.toContain("hide()");
  expect(ensure).toMatch(/if let Some\(window\)[\s\S]*?window\.show\(\)[\s\S]*?window\.unminimize\(\)[\s\S]*?window\.set_focus\(\)/);
});
