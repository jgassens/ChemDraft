import { readFileSync, readdirSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: mocks.invoke }));
beforeEach(() => {
  vi.resetModules();
  vi.stubGlobal("__TAURI_INTERNALS__", {});
});
afterEach(() => {
  vi.resetAllMocks();
  vi.unstubAllGlobals();
});

describe("palette focus diagnostics", () => {
  it("keeps the test override when startup permission resolves and restores the cached result", async () => {
    let resolveStatus!: (status: { enabled: boolean }) => void;
    mocks.invoke.mockReturnValueOnce(new Promise(resolve => { resolveStatus = resolve; }));
    const {
      paletteFocusDiagnostic, paletteFocusDiagnosticsReady,
      setPaletteFocusDiagnosticsEnabledForTests, waitForPaletteFocusDiagnosticsForTests
    } = await import("./paletteFocusDiagnostic");
    setPaletteFocusDiagnosticsEnabledForTests(true);
    try {
      await vi.waitFor(() => expect(mocks.invoke.mock.calls).toEqual([["agent_bridge_status"]]));
      resolveStatus({ enabled: false });
      await paletteFocusDiagnosticsReady;
      mocks.invoke.mockClear();
      paletteFocusDiagnostic("enabled by test");
      await vi.waitFor(() => expect(mocks.invoke.mock.calls).toEqual([["palette_focus_diagnostic", { line: "enabled by test" }]]));
      await waitForPaletteFocusDiagnosticsForTests();
      mocks.invoke.mockClear();
      setPaletteFocusDiagnosticsEnabledForTests(undefined);
      paletteFocusDiagnostic("disabled by cached permission");
      await waitForPaletteFocusDiagnosticsForTests();
      expect(mocks.invoke).not.toHaveBeenCalled();
    } finally {
      setPaletteFocusDiagnosticsEnabledForTests(undefined);
    }
  });

  it("resolves permission at startup and sends no per-event IPC when disabled", async () => {
    mocks.invoke.mockResolvedValue({ enabled: false });
    const {
      paletteFocusDiagnostic, paletteFocusDiagnosticsReady, waitForPaletteFocusDiagnosticsForTests
    } = await import("./paletteFocusDiagnostic");
    await paletteFocusDiagnosticsReady;
    await vi.waitFor(() => expect(mocks.invoke.mock.calls).toEqual([["agent_bridge_status"]]));
    mocks.invoke.mockClear();
    for (const event of ["input", "change", "preview", "commit"]) {
      expect(paletteFocusDiagnostic(`${event} command=object.color.#123456`)).toBeUndefined();
    }
    await waitForPaletteFocusDiagnosticsForTests();
    expect(mocks.invoke).not.toHaveBeenCalled();
  });

  it("drops pending diagnostics without IPC or replay after permission arrives", async () => {
    let resolveStatus!: (status: { enabled: boolean }) => void;
    mocks.invoke.mockReturnValue(new Promise(resolve => { resolveStatus = resolve; }));
    const {
      paletteFocusDiagnostic, paletteFocusDiagnosticsReady, waitForPaletteFocusDiagnosticsForTests
    } = await import("./paletteFocusDiagnostic");
    await vi.waitFor(() => expect(mocks.invoke.mock.calls).toEqual([["agent_bridge_status"]]));
    mocks.invoke.mockClear();
    paletteFocusDiagnostic("input while pending");
    paletteFocusDiagnostic("change while pending");
    await waitForPaletteFocusDiagnosticsForTests();
    expect(mocks.invoke).not.toHaveBeenCalled();
    resolveStatus({ enabled: true });
    await paletteFocusDiagnosticsReady;
    await waitForPaletteFocusDiagnosticsForTests();
    expect(mocks.invoke).not.toHaveBeenCalled();
  });

  it("bounds enabled payloads and swallows transport failures", async () => {
    mocks.invoke.mockResolvedValueOnce({ enabled: true });
    const {
      paletteFocusDiagnostic, paletteFocusDiagnosticsReady, waitForPaletteFocusDiagnosticsForTests
    } = await import("./paletteFocusDiagnostic");
    await paletteFocusDiagnosticsReady;
    await vi.waitFor(() => expect(mocks.invoke.mock.calls).toEqual([["agent_bridge_status"]]));
    mocks.invoke.mockClear();
    mocks.invoke.mockRejectedValue(new Error("closed"));
    expect(() => paletteFocusDiagnostic("x".repeat(600))).not.toThrow();
    await vi.waitFor(() => expect(mocks.invoke).toHaveBeenCalledWith("palette_focus_diagnostic", { line: "x".repeat(500) }));
    await waitForPaletteFocusDiagnosticsForTests();
    expect(mocks.invoke).toHaveBeenCalledTimes(1);
  });

  it("returns before logging or caller validation when the native bridge is off", () => {
    const source = readFileSync(new URL("../src-tauri/src/lib.rs", import.meta.url), "utf8");
    const command = source.slice(source.indexOf("fn palette_focus_diagnostic("), source.indexOf("// Diagnostics share"));
    expect(command).toMatch(/if !agent_bridge_status\(\).enabled \{\s*return Ok\(\(\)\);\s*\}/);
    expect(command.indexOf("return Ok(())")).toBeLessThan(command.indexOf("window.label()"));
    expect(command.indexOf("return Ok(())")).toBeLessThan(command.indexOf("palette_focus_log("));
    expect(command).toContain(".take(500)");
    expect(command).toContain('label != "main"');
    expect(command).toContain('label.starts_with("toolset-") && is_input_focus_window_label(label)');
  });

  it("grants diagnostics only to main and toolsets, with native tooltip exclusion", () => {
    const directory = new URL("../src-tauri/capabilities/", import.meta.url);
    const grants = readdirSync(directory).filter(name => name.endsWith(".json")).map(name =>
      JSON.parse(readFileSync(new URL(name, directory), "utf8")) as { windows: string[]; permissions: unknown[] }
    ).filter(capability => capability.permissions.includes("allow-palette-focus-diagnostic"));
    expect(grants).toHaveLength(1);
    expect(grants[0].windows).toEqual(["main", "toolset-*"]);
    const source = readFileSync(new URL("../src-tauri/src/lib.rs", import.meta.url), "utf8");
    expect(source).toContain('suffix != "tooltip"');
  });
});
