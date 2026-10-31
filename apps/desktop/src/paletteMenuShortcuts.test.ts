import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";
import { NATIVE_MENU_COMMAND_IDS } from "./paletteMenuShortcuts";

const readNative = (path: string) => readFileSync(fileURLToPath(new URL(`../src-tauri/${path}`, import.meta.url)), "utf8");

it("keeps palette native-menu routes exactly in step with Rust, including named constants", () => {
  const source = readNative("src/lib.rs");
  const list = source.split("const MENU_COMMAND_IDS: &[&str] = &[")[1]!.split("];")[0]!;
  const ids = list.split(",").map((entry) => entry.trim()).filter(Boolean).map((entry) => {
    if (entry.startsWith('"')) return JSON.parse(entry) as string;
    const value = source.match(new RegExp(`const ${entry}: &str = "([^"]+)";`));
    expect(value, entry).not.toBeNull();
    return value![1]!;
  });
  expect(ids.length).toBeGreaterThan(0);
  expect([...NATIVE_MENU_COMMAND_IDS].sort()).toEqual(ids.sort());
  for (const command of ["view.zoomIn", "view.zoomOut", "document.nextTab", "document.previousTab", "document.closeTab"]) {
    expect(NATIVE_MENU_COMMAND_IDS.has(command), command).toBe(false);
  }
});

it("makes a released palette non-focusable even when the foreground hand-back fails", () => {
  const release = readNative("src/lib.rs").split("async fn set_plugin_panel_input_focus(")[1]!
    .split("// Hand back before disabling key eligibility:")[1]!.split("Ok(false)")[0]!;
  expect(release).toContain("if let Err(error)");
  expect(release).toContain('eprintln!("Could not return panel keyboard focus after release: {error}")');
  expect(release).not.toContain("return_focus.unwrap_or(false))?");
  expect(release.indexOf(".set_focusable(false)")).toBeGreaterThan(release.indexOf("eprintln!"));
});
