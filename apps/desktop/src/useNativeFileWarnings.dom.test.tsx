// @vitest-environment jsdom
import { readFileSync } from "node:fs";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { openChemDraftPayload } from "@chemdraft/cdx-compat";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { FileWarningsAction, FileWarningsSnapshot } from "./fileWarningsProtocol";
import type { OpenWarningsReport } from "./openWarnings";
import { useNativeFileWarnings } from "./useNativeFileWarnings";
import { OpenWarningsList } from "./OpenWarningsList";

const native = vi.hoisted(() => ({ desktop: true, invoke: vi.fn(async (_command: string, _args?: unknown) => {}) }));
vi.mock("./window-manager", () => ({ isDesktopRuntime: () => native.desktop, currentWindowLogicalPosition: async () => ({ x: 100, y: 200 }) }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: native.invoke, Channel: class { onmessage = (_action: FileWarningsAction) => {}; } }));
const drawing = openChemDraftPayload(readFileSync("packages/fixtures/cdxml/invalid-element.cdxml", "utf8")).document!;
const object = drawing.pages[0].objects[0]!;
const reports: OpenWarningsReport[] = [{ displayName: "import.cdxml", sourceLabel: "CDXML", warnings: [{ code: "warning", message: "Preserved warning", sourceObjectId: object.id }] }];
const show = vi.fn(), close = vi.fn(), error = vi.fn();
function Harness({ shown = true, tabId = "first", document = drawing }) {
  const fallback = useNativeFileWarnings(shown, tabId, reports, document, show, close, error);
  return shown && fallback ? <OpenWarningsList report={reports[0]!} document={document} onShow={show} onClose={close} /> : null;
}
let root: Root, container: HTMLDivElement;
beforeEach(() => {
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  vi.clearAllMocks(); native.desktop = true;
  native.invoke.mockResolvedValue(undefined);
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
  expect(container.querySelector("[data-open-warnings-list]")).not.toBeNull();
});

it.each(["refused", "unavailable", "publish", "reveal"])("keeps a usable HTML list after native warnings are %s", async failure => {
  native.invoke.mockImplementation(async command => {
    if (failure !== "reveal" && command === (failure === "publish" ? "file_warnings_publish" : "file_warnings_open")) throw new Error(failure);
  });
  await act(async () => root.render(<Harness />));
  if (failure === "publish") await act(async () => root.render(<Harness document={{ ...drawing }} />));
  if (failure === "reveal") {
    const session = opening();
    await act(async () => session.onAction.onmessage({ kind: "unavailable", sessionId: session.snapshot.sessionId,
      revision: session.snapshot.revision, message: "reveal" }));
  }
  expect(container.querySelector("[data-open-warnings-list]")).not.toBeNull();
  expect(container.textContent).toContain("Preserved warning");
  expect(close).not.toHaveBeenCalled();
  expect(error).toHaveBeenCalledWith(expect.stringContaining(failure));
  expect(native.invoke).toHaveBeenCalledWith("file_warnings_close", expect.anything());
  act(() => container.querySelector<HTMLButtonElement>("[data-open-warning-show]")!.click());
  expect(show).toHaveBeenCalledWith({ objectId: object.id, atomIds: [], bondIds: [] }, expect.any(String));
  act(() => container.querySelector<HTMLButtonElement>("[aria-label='Close the warnings list']")!.click());
  expect(close).toHaveBeenCalledOnce();
  await act(async () => root.render(<Harness shown={false} />));
  native.invoke.mockResolvedValue(undefined);
  await act(async () => root.render(<Harness />));
  expect(container.querySelector("[data-open-warnings-list]")).toBeNull();
});
