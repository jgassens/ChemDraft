import { readFileSync } from "node:fs";
import { expect, it } from "vitest";

it("keeps native Wayland toolbars resizable at the GTK level while fitting their content", () => {
  const source = readFileSync(new URL("../../src-tauri/src/lib.rs", import.meta.url), "utf8");
  const open = source.split("fn ensure_toolset_window<")[1]!.split("fn install_toolset_input_focus<")[0]!;
  // Every Linux palette GtkWindow is resizable, native Wayland included.
  expect(open).toMatch(/#\[cfg\(target_os = "linux"\)\]\s*let native_resizable = true;/);
  expect(open).toMatch(/#\[cfg\(not\(target_os = "linux"\)\)\]\s*let native_resizable = resizable;/);
  expect(open).toContain(".resizable(native_resizable)");
  expect(open).toContain("&resizable={resizable}");
  // Fixed (min = max) size hints conflict with a Wayland compositor's configure, so only X11/XWayland
  // content-fit palettes are pinned, both when created and before every content-fit resize.
  expect(open).toMatch(/let native_wayland = utility_window::uses_native_wayland\(app\)\?;[\s\S]*#\[cfg\(target_os = "linux"\)\]\s*if !resizable && !native_wayland \{[^}]*utility_window::pin_content_fit_frame\(/);
  expect(open.match(/utility_window::pin_content_fit_frame\(/g)).toHaveLength(1);
  const resize = source.split("fn resize_toolset_window(")[1]!.split("fn toolset_title_in_physical_work_area(")[0]!;
  expect(resize).toMatch(/if utility_window::uses_native_wayland\(app\)\? \{[^}]*return Ok\(true\);\s*\}[\s\S]*#\[cfg\(target_os = "linux"\)\]\s*utility_window::pin_content_fit_frame\(/);
  expect(resize.match(/utility_window::pin_content_fit_frame\(/g)).toHaveLength(1);
});
