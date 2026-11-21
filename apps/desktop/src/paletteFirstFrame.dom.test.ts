// @vitest-environment jsdom
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { TOOLSET_POPOVER_WINDOW_KIND, TOOLSET_TOOLTIP_WINDOW_KIND } from "./window-manager";

const here = dirname(fileURLToPath(import.meta.url));
const html = readFileSync(join(here, "../index.html"), "utf8");
const css = readFileSync(join(here, "App.css"), "utf8");
const lib = readFileSync(join(here, "../src-tauri/src/lib.rs"), "utf8");

/** The classic inline script in index.html's head, which runs before any stylesheet or module. */
function firstFrameScript(): string {
  const head = html.slice(0, html.indexOf("</head>"));
  const match = /<script>([\s\S]*?)<\/script>/.exec(head);
  expect(match, "an inline classic script in <head>").not.toBeNull();
  return match![1]!;
}

/** Runs the head script as the page `search` would, and returns the attribute it left. */
function firstFrameFor(search: string): string | null {
  window.history.replaceState(null, "", `/${search}`);
  document.documentElement.removeAttribute("data-cd-first-frame");
  new Function(firstFrameScript())();
  return document.documentElement.getAttribute("data-cd-first-frame");
}

function rule(selector: string): string {
  const start = css.indexOf(`${selector} {`);
  expect(start, selector).toBeGreaterThanOrEqual(0);
  return css.slice(start, css.indexOf("}", start));
}

afterEach(() => {
  window.history.replaceState(null, "", "/");
  document.documentElement.removeAttribute("data-cd-first-frame");
});

describe("palette pages paint their panel background from the first frame", () => {
  it("marks palette, popover and tooltip pages before React mounts, and nothing else", () => {
    expect(firstFrameFor("?window=toolset&toolsetId=core.main&resizable=false")).toBe("panel");
    expect(firstFrameFor("?window=tool-palette")).toBe("panel");
    expect(firstFrameFor(`?window=${TOOLSET_POPOVER_WINDOW_KIND}&toolsetId=core.art&kind=artColor&prewarm=1`)).toBe("panel");
    expect(firstFrameFor(`?window=${TOOLSET_TOOLTIP_WINDOW_KIND}`)).toBe("tooltip");
    // The document window and every other window keep their own background.
    for (const search of ["", "?window=preferences", "?window=pluginPanel&panelId=x", "?window=dialog&hostId=x",
      "?window=fileWarnings", "?window=constructor", "?window=__proto__"]) {
      expect(firstFrameFor(search), search).toBeNull();
    }
  });

  it("runs ahead of the app's stylesheet and module, as a classic script", () => {
    const script = html.indexOf("<script>");
    expect(script).toBeGreaterThan(0);
    expect(script).toBeLessThan(html.indexOf("</head>"));
    expect(script).toBeLessThan(html.indexOf('<script type="module"'));
  });

  it("uses the window kinds the native builders load", () => {
    expect(lib).toContain('format!("/?window=toolset&toolsetId={toolset_id}&resizable={resizable}")');
    expect(lib).toContain('format!("/?window=toolsetPopover&toolsetId={toolset_id}&kind={kind}{prewarm_param}")');
    expect(lib).toContain('WebviewUrl::App("/?window=toolsetTooltip".into())');
  });

  it("colors the first frame with the same tokens the mounted pages use, never a literal", () => {
    expect(rule('html[data-cd-first-frame="panel"]')).toContain("background: var(--cd-bg-panel);");
    expect(rule("html.palette-window-html")).toContain("background: var(--cd-bg-panel);");
    expect(rule('html[data-cd-first-frame="tooltip"]')).toContain("background: var(--cd-bg-control-opaque);");
    for (const selector of ['html[data-cd-first-frame="panel"]', 'html[data-cd-first-frame="tooltip"]']) {
      expect(rule(selector)).not.toMatch(/#[0-9a-f]{3,8}\b|rgb\(/i);
    }
    // The app has one, light, set of tokens: there is no dark theme or theme setting to follow.
    expect(css).not.toMatch(/prefers-color-scheme|data-theme/);
    // The document window's background is unchanged.
    expect(rule(":root")).toContain("background: var(--cd-bg-app);");
  });
});
