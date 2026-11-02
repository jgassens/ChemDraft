import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const css = readFileSync(new URL("./App.css", import.meta.url), "utf8");
const native = readFileSync(new URL("../src-tauri/src/lib.rs", import.meta.url), "utf8");

function cssRule(selector: string, first = false): string {
  const rules = [...css.replace(/\/\*[\s\S]*?\*\//g, "").matchAll(/([^{}]+)\{([^{}]+)\}/g)];
  const rule = (first ? rules : rules.reverse())
    .find((match) => match[1]!.split(",").some((entry) => entry.trim() === selector));
  expect(rule, selector).toBeDefined();
  return rule![2]!;
}

function nativeFunction(name: string): string {
  const start = native.indexOf(`fn ${name}(`);
  expect(start, name).toBeGreaterThan(-1);
  return native.slice(start, native.indexOf("\n}\n", start) + 2);
}

describe("native palette tooltip suppression", () => {
  // These checks pin the native wiring; the Rust unit test exercises visibility transitions.
  // Both platforms must use the guard before reaching their separate reveal implementations.
  it("checks actual popover visibility before positioning or showing a delayed tooltip", () => {
    const show = nativeFunction("show_toolset_tooltip_window");
    const guard = show.indexOf("toolset_tooltip_suppressed(");
    expect(guard).toBeGreaterThan(-1);
    expect(guard).toBeLessThan(show.indexOf("set_window_global_logical_position"));
    expect(guard).toBeLessThan(show.indexOf('#[cfg(target_os = "macos")]'));
    expect(show.slice(guard, show.indexOf("let Some(window)"))).toContain("return Ok(())");
    expect(show).toContain("app.webview_windows()");
    expect(show).toContain("window.is_visible().unwrap_or(false)");
    expect(show).not.toContain('.filter(|(label, _)| label.starts_with("toolset-popover-"))');
  });

  it("hides the existing tooltip before either platform reveals a popover", () => {
    const show = nativeFunction("show_toolset_popover_window");
    const hide = show.indexOf("hide_toolset_tooltip_window(");
    expect(hide).toBeGreaterThan(-1);
    expect(show).toContain("let _ = hide_toolset_tooltip_window(window.app_handle().clone());");
    expect(hide).toBeLessThan(show.indexOf('#[cfg(target_os = "macos")]'));
    expect(show.slice(0, hide)).not.toContain("window.show()");
  });
});

it("gives inspector select menus light opaque options without restyling closed controls", () => {
  expect(cssRule(".molecule-inspector-field select").trim()).toBe("color-scheme: light;");
  const options = cssRule(".molecule-inspector-field select option");
  expect(options).toBe(cssRule(".toolbar-select option"));
  expect(options).toContain("background-color: var(--cd-bg-control);");
  expect(options).toContain("color: var(--cd-text-primary);");
  const closed = cssRule(".molecule-inspector-field input");
  expect(closed).toContain("background: var(--cd-bg);");
  expect(closed).toContain("border: 1px solid var(--cd-border);");
  expect(closed).toContain("color: var(--cd-text);");
});

it("uses the light toolbar theme for native select menus, including their opaque options", () => {
  expect(cssRule(".toolbar-select")).toContain("color-scheme: light;");
  expect(cssRule(".toolbar-select", true)).toContain("var(--cd-bg-control)");
  expect(cssRule(".toolbar-select", true)).toContain("color: var(--cd-text-primary);");
  const options = cssRule(".toolbar-select option");
  expect(options).toContain("background-color: var(--cd-bg-control);");
  expect(options).toContain("color: var(--cd-text-primary);");
  expect(cssRule(":root")).toContain("--cd-bg-control: #ffffff;");
});
