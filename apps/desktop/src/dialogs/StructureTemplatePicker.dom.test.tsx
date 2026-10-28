// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { structureTemplates } from "@chemdraft/template-library";
import { StructureTemplatePicker } from "./StructureTemplatePicker";
const engines = vi.hoisted(() => ({ rdkit: vi.fn(), ocl: vi.fn() }));
vi.mock("@chemdraft/rdkit-adapter", () => { engines.rdkit(); throw new Error("Picker loaded RDKit"); });
vi.mock("@chemdraft/ocl-adapter", () => { engines.ocl(); throw new Error("Picker loaded OCL"); });
let root: Root, container: HTMLDivElement;
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  container = document.createElement("div"); document.body.append(container); root = createRoot(container);
});
afterEach(() => { act(() => root.unmount()); container.remove(); vi.unstubAllGlobals(); });
describe.each(["macos", "windows"] as const)("Templates keyboard on %s", platform => {
  it("focuses search, navigates tiles, inserts once on Enter/click, and closes", async () => {
    const insert = vi.fn(), close = vi.fn(), ready = vi.fn();
    await act(async () => root.render(createElement(StructureTemplatePicker, { title: "Drawing A", templateIds: structureTemplates.slice(0, 4).map(template => template.id), onInsert: insert, onClose: close, onReady: ready, platform })));
    const input = container.querySelector("input")!;
    expect(document.activeElement).toBe(input); expect(ready).toHaveBeenCalledOnce();
    const tiles = [...container.querySelectorAll<HTMLButtonElement>("[data-template-id]")];
    const press = (key: string, extra: KeyboardEventInit = {}) => act(() => document.activeElement!.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true, ...extra })));
    press("ArrowDown"); expect(document.activeElement).toBe(tiles[0]);
    press("ArrowRight"); expect(document.activeElement).toBe(tiles[1]);
    press("ArrowDown"); expect(document.activeElement).toBe(tiles[3]);
    press("ArrowUp"); press("ArrowLeft"); expect(document.activeElement).toBe(tiles[0]);
    press("End"); expect(document.activeElement).toBe(tiles[3]);
    press("Home"); expect(document.activeElement).toBe(tiles[0]);
    press("Enter", { isComposing: true }); expect(insert).not.toHaveBeenCalled();
    press("Enter"); expect(insert).toHaveBeenCalledExactlyOnceWith(tiles[0]!.dataset.templateId);
    act(() => tiles[0]!.click()); expect(insert).toHaveBeenCalledTimes(2);
    expect(container.querySelector('[role="dialog"]')).not.toBeNull();
    expect(tiles[0]!.getAttribute("aria-describedby")).toBeTruthy();
    expect(tiles[0]!.title).toContain(structureTemplates[0]!.formula);
    const svg = decodeURIComponent(container.querySelector("img")!.src.split(",").slice(1).join(","));
    expect(svg).toContain("<svg"); expect(svg).toContain('data-object-id=');
    expect(engines.rdkit).not.toHaveBeenCalled(); expect(engines.ocl).not.toHaveBeenCalled();
    press("Escape"); press("w", platform === "macos" ? { metaKey: true } : { ctrlKey: true });
    expect(close).toHaveBeenCalledTimes(2);
  });
});
it("filters while retaining search focus and exposes the empty state", async () => {
  await act(async () => root.render(createElement(StructureTemplatePicker, { title: "A", templateIds: structureTemplates.map(template => template.id), onInsert: vi.fn(), onClose: vi.fn() })));
  const input = container.querySelector("input")!;
  const search = async (query: string) => act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, query);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
  await search("β-CD"); expect(container.querySelectorAll("[data-template-id]")).toHaveLength(1);
  expect(document.activeElement).toBe(input);
  await search("");
  const lastCrown = structureTemplates.filter(template => template.family === "crown-ethers-cryptands").at(-1)!;
  const firstCyclodextrin = structureTemplates.find(template => template.family === "cyclodextrins")!;
  act(() => container.querySelector<HTMLButtonElement>(`[data-template-id="${lastCrown.id}"]`)!.focus());
  act(() => document.activeElement!.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true, cancelable: true })));
  expect((document.activeElement as HTMLElement).dataset.templateId).toBe(firstCyclodextrin.id);
  await search("no such template"); expect(container.textContent).toContain("No templates match");
});
