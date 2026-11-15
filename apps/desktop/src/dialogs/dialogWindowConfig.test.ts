import { readFileSync } from "node:fs";
import { expect, it } from "vitest";

const native = readFileSync(new URL("../../src-tauri/src/dialog_windows.rs", import.meta.url), "utf8");
const builder = native.split("let builder = WebviewWindowBuilder::new(")[1]!
  .split("let dialog_window = match builder.build()")[0]!;

it("lets the activation click reach every shared dialog on macOS only", () => {
  // jsdom cannot exercise AppKit's non-key-window activation. Pin the native builder
  // contract alongside the form's DOM focus/submit test; native checks are still required.
  expect(builder).toMatch(/#\[cfg\(target_os = "macos"\)\]\s*let builder = builder\.accept_first_mouse\(true\);/);
  expect(builder).toMatch(/#\[cfg\(not\(target_os = "macos"\)\)\]\s*let builder = builder;/);
  expect(builder.match(/\.accept_first_mouse\(/g)).toHaveLength(1);
  // The first-mouse change must retain Windows ownership and hidden, unfocused creation.
  expect(builder).toMatch(/#\[cfg\(windows\)\]\s*let builder = builder\.parent\(&window\)/);
  expect(builder).toContain(".visible(false)");
  expect(builder).toContain(".focused(false)");
});
