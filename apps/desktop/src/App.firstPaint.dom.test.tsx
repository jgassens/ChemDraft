// @vitest-environment jsdom
import { act, createElement, StrictMode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";

// Each window is a stub that records its render, so the test can tell the acknowledgement came
// after the window's first render, not before it.
const page = vi.hoisted(() => ({
  ack: vi.fn(),
  rendered: [] as string[]
}));
vi.mock("./firstPaint", () => ({ ackFirstPaint: page.ack }));
vi.mock("./PaletteWindow", () => ({
  PaletteWindow: () => { page.rendered.push("palette"); return createElement("p", null, "palette"); }
}));
vi.mock("./PalettePopoverWindow", () => ({
  PalettePopoverWindow: () => { page.rendered.push("popover"); return createElement("p", null, "popover"); }
}));
vi.mock("./PaletteTooltipWindow", () => ({
  PaletteTooltipWindow: () => { page.rendered.push("tooltip"); return createElement("p", null, "tooltip"); }
}));
vi.mock("./MainWindow", () => ({ MainWindow: () => createElement("p", null, "main") }));

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement | undefined;
let root: Root | undefined;

/** Loads a fresh App (and so a fresh once-per-page guard) for `search`, as main.tsx mounts it. */
async function mountPage(search: string): Promise<HTMLDivElement> {
  window.history.replaceState(null, "", `/${search}`);
  vi.resetModules();
  page.ack.mockReset();
  page.ack.mockImplementation(() => {
    // The window's content is in the DOM when the page acknowledges.
    expect(container?.textContent).not.toBe("");
    return Promise.resolve();
  });
  page.rendered.length = 0;
  const { App } = await import("./App");
  container = document.createElement("div");
  document.body.append(container);
  const mounted = createRoot(container);
  root = mounted;
  await act(async () => mounted.render(createElement(StrictMode, null, createElement(App))));
  // Let the lazy window module resolve and its boundary commit.
  for (let attempt = 0; attempt < 20 && container.textContent === ""; attempt += 1) {
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 0)); });
  }
  return container;
}

afterEach(async () => {
  const mounted = root;
  if (mounted) await act(async () => mounted.unmount());
  container?.remove();
  root = undefined;
  container = undefined;
});

describe("first-paint acknowledgement from the palette page entry points", () => {
  for (const [name, search, text] of [
    ["toolset palette", "?window=toolset&toolsetId=core.main&resizable=false", "palette"],
    ["palette popover", "?window=toolsetPopover&toolsetId=core.art&kind=artColor&prewarm=1", "popover"],
    ["palette tooltip", "?window=toolsetTooltip", "tooltip"]
  ] as const) {
    it(`acks once after the ${name}'s first render, even under StrictMode`, async () => {
      const shown = await mountPage(search);
      expect(shown.textContent).toBe(text);
      expect(page.rendered).toContain(text);
      expect(page.ack).toHaveBeenCalledTimes(1);
      // Called with no environment, so ackFirstPaint reads the real page and invokes the command.
      expect(page.ack.mock.calls[0]).toEqual([]);
      // A re-render does not acknowledge again.
      await act(async () => root!.render(createElement(StrictMode, null, createElement((await import("./App")).App))));
      expect(page.ack).toHaveBeenCalledTimes(1);
    });
  }

  it("does not ack from the document window", async () => {
    const shown = await mountPage("");
    expect(shown.textContent).toBe("main");
    expect(page.ack).not.toHaveBeenCalled();
  });
});
