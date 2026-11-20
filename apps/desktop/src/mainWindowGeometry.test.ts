import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const nativeFile = (path: string) => readFileSync(new URL(`../src-tauri/${path}`, import.meta.url), "utf8");
const rust = nativeFile("src/lib.rs");
const between = (start: string, end: string) => {
  const startIndex = rust.indexOf(start);
  expect(startIndex, `Missing start marker: ${start}`).toBeGreaterThanOrEqual(0);
  const endIndex = rust.indexOf(end, startIndex);
  expect(endIndex, `Missing end marker after ${start}: ${end}`).toBeGreaterThanOrEqual(0);
  return rust.slice(startIndex, endIndex);
};

describe("document window launch placement", () => {
  it("creates the configured and fallback main windows hidden", () => {
    const config = JSON.parse(nativeFile("tauri.conf.json"));
    expect(config.app.windows.find((window: { label: string }) => window.label === "main").visible).toBe(false);
    const create = between("fn create_main_window<", "/// Window geometry supplied by JS");
    expect(create).toContain(".visible(false)");
    expect(create).not.toContain(".visible(true)");
  });

  it("shows during setup before readiness, argv delivery, or frontend recovery", () => {
    const initial = between(".setup(move |app|", ".invoke_handler(");
    expect(initial).toContain("setup_primary_app(app.handle())");
    const takeover = between("fn start_macos_primary(", "fn setup_primary_app(");
    expect(takeover).toMatch(/create_main_window\(app\)\?;\s*setup_primary_app\(app\)/);
    const setup = between("fn setup_primary_app(", "const DEVELOPMENT_UPDATES_MESSAGE");
    const show = setup.indexOf("ensure_main_window_visible(app)");
    expect(show).toBeGreaterThan(0);
    expect(show).toBeLessThan(setup.indexOf(".setup_completed"));
    expect(show).toBeLessThan(setup.indexOf("handle_opened_document_args(app"));
  });

  it("keeps early OS opens queued for setup and reveals later opens", () => {
    const delivery = between("fn deliver_opened_document<", "fn open_document_payload_from_url(");
    expect(delivery).toMatch(/state\.record\([\s\S]*?if delivery == OpenDocumentDelivery::PendingOnly \{[^}]*return Ok\(\(\)\);\s*\}\s*show_and_emit_open_document\(app\)/);
    const revealOpen = between("fn show_and_emit_open_document<", "fn emit_toolset_window_state_to_main<");
    expect(revealOpen).toMatch(/ensure_main_window_visible\(app\)[\s\S]*app\.emit_to\(MAIN_WINDOW_LABEL, OPEN_DOCUMENT_EVENT/);
    const events = between("app.run(move |app, event|", "fn start_macos_primary(");
    expect(events).toMatch(/RunEvent::Reopen[\s\S]*?ensure_main_window_visible\(app\)/);
    expect(events).toMatch(/RunEvent::Opened[\s\S]*?handle_opened_document_urls\(app, urls\)/);
    const startup = between("pub fn run() {", "fn start_macos_primary(");
    expect(startup).toContain("tauri_plugin_single_instance::init(handle_second_launch)");
    expect(startup).toMatch(/macos_single_instance::plugin\(\s*guard,\s*handle_macos_second_launch,/);
    const secondLaunch = between("fn handle_second_launch<", "fn handle_macos_second_launch(");
    expect(secondLaunch).toContain("handle_second_launch_with(app,");
    const reveal = between("fn handle_second_launch_with<", "fn quit_in_progress(");
    expect(reveal).toContain("ensure_main_window_visible(app)");
    const mac = between("fn handle_macos_second_launch(", "fn open_macos_launch(");
    expect(mac).toContain("ensure_main_window_visible(app)");
  });

  it("places hidden windows before show, preserving visible and fullscreen frames", () => {
    const ensure = between("fn ensure_main_window_visible<", "fn configure_document_webview<");
    expect(ensure).toContain("let keep_frame = already_on_screen || window.is_fullscreen().unwrap_or(false)");
    expect(ensure.indexOf("match main_window_frame_action")).toBeLessThan(ensure.indexOf("main_window_placement::show("));
    expect(ensure).toMatch(/if !already_on_screen \{\s*main_window_placement::show\(&window, maximize_on_show\)/);
    // Setup and second-launch paths focus again after ensure; that must not show twice.
    const focus = between("fn focus_main_document_window_impl<", "fn focus_native_document_window<");
    expect(focus).toMatch(/if !window.is_visible\(\).unwrap_or\(false\) \{\s*window.show\(\)/);
  });

  it("collects preparation errors through reveal and focus instead of returning early", () => {
    const ensure = between("fn ensure_main_window_visible<", "fn configure_document_webview<");
    const sequence = ensure.slice(ensure.indexOf("main_window_placement::reveal_after_preparation("));
    expect(sequence).toContain('errors.record("set title"');
    expect(sequence).toContain('errors.record("unminimize"');
    expect(sequence).toContain("restore_main_window_geometry(");
    expect(sequence).toContain("window.set_focus()");
    expect(sequence).not.toContain("?");
    const placement = nativeFile("src/main_window_placement.rs");
    const show = placement.slice(placement.indexOf("/// Reveal only"), placement.indexOf('#[cfg(target_os = "macos")]'));
    expect(show).not.toContain("?");
  });

  it("uses native normal placement and reveals maximized Windows windows without re-hiding", () => {
    const placement = nativeFile("src/main_window_placement.rs");
    expect(placement).toContain("GetWindowPlacement(hwnd, &mut placement)");
    expect(placement).toContain("placement.rcNormalPosition");
    expect(placement).toContain("placement.showCmd == SW_SHOWMAXIMIZED as u32 || IsZoomed(hwnd) != 0");
    expect(placement).toContain("info.rcWork.left - info.rcMonitor.left");
    expect(placement).toContain("info.rcWork.top - info.rcMonitor.top");
    expect(placement).toContain("AdjustWindowRectExForDpi(");
    expect(placement).toContain("Some(native.isZoomed())");
    expect(placement).toContain("NSWindowStyleMask::FullScreen");
    const windowsShow = placement.slice(placement.indexOf("#[cfg(windows)]"), placement.indexOf("#[cfg(not(windows))]"));
    expect(windowsShow).toContain("ShowWindow(hwnd.0 as _, SW_SHOWMAXIMIZED)");
    expect(windowsShow).not.toContain("window.maximize()");
    expect(windowsShow.indexOf("ShowWindow(hwnd.0 as _, SW_SHOWMAXIMIZED)")).toBeLessThan(windowsShow.indexOf("window.show()"));
    const restore = between("fn restore_main_window_geometry<", "fn main_window_geometry_reachable<");
    expect(restore).toContain("main_window_restore_steps(reachable, geometry.maximized)");
    expect(restore).not.toContain("window.show()");
    expect(restore).not.toContain("window.maximize()");
  });
});
