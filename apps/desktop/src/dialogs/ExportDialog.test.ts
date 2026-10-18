import { describe, expect, it, vi } from "vitest";
import { DialogCoordinator } from "./DialogCoordinator";
import { dialogEnvelope, parseDialogMessage, type ExportDialogResult } from "./dialogProtocol";
import type { ExportOptions } from "./exportOptions";
import type { DialogTransport } from "./dialogTransport";
import { exportFixture } from "./exportTestFixtures";

async function setup() {
  const transport: DialogTransport = { subscribe: vi.fn(async () => vi.fn()), open: vi.fn(async () => ({ hostId: "host", windowLabel: "dialog-main-export-1" })),
    publish: vi.fn(async () => {}), close: vi.fn(async () => {}) };
  const owner = { applyPageSize: vi.fn(), onError: vi.fn(), export: vi.fn<(tab: string, options: ExportOptions, live: () => boolean) => Promise<ExportDialogResult>>(async () => ({ status: "exported", notice: "Exported PDF" })),
    chooseExportDestination: vi.fn<(tab: string, options: ExportOptions, live: () => boolean) => Promise<ExportDialogResult>>(async () => ({ status: "picked" as const, destinationPath: "C:\\Drawings\\Drawing.pdf", filename: "Drawing.pdf" })) };
  const coordinator = new DialogCoordinator(transport, owner);
  await coordinator.openExport("tab-origin", { title: "Drawing", options: exportFixture() });
  const snapshot = vi.mocked(transport.open).mock.calls[0]![0];
  const deliver = (type: string, data: unknown, requestId: string = crypto.randomUUID()) => coordinator.receive({
    message: { ...dialogEnvelope(snapshot), type, data, requestId }, senderWindowId: "dialog-main-export-1", windowLabel: "dialog-main-export-1" });
  await deliver("ready", {});
  return { transport, owner, coordinator, snapshot, deliver };
}
describe("Export protocol and authority", () => {
  it("validates the second kind and refuses cross-kind actions, unknown options and unsafe values", async () => {
    const h = await setup();
    try {
      expect(parseDialogMessage(h.snapshot)).toBeDefined();
      const action = { ...dialogEnvelope(h.snapshot), type: "action", data: { action: "export", options: exportFixture() } };
      expect(parseDialogMessage(action)).toBeDefined();
      for (const options of [ { ...exportFixture(), filename: "../bad.pdf" }, { ...exportFixture(), destinationPath: null },
        { ...exportFixture(), command: "document.delete" }, { ...exportFixture(), format: "unknown" },
        { ...exportFixture(), pdf: { ...exportFixture().pdf, pdfType: "raster" } },
        { ...exportFixture(), raster: { ...exportFixture().raster, scale: Infinity } } ]) {
        expect(parseDialogMessage({ ...action, data: { action: "export", options } })).toBeUndefined();
      }
      expect(parseDialogMessage({ ...action, dialogKind: "pageSize" })).toBeUndefined();
      expect(parseDialogMessage({ ...action, data: { action: "apply", width: 1, height: 2, unit: "mm" } })).toBeUndefined();
      expect(parseDialogMessage({ ...action, data: { action: ["export"], options: exportFixture() } })).toBeUndefined();
      expect(parseDialogMessage({ ...action, type: "result", data: { status: ["exported"] } })).toBeUndefined();
      for (const status of ["accepted", "progress", "picked", "exported", "cancelled", "error"]) expect(parseDialogMessage({ ...action, type: "result", data: { status } })).toBeDefined();
    } finally { await h.coordinator.dispose(); }
  });
  it("reserves an export across duplicate and distinct request IDs; success is shown and Close still works", async () => {
    const h = await setup();
    try {
      let finish!: () => void;
      h.owner.export.mockImplementationOnce(() => new Promise(resolve => { finish = () => resolve({ status: "exported", notice: "Exported with warnings" }); }));
      const action = { action: "export", options: exportFixture() };
      const first = h.deliver("action", action, "press-1");
      const duplicate = h.deliver("action", action, "press-1");
      await h.deliver("action", action, "press-2");
      expect(h.owner.export).toHaveBeenCalledExactlyOnceWith("tab-origin", exportFixture(), expect.any(Function), expect.any(Function));
      finish(); await Promise.all([first, duplicate]);
      await h.deliver("action", action, "press-3");
      expect(h.owner.export).toHaveBeenCalledTimes(1);
      expect(h.transport.publish).toHaveBeenCalledWith("host", expect.objectContaining({ data: { status: "exported", notice: "Exported with warnings" } }));
      await h.coordinator.openExport("tab-origin", { title: "Ignored replay", options: exportFixture() });
      expect(h.transport.open).toHaveBeenCalledTimes(2);
      await h.deliver("action", { action: "cancel" });
      expect(h.transport.close).toHaveBeenCalledWith("host", "cancel");
    } finally { await h.coordinator.dispose(); }
  });
  it("replays a failure to the dialog without repeating a write, and permits an explicit retry", async () => {
    const h = await setup();
    try {
      h.owner.export.mockRejectedValueOnce(new Error("Disk full"));
      const action = { action: "export", options: exportFixture() };
      await h.deliver("action", action, "failed"); await h.deliver("action", action, "failed");
      expect(h.owner.export).toHaveBeenCalledTimes(1);
      expect(h.transport.publish).toHaveBeenCalledWith("host", expect.objectContaining({ data: { status: "error", error: "Error: Disk full" } }));
      await h.deliver("action", action, "retry"); expect(h.owner.export).toHaveBeenCalledTimes(2);
    } finally { await h.coordinator.dispose(); }
  });
  it("returns the picker receipt, leaves the session live, then permits Export", async () => {
    const h = await setup();
    try {
      await h.deliver("action", { action: "chooseDestination", options: exportFixture() });
      expect(h.transport.publish).toHaveBeenCalledWith("host", expect.objectContaining({ data: expect.objectContaining({ status: "picked", filename: "Drawing.pdf" }) }));
      expect(h.transport.close).not.toHaveBeenCalled();
      await h.deliver("action", { action: "export", options: exportFixture() }); expect(h.owner.export).toHaveBeenCalledTimes(1);
    } finally { await h.coordinator.dispose(); }
  });
  it.each(["closed", "replaced"])("invalidates in-flight work when the originating tab is %s", async () => {
    const h = await setup();
    try {
      let finish!: () => void;
      h.owner.export.mockImplementationOnce(async (_tab, _options, live) => {
        await new Promise<void>(resolve => { finish = resolve; });
        expect(live()).toBe(false);
        throw new Error("Origin gone");
      });
      const pending = h.deliver("action", { action: "export", options: exportFixture() });
      await Promise.resolve();
      await h.coordinator.closeTab("tab-origin"); finish(); await pending;
      expect(h.transport.close).toHaveBeenCalledWith("host", "ownerTabClose");
      expect(h.transport.publish).toHaveBeenCalledTimes(1);
      expect(h.transport.publish).toHaveBeenCalledWith("host", expect.objectContaining({ data: { status: "accepted" } }));
    } finally { await h.coordinator.dispose(); }
  });
  it("retains independent Page Size and Export sessions on the same tab", async () => {
    const h = await setup();
    await h.coordinator.openPageSize("tab-origin", { title: "Drawing", width: 1, height: 2, unit: "inch" });
    expect(h.transport.open).toHaveBeenCalledTimes(2);
    await h.coordinator.closeTab("tab-origin"); expect(h.transport.close).toHaveBeenCalledTimes(2);
    await h.coordinator.dispose();
  });
});

it.each(["preparing", "writing", "picking"])("cancel settles while %s and suppresses pending results without a second write", async stage => {
  const h = await setup();
  const write = vi.fn();
  let finish!: () => void;
  let live!: () => boolean;
  const work = async (_tab: string, _options: ExportOptions, isLive: () => boolean): Promise<ExportDialogResult> => {
    live = isLive;
    if (stage === "writing") write();
    await new Promise<void>(resolve => { finish = resolve; });
    if (stage === "preparing" && live()) write();
    return { status: stage === "picking" ? "picked" : "exported", notice: "Late receipt" };
  };
  h.owner.export.mockImplementation(work);
  h.owner.chooseExportDestination.mockImplementation(work);
  try {
    const action = { action: stage === "picking" ? "chooseDestination" : "export", options: exportFixture() };
    const pending = h.deliver("action", action, "first");
    const duplicate = h.deliver("action", action, "first");
    await h.deliver("action", action, "second");
    await h.deliver("action", { action: "cancel" }, "cancel");
    expect(live()).toBe(false);
    expect(h.transport.close).toHaveBeenCalledWith("host", "cancel");
    finish(); await Promise.all([pending, duplicate]);
    expect(write).toHaveBeenCalledTimes(stage === "writing" ? 1 : 0);
    expect(h.transport.publish).toHaveBeenCalledTimes(1);
    expect(h.transport.publish).toHaveBeenCalledWith("host", expect.objectContaining({ data: { status: "accepted" } }));
  } finally { finish?.(); await h.coordinator.dispose(); }
});

it.each(["export", "chooseDestination"])("accepts %s synchronously before owner work, and cancellation during delivery prevents starting it", async action => {
  const h = await setup();
  let accepted!: () => void;
  vi.mocked(h.transport.publish).mockImplementationOnce(() => new Promise<void>(resolve => { accepted = resolve; }));
  try {
    const pending = h.deliver("action", { action, options: exportFixture() }, "press");
    expect(h.transport.publish).toHaveBeenCalledExactlyOnceWith("host", expect.objectContaining({ requestId: "press", data: { status: "accepted" } }));
    expect(h.owner.export).not.toHaveBeenCalled();
    expect(h.owner.chooseExportDestination).not.toHaveBeenCalled();
    await h.deliver("action", { action, options: exportFixture() }, "second-press");
    await h.deliver("action", { action: "cancel" }, "cancel");
    accepted(); await pending;
    expect(h.owner.export).not.toHaveBeenCalled();
    expect(h.owner.chooseExportDestination).not.toHaveBeenCalled();
    expect(h.transport.publish).toHaveBeenCalledTimes(1);
  } finally { accepted?.(); await h.coordinator.dispose(); }
});
