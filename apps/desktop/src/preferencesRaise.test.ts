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

it("restores the document without focus before creating or raising Preferences on either platform", () => {
  const source = readFileSync(new URL("../src-tauri/src/lib.rs", import.meta.url), "utf8");
  const command = source.split("async fn toggle_preferences_window")[1]!.split("fn ensure_preferences_window")[0]!;
  const ensure = source.split("fn ensure_preferences_window")[1]!.split("fn agent_bridge_status")[0]!;
  const dialogs = readFileSync(new URL("../src-tauri/src/dialog_windows.rs", import.meta.url), "utf8");
  const showPreferences = dialogs.split("fn show_preferences<R: Runtime>")[1]!.split("fn reveal_on_main")[0]!;
  const show = dialogs.split("fn show_on_main<R: Runtime>")[1]!.split("pub(crate) fn configure_on_main")[0]!;
  expect(command).toContain("ensure_preferences_window(&app)");
  expect(command).not.toContain("hide()");
  // The tested restore/continue helper waits for native owner restoration on the main thread.
  expect(ensure).toMatch(/with_preferences_owner_restored\([\s\S]*?run_on_main_thread_blocking\(app, move \|\| \{[\s\S]*?focus_main_document_window_impl\([\s\S]*?&target,\s*MainWindowFocusMode::RestoreForPreferences,[\s\S]*?create_or_raise_preferences_window\(app\)/);
  expect(ensure).not.toContain("MainWindowFocusMode::Force");
  const focus = source.split("fn focus_main_document_window_impl<R: Runtime>")[1]!.split("fn focus_native_document_window")[0]!;
  expect(focus).toMatch(/if !should_focus_main_window\(mode\) \{\s*clear_document_key_after_unhide_for_preferences\(\);\s*restore_main_document_window_without_focus\(&window\)\?;\s*return Ok\(true\);\s*\}[\s\S]*?focus_native_document_window\(&window\)\?;\s*window\.set_focus\(\)/);
  const restore = source.split("fn restore_main_document_window_without_focus<R: Runtime>")[1]!.split("fn focus_native_document_window")[0]!;
  expect(restore).toMatch(/#\[cfg\(target_os = "macos"\)\][\s\S]*?native\.deminiaturize\(None\)[\s\S]*?native\.orderFront\(None\)/);
  expect(restore).toMatch(/#\[cfg\(windows\)\][\s\S]*?let mut enabled_guard = WindowEnabledGuard::disable\(window\)\?;\s*window\.unminimize\(\)\.map_err[\s\S]*?window\.show\(\)\.map_err[\s\S]*?enabled_guard\.restore\(\)\?;/);
  expect(restore).not.toMatch(/makeKey|makeMainWindow|set_focus\(/);
  // The shared dialog host owns placement and readiness before raising on either platform.
  expect(ensure).toMatch(/if let Some\(window\) = app\.get_webview_window\(PREFERENCES_WINDOW_LABEL\)[\s\S]*?run_on_main_thread_blocking\(&window, move \|\| dialog_windows::show_preferences\(&target\)\)[\s\S]*?return Ok\(window\)/);
  expect(ensure).not.toContain("hide()");
  expect(showPreferences).toMatch(/if ready \{[\s\S]*?show_on_main\(window\)\?/);
  expect(showPreferences).not.toContain("hide()");
  expect(show).toMatch(/window\.unminimize\(\)[\s\S]*?place_content_window\(window,[\s\S]*?window\.show\(\)[\s\S]*?window\.set_focus\(\)[\s\S]*?bring_to_front_on_main\(window\)/);
  expect(show).not.toContain("hide()");
});

it("gives Preferences priority over pending unhide focus and defers its final macOS raise", () => {
  const source = readFileSync(new URL("../src-tauri/src/lib.rs", import.meta.url), "utf8");
  const dialogs = readFileSync(new URL("../src-tauri/src/dialog_windows.rs", import.meta.url), "utf8");
  const show = dialogs.split("fn show_on_main<R: Runtime>")[1]!.split("fn activate_preferences_application_on_main")[0]!;
  expect(show).toMatch(/if preferences \{\s*super::clear_document_key_after_unhide_for_preferences\(\);[\s\S]*?window\.show\(\)[\s\S]*?activate_preferences_application_on_main\(\)\?;[\s\S]*?window\.set_focus\(\)[\s\S]*?bring_to_front_on_main\(window\)\?;\s*if preferences \{\s*defer_preferences_raise_on_main\(window\);/);
  expect(source).toMatch(/fn preferences_raised\(&mut self\) \{\s*self\.document_was_key_at_hide = None;/);
  expect(source).toMatch(/fn clear_document_key_after_unhide_for_preferences\(\) \{[\s\S]*?DOCUMENT_KEY_AFTER_UNHIDE\.lock\(\)[\s\S]*?state\.preferences_raised\(\)/);
  expect(source).toMatch(/#\[cfg\(not\(target_os = "macos"\)\)\]\s*fn clear_document_key_after_unhide_for_preferences\(\)/);

  const deferred = dialogs.split("fn defer_preferences_raise_on_main<R: Runtime>")[1]!.split('#[cfg(not(target_os = "macos"))]')[0]!;
  expect(dialogs).toMatch(/#\[cfg\(target_os = "macos"\)\]\s*fn defer_preferences_raise_on_main<R: Runtime>/);
  expect(deferred).toContain("block2::RcBlock::new(move ||");
  expect(deferred).toContain("NSOperationQueue::mainQueue().addOperationWithBlock(&raise)");
  expect(deferred).not.toContain("run_on_main_thread");
  expect(deferred).toMatch(/get_webview_window\(super::PREFERENCES_WINDOW_LABEL\)[\s\S]*?get_webview_window\(super::MAIN_WINDOW_LABEL\)[\s\S]*?should_raise_preferences_after_activation\([\s\S]*?super::quit_in_progress\(\)[\s\S]*?window\.is_visible\(\)[\s\S]*?bring_to_front_on_main\(&window\)/);
  expect(dialogs).toMatch(/#\[cfg\(not\(target_os = "macos"\)\)\]\s*fn defer_preferences_raise_on_main<R: Runtime>/);
  const bringToFront = dialogs.split("fn bring_to_front_on_main<R: Runtime>")[1]!.split("struct SavedPosition")[0]!;
  expect(bringToFront).toMatch(/#\[cfg\(target_os = "macos"\)\][\s\S]*?if window\.label\(\) == super::PREFERENCES_WINDOW_LABEL \{\s*native\.makeKeyAndOrderFront\(None\);\s*\} else \{\s*native\.orderFront\(None\);/);
});
