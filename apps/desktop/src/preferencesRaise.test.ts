import { readFileSync } from "node:fs";
import { expect, it } from "vitest";

it("activates ChemDraft on macOS when the menu reveals Preferences before focusing it", () => {
  const dialogs = readFileSync(new URL("../src-tauri/src/dialog_windows.rs", import.meta.url), "utf8");
  const show = dialogs.split("fn show_on_main<R: Runtime>")[1]!.split("pub(crate) fn configure_on_main")[0]!;
  // First-ready and retained-window opens both reach show_on_main (covered below).
  // Activation must be after the quit/suspension/owner guards and restricted to Preferences.
  expect(show).toMatch(/window\.show\(\)[\s\S]*?configure_on_main\(window\)\?;\s*if preferences \{\s*activate_preferences_application_on_main\(\)\?;\s*\}\s*window\.set_focus\(\)/);
  expect(dialogs).toMatch(/#\[cfg\(target_os = "macos"\)\]\s*fn activate_preferences_application_on_main\(\)[\s\S]*?NSApplication::sharedApplication\(marker\)\.activateIgnoringOtherApps\(true\)/);
  expect(dialogs).toMatch(/#\[cfg\(not\(target_os = "macos"\)\)\]\s*fn activate_preferences_application_on_main\(\) -> Result<\(\), String> \{\s*\/\/[^\n]*\n\s*Ok\(\(\)\)\s*\}/);
  const ready = dialogs.split("pub(crate) async fn preferences_ready")[1]!.split("pub(crate) fn show_preferences")[0]!;
  expect(ready).toContain("show_on_main(&target)?");
});

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
  expect(show).toMatch(/window\.unminimize\(\)[\s\S]*?place_content_window\(window,[\s\S]*?window\.show\(\)[\s\S]*?window\.set_focus\(\)[\s\S]*?bring_to_front_on_main\(window\)/);
  expect(show).not.toContain("hide()");
});

it("makes retained Preferences key as well as frontmost on macOS, keeping Windows activation", () => {
  const main = readFileSync(new URL("./MainWindow.tsx", import.meta.url), "utf8");
  const command = main.split("if (action.id === PREFERENCES_COMMAND_ID)")[1]!.split("if (action.id === SPIN3D_DEBUGGER_COMMAND_ID)")[0]!;
  expect(command).toContain('await invoke("toggle_preferences_window")');
  const dialogs = readFileSync(new URL("../src-tauri/src/dialog_windows.rs", import.meta.url), "utf8");
  const raise = dialogs.split("fn bring_to_front_on_main<R: Runtime>")[1]!.split("fn place_window")[0]!;
  const macos = raise.split('#[cfg(target_os = "macos")]')[1]!.split("#[cfg(windows)]")[0]!;
  // orderFront alone changes stacking, but does not make an already-open window key.
  // The command -> retained window -> show_on_main path is covered above; its final native
  // raise must explicitly activate Preferences without activating other restored utilities.
  expect(macos).toMatch(/if window\.label\(\) == super::PREFERENCES_WINDOW_LABEL \{\s*native\.makeKeyAndOrderFront\(None\);\s*\} else \{\s*native\.orderFront\(None\);/);
  const windows = raise.split("#[cfg(windows)]")[1]!.split("#[cfg(not(any")[0]!;
  expect(windows).toContain("SetWindowPos(");
  // Windows activation remains in the shared path before its sibling z-order adjustment.
  const show = dialogs.split("fn show_on_main<R: Runtime>")[1]!.split("pub(crate) fn configure_on_main")[0]!;
  expect(show).toMatch(/window\.unminimize\(\)[\s\S]*?window\.show\(\)[\s\S]*?window\.set_focus\(\)[\s\S]*?bring_to_front_on_main\(window\)/);
});
