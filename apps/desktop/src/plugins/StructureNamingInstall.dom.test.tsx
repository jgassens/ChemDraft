// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { DialogCoordinator } from "../dialogs/DialogCoordinator";
import type { DialogTransport } from "../dialogs/dialogTransport";
import type { DialogMessage } from "../dialogs/dialogProtocol";
import { StructureNamingController } from "./StructureNamingController";
import { presentStructureNamingInstall, mountStructureNamingHost, NAMING_ENGINE_DISCLOSURE } from "./StructureNamingInstallDialog";
import { fakeNamingEngine, namingInstalled, namingMolecule } from "./structureNamingTestFixtures";
const host = vi.hoisted(() => ({ receive: undefined as ((message: DialogMessage) => void) | undefined, send: vi.fn() }));
vi.mock("../dialogs/dialogTransport", () => ({
  subscribeDialogHost: async (_id: string, receive: typeof host.receive) => { host.receive = receive; return () => {}; },
  sendDialogMessage: host.send
}));
import { DialogWindow } from "../dialogs/DialogWindow";

let root: Root;
let container: HTMLDivElement;
const cleanups: (() => void | Promise<void>)[] = [];
beforeEach(async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true); vi.clearAllMocks();
  container = document.createElement("div"); document.body.append(container); root = createRoot(container);
  await act(async () => root.render(createElement(DialogWindow, { hostId: "engine-host" })));
});
afterEach(async () => {
  await act(async () => { for (const cleanup of cleanups.splice(0)) await cleanup(); root.unmount(); });
  container.remove(); vi.unstubAllGlobals();
});
function setup(state: typeof namingInstalled.state = "notInstalled") {
  const engine = fakeNamingEngine({ ...namingInstalled, state, detail: "Damaged receipt" });
  const controller = new StructureNamingController(engine, { canonicalize: async () => "CCO", version: "test" });
  let snapshot!: DialogMessage;
  const transport: DialogTransport = {
    subscribe: async () => () => {},
    open: vi.fn(async message => { snapshot = message; host.receive!(message); return { hostId: "engine-host", windowLabel: "dialog-main-engineInstall-1" }; }),
    publish: vi.fn(async (_id, message) => { host.receive!(message); }), close: vi.fn(async () => {})
  };
  const onError = vi.fn();
  const coordinator = new DialogCoordinator(transport, { applyPageSize: vi.fn(), onError });
  const detach = presentStructureNamingInstall(controller, { coordinator: () => coordinator, documentTabId: () => "origin-tab" });
  cleanups.push(async () => { detach(); await coordinator.dispose(); });
  host.send.mockImplementation((_id, message: DialogMessage) => coordinator.receive({ message,
    senderWindowId: "dialog-main-engineInstall-1", windowLabel: "dialog-main-engineInstall-1" }));
  const start = async () => {
    let result!: ReturnType<typeof controller.name>;
    await act(async () => { result = controller.name({ id: "names", name: "Structure names" }, namingMolecule, new AbortController().signal); });
    return { result };
  };
  const button = (name: string) => Array.from(container.querySelectorAll<HTMLButtonElement>("button")).find(b => b.textContent === name)!;
  const closeNative = () => coordinator.receive({ senderWindowId: "main", windowLabel: "dialog-main-engineInstall-1", message: { ...snapshot, type: "closed", data: { reason: "close" } } });
  return { engine, controller, coordinator, transport, onError, start, button, closeNative };
}
it("discloses the host-fixed download and licences, installs once, and continues naming", async () => {
  const h = setup(); const { result } = await h.start();
  expect(container.textContent).toContain(NAMING_ENGINE_DISCLOSURE);
  expect(container.textContent).toContain("Structure names (names)");
  await act(async () => { h.button("Install").click(); h.button("Install").click(); });
  expect(await result).toMatchObject({ status: "named" });
  expect(h.engine.install).toHaveBeenCalledOnce();
  expect(h.onError).not.toHaveBeenCalled();
});
it.each(["Close", "title-bar"])("%s before completion returns engineNotInstalled and cancels the owned install", async control => {
  const h = setup();
  let finish!: (status: typeof namingInstalled) => void;
  vi.mocked(h.engine.install).mockImplementation(progress => {
    progress({ phase: "installingPython", message: "/private/path is never displayed", bytesDone: 100, bytesTotal: 200, estimated: true });
    return new Promise(resolve => { finish = resolve; });
  });
  const { result } = await h.start();
  await act(async () => h.button("Install").click());
  expect(container.textContent).toContain("Step 2 of 5: Installing Python");
  expect(container.textContent).toContain("Estimated: 100 of 200 bytes");
  expect(container.textContent).not.toContain("/private/path");
  expect(h.button("Cancel installation").disabled).toBe(false);
  await act(async () => { if (control === "Close") h.button("Close").click(); else await h.closeNative(); });
  expect(await result).toEqual({ status: "engineNotInstalled" });
  expect(h.engine.cancelInstall).toHaveBeenCalledOnce();
  await act(async () => finish(namingInstalled));
  expect(h.engine.name).not.toHaveBeenCalled();
});
it("Cancel installation calls the native cancellation and displays the failure", async () => {
  const h = setup(); let fail!: (error: unknown) => void;
  vi.mocked(h.engine.install).mockImplementation(() => new Promise((_resolve, reject) => { fail = reject; }));
  vi.mocked(h.engine.cancelInstall).mockImplementation(async () => { fail({ code: "cancelled", message: "Installation cancelled." }); });
  const { result } = await h.start();
  await act(async () => h.button("Install").click());
  await act(async () => h.button("Cancel installation").click());
  expect(h.engine.cancelInstall).toHaveBeenCalledOnce();
  expect(await result).toEqual({ status: "cancelled" });
  expect(container.textContent).toContain("Installation cancelled.");
});
it("shows broken detail and Install engine again", async () => {
  const h = setup("broken"); const { result } = await h.start();
  expect(container.textContent).toContain("Damaged receipt");
  expect(h.button("Install engine again")).toBeDefined();
  await act(async () => h.button("Close").click());
  expect(await result).toEqual({ status: "engineNotInstalled" });
});
it("mounts only the activity indicator in the document, with no in-page install fallback", async () => {
  const h = setup();
  await act(async () => { const stop = mountStructureNamingHost(h.controller); cleanups.push(stop); });
  const { result } = await h.start();
  expect(document.querySelector(".structure-naming-host [role=dialog]")).toBeNull();
  await act(async () => h.button("Close").click()); await result;
});
