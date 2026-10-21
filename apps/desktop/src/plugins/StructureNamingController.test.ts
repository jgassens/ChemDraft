import { afterEach, describe, expect, it, vi } from "vitest";
import { presentStructureNamingInstall } from "./StructureNamingInstallDialog";
import { DialogCoordinator } from "../dialogs/DialogCoordinator";
import { dialogEnvelope, type DialogMessage } from "../dialogs/dialogProtocol";
import type { DialogTransport } from "../dialogs/dialogTransport";
import { StructureNamingController } from "./StructureNamingController";
import { fakeNamingEngine, namingInstalled, namingMolecule, namingRaw } from "./structureNamingTestFixtures";

const plugin = { id: "test", name: "Test" };
function setup(state = "installed" as typeof namingInstalled.state) {
  const engine = fakeNamingEngine({ ...namingInstalled, state, detail: state === "broken" ? "Damaged receipt" : "Unsupported architecture" });
  const controller = new StructureNamingController(engine, { canonicalize: async () => "CCO", version: "test" });
  let snapshot!: DialogMessage;
  const transport: DialogTransport = {
    subscribe: async () => () => {},
    open: vi.fn(async message => { snapshot = message; return { hostId: "host", windowLabel: "dialog-main-engineInstall-1" }; }),
    publish: vi.fn(async () => {}), close: vi.fn(async () => {})
  };
  const onError = vi.fn();
  const coordinator = new DialogCoordinator(transport, { applyPageSize: vi.fn(), onError });
  const detach = presentStructureNamingInstall(controller, { coordinator: () => coordinator, documentTabId: () => "origin-tab" });
  cleanups.push(async () => { detach(); await coordinator.dispose(); });
  const deliver = async (type: "ready" | "action" | "closed", data: unknown) => {
    await vi.waitFor(() => expect(snapshot).toBeDefined());
    await coordinator.receive({ windowLabel: "dialog-main-engineInstall-1",
      senderWindowId: type === "closed" ? "main" : "dialog-main-engineInstall-1",
      message: { ...dialogEnvelope(snapshot), type, data, requestId: crypto.randomUUID() } });
  };
  const action = async (action: string) => { await deliver("ready", {}); await deliver("action", { action }); };
  return { engine, controller, coordinator, action, deliver, transport, onError };
}
const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0)) await cleanup(); vi.useRealTimers(); });
describe("StructureNamingController", () => {
  it("installs on first use and continues naming", async () => {
    const { engine, controller, action } = setup("notInstalled");
    const result = controller.name(plugin, namingMolecule, new AbortController().signal);
    await vi.waitFor(() => expect(controller.getOpenInstall()).toBeDefined());
    await action("install");
    expect(await result).toMatchObject({ status: "named" });
    expect(engine.install).toHaveBeenCalledOnce();
  });
  it("closing first-use install returns engineNotInstalled", async () => {
    const { engine, controller, action } = setup("notInstalled");
    const result = controller.name(plugin, namingMolecule, new AbortController().signal);
    await vi.waitFor(() => expect(controller.getOpenInstall()).toBeDefined());
    await action("close");
    expect(await result).toEqual({ status: "engineNotInstalled" });
    expect(engine.name).not.toHaveBeenCalled();
  });
  it("broken exposes the native detail for reinstall", async () => {
    const { controller, action } = setup("broken");
    const result = controller.name(plugin, namingMolecule, new AbortController().signal);
    await vi.waitFor(() => expect(controller.getOpenInstall()?.status.detail).toBe("Damaged receipt"));
    await action("install");
    expect(await result).toMatchObject({ status: "named" });
  });
  it("unsupported reports its reason without an install dialog", async () => {
    const { controller, engine } = setup("unsupported");
    expect(await controller.name(plugin, namingMolecule, new AbortController().signal)).toEqual({ status: "unsupported", reason: "Unsupported architecture" });
    expect(controller.getOpenInstall()).toBeUndefined();
    expect(engine.name).not.toHaveBeenCalled();
  });
  it.each(["busy", "timeout", "engineCrashed"] as const)("maps native %s errors", async code => {
    const { controller, engine } = setup();
    vi.mocked(engine.name).mockRejectedValue({ code, message: "Native failure" });
    expect(await controller.name(plugin, namingMolecule, new AbortController().signal)).toEqual({ status: "failed", code, message: "Native failure" });
  });
  it("preserves the installing busy message from native naming", async () => {
    const { controller, engine } = setup();
    vi.mocked(engine.name).mockRejectedValue({ code: "busy", message: "The naming engine is being installed." });
    expect(await controller.name(plugin, namingMolecule, new AbortController().signal)).toEqual({
      status: "failed", code: "busy", message: "The naming engine is being installed."
    });
  });
  it("install failure reports failed installFailed", async () => {
    const { controller, engine, action } = setup("notInstalled");
    vi.mocked(engine.install).mockRejectedValue({ code: "network", message: "Download failed" });
    const result = controller.name(plugin, namingMolecule, new AbortController().signal);
    await vi.waitFor(() => expect(controller.getOpenInstall()).toBeDefined());
    await action("install");
    expect(await result).toEqual({ status: "failed", code: "installFailed", message: "Download failed" });
  });
  it("cancellation waits for native acknowledgement, discards late results, and allows retry", async () => {
    const { controller, engine } = setup();
    let resolve!: (value: Awaited<ReturnType<typeof engine.name>>) => void;
    vi.mocked(engine.name).mockImplementationOnce(() => new Promise(done => { resolve = done; }));
    let acknowledge!: () => void;
    vi.mocked(engine.cancel).mockImplementationOnce(() => new Promise(done => { acknowledge = done; }));
    const stop = new AbortController();
    const result = controller.name(plugin, namingMolecule, stop.signal);
    await vi.waitFor(() => expect(engine.name).toHaveBeenCalled());
    expect(await controller.name(plugin, namingMolecule, new AbortController().signal)).toMatchObject({ status: "failed", code: "busy" });
    stop.abort();
    expect(engine.cancel).toHaveBeenCalledOnce();
    let settled = false;
    void result.then(() => { settled = true; });
    resolve(namingRaw);
    await new Promise(done => setTimeout(done, 0));
    expect(settled).toBe(false);
    expect(await controller.name(plugin, namingMolecule, new AbortController().signal)).toMatchObject({ status: "failed", code: "busy" });
    acknowledge();
    expect(await result).toEqual({ status: "cancelled" });
    expect(await controller.name(plugin, namingMolecule, new AbortController().signal)).toMatchObject({ status: "named" });
    expect(engine.name).toHaveBeenCalledTimes(2);
  });
  it("failed cancellation IPC keeps the controller busy until the original request stops", async () => {
    const { controller, engine } = setup();
    let reject!: (reason: unknown) => void;
    vi.mocked(engine.name).mockImplementationOnce(() => new Promise((_, fail) => { reject = fail; }));
    vi.mocked(engine.cancel).mockRejectedValueOnce(new Error("IPC failed"));
    const stop = new AbortController();
    const result = controller.name(plugin, namingMolecule, stop.signal);
    await vi.waitFor(() => expect(engine.name).toHaveBeenCalled());
    stop.abort();
    await new Promise(done => setTimeout(done, 0));
    expect(await controller.name(plugin, namingMolecule, new AbortController().signal)).toMatchObject({ status: "failed", code: "busy" });
    reject({ code: "cancelled", message: "Stopped" });
    expect(await result).toEqual({ status: "cancelled" });
    expect(await controller.name(plugin, namingMolecule, new AbortController().signal)).toMatchObject({ status: "named" });
  });
  it("activity is hidden for the first second", async () => {
    vi.useFakeTimers();
    const { controller, engine } = setup();
    vi.mocked(engine.name).mockImplementation(() => new Promise(() => undefined));
    const stop = new AbortController();
    const result = controller.name(plugin, namingMolecule, stop.signal);
    await vi.advanceTimersByTimeAsync(999);
    expect(controller.getActivity()).toBeUndefined();
    await vi.advanceTimersByTimeAsync(1);
    expect(controller.getActivity()).toBeDefined();
    stop.abort();
    expect(await result).toEqual({ status: "cancelled" });
    expect(controller.getActivity()).toBeUndefined();
  });
});

it("native title-bar close cancels installation and returns engineNotInstalled", async () => {
  const { controller, engine, action, deliver } = setup("notInstalled");
  let finish!: (value: typeof namingInstalled) => void;
  vi.mocked(engine.install).mockImplementation(() => new Promise(resolve => { finish = resolve; }));
  const result = controller.name(plugin, namingMolecule, new AbortController().signal);
  const installing = action("install");
  await vi.waitFor(() => expect(engine.install).toHaveBeenCalled());
  await deliver("closed", { reason: "close" });
  expect(await result).toEqual({ status: "engineNotInstalled" });
  expect(engine.cancelInstall).toHaveBeenCalledOnce();
  finish(namingInstalled); await installing;
  expect(engine.name).not.toHaveBeenCalled();
});

it("originating tab close dismisses the native install", async () => {
  const { controller, coordinator, transport } = setup("notInstalled");
  const result = controller.name(plugin, namingMolecule, new AbortController().signal);
  await vi.waitFor(() => expect(transport.open).toHaveBeenCalled());
  await coordinator.closeTab("origin-tab");
  expect(await result).toEqual({ status: "engineNotInstalled" });
  expect(transport.close).toHaveBeenCalledWith("host", "ownerTabClose");
});

it("reinvoking naming focuses the retained native installer", async () => {
  const { controller, transport, action } = setup("notInstalled");
  const result = controller.name(plugin, namingMolecule, new AbortController().signal);
  await vi.waitFor(() => expect(transport.open).toHaveBeenCalledOnce());
  expect(await controller.name(plugin, namingMolecule, new AbortController().signal)).toMatchObject({ status: "failed", code: "busy" });
  await vi.waitFor(() => expect(transport.open).toHaveBeenCalledTimes(2));
  expect(vi.mocked(transport.open).mock.calls[1]![0]).toEqual(vi.mocked(transport.open).mock.calls[0]![0]);
  await action("close"); await result;
});

it("bounds JSON-escaped disclosure details within the complete channel delivery", async () => {
  const { controller, engine, transport, action } = setup("broken");
  vi.mocked(engine.status).mockResolvedValue({ ...namingInstalled, state: "broken", detail: "\u0001😀\"".repeat(5000) });
  const result = controller.name({ id: "names", name: "😀\"".repeat(1000) }, namingMolecule, new AbortController().signal);
  await vi.waitFor(() => expect(transport.open).toHaveBeenCalledOnce());
  const message = vi.mocked(transport.open).mock.calls[0]![0];
  const { parseDialogMessage } = await import("../dialogs/dialogProtocol");
  expect(parseDialogMessage(message)).toBeDefined();
  expect(new TextEncoder().encode(JSON.stringify({ senderWindowId: "main", windowLabel: "dialog-main-engineInstall-12345678901234567890", message })).length).toBeLessThan(4096);
  await action("close"); await result;
});

it("native creation failure reports document status and never installs", async () => {
  const { controller, transport, onError, engine } = setup("notInstalled");
  vi.mocked(transport.open).mockRejectedValueOnce(new Error("Window creation failed"));
  expect(await controller.name(plugin, namingMolecule, new AbortController().signal)).toEqual({ status: "engineNotInstalled" });
  await vi.waitFor(() => expect(onError).toHaveBeenCalledWith(expect.stringContaining("Window creation failed")));
  expect(engine.install).not.toHaveBeenCalled();
});
