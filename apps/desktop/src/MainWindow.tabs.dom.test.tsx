// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MainWindow } from "./MainWindow";
import { createPhase4Document } from "./documentWorkflow";
import { DOM_COMMAND_EVENT } from "./window-manager";

vi.mock("./rdkitWasmLoader", () => ({ registerRdkitWasmLoader: vi.fn() }));
(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

describe("independent canvas tabs", () => {
  let container: HTMLDivElement;
  let root: Root;
  beforeEach(async () => {
    vi.stubGlobal("ResizeObserver", class { observe() {} unobserve() {} disconnect() {} });
    vi.spyOn(window, "focus").mockImplementation(() => {});
    Object.defineProperty(HTMLDialogElement.prototype, "showModal", {
      configurable: true, value: function (this: HTMLDialogElement) { this.open = true; }
    });
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
    await act(async () => {
      root.render(createElement(MainWindow, {
        initialDocument: createPhase4Document("First canvas"),
        initialActiveToolCommandId: "tool.select", initialPaletteMode: "hidden",
        initialCrosshairsVisible: false, initialRulersVisible: false, nativePalette: true
      }));
    });
  });
  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });
  async function click(selector: string) {
    await act(async () => { container.querySelector<HTMLButtonElement>(selector)!.click(); });
  }
  async function pasteText(text: string) {
    const event = new Event("paste", { bubbles: true, cancelable: true });
    Object.defineProperty(event, "clipboardData", {
      value: { types: ["text/plain"], getData: () => text }
    });
    await act(async () => { window.dispatchEvent(event); });
  }
  it("keeps a drawing and its undo history when another canvas is created", async () => {
    await pasteText("First canvas note");
    expect(container.querySelectorAll(".text-object")).toHaveLength(1);
    await click('[aria-label="New canvas tab"]');
    expect(container.querySelectorAll('[role="tab"]')).toHaveLength(2);
    expect(container.querySelectorAll(".text-object")).toHaveLength(0);
    await pasteText("Second canvas note");
    await click('[role="tab"]:first-child');
    expect(container.querySelector(".text-object")?.textContent).toContain("First canvas note");
    expect(container.querySelector("main")?.getAttribute("data-can-undo")).toBe("true");
    await act(async () => {
      window.dispatchEvent(new CustomEvent(DOM_COMMAND_EVENT, { detail: { commandId: "edit.undo" } }));
    });
    expect(container.querySelectorAll(".text-object")).toHaveLength(0);
    await click('.canvas-tab:nth-child(2) [role="tab"]');
    expect(container.querySelector(".text-object")?.textContent).toContain("Second canvas note");
  });
  it("prompts before closing a dirty tab and leaves the other drawing intact", async () => {
    await pasteText("Keep this drawing");
    await click('[aria-label="New canvas tab"]');
    await pasteText("Discard this drawing");
    await click('[aria-label="Close canvas tab"]');
    expect(container.querySelector("dialog")?.textContent).toContain("Save changes before closing?");
    const discard = Array.from(container.querySelectorAll<HTMLButtonElement>("dialog button"))
      .find((button) => button.textContent === "Discard")!;
    await act(async () => discard.click());
    expect(container.querySelectorAll('[role="tab"]')).toHaveLength(1);
    expect(container.querySelector(".text-object")?.textContent).toContain("Keep this drawing");
  });
});
