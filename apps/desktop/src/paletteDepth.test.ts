import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const css = readFileSync(new URL("./App.css", import.meta.url), "utf8");
const nativeSource = readFileSync(new URL("../src-tauri/src/lib.rs", import.meta.url), "utf8");

function rule(selector: string): string {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = css.match(new RegExp(`(?:^|\\n)${escaped}\\s*\\{([^}]+)\\}`, "m"));
  expect(match, selector).not.toBeNull();
  return match![1]!;
}

describe("floating frame depth and document tabs", () => {
  it("gives tabs an accent active state, rounded edges and inactive hover without changing height", () => {
    expect(rule(".document-tab")).toContain("border-radius: 6px 6px 0 0");
    expect(rule(".document-tab")).toContain("inset 0 0 0 1px var(--cd-border-subtle)");
    const active = rule('.document-tab[data-active="true"]');
    expect(active).toContain("background: var(--cd-accent-soft)");
    expect(active).toContain("border-bottom-color: var(--cd-accent)");
    expect(active).toContain("var(--cd-shadow-tab)");
    expect(rule(':root')).toMatch(/--cd-shadow-tab: 0 -1px 3px/);
    expect(rule('.document-tab[data-active="true"] [role="tab"]')).toContain("color: var(--cd-accent-text)");
    expect(rule('.document-tab:not([data-active="true"]):hover')).toContain("background: var(--cd-bg-hover)");
    expect(rule(".document-tab button")).toContain("padding: 5px 8px");
    expect(rule(".document-tab .document-tab-close")).toContain("padding: 5px");
    expect(rule(".document-tab button:focus-visible,\n.document-tab-new:focus-visible")).toContain("outline: 2px solid");
  });

  it("paints the shared edge and highlight inside native and web frames at any size", () => {
    expect(rule(":root")).toContain("--cd-panel-edge-highlight: var(--cd-bg-control-translucent)");
    expect(rule(":root")).toContain("--cd-shadow-edge: inset 0 2px 0 var(--cd-panel-edge-highlight), inset 0 0 0 1px var(--cd-border-strong)");
    const edge = rule(".palette-window-shell::after,\n.plugin-panel-shell::after,\n.web-floating-palette::after");
    expect(edge).toContain("box-shadow: var(--cd-shadow-edge)");
    expect(edge).toContain("inset: 0");
    expect(edge).toContain("pointer-events: none");
    expect(edge).not.toMatch(/(?:width|height|padding|margin):/);
    // The original palette rules remain available for independent resize/orientation work.
    expect(rule(".palette-window-shell")).toContain("box-shadow: none");
    expect(rule(".palette-window-shell > .palette-title,\n.plugin-panel-shell > .plugin-panel-window-title,\n.web-floating-palette > .palette-title"))
      .toContain("linear-gradient(to bottom, var(--cd-bg-panel-raised), var(--cd-bg-panel))");
  });

  it.each(["build_or_show_plugin_panel", "ensure_toolset_window"])(
    "%s enables a native shadow in the shared window builder",
    (name) => {
      // Native window creation requires a GUI event loop; pin the shared builder source here.
      const start = nativeSource.indexOf(`fn ${name}<`);
      expect(start).toBeGreaterThan(-1);
      const body = nativeSource.slice(start, nativeSource.indexOf("\nfn ", start + 1));
      const builder = body.slice(body.indexOf("WebviewWindowBuilder::new"), body.indexOf(".build()"));
      expect(builder).toContain(".decorations(false)");
      expect(builder).toContain(".shadow(true)");
      expect(builder).not.toContain(".shadow(false)");
      expect(builder).not.toMatch(/#\[cfg/);
    }
  );
});
