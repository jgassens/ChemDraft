// @vitest-environment jsdom
import { act, createElement, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ExportForm, updateExportDialogFormat } from "./ExportForm";
import { exportFixture } from "./exportTestFixtures";
import type { ExportDialogState } from "./exportOptions";

let root: Root; let container: HTMLDivElement;
beforeEach(() => {
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
it("clears an old picker grant when filename or format changes and keeps all option controls", () => {
  const state = { ...exportFixture(), destinationPath: "C:\\Drawing.pdf", busy: false };
  const change = vi.fn();
  act(() => root.render(createElement(ExportForm, { state, onChange: change, onSubmit: vi.fn(), onCancel: vi.fn(), onChooseDestination: vi.fn() })));
  const input = container.querySelector<HTMLInputElement>("#chemdraft-export-filename")!;
  act(() => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, "Renamed.pdf");
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
  expect(change).toHaveBeenCalledWith(expect.objectContaining({ filename: "Renamed.pdf", destinationPath: undefined }));
  expect(updateExportDialogFormat(state, "svg")).toMatchObject({ filename: "Drawing.svg", destinationPath: undefined });
  for (const format of ["svg", "pdf", "png", "jpeg", "cdxml"] as const) {
    act(() => root.render(createElement(ExportForm, { state: { ...state, format }, onChange: change, onSubmit: vi.fn(), onCancel: vi.fn(), onChooseDestination: vi.fn() })));
    expect(container.querySelector("fieldset")).not.toBeNull();
  }
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

it("restores valid visual settings when switching from an invalid size draft to CDXML", () => {
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
