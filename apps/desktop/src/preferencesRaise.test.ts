import { readFileSync } from "node:fs";
import { expect, it } from "vitest";

it("restores the document before creating or raising Preferences on either platform", () => {
  const source = readFileSync(new URL("../src-tauri/src/lib.rs", import.meta.url), "utf8");
  const command = source.split("async fn toggle_preferences_window")[1]!.split("fn ensure_preferences_window")[0]!;
  const ensure = source.split("fn ensure_preferences_window")[1]!.split("fn agent_bridge_status")[0]!;
  const dialogs = readFileSync(new URL("../src-tauri/src/dialog_windows.rs", import.meta.url), "utf8");
  const showPreferences = dialogs.split("fn show_preferences<R: Runtime>")[1]!.split("fn reveal_on_main")[0]!;
  const show = dialogs.split("fn show_on_main<R: Runtime>")[1]!.split("pub(crate) fn configure_on_main")[0]!;
  expect(command).toContain("ensure_preferences_window(&app)");
  expect(command).not.toContain("hide()");
  // The tested restore/continue helper waits for native owner restoration on the main thread.
  expect(ensure).toMatch(/with_preferences_owner_restored\([\s\S]*?run_on_main_thread_blocking\(app, move \|\| \{[\s\S]*?focus_main_document_window_impl\(&target, MainWindowFocusMode::Force\)[\s\S]*?create_or_raise_preferences_window\(app\)/);
  // The shared dialog host owns placement and readiness before raising on either platform.
  expect(ensure).toMatch(/if let Some\(window\) = app\.get_webview_window\(PREFERENCES_WINDOW_LABEL\)[\s\S]*?run_on_main_thread_blocking\(&window, move \|\| dialog_windows::show_preferences\(&target\)\)[\s\S]*?return Ok\(window\)/);
  expect(ensure).not.toContain("hide()");
  expect(showPreferences).toMatch(/if ready \{[\s\S]*?show_on_main\(window\)\?/);
  expect(showPreferences).not.toContain("hide()");
  // Explicit reveal now passes true to the raise helper; the restore/place/show/focus/raise order is unchanged.
  expect(show).toMatch(/window\.unminimize\(\)[\s\S]*?place_content_window\(window,[\s\S]*?window\.show\(\)[\s\S]*?window\.set_focus\(\)[\s\S]*?bring_to_front_on_main\(window, true\)/);
  expect(show).not.toContain("hide()");
});
