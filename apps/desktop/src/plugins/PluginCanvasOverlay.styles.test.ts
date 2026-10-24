import { readFileSync } from "node:fs";
import { expect, it } from "vitest";

const css = readFileSync(new URL("../App.css", import.meta.url), "utf8");
const rule = (selector: string) => css.slice(css.indexOf(`${selector} {`)).split("}")[0]!;

it("keeps a visible content scrollbar on WebKit and WebView2, with fixed primary actions", () => {
  expect(rule(".plugin-canvas-overlay-content")).toContain("overflow-y: scroll");
  expect(rule(".plugin-canvas-overlay-content")).toContain("scrollbar-gutter: stable");
  expect(rule(".plugin-canvas-overlay-content::-webkit-scrollbar")).toContain("width: 8px");
  expect(rule(".plugin-canvas-overlay-content::-webkit-scrollbar-thumb")).toContain("background:");
  expect(rule(".plugin-canvas-overlay-primary-actions")).toContain("flex-shrink: 0");
});
