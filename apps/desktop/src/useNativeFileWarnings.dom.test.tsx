// @vitest-environment jsdom
import { readFileSync } from "node:fs";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { openChemDraftPayload } from "@chemdraft/cdx-compat";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { FileWarningsAction, FileWarningsSnapshot } from "./fileWarningsProtocol";
import type { OpenWarningsReport } from "./openWarnings";
import { useNativeFileWarnings } from "./useNativeFileWarnings";

const native = vi.hoisted(() => ({ desktop: true, invoke: vi.fn(async (_command: string, _args?: unknown) => {}) }));
vi.mock("./window-manager", () => ({ isDesktopRuntime: () => native.desktop, currentWindowLogicalPosition: async () => ({ x: 100, y: 200 }) }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: native.invoke, Channel: class { onmessage = (_action: FileWarningsAction) => {}; } }));
const drawing = openChemDraftPayload(readFileSync("packages/fixtures/cdxml/invalid-element.cdxml", "utf8")).document!;
const object = drawing.pages[0].objects[0]!;
const reports: OpenWarningsReport[] = [{ displayName: "import.cdxml", sourceLabel: "CDXML", warnings: [{ code: "warning", message: "Preserved warning", sourceObjectId: object.id }] }];
const show = vi.fn(), close = vi.fn(), error = vi.fn();
function Harness({ shown = true, tabId = "first", document = drawing }) {
  useNativeFileWarnings(shown, tabId, reports, document, show, close, error);
  return null;
}
let root: Root, container: HTMLDivElement;
beforeEach(() => {
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  vi.clearAllMocks(); native.desktop = true;
  container = document.createElement("div"); document.body.append(container); root = createRoot(container);
});
afterEach(async () => { await act(async () => root.unmount()); container.remove(); });
function opening(index = 0) {
  return native.invoke.mock.calls.filter(([command]) => command === "file_warnings_open")[index]![1] as {
    snapshot: FileWarningsSnapshot; onAction: { onmessage: (action: FileWarningsAction) => void };
  };
}

it("routes live Show actions to the owner, rejects an old tab session, and closes on its toggle", async () => {
  await act(async () => root.render(<Harness />));
  const first = opening();
  const action = { kind: "show" as const, sessionId: first.snapshot.sessionId, revision: first.snapshot.revision, reportIndex: 0, warningIndex: 0 };
  act(() => first.onAction.onmessage(action));
  expect(show).toHaveBeenCalledWith({ objectId: object.id, atomIds: [], bondIds: [] }, expect.any(String));
  show.mockClear();
  await act(async () => root.render(<Harness tabId="second" />));
  act(() => first.onAction.onmessage(action));
  expect(show).not.toHaveBeenCalled();
  expect(native.invoke).toHaveBeenCalledWith("file_warnings_close", { sessionId: first.snapshot.sessionId });
  const second = opening(1);
  await act(async () => root.render(<Harness shown={false} tabId="second" />));
  expect(native.invoke).toHaveBeenCalledWith("file_warnings_close", { sessionId: second.snapshot.sessionId });
  expect(error).not.toHaveBeenCalled();
});

it("publishes missing targets after edits and ignores stale Show deliveries", async () => {
  await act(async () => root.render(<Harness />));
  const first = opening();
  const edited = { ...drawing, pages: drawing.pages.map(page => ({ ...page, objects: [] })) };
  await act(async () => root.render(<Harness document={edited} />));
  const publication = native.invoke.mock.calls.find(([command]) => command === "file_warnings_publish")![1] as { snapshot: FileWarningsSnapshot };
  expect(publication.snapshot.reports[0]!.rows[0]).toMatchObject({ missing: true, canShow: false });
  act(() => first.onAction.onmessage({ kind: "show", sessionId: first.snapshot.sessionId, revision: first.snapshot.revision, reportIndex: 0, warningIndex: 0 }));
  expect(show).not.toHaveBeenCalled();
});

it("does not create a native window for the browser fallback", async () => {
  native.desktop = false;
  await act(async () => root.render(<Harness />));
  expect(native.invoke).not.toHaveBeenCalled();
});
