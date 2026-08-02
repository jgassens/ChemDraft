import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * Positive cross-check for the CORE Tauri permissions this app's own code depends on.
 *
 * Tauri v2's ACL is deny-by-default, and a denied `invoke` rejects into JS where the result is
 * usually a swallowed promise — so a missing grant does not fail loudly, it makes a feature quietly
 * stop working, often intermittently. The Rust-side test
 * (`registered_commands_have_permissions_and_capability_grants`) already guards the app's OWN
 * commands, and the capability file is read elsewhere only to assert what is *absent*. Neither
 * notices if a `core:*` grant disappears.
 *
 * That is not hypothetical: the toolset popover could not reveal itself because
 * `core:window:allow-show` had never been granted, which presented as flyouts that opened blank.
 * Each entry below pairs the API a source file actually calls with the grant that call needs, and
 * the grant is only required when the call is really present — so removing the feature removes the
 * requirement, but keeping the feature without the grant fails here.
 */
describe("core capability grants", () => {
  const capabilities = readFileSync(
    new URL("../src-tauri/capabilities/default.json", import.meta.url),
    "utf8"
  );

  function sourceFiles(): string[] {
    const root = new URL(".", import.meta.url).pathname;
    const found: string[] = [];
    const walk = (dir: string): void => {
      for (const entry of readdirSync(dir)) {
        const path = join(dir, entry);
        if (statSync(path).isDirectory()) {
          if (entry !== "node_modules") {
            walk(path);
          }
        } else if (/\.tsx?$/.test(entry) && !/\.test\.tsx?$/.test(entry)) {
          found.push(readFileSync(path, "utf8"));
        }
      }
    };
    walk(root);
    return found;
  }

  const sources = sourceFiles().join("\n");

  const required: ReadonlyArray<{ call: RegExp; permission: string; why: string }> = [
    {
      call: /\.show\(\)/,
      permission: "core:window:allow-show",
      why: "a window that cannot show itself opens blank — this is how the popover reveal broke"
    },
    { call: /\.hide\(\)/, permission: "core:window:allow-hide", why: "windows are hidden, not closed, when dismissed" },
    { call: /\.setPosition\(/, permission: "core:window:allow-set-position", why: "palettes and popovers are positioned natively" },
    { call: /\.setSize\(/, permission: "core:window:allow-set-size", why: "popovers are sized before they are shown" },
    { call: /\.outerPosition\(/, permission: "core:window:allow-outer-position", why: "anchor geometry is read natively" },
    { call: /\.scaleFactor\(/, permission: "core:window:allow-scale-factor", why: "mixed-DPI placement needs the scale factor" },
    { call: /\.setFocus\(/, permission: "core:window:allow-set-focus", why: "focus is handed back to the document window" },
    { call: /startDragging\(/, permission: "core:window:allow-start-dragging", why: "palette title bars drag their own window" }
  ];

  it("grants every core window permission the desktop source actually calls", () => {
    // Sanity: the scan must see real source, or every case below passes vacuously.
    expect(sources.length).toBeGreaterThan(100_000);

    const missing = required
      .filter((entry) => entry.call.test(sources))
      .filter((entry) => !capabilities.includes(`"${entry.permission}"`))
      .map((entry) => `${entry.permission} — ${entry.why}`);

    expect(missing).toEqual([]);
  });

  it("still grants the popover reveal that this branch had to learn about", () => {
    // Pinned by name as well as by scan: `show()` is common enough that a future refactor could
    // rename it out of the pattern above and quietly take the guard with it.
    expect(capabilities).toContain('"core:window:allow-show"');
  });
});
