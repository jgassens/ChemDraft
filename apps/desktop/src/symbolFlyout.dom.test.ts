// @vitest-environment jsdom
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterEach, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { createElement } from "react";
import { ToolPalette } from "./ToolPalette";
import { getToolsetCommandGroups, getToolsetItemGroups } from "./toolsets";

afterEach(() => {
  document.head.innerHTML = "";
  document.body.innerHTML = "";
});

it("keeps all six Symbol previews visible while hiding only grid labels", () => {
  const style = document.createElement("style");
  style.textContent = readFileSync(resolve("apps/desktop/src/App.css"), "utf8");
  document.head.append(style);
  document.body.innerHTML = renderToStaticMarkup(createElement(ToolPalette, {
    groups: getToolsetCommandGroups("core.main"),
    itemGroups: getToolsetItemGroups("core.main"),
    activeTool: "tool.symbol.degree",
    onInvoke: () => undefined
  }));
  const glyphs = [...document.querySelectorAll<HTMLElement>(
    '.toolbar-command-flyout-menu[data-toolbar-command-grid-columns] button[data-command-id^="tool.symbol."] .symbol-tool-glyph'
  )];
  expect(glyphs.map((glyph) => glyph.textContent)).toEqual(["°", "±", "Å", "Δ", "·", "′"]);
  for (const glyph of glyphs) {
    const computed = getComputedStyle(glyph);
    expect(computed.position).not.toBe("absolute");
    expect(computed.clipPath).not.toBe("inset(50%)");
    expect(computed.height).toBe("17px");
    const label = glyph.parentElement!.querySelector<HTMLElement>(".toolbar-command-label")!;
    expect(getComputedStyle(label).clipPath).toBe("inset(50%)");
  }
});
