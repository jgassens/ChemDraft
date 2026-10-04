// @vitest-environment jsdom

import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { ensureOclResources, UnrequestedSmilesRadicalError } from "@chemdraft/ocl-adapter";
import { MainWindow } from "./MainWindow";
import { createPhase4Document } from "./documentWorkflow";

// Exercise the real paste helper and OCL refusal, with RDKit's unavailable-engine fallback.
vi.mock("./rdkitWasmLoader", () => ({ registerRdkitWasmLoader: vi.fn() }));
vi.mock("@chemdraft/rdkit-adapter", () => ({
  generateSmiles2DMolfile: vi.fn().mockRejectedValue(new Error("WASM unavailable"))
}));

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

class TestResizeObserver {
  observe() {}
  unobserve() {}
  disconnect() {}
}

describe("MainWindow SMILES paste failure notices", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeAll(async () => { await ensureOclResources(); });

  beforeEach(async () => {
    vi.stubGlobal("ResizeObserver", TestResizeObserver);
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
    await act(async () => {
      root.render(createElement(MainWindow, {
        initialActiveToolCommandId: "tool.select",
        initialCrosshairsVisible: false,
        initialDocument: createPhase4Document("SMILES paste errors"),
        initialPaletteMode: "hidden",
        initialRulersVisible: false,
        nativePalette: true
      }));
    });
  });

  afterEach(() => {
    act(() => { root.unmount(); });
    container.remove();
    vi.unstubAllGlobals();
  });

  async function paste(text: string, type = "text/plain", statusNeedle = new UnrequestedSmilesRadicalError("n1cccc1").message) {
    const event = new Event("paste", { bubbles: true, cancelable: true });
    Object.defineProperty(event, "clipboardData", {
      value: { types: [type], getData: (requested: string) => requested === type ? text : "" }
    });
    await act(async () => { window.dispatchEvent(event); });
    expect(event.defaultPrevented).toBe(true);
    await vi.waitFor(async () => {
      await act(async () => { await Promise.resolve(); });
      expect(container.querySelector('[role="status"]')?.textContent).toContain(statusNeedle);
    });
    return container.querySelector('[role="status"]')?.textContent;
  }

  it.each(["text/plain", "chemical/x-daylight-smiles"])(
    "shows the specific n1cccc1 refusal pasted as %s, while preserving the input as text",
    async (type) => {
      const status = await paste("n1cccc1", type);
      expect(status).toContain("Clipboard SMILES could not be parsed:");
      expect(status).toContain("pasted as text");
      expect(container.querySelectorAll(".molecule-object")).toHaveLength(0);
      expect(container.querySelectorAll(".text-object")).toHaveLength(1);
      expect(container.querySelector(".text-object")?.textContent).toContain("n1cccc1");
    }
  );

  it.each([
    ["CCO\nn1cccc1\nCCN\nc1ccccc1", "1 item failed", 3],
    ["CCO\nn1cccc1\nc1cccc1\nCCN\nCCCl\nc1ccccc1", "2 items failed", 4]
  ])("reports refused SMILES only as failures while inserting valid entries from %s", async (text, count, molecules) => {
    const status = await paste(text);
    expect(status).toContain(count);
    expect(status).not.toContain("token skipped");
    expect(status).not.toContain("tokens skipped");
    expect(container.querySelectorAll(".molecule-object")).toHaveLength(molecules);
    expect(container.querySelectorAll(".text-object")).toHaveLength(0);
  });

  it("counts C1CC as skipped while placing the other list entries", async () => {
    const status = await paste("CCO\nC1CC\nCCN\nCCC", "text/plain", "1 token skipped");
    expect(status).not.toContain("failed");
    expect(container.querySelectorAll(".molecule-object")).toHaveLength(3);
  });

  it("pastes prose with all-caps acronyms as editable text without a failure notice", async () => {
    const status = await paste("The NMR and HPLC data for THF", "text/plain", "Pasted editable text");
    expect(status).toBe("Pasted editable text");
    expect(status).not.toContain("could not be placed");
    expect(status).not.toContain("failed");
    expect(container.querySelectorAll(".molecule-object")).toHaveLength(0);
    expect(container.querySelectorAll(".text-object")).toHaveLength(1);
  });

  it("reports both failures and the first reason when the whole list falls back to text", async () => {
    const status = await paste("n1cccc1\nc1cccc1");
    expect(status).toBe(
      `Clipboard SMILES list could not be placed; 2 items failed: ${new UnrequestedSmilesRadicalError("n1cccc1").message}; pasted as text`
    );
    expect(container.querySelectorAll(".molecule-object")).toHaveLength(0);
    expect(container.querySelectorAll(".text-object")).toHaveLength(1);
  });
});
