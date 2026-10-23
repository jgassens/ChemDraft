// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { JournalPresetForm, journalFontWarning } from "./JournalPresetForm";

let root: Root, container: HTMLDivElement;
beforeEach(() => { vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true); vi.useFakeTimers(); container = document.createElement("div"); document.body.append(container); root = createRoot(container); });
afterEach(() => { act(() => root.unmount()); container.remove(); vi.useRealTimers(); vi.unstubAllGlobals(); });
const image = { url: "data:image/svg+xml;base64,PHN2Zy8+", kind: "image" as const, width: 100, height: 100, warnings: ["Partial coverage"] };
const setup = (platform: "macos" | "windows" = "macos", renderPreview = vi.fn(async () => image)) => {
  const apply = vi.fn(), cancel = vi.fn(), ready = vi.fn();
  act(() => root.render(createElement(JournalPresetForm, { title: "My reaction", selectionCount: 2, platform, renderPreview, onReady: ready, onApply: apply, onCancel: cancel })));
  return { apply, cancel, renderPreview, ready };
};
const flush = () => act(async () => { await vi.advanceTimersByTimeAsync(200); });
const button = (name: string) => [...container.querySelectorAll("button")].find(button => button.textContent === name)!;
const changeSelect = (label: string, value: string) => act(() => {
  const select = [...container.querySelectorAll("label")].find(labelNode => labelNode.textContent?.startsWith(label))!.querySelector("select")!;
  select.value = value; select.dispatchEvent(new Event("change", { bubbles: true }));
});
describe.each(["macos", "windows"] as const)("journal form on %s", platform => {
  it("waits for the exact draft preview, then applies the selected scope once per submission", async () => {
    const h = setup(platform); expect(button("Apply").disabled).toBe(true); expect(h.ready).toHaveBeenCalledOnce();
    expect(document.activeElement).toBe(container.querySelector("input"));
    await flush(); expect(button("Apply").disabled).toBe(false);
    changeSelect("Figure type", "double-column"); expect(button("Apply").disabled).toBe(true);
    await flush(); act(() => container.querySelector("form")!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })));
    expect(h.apply).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ profileId: "jacs", figureType: "double-column", scope: "selection", resizeBonds: false }));
  });
  it("supports cancel, reset, custom settings, reload protection and platform close shortcuts", async () => {
    const h = setup(platform); await flush();
    act(() => button("Custom preset").click()); await flush();
    expect(container.textContent).toContain("Custom — no journal verification");
    act(() => button("Reset").click()); expect(container.textContent).toContain("Journal of the American Chemical Society");
    const form = container.querySelector("form")!;
    for (const init of [{ key: "Escape" }, { key: "w", metaKey: platform === "macos", ctrlKey: platform === "windows" }]) {
      act(() => form.dispatchEvent(new KeyboardEvent("keydown", { ...init, bubbles: true, cancelable: true })));
    }
    expect(h.cancel).toHaveBeenCalledTimes(2); expect(h.apply).not.toHaveBeenCalled();
    const reload = new KeyboardEvent("keydown", { key: "F5", bubbles: true, cancelable: true });
    act(() => form.dispatchEvent(reload)); expect(reload.defaultPrevented).toBe(true);
  });
});
it("ignores an obsolete preview response and reports current preview failures without applying", async () => {
  let finish!: (value: typeof image) => void;
  const renderer = vi.fn(() => new Promise<typeof image>(resolve => { finish = resolve; }));
  const h = setup("windows", renderer); await flush(); const first = finish;
  changeSelect("Figure type", "double-column"); await flush();
  await act(async () => first(image)); expect(button("Apply").disabled).toBe(true);
  await act(async () => finish(image)); expect(button("Apply").disabled).toBe(false);
  expect(h.apply).not.toHaveBeenCalled();
});
it("warns for missing requested fonts while allowing an installed alternative", () => {
  expect(journalFontWarning("Arial, Helvetica, sans-serif", () => false)).toMatch(/fallback font/);
  expect(journalFontWarning("Arial, Helvetica, sans-serif", font => font.includes("Helvetica"))).toBeUndefined();
});
it("loads the optional pack on request and enables sourced Cell and omits unverified journals", async () => {
  const h = setup(); await flush();
  const { loadJournalStylePack } = await import("./catalog");
  await act(async () => { button("Load additional journal pack (15 journals)").click(); await loadJournalStylePack(); });
  expect(container.textContent).toContain("20 journals available");
  expect(button("Additional journal pack loaded").disabled).toBe(true);
  changeSelect("Journal", "cell"); await flush();
  expect(button("Apply").disabled).toBe(false);
  expect(container.textContent).toContain("Font size: 7 pt");
  expect(container.textContent).toContain("Target bond length: 0.45 cm");
  changeSelect("Figure type", "commentary-single"); await flush();
  expect(container.textContent).toContain("55.0 mm wide");
  const journalOptions = [...container.querySelector('select[aria-label="Journal"]')!.querySelectorAll("option")].map(option => option.value);
  for (const id of ["chemical-engineering-journal", "journal-of-hazardous-materials", "applied-catalysis-b", "nano-energy", "biological-macromolecules"]) expect(journalOptions).not.toContain(id);
  changeSelect("Journal", "advanced-materials"); await flush();
  expect(button("Apply").disabled).toBe(false);
  expect(container.textContent).toContain("Bond width: 0.75 pt");
});
