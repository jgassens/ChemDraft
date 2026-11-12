import { readFileSync } from "node:fs";
import { expect, it } from "vitest";

const source = readFileSync(new URL("../../src-tauri/src/dialog_windows.rs", import.meta.url), "utf8");
const dismissOwned = source.split("pub(crate) fn dismiss_owned")[1]!.split("pub(crate) fn dismiss_all")[0]!;
const dismissAll = source.split("pub(crate) fn dismiss_all")[1]!.split("pub(crate) fn reown_preferences")[0]!;
const reown = source.split("pub(crate) fn reown_preferences")[1]!.split("pub(crate) fn prepare_preferences")[0]!;

it("uses the release flush-before-destroy path when the last document is dismissed", () => {
  const releaseDisposal = `flush_preferences(app, PreferencesClose::Close);
        if let Some(window) = app.get_webview_window(super::PREFERENCES_WINDOW_LABEL) {
            let _ = window.destroy();
        }`;
  expect(dismissOwned).toContain(`if reason != "quit" && !reown_preferences(app, Some(owner_window_id)) {
        ${releaseDisposal}
    }`);
  expect(dismissOwned.indexOf("flush_preferences(")).toBeLessThan(dismissOwned.indexOf("take_owned_sessions("));
  expect(dismissAll.indexOf("flush_preferences(")).toBeLessThan(dismissAll.indexOf("window.destroy()"));
});

it("keeps Preferences only when its registry supplies a ready surviving owner", () => {
  // The Rust registry tests exercise sole, closing, creating and surviving document states.
  // This checks that the native dismissal actually uses their result before touching the HWND.
  expect(reown).toMatch(/\.reown_preferences\(closing_owner\)\s*else \{\s*return false;\s*\};/);
  expect(reown.indexOf("return false;")).toBeLessThan(reown.indexOf("get_webview_window("));
  expect(reown.trimEnd()).toMatch(/true\s*\}$/);
  expect(dismissOwned).toContain("!reown_preferences(app, Some(owner_window_id))");
});
