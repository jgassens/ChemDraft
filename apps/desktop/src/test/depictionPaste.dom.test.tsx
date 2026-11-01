// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { MainWindow } from "../MainWindow";
import { createPhase4Document } from "../documentWorkflow";
import { depictSmilesOffThread } from "../depiction2d/client";

// These cases exercise generic depiction; template identity/layout has its own real-engine tests.
vi.mock("../structureTemplateInsertion", () => ({ templateMoleculeForSmiles: vi.fn().mockResolvedValue(undefined) }));
vi.mock("../depiction2d/client", () => ({ depictSmilesOffThread: vi.fn() }));
(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let container: HTMLDivElement;
let root: Root;
beforeEach(() => {
  vi.stubGlobal("ResizeObserver", class { observe() {} unobserve() {} disconnect() {} });
  container = document.createElement("div"); document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount()); container.remove(); vi.unstubAllGlobals(); vi.clearAllMocks();
});

it.each(["paste", "close"])("cancels remaining SMILES-list paste entries on a new %s", async (action) => {
  let signal: AbortSignal | undefined;
  vi.mocked(depictSmilesOffThread).mockImplementationOnce(async (_smiles, options) => {
    signal = options?.signal;
    await new Promise<void>(resolve => signal?.addEventListener("abort", () => resolve(), { once: true }));
    throw Object.assign(new Error("cancelled"), { name: "AbortError" });
  });
  await act(async () => {
    root.render(createElement(MainWindow, { initialDocument: createPhase4Document("Paste cancellation"),
      initialPaletteMode: "hidden", initialRulersVisible: false, nativePalette: true }));
  });
  const paste = (text: string) => {
    const event = new Event("paste", { bubbles: true, cancelable: true });
    Object.defineProperty(event, "clipboardData", { value: {
      types: ["text/plain"], getData: (type: string) => type === "text/plain" ? text : ""
    } });
    window.dispatchEvent(event);
  };
  await act(async () => { paste("CCO\nCCN\nCCC"); });
  expect(signal?.aborted).toBe(false);
  await act(async () => {
    if (action === "paste") paste("hello world");
    else {
      const close = container.querySelector<HTMLButtonElement>('.document-tab button[aria-label]');
      expect(close).not.toBeNull();
      close!.click();
    }
  });
  expect(signal?.aborted).toBe(true);
  expect(depictSmilesOffThread).toHaveBeenCalledTimes(1);
  expect(container.querySelectorAll(".molecule-object")).toHaveLength(0);
  expect(container.querySelector('[role="status"]')?.textContent).not.toContain("list could not be placed");
});

it.each([
  ["CCO", "2D depiction worker exited (1)."],
  ["CCO\n", "The 2D depiction worker failed to load."],
  ["CCO", "2D depiction exceeded its 2000 ms layout deadline before a standard layout was available."]
])("paste of %j surfaces the specific depiction failure and inserts no text", async (text, reason) => {
  vi.mocked(depictSmilesOffThread).mockRejectedValueOnce(new Error(reason));
  await act(async () => {
    root.render(createElement(MainWindow, { initialDocument: createPhase4Document("Paste failure"),
      initialPaletteMode: "hidden", initialRulersVisible: false, nativePalette: true }));
  });
  const event = new Event("paste", { bubbles: true, cancelable: true });
  Object.defineProperty(event, "clipboardData", { value: {
    types: ["text/plain"], getData: (type: string) => type === "text/plain" ? text : ""
  } });
  await act(async () => { window.dispatchEvent(event); });
  expect(container.querySelector('[role="status"]')?.textContent).toContain(`Clipboard SMILES could not be placed: ${reason}`);
  expect(container.querySelectorAll(".text-object")).toHaveLength(0);
  expect(container.querySelectorAll(".molecule-object")).toHaveLength(0);
});
