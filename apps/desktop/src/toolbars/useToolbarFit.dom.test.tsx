// @vitest-environment jsdom

import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import { useToolbarFit, type ToolbarFitMeasurement } from "./useToolbarFit";
import { toolbarOverflowPrefix } from "./toolbarFit";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
afterEach(() => { document.body.innerHTML = ""; vi.restoreAllMocks(); });

it.each(["horizontal", "vertical"] as const)("includes both padded/bordered ends in a folded %s group", async orientation => {
  const viewport = document.createElement("aside");
  viewport.innerHTML = `<div class="toolbar-natural-size"><aside class="tool-palette"><div class="tool-group" data-toolbar-group-id="orbitals" style="padding: 4px 8px; border: 1px solid"><span></span></div></aside></div><span class="toolbar-overflow-measure"></span>`;
  const host = document.createElement("div");
  document.body.append(viewport, host);
  const rect = (width: number, height: number, x = 0, y = 0) => ({ width, height, x, y,
    left: x, top: y, right: x + width, bottom: y + height, toJSON() {} });
  vi.spyOn(viewport, "getBoundingClientRect").mockReturnValue(rect(200, 200));
  const group = viewport.querySelector<HTMLElement>(".tool-group")!;
  vi.spyOn(group, "getBoundingClientRect").mockReturnValue(rect(100, 100));
  vi.spyOn(group.firstElementChild!, "getBoundingClientRect").mockReturnValue(rect(24, 24, 9, 5));
  vi.spyOn(viewport.querySelector<HTMLElement>(".toolbar-overflow-measure")!, "getBoundingClientRect").mockReturnValue(rect(24, 24));
  let measured: ToolbarFitMeasurement | undefined;
  function Probe() {
    measured = useToolbarFit({ current: viewport }, true, orientation, []);
    return null;
  }
  const root = createRoot(host);
  await act(async () => root.render(<Probe />));
  const foldedLength = orientation === "horizontal" ? 42 : 34;
  expect(measured?.groups[0]).toMatchObject({ foldedLength, prefixes: [foldedLength] });
  const folded = [{ ...measured!.groups[0], length: foldedLength, prefixes: [foldedLength] },
    { length: 100, prefixes: [100], foldedLength: 24 }];
  // At the exact shrink boundary the fold and More tools fit; one pixel less must overflow it.
  expect(toolbarOverflowPrefix(folded, foldedLength + 24, 0, 24)).toBe(1);
  expect(toolbarOverflowPrefix(folded, foldedLength + 23, 0, 24)).toBe(0);
  await act(async () => root.unmount());
});
