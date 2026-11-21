// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";

// MainWindow is the heavy chunk (editor, engines, plugin runtime). Hold it unresolved so the test
// sees exactly what the Office editor window shows while that chunk is still loading.
const heavy = vi.hoisted(() => {
  let resolve!: () => void;
  const loaded = new Promise<void>(done => { resolve = done; });
  return { loaded, resolve, officeObjectEvaluated: false };
});
vi.mock("./MainWindow", async () => {
  await heavy.loaded;
  return { MainWindow: () => <main data-testid="editor">Editor</main> };
});
vi.mock("./officeObject", () => {
  heavy.officeObjectEvaluated = true;
  return {};
});

import { App } from "./App";

let root: Root | undefined;
let container: HTMLElement | undefined;

afterEach(() => {
  act(() => root?.unmount());
  container?.remove();
  root = undefined;
  container = undefined;
  window.history.replaceState(null, "", "/");
});

describe("Office editor first paint", () => {
  // Runs first: once the deferred MainWindow resolves, React.lazy caches it for later tests.
  it("labels the loading state with a generic container name when none was passed", async () => {
    window.history.replaceState(null, "", "/index.html?officeObject=18");
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
    await act(async () => { root!.render(<App />); });
    expect(container.querySelector(".office-object-loading")?.textContent).toBe("Opening structure from Office…");
  });

  it("renders the themed loading state before the editor modules resolve, then the editor", async () => {
    window.history.replaceState(null, "", "/index.html?officeObject=17&officeApp=Microsoft%20PowerPoint");
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
    await act(async () => { root!.render(<App />); });

    const status = container.querySelector<HTMLElement>(".office-object-loading");
    expect(status?.getAttribute("role")).toBe("status");
    expect(status?.textContent).toBe("Opening structure from Microsoft PowerPoint…");
    expect(status?.style.background).toMatch(/#d8dee3|rgb\(216, 222, 227\)/);
    expect(container.querySelector("[data-testid=editor]")).toBeNull();
    // The loading path never pulls in the Office bridge (or the document workflow it imports).
    expect(heavy.officeObjectEvaluated).toBe(false);

    await act(async () => {
      heavy.resolve();
      await heavy.loaded;
      await new Promise(done => setTimeout(done, 0));
    });
    expect(container.querySelector("[data-testid=editor]")?.textContent).toBe("Editor");
    expect(container.querySelector(".office-object-loading")).toBeNull();
  });
});
