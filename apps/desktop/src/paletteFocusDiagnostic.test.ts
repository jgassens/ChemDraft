import { readFileSync, readdirSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import { paletteFocusDiagnostic } from "./paletteFocusDiagnostic";

const mocks = vi.hoisted(() => ({ permission: vi.fn(), invoke: vi.fn() }));
vi.mock("./agentBridge", () => ({ resolveAgentBridgePermission: mocks.permission }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: mocks.invoke }));
afterEach(() => vi.resetAllMocks());

describe("palette focus diagnostics", () => {
  it("sends nothing when the page bridge is disabled", async () => {
    mocks.permission.mockResolvedValue({ enabled: false });
    paletteFocusDiagnostic("preview command=object.color.#123456");
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(mocks.invoke).not.toHaveBeenCalled();
  });

  it("bounds enabled payloads and swallows transport failures", async () => {
    mocks.permission.mockResolvedValue({ enabled: true });
    mocks.invoke.mockRejectedValue(new Error("closed"));
    expect(() => paletteFocusDiagnostic("x".repeat(600))).not.toThrow();
    await vi.waitFor(() => expect(mocks.invoke).toHaveBeenCalledWith("palette_focus_diagnostic", { line: "x".repeat(500) }));
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
