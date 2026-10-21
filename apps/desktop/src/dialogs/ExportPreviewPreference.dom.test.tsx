// @vitest-environment jsdom
import { act, createElement, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { ExportForm } from "./ExportForm";
import { DialogWindow } from "./DialogWindow";
import { PreferencesWindow } from "../PreferencesWindow";
import { MemoryStorage } from "../testSupport/memoryStorage";
import { saveExportPreviewEnabled, loadExportPreviewEnabled } from "../exportPreviewSettings";
import { broadcastExportPreviewSettings } from "../window-manager";
import { exportFixture } from "./exportTestFixtures";
import type { DialogMessage } from "./dialogProtocol";
import type { ExportDialogState, ExportPreviewResult } from "./exportOptions";
import { createDialogExportPreview } from "../MainWindow";
import { applyReactionArrowToolAtPoint, createPhase4Document, exportPhase4Svg, insertNativeTemplateMolecule } from "../documentWorkflow";
import { parseDialogMessage } from "./dialogProtocol";

const ipc = vi.hoisted(() => ({ invoke: vi.fn(), channels: [] as { onmessage(value: unknown): void }[] }));
vi.mock("@tauri-apps/api/core", () => ({
  invoke: ipc.invoke,
  Channel: class { onmessage = (_value: unknown) => {}; constructor() { ipc.channels.push(this); } }
}));
vi.mock("../window-manager", async original => ({ ...await original<typeof import("../window-manager")>(), isDesktopRuntime: () => true }));
let root: Root, container: HTMLDivElement;
const frame = { page: { width: 800, height: 600 }, content: { width: 400, height: 300 }, revision: 1 };
const preview: ExportPreviewResult = { url: "data:image/png;base64,AAAA", kind: "image", width: 800, height: 600, warnings: [] };
beforeEach(() => {
  vi.useFakeTimers(); vi.clearAllMocks(); ipc.channels.length = 0; ipc.invoke.mockResolvedValue(undefined);
  vi.stubGlobal("localStorage", new MemoryStorage()); vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  container = document.createElement("div"); document.body.append(container); root = createRoot(container);
});
afterEach(() => { act(() => root.unmount()); container.remove(); vi.useRealTimers(); vi.unstubAllGlobals(); });
async function tick(ms = 250) { await act(async () => vi.advanceTimersByTimeAsync(ms)); }
async function toggle(enabled: boolean) {
  await act(async () => { saveExportPreviewEnabled(enabled); await broadcastExportPreviewSettings(enabled); });
}
function change(input: HTMLInputElement, value: string) {
  Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, value);
  input.dispatchEvent(new Event("input", { bubbles: true }));
}
async function mountForm(renderPreview = vi.fn().mockResolvedValue(preview), initial = { ...exportFixture(), format: "jpeg" as const, busy: false } as ExportDialogState) {
  let selected = initial;
  const choose = vi.fn();
  function Form() {
    const [state, setState] = useState(initial); selected = state;
    return createElement(ExportForm, { state, frame, renderPreview, onChange: setState, onCancel: vi.fn(), onSubmit: vi.fn(), onChooseDestination: choose });
  }
  await act(async () => root.render(createElement(Form)));
  return { renderPreview, choose, selected: () => selected };
}
const exportSnapshot: DialogMessage = { protocolVersion: 1, ownerWindowId: "main", documentTabId: "tab", dialogKind: "export", sessionId: "session", requestId: "request", snapshotRevision: 1, type: "snapshot", data: { title: "Drawing", options: { ...exportFixture(), format: "jpeg", destinationPath: "C:\\Exports\\Drawing.jpeg" }, frame } };
function deliver(message: DialogMessage) {
  ipc.channels[0]!.onmessage({ senderWindowId: "main", windowLabel: "dialog-main-export-1", message });
}
async function mountHost() {
  await act(async () => root.render(createElement(DialogWindow, { hostId: "export-host" })));
  await act(async () => { deliver(exportSnapshot); await import("./ExportForm"); });
}
const previewCalls = () => ipc.invoke.mock.calls.filter(([command, args]) => command === "dialog_send" && args.message.data.action === "preview");

it.each(["macos", "windows"] as const)("renders the PDF page layout as an SVG image on %s without a PDF viewer", async platform => {
  saveExportPreviewEnabled(true);
  const drawing = applyReactionArrowToolAtPoint(insertNativeTemplateMolecule(createPhase4Document("PDF layout"), { x: 100, y: 100 }, "benzene"), { x: 200, y: 130 }, "forward");
  const options = { ...exportFixture(), svg: { includeWarnings: false, includePageGuides: false },
    pdf: { ...exportFixture().pdf, includePageGuides: true },
    presentation: { width: 1200, height: 600, linked: false, dpi: 300, crop: "page" as const, background: "transparent" as const } };
  const result = await createDialogExportPreview(drawing, options);
  expect(result.kind).toBe("image");
  expect(result.url).toMatch(/^data:image\/svg\+xml;base64,/);
  const svg = atob(result.url.split(",")[1]!);
  expect(svg).toBe(exportPhase4Svg(drawing, { outputWidth: 800, outputHeight: 400, background: "#ffffff", includeWarnings: true, includePageGuides: true }).contents);
  expect(svg).toContain("<line");
  expect(parseDialogMessage({ ...exportSnapshot, type: "result", data: { status: "preview", preview: result } })).toBeDefined();
  await act(async () => root.render(createElement(ExportForm, {
    state: { ...options, busy: false }, platform, frame, renderPreview: () => Promise.resolve(result),
    onChange: vi.fn(), onCancel: vi.fn(), onSubmit: vi.fn(), onChooseDestination: vi.fn()
  })));
  await tick();
  const image = container.querySelector<HTMLImageElement>('img[alt="Preview of the PDF page layout"]');
  expect(image?.getAttribute("src")).toBe(result.url);
  expect(container.querySelector("object")).toBeNull();
  expect(container.textContent).toContain("Preview of the PDF page layout");
});

it("defaults to main's controls and destination, permits Choose with an invalid filename, and sends zero preview IPC", async () => {
  await mountHost();
  expect(container.querySelector("#chemdraft-export-raster-scale")).not.toBeNull();
  expect(container.querySelector("#chemdraft-export-raster-max")).not.toBeNull();
  expect(container.querySelector<HTMLInputElement>("#chemdraft-export-jpeg-quality")!.type).toBe("range");
  expect(container.querySelector<HTMLInputElement>("#chemdraft-export-destination")!.value).toBe("C:\\Exports\\Drawing.jpeg");
  expect(container.querySelector('[aria-label="Size preset"]')).toBeNull();
  await act(async () => change(container.querySelector<HTMLInputElement>("#chemdraft-export-filename")!, ""));
  expect([...container.querySelectorAll("button")].find(button => button.textContent === "Choose...")!.disabled).toBe(false);
  await tick(1000);
  expect(previewCalls()).toHaveLength(0);
  expect(ipc.invoke.mock.calls.map(([command]) => command)).toEqual(["dialog_request", "dialog_send"]); // bootstrap + ready only
});

it("starts with the saved opt-in, then reacts live to Preferences and cross-window storage notifications", async () => {
  saveExportPreviewEnabled(true);
  await mountHost();
  expect(container.querySelector('[aria-label="Size preset"]')).not.toBeNull();
  expect(container.querySelector<HTMLInputElement>("#chemdraft-export-jpeg-quality")!.type).toBe("number");
  await tick(); expect(previewCalls()).toHaveLength(1);
  await toggle(false); await tick();
  expect(container.querySelector('[aria-label="Size preset"]')).toBeNull();
  expect(previewCalls()).toHaveLength(1);
  await act(async () => {
    saveExportPreviewEnabled(true);
    window.dispatchEvent(new StorageEvent("storage", { key: "chemdraft.export.preview-and-presets.v1", newValue: "true" }));
  });
  expect(container.querySelector('[aria-label="Size preset"]')).not.toBeNull();
  await tick(); expect(previewCalls()).toHaveLength(2);
});

it("the actual Preferences checkbox persists and broadcasts to an open form", async () => {
  function Both() {
    const [state, setState] = useState<ExportDialogState>({ ...exportFixture(), format: "png", busy: false });
    return createElement("div", null, createElement(PreferencesWindow), createElement(ExportForm, { state, frame, onChange: setState, onCancel: vi.fn(), onSubmit: vi.fn(), onChooseDestination: vi.fn() }));
  }
  await act(async () => root.render(createElement(Both)));
  const checkbox = [...container.querySelectorAll("label")].find(label => label.textContent?.includes("Export preview and size presets"))!.querySelector("input")!;
  await act(async () => checkbox.click());
  expect(loadExportPreviewEnabled()).toBe(true);
  expect(container.querySelector('[aria-label="Size preset"]')).not.toBeNull();
  await act(async () => checkbox.click());
  expect(loadExportPreviewEnabled()).toBe(false);
  expect(container.querySelector('[aria-label="Size preset"]')).toBeNull();
});

it("does no preview rendering off, debounces field edits on, aborts stale renders and clears sizing on disable", async () => {
  let resolveFirst!: (result: ExportPreviewResult) => void;
  const first = new Promise<ExportPreviewResult>(resolve => { resolveFirst = resolve; });
  const render = vi.fn().mockReturnValueOnce(first).mockResolvedValue(preview);
  const form = await mountForm(render);
  await tick(1000); expect(render).not.toHaveBeenCalled();
  await toggle(true); await tick(249); expect(render).not.toHaveBeenCalled();
  await tick(1); expect(render).toHaveBeenCalledTimes(1);
  const field = () => [...container.querySelectorAll("label")].find(label => label.textContent?.startsWith("Width (px)"))!.querySelector("input")!;
  for (const value of ["1", "12", "120", "1200"]) {
    await act(async () => change(field(), value)); await tick(100);
  }
  expect(render.mock.calls[0]![1].aborted).toBe(true);
  expect(render).toHaveBeenCalledTimes(1);
  await tick(150); expect(render).toHaveBeenCalledTimes(2);
  expect(render.mock.calls[1]![0].presentation.width).toBe(1200);
  await act(async () => resolveFirst({ ...preview, url: "data:image/png;base64,BBBB" }));
  expect(container.querySelector("img")!.src).toBe(preview.url);
  await toggle(false); await tick(1000);
  expect(form.selected().presentation).toBeUndefined();
  expect(render).toHaveBeenCalledTimes(2);
});

it("claims embedded PNG density only after explicit sizing, and never for other formats", async () => {
  await toggle(true);
  await mountForm(undefined, { ...exportFixture(), format: "png", busy: false });
  expect(container.textContent).not.toContain("PNG density embedded");
  const width = [...container.querySelectorAll("label")].find(label => label.textContent?.startsWith("Width (px)"))!.querySelector("input")!;
  await act(async () => change(width, "1200"));
  expect(container.textContent).toContain("PNG density embedded");
  const format = container.querySelector<HTMLSelectElement>("#chemdraft-export-format")!;
  await act(async () => { format.value = "jpeg"; format.dispatchEvent(new Event("change", { bubbles: true })); });
  expect(container.textContent).not.toContain("PNG density embedded");
});

it("retains a frame delivered before the pending picker receipt releases the action", async () => {
  saveExportPreviewEnabled(true); await mountHost(); await tick();
  const choose = [...container.querySelectorAll("button")].find(button => button.textContent === "Choose...")!;
  await act(async () => choose.click());
  const request = ipc.invoke.mock.calls.at(-1)![1].message as DialogMessage;
  await act(async () => deliver({ ...exportSnapshot, type: "result", data: { status: "frame", frame: { page: { width: 600, height: 800 }, content: { width: 300, height: 400 }, revision: 2 } } }));
  await act(async () => deliver({ ...exportSnapshot, requestId: request.requestId, type: "result", data: { status: "cancelled" } }));
  await tick();
  // The new default width proves the frame was retained despite actionPending.
  const width = [...container.querySelectorAll("label")].find(label => label.textContent?.startsWith("Width (px)"))!.querySelector("input")!;
  expect(width.value).toBe("600");
  expect(previewCalls()).toHaveLength(2);
});
