import { afterEach, describe, expect, it, vi } from "vitest";
import { StructureNamingController } from "./StructureNamingController";
import { fakeNamingEngine, namingInstalled, namingMolecule } from "./structureNamingTestFixtures";

const plugin = { id: "test", name: "Test" };
function setup(state = "installed" as typeof namingInstalled.state) {
  const engine = fakeNamingEngine({ ...namingInstalled, state, detail: state === "broken" ? "Damaged receipt" : "Unsupported architecture" });
  const controller = new StructureNamingController(engine, { canonicalize: async () => "CCO", version: "test" });
  controller.attachInstallPresenter();
  return { engine, controller };
}
afterEach(() => vi.useRealTimers());
describe("StructureNamingController", () => {
  it("installs on first use and continues naming", async () => {
    const { engine, controller } = setup("notInstalled");
    const result = controller.name(plugin, namingMolecule, new AbortController().signal);
    await vi.waitFor(() => expect(controller.getOpenInstall()).toBeDefined());
    await controller.install(controller.getOpenInstall()!.id);
    expect(await result).toMatchObject({ status: "named" });
    expect(engine.install).toHaveBeenCalledOnce();
  });
  it("closing first-use install returns engineNotInstalled", async () => {
    const { engine, controller } = setup("notInstalled");
    const result = controller.name(plugin, namingMolecule, new AbortController().signal);
    await vi.waitFor(() => expect(controller.getOpenInstall()).toBeDefined());
    controller.decline(controller.getOpenInstall()!.id);
    expect(await result).toEqual({ status: "engineNotInstalled" });
    expect(engine.name).not.toHaveBeenCalled();
  });
  it("broken exposes the native detail for reinstall", async () => {
    const { controller } = setup("broken");
    const result = controller.name(plugin, namingMolecule, new AbortController().signal);
    await vi.waitFor(() => expect(controller.getOpenInstall()?.status.detail).toBe("Damaged receipt"));
    await controller.install(controller.getOpenInstall()!.id);
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
  it("install failure reports failed installFailed", async () => {
    const { controller, engine } = setup("notInstalled");
    vi.mocked(engine.install).mockRejectedValue({ code: "network", message: "Download failed" });
    const result = controller.name(plugin, namingMolecule, new AbortController().signal);
    await vi.waitFor(() => expect(controller.getOpenInstall()).toBeDefined());
    await controller.install(controller.getOpenInstall()!.id);
    expect(await result).toEqual({ status: "failed", code: "installFailed", message: "Download failed" });
  });
  it("cancellation calls naming_cancel and resolves promptly; another call is busy", async () => {
    const { controller, engine } = setup();
    let resolve!: (value: Awaited<ReturnType<typeof engine.name>>) => void;
    vi.mocked(engine.name).mockImplementation(() => new Promise(done => { resolve = done; }));
    const stop = new AbortController();
    const result = controller.name(plugin, namingMolecule, stop.signal);
    await vi.waitFor(() => expect(engine.name).toHaveBeenCalled());
    expect(await controller.name(plugin, namingMolecule, new AbortController().signal)).toMatchObject({ status: "failed", code: "busy" });
    stop.abort();
    expect(await result).toEqual({ status: "cancelled" });
    expect(engine.cancel).toHaveBeenCalledOnce();
    // Settle the abandoned native call without making its late result visible.
    resolve({ name: null, tier: "abstain", isPin: false, opsin: "failed", gateOutcome: "", limitCode: null, stereoUnexpressed: false, source: "", elapsedMs: 0, opsinReadBack: null });
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
