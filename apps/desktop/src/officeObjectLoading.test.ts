import { readdirSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  OFFICE_OBJECT_LOADING_BACKGROUND, OFFICE_OBJECT_LOADING_HTML_CLASS, OFFICE_OBJECT_PAINTED_COMMAND,
  OFFICE_OBJECT_PAINTED_EVENT, officeObjectContainerLabel, officeObjectLoadingMessage, officeObjectLoadingRoute
} from "./officeObjectLoading";

const html = readFileSync(new URL("../index.html", import.meta.url), "utf8");
const css = readFileSync(new URL("./App.css", import.meta.url), "utf8");
const bridge = readFileSync(new URL("../src-tauri/src/office_ole/bridge.rs", import.meta.url), "utf8");
const toolsetEvents = readFileSync(new URL("../src-tauri/src/office_ole/toolset_events.rs", import.meta.url), "utf8");
const capabilityDirectory = new URL("../src-tauri/capabilities/", import.meta.url);

/**
 * Runs index.html's inline loader against a minimal DOM and returns what it painted. With `tauri`,
 * the window carries a recording `invoke` and a manual animation-frame queue (`frame()` runs one).
 */
function runInlineLoader(search: string, tauri = false) {
  const script = /<script>([\s\S]*?)<\/script>/.exec(html)?.[1];
  if (!script) throw new Error("index.html has no inline loader");
  const classes = new Set<string>();
  const root = { children: [] as Array<Record<string, unknown>>, appendChild(node: Record<string, unknown>) { this.children.push(node); } };
  const document = {
    documentElement: { classList: { add: (name: string) => classes.add(name) } },
    createElement: (tag: string) => {
      const attributes: Record<string, string> = {};
      return { tag, attributes, className: "", textContent: "", setAttribute: (key: string, value: string) => { attributes[key] = value; } };
    },
    getElementById: (id: string) => (id === "root" ? root : null)
  };
  const invoked: Array<[string, unknown]> = [];
  let frames: Array<() => void> = [];
  const window: Record<string, unknown> = { location: { search } };
  if (tauri) {
    window.__TAURI_INTERNALS__ = { invoke: (command: string, args: unknown) => {
      invoked.push([command, args]);
      return Promise.reject(new Error("denied")); // a refusal must not surface as an unhandled rejection
    } };
    window.requestAnimationFrame = (callback: () => void) => { frames.push(callback); return frames.length; };
  }
  new Function("window", "document", script)(window, document);
  const frame = () => { const due = frames; frames = []; due.forEach(callback => callback()); };
  return { classes, painted: root.children, invoked, frame, pendingFrames: () => frames.length };
}

const settle = () => new Promise(resolve => setTimeout(resolve, 0));

describe("Office editor loading state", () => {
  it("is themed with the app background the native window paints first", () => {
    expect(css).toContain(`--cd-bg-app: ${OFFICE_OBJECT_LOADING_BACKGROUND};`);
    expect(html).toContain(`html.${OFFICE_OBJECT_LOADING_HTML_CLASS}`);
    expect(html.match(new RegExp(OFFICE_OBJECT_LOADING_BACKGROUND, "g"))?.length).toBeGreaterThanOrEqual(2);
    const [r, g, b] = [1, 3, 5].map(at => OFFICE_OBJECT_LOADING_BACKGROUND.slice(at, at + 2));
    expect(bridge).toContain(`const EDITOR_BACKGROUND: (u8, u8, u8) = (0x${r}, 0x${g}, 0x${b});`);
  });

  it("reads the object and container from the editor URL", () => {
    expect(officeObjectLoadingRoute("?window=palette")).toBeUndefined();
    expect(officeObjectLoadingRoute("?officeObject=")).toBeUndefined();
    expect(officeObjectLoadingRoute("?officeObject=7")).toEqual({ objectId: "7", containerApp: "Office" });
    expect(officeObjectLoadingRoute("?officeObject=7&officeApp=Microsoft%20%20Word"))
      .toEqual({ objectId: "7", containerApp: "Microsoft Word" });
    expect(officeObjectContainerLabel(" A\u0007B\tC ")).toBe("AB C");
    expect([...officeObjectContainerLabel("é".repeat(200))]).toHaveLength(80);
    expect(officeObjectLoadingMessage("Word")).toBe("Opening structure from Word…");
  });

  it("paints the same message from index.html before any module loads, only in Office windows", () => {
    for (const search of ["", "?window=palette&toolsetId=core.main", "?window=dialog&hostId=x"]) {
      expect(runInlineLoader(search)).toMatchObject({ classes: new Set(), painted: [] });
    }
    for (const [search, app] of [
      ["?officeObject=17&officeApp=Microsoft%20PowerPoint", "Microsoft PowerPoint"],
      ["?officeObject=17", undefined],
      ["?officeObject=17&officeApp=%3Cb%3E%07x%3C%2Fb%3E", "<b>x</b>"]
    ] as const) {
      const { classes, painted } = runInlineLoader(search);
      const expected = officeObjectLoadingRoute(search)!.containerApp;
      expect(expected).toBe(app ?? "Office");
      expect(classes).toEqual(new Set([OFFICE_OBJECT_LOADING_HTML_CLASS]));
      // textContent, never innerHTML: the container name is shown as text.
      expect(painted).toMatchObject([{
        tag: "div", className: "office-object-loading", attributes: { role: "status", "aria-live": "polite" },
        textContent: officeObjectLoadingMessage(expected)
      }]);
    }
    expect(html).not.toMatch(/innerHTML/);
  });
  it("reveals the hidden window only after the loading screen has painted, only in Office windows", async () => {
    for (const search of ["", "?officeObject=", "?window=palette&toolsetId=core.main", "?window=dialog&hostId=x"]) {
      const loader = runInlineLoader(search, true);
      expect(loader.pendingFrames()).toBe(0);
      expect(loader.painted).toEqual([]);
      await settle();
      expect(loader.invoked).toEqual([]);
    }
    const loader = runInlineLoader("?officeObject=17&officeApp=Microsoft%20Word", true);
    expect(loader.painted).toHaveLength(1);
    expect(loader.invoked).toEqual([]);
    loader.frame(); // the frame that paints the loading markup
    await settle();
    expect(loader.invoked).toEqual([]);
    loader.frame(); // runs once that frame has reached the screen
    await settle();
    expect(loader.invoked).toEqual([[OFFICE_OBJECT_PAINTED_COMMAND, { event: OFFICE_OBJECT_PAINTED_EVENT }]]);
    expect(loader.pendingFrames()).toBe(0);
    // Outside the desktop app (no Tauri bridge) the loader paints and sends nothing.
    expect(runInlineLoader("?officeObject=17").painted).toHaveLength(1);
  });

  it("lets only the office-object window send the paint signal, and Rust shows the window either way", () => {
    expect(bridge).toContain(`pub(super) const EDITOR_PAINTED: &str = "${OFFICE_OBJECT_PAINTED_EVENT}";`);
    expect(bridge).toContain("const REVEAL_FALLBACK: std::time::Duration = std::time::Duration::from_millis(1500);");
    expect(toolsetEvents).toContain(`pub(crate) fn ${OFFICE_OBJECT_PAINTED_COMMAND}(`);
    expect(toolsetEvents).toMatch(/if event == super::bridge::EDITOR_PAINTED \{\s*return super::bridge::editor_painted\(&window\);/);
    expect(bridge).toMatch(/fn painted_sender\(label: &str\) -> Result<&str, String> \{\s*owner_id\(label\)/);
    // Which windows hold the grant: the editor itself, and its utilities (refused by `painted_sender`).
    const grants = readdirSync(capabilityDirectory).filter(name => name.endsWith(".json")).map(name =>
      JSON.parse(readFileSync(new URL(name, capabilityDirectory), "utf8")) as {
        identifier: string; windows: string[]; platforms?: string[]; permissions: unknown[];
      });
    const holders = grants.filter(grant => grant.permissions.includes(`allow-${OFFICE_OBJECT_PAINTED_COMMAND.replaceAll("_", "-")}`));
    expect(holders.map(grant => [grant.identifier, grant.windows, grant.platforms]).sort()).toEqual([
      ["office-object", ["office-object-*"], ["windows"]],
      ["office-toolset", ["office-utility-office-object-*--toolset-core-*", "office-utility-office-object-*--toolset-popover-*"], ["windows"]]
    ]);
  });
});
