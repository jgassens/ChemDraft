import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const nativeFile = (path: string) => readFileSync(new URL(`../src-tauri/${path}`, import.meta.url), "utf8");
const rust = nativeFile("src/lib.rs");
const between = (start: string, end: string) => rust.slice(rust.indexOf(start), rust.indexOf(end, rust.indexOf(start)));

describe("document window launch placement", () => {
  it("creates the configured and fallback main windows hidden", () => {
    const config = JSON.parse(nativeFile("tauri.conf.json"));
    expect(config.app.windows.find((window: { label: string }) => window.label === "main").visible).toBe(false);
    const create = between("fn create_main_window<", "/// Window geometry supplied by JS");
    expect(create).toContain(".visible(false)");
    expect(create).not.toContain(".visible(true)");
  });

  it("shows during setup before readiness, argv delivery, or frontend recovery", () => {
    const setup = between(".setup(|app|", ".invoke_handler(");
    const show = setup.indexOf("ensure_main_window_visible(app)");
    expect(show).toBeGreaterThan(0);
    expect(show).toBeLessThan(setup.indexOf(".setup_completed"));
    expect(show).toBeLessThan(setup.indexOf("handle_opened_document_args(app"));
  });

  it("keeps early OS opens queued for setup and reveals later opens", () => {
    const delivery = between("fn deliver_opened_document<", "fn open_document_payload_from_url(");
    expect(delivery).toMatch(/if delivery == OpenDocumentDelivery::PendingOnly[\s\S]*?return Ok\(\(\)\);/);
    expect(delivery.indexOf("return Ok(());")).toBeLessThan(delivery.indexOf("ensure_main_window_visible(app)"));
    expect(delivery.indexOf("ensure_main_window_visible(app)")).toBeLessThan(delivery.indexOf("emit_open_document_to_main(app"));
    const events = between(".run(|app, event|", "fn check_for_updates<");
    expect(events).toMatch(/RunEvent::Reopen[\s\S]*?ensure_main_window_visible\(app\)/);
    expect(events).toMatch(/RunEvent::Opened[\s\S]*?handle_opened_document_urls\(app, urls\)/);
    const secondLaunch = between("tauri_plugin_single_instance::init(", "let builder = builder\n");
    expect(secondLaunch).toContain("ensure_main_window_visible(app)");
  });

  it("places hidden windows before show, preserving visible and fullscreen frames", () => {
    const ensure = between("fn ensure_main_window_visible<", "fn configure_document_webview<");
    expect(ensure).toContain("let keep_frame = already_on_screen || window.is_fullscreen().unwrap_or(false)");
    expect(ensure.indexOf("match main_window_frame_action")).toBeLessThan(ensure.indexOf("window.show()"));
    expect(ensure).toMatch(/if !already_on_screen \{\s*window.show\(\)/);
    // Setup and second-launch paths focus again after ensure; that must not show twice.
    const focus = between("fn focus_main_document_window_impl<", "fn focus_native_document_window<");
    expect(focus).toMatch(/if !window.is_visible\(\).unwrap_or\(false\) \{\s*window.show\(\)/);
  });
});
