import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  OFFICE_OBJECT_LOADING_BACKGROUND, OFFICE_OBJECT_LOADING_HTML_CLASS, officeObjectContainerLabel,
  officeObjectLoadingMessage, officeObjectLoadingRoute
} from "./officeObjectLoading";

const html = readFileSync(new URL("../index.html", import.meta.url), "utf8");
const css = readFileSync(new URL("./App.css", import.meta.url), "utf8");
const bridge = readFileSync(new URL("../src-tauri/src/office_ole/bridge.rs", import.meta.url), "utf8");

/** Runs index.html's inline loader against a minimal DOM and returns what it painted. */
function runInlineLoader(search: string) {
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
  new Function("window", "document", script)({ location: { search } }, document);
  return { classes, painted: root.children };
}

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
      expect(runInlineLoader(search)).toEqual({ classes: new Set(), painted: [] });
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
});
