// @vitest-environment jsdom
import { saveExportPreviewEnabled } from "../exportPreviewSettings";
import { MemoryStorage } from "../testSupport/memoryStorage";
import { act, createElement, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ExportForm, updateExportDialogFormat } from "./ExportForm";
import { exportFixture } from "./exportTestFixtures";
import type { ExportDialogState } from "./exportOptions";
import { desktopExportFormatDescriptors } from "../desktopExportFormats";
import { exportDefaultPath, replaceExportFileExtension } from "../exportFilename";

let root: Root; let container: HTMLDivElement;
beforeEach(() => {
  vi.stubGlobal("localStorage", new MemoryStorage());
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  container = document.createElement("div"); document.body.append(container); root = createRoot(container);
});
afterEach(() => { act(() => root.unmount()); container.remove(); vi.unstubAllGlobals(); });
describe.each(["macos", "windows"] as const)("Export keyboard on %s", platform => {
  it.each(["ready", "busy", "error", "completed"])("closes from the document body in %s state", state => {
    const cancel = vi.fn();
    act(() => root.render(createElement(ExportForm, {
      state: { ...exportFixture(), busy: state === "busy" || state === "completed" },
      completed: state === "completed", error: state === "error" ? "Disk full" : undefined,
      onChange: vi.fn(), onSubmit: vi.fn(), onCancel: cancel, onChooseDestination: vi.fn(), platform
    })));
    const close = Array.from(container.querySelectorAll("button")).find(button => button.textContent === "Close");
    if (state === "completed") expect(document.activeElement).toBe(close);
    (document.activeElement as HTMLElement).blur();
    for (const [key, modifier] of [["Escape", false], ["w", true]] as const) {
      const event = new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true,
        metaKey: modifier && platform === "macos", ctrlKey: modifier && platform === "windows" });
      act(() => document.body.dispatchEvent(event));
      expect(event.defaultPrevented).toBe(true);
    }
    expect(cancel).toHaveBeenCalledTimes(2);
  });
  it("focuses filename, submits valid Enter once, ignores IME and invalid input, wraps Tab and cancels", () => {
    const submit = vi.fn(), cancel = vi.fn(), change = vi.fn();
    const render = (state: ExportDialogState = { ...exportFixture(), busy: false }) => act(() => root.render(createElement(ExportForm, {
      state, title: "Origin", onChange: change, onSubmit: submit, onCancel: cancel, onChooseDestination: vi.fn(), platform
    })));
    render(); const field = container.querySelector<HTMLInputElement>("#chemdraft-export-filename")!;
    expect(document.activeElement).toBe(field);
    const press = (key: string, extra: KeyboardEventInit = {}) => act(() => field.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true, ...extra })));
    press("Enter", { isComposing: true }); expect(submit).not.toHaveBeenCalled();
    render({ ...exportFixture(), busy: false, filename: "" }); press("Enter"); expect(submit).not.toHaveBeenCalled();
    render(); press("Enter"); expect(submit).toHaveBeenCalledTimes(1);
    const fields = Array.from(container.querySelectorAll<HTMLElement>("input:not(:disabled),select:not(:disabled),button:not(:disabled)"));
    const first = fields[0]!, last = fields.at(-1)!;
    first.focus(); act(() => first.dispatchEvent(new KeyboardEvent("keydown", { key: "Tab", shiftKey: true, bubbles: true, cancelable: true })));
    expect(document.activeElement).toBe(last);
    act(() => last.dispatchEvent(new KeyboardEvent("keydown", { key: "Tab", bubbles: true, cancelable: true })));
    expect(document.activeElement).toBe(first);
    press("Escape"); press("w", { metaKey: platform === "macos", ctrlKey: platform === "windows" });
    expect(cancel).toHaveBeenCalledTimes(2);
  });
});
it("lists every implemented desktop export format without planned/deferred rows or developer notes", () => {
  act(() => root.render(createElement(ExportForm, { state: exportFixture(), onChange: vi.fn(), onSubmit: vi.fn(), onCancel: vi.fn(), onChooseDestination: vi.fn() })));
  const select = container.querySelector<HTMLSelectElement>("#chemdraft-export-format")!;
  const options = Array.from(select.options);
  expect(options.map(option => option.value)).toEqual([
    "svg", "pdf", "png", "jpeg", "bmp", "gif", "tiff",
    "sdf", "smiles", "cdxml", "cdx"
  ]);
  expect(new Set(options.map(option => option.value))).toEqual(new Set(desktopExportFormatDescriptors.filter(descriptor => descriptor.status === "implemented").map(descriptor => descriptor.id)));
  expect(select.textContent).not.toMatch(/\(planned\)|\(deferred\)|\.cds|\.chm/i);
  for (const descriptor of desktopExportFormatDescriptors) {
    act(() => root.render(createElement(ExportForm, { state: { ...exportFixture(), format: descriptor.id }, onChange: vi.fn(), onSubmit: vi.fn(), onCancel: vi.fn(), onChooseDestination: vi.fn() })));
    const visibleText = `${container.textContent} ${[...container.querySelectorAll("[title]")].map(node => node.getAttribute("title")).join(" ")}`;
    expect(visibleText).not.toContain("Initial MOL export should alias the tested V2000 writer");
    expect(visibleText).not.toMatch(/\(planned\)|\(deferred\)|should alias|resvg pipeline|delegates through|SVG export path/i);
    if (descriptor.status !== "implemented" && descriptor.warningSummary) expect(visibleText).not.toContain(descriptor.warningSummary);
  }
  expect(updateExportDialogFormat({ ...exportFixture(), filename: "compound.mol", busy: false }, "pdf").filename).toBe("compound.pdf");
});

it.each(["macos", "windows"] as const)("suggests one extension for every implemented format on %s", platform => {
  const folder = platform === "macos" ? "/Users/me/Figures/" : "C:\\Figures\\";
  const sourceExtensions = new Set(["chemdraft", ...desktopExportFormatDescriptors.flatMap(descriptor => descriptor.extensions)]);
  for (const descriptor of desktopExportFormatDescriptors.filter(descriptor => descriptor.status === "implemented")) {
    const expected = `colours.${descriptor.extensions[0]}`;
    for (const sourceExtension of sourceExtensions) {
      const state = updateExportDialogFormat({ ...exportFixture(), filename: `colours.${sourceExtension.toUpperCase()}`, destinationPath: `${folder}colours.${sourceExtension}` }, descriptor.id);
      expect(state).toMatchObject({ filename: expected, destinationPath: `${folder}${expected}` });
    }
    const state = updateExportDialogFormat({ ...exportFixture(), filename: "colours.cdxml" }, descriptor.id);
    act(() => root.render(createElement(ExportForm, { state, onChange: vi.fn(), onSubmit: vi.fn(), onCancel: vi.fn(), onChooseDestination: vi.fn(), platform })));
    expect(container.querySelector<HTMLInputElement>("#chemdraft-export-filename")!.value).toBe(expected);
  }
  expect(replaceExportFileExtension("figure.v2.cdxml", "pdf")).toBe("figure.v2.pdf");
  expect(replaceExportFileExtension("figure.custom", "pdf")).toBe("figure.custom.pdf");
  expect(replaceExportFileExtension("   ", "pdf")).toBe("Untitled.pdf");
  expect(exportDefaultPath(`${folder}figure.jpeg`, ["jpg", "jpeg"])).toBe(`${folder}figure.jpeg`);
  expect(exportDefaultPath(`${folder}figure.tiff`, ["tif", "tiff"])).toBe(`${folder}figure.tiff`);
});

it("updates the old picker path hint when filename or format changes and keeps all option controls", () => {
  const state = { ...exportFixture(), destinationPath: "C:\\Drawing.pdf", busy: false };
  const change = vi.fn();
  act(() => root.render(createElement(ExportForm, { state, onChange: change, onSubmit: vi.fn(), onCancel: vi.fn(), onChooseDestination: vi.fn() })));
  const input = container.querySelector<HTMLInputElement>("#chemdraft-export-filename")!;
  act(() => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, "Renamed.pdf");
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
  expect(change).toHaveBeenCalledWith(expect.objectContaining({ filename: "Renamed.pdf", destinationPath: "C:\\Renamed.pdf" }));
  expect(updateExportDialogFormat(state, "svg")).toMatchObject({ filename: "Drawing.svg", destinationPath: "C:\\Drawing.svg" });
  for (const format of ["svg", "pdf", "png", "jpeg", "cdxml"] as const) {
    act(() => root.render(createElement(ExportForm, { state: { ...state, format }, onChange: change, onSubmit: vi.fn(), onCancel: vi.fn(), onChooseDestination: vi.fn() })));
    expect(container.querySelector("fieldset")).not.toBeNull();
  }
});

it.each([
  ["/Users/me/Figures/Drawing.pdf", "/Users/me/Figures/"],
  ["C:\\Figures\\Drawing.pdf", "C:\\Figures\\"]
])("keeps the chosen folder as a hint after filename and format changes (%s)", (path, folder) => {
  const state = { ...exportFixture(), destinationPath: path, busy: false };
  expect(updateExportDialogFormat(state, "svg")).toMatchObject({
    filename: "Drawing.svg", destinationPath: `${folder}Drawing.svg`
  });
  const change = vi.fn();
  act(() => root.render(createElement(ExportForm, {
    state, onChange: change, onSubmit: vi.fn(), onCancel: vi.fn(), onChooseDestination: vi.fn()
  })));
  const input = container.querySelector<HTMLInputElement>("#chemdraft-export-filename")!;
  act(() => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, "Renamed.pdf");
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
  expect(change).toHaveBeenCalledWith(expect.objectContaining({
    filename: "Renamed.pdf", destinationPath: `${folder}Renamed.pdf`
  }));
});

it.each([
  { platform: "macOS", path: "/Users/me/Figures/Drawing.pdf", invalid: "../Temporary.pdf", folder: "/Users/me/Figures/", preview: false },
  { platform: "macOS", path: "/Users/me/Figures/Drawing.pdf", invalid: "../Temporary.pdf", folder: "/Users/me/Figures/", preview: true },
  { platform: "Windows", path: "C:\\Figures\\Drawing.pdf", invalid: "Sub\\Temporary.pdf", folder: "C:\\Figures\\", preview: false },
  { platform: "Windows", path: "C:\\Figures\\Drawing.pdf", invalid: "Sub\\Temporary.pdf", folder: "C:\\Figures\\", preview: true }
])("keeps the chosen folder after an invalid filename is corrected ($platform, preview $preview)", async ({ path, invalid, folder, preview }) => {
  act(() => saveExportPreviewEnabled(preview));
  let selected: ExportDialogState = { ...exportFixture(), destinationPath: path, busy: false };
  function Form() {
    const [state, setState] = useState(selected);
    selected = state;
    return createElement(ExportForm, {
      state, onChange: setState, onSubmit: vi.fn(), onCancel: vi.fn(), onChooseDestination: vi.fn()
    });
  }
  await act(async () => root.render(createElement(Form)));
  const input = container.querySelector<HTMLInputElement>("#chemdraft-export-filename")!;
  const enter = (filename: string) => act(() => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, filename);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
  enter(invalid);
  expect(selected.destinationPath).toBe(path);
  enter("Final.pdf");
  expect(selected).toMatchObject({ filename: "Final.pdf", destinationPath: `${folder}Final.pdf` });
});

it("keeps the action footer outside the scrollable form body", () => {
  act(() => root.render(createElement(ExportForm, {
    state: { ...exportFixture(), busy: false }, notice: "Warning\n".repeat(100),
    onChange: vi.fn(), onSubmit: vi.fn(), onCancel: vi.fn(), onChooseDestination: vi.fn()
  })));
  const form = container.querySelector("form")!;
  const body = container.querySelector("fieldset")!.parentElement!;
  const footer = form.lastElementChild as HTMLElement;
  expect(form.style.overflow).toBe("hidden");
  expect(form.style.gridTemplateRows).toBe("auto minmax(0, 1fr) auto");
  expect(body.style.overflowY).toBe("auto");
  expect(body.style.minHeight).toBe("0px");
  expect(body.contains(footer)).toBe(false);
  expect(footer.querySelector('button[type="submit"]')).not.toBeNull();
});

it("reserves the final preview height before the content-fit measurement", async () => {
  vi.useFakeTimers();
  saveExportPreviewEnabled(true);
  const ready = vi.fn();
  const renderPreview = vi.fn().mockResolvedValue({ url: "data:image/png;base64,AA==", kind: "image", width: 800, height: 600, warnings: [] });
  try {
    act(() => root.render(createElement(ExportForm, {
      state: { ...exportFixture(), busy: false }, onReady: ready, renderPreview,
      frame: { page: { width: 800, height: 600 }, content: { width: 800, height: 600 }, revision: 1 },
      onChange: vi.fn(), onSubmit: vi.fn(), onCancel: vi.fn(), onChooseDestination: vi.fn()
    })));
    const preview = container.querySelector<HTMLElement>('[aria-label="Preview of the PDF page layout"]')!;
    expect(preview.style.minHeight).toBe("220px");
    expect(ready).toHaveBeenCalledExactlyOnceWith(container.querySelector("form"));
    await act(async () => { await vi.advanceTimersByTimeAsync(250); });
    const image = preview.querySelector("img")!;
    expect(image.style.height).toBe(preview.style.minHeight);
    expect(image.style.display).toBe("block"); // No inline-image baseline adds height after ready.
    expect(ready).toHaveBeenCalledTimes(1);
  } finally {
    vi.useRealTimers();
  }
});

it("restores valid visual settings when switching from an invalid size draft to CDXML", () => {
  saveExportPreviewEnabled(true);
  const presentation = { width: 1200, dpi: 300, crop: "content" as const, background: "white" as const, preset: "custom" as const };
  const submitted = vi.fn();
  let selected: ExportDialogState = { ...exportFixture(), format: "svg", busy: false, presentation };
  function Form() {
    const [state, setState] = useState(selected);
    selected = state;
    return createElement(ExportForm, { state, onChange: setState, onSubmit: submitted, onCancel: vi.fn(), onChooseDestination: vi.fn() });
  }
  act(() => root.render(createElement(Form)));
  const width = [...container.querySelectorAll("label")].find(label => label.textContent?.startsWith("Width (px)"))!.querySelector("input")!;
  act(() => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(width, "9000");
    width.dispatchEvent(new Event("input", { bubbles: true }));
  });
  expect(container.querySelector<HTMLButtonElement>('button[type="submit"]')!.disabled).toBe(true);
  const format = container.querySelector<HTMLSelectElement>("#chemdraft-export-format")!;
  act(() => { format.value = "cdxml"; format.dispatchEvent(new Event("change", { bubbles: true })); });
  expect(container.querySelector('[aria-label="Size preset"]')).toBeNull();
  expect(container.querySelector<HTMLButtonElement>('button[type="submit"]')!.disabled).toBe(false);
  expect(selected.presentation).toEqual(presentation);
  act(() => container.querySelector("form")!.requestSubmit());
  expect(submitted).toHaveBeenCalledTimes(1);
});
