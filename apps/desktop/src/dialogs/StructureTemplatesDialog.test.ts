import { expect, it, vi } from "vitest";
import { structureTemplates } from "@chemdraft/template-library";
import { DialogCoordinator } from "./DialogCoordinator";
import { dialogEnvelope, type DialogMessage, type DialogSnapshot } from "./dialogProtocol";
import type { DialogTransport } from "./dialogTransport";

it("retains the picker, dispatches once per insertion to its originating tab, and dismisses on tab close", async () => {
  let snapshot!: DialogSnapshot;
  const registration = { hostId: "host", windowLabel: "dialog-main-structureTemplates-0" };
  const transport: DialogTransport = { subscribe: async () => () => {},
    open: vi.fn(async message => { snapshot = message as DialogSnapshot; return registration; }),
    publish: vi.fn(async () => {}), close: vi.fn(async () => {}) };
  let finish!: () => void;
  const insert = vi.fn(() => new Promise<void>(resolve => { finish = resolve; }));
  const coordinator = new DialogCoordinator(transport, { applyPageSize() {}, insertTemplate: insert, onError: vi.fn() });
  const receive = (type: "ready" | "action", data: unknown, requestId = "request") => coordinator.receive({ senderWindowId: registration.windowLabel,
    windowLabel: registration.windowLabel, message: { ...dialogEnvelope(snapshot), type, data, requestId } });
  try {
    await coordinator.openStructureTemplates("original-tab", { title: "Drawing A", templateIds: [structureTemplates[0]!.id] });
    await receive("ready", {});
    const first = receive("action", { action: "insert", templateId: structureTemplates[0]!.id }, "first");
    await Promise.resolve(); await Promise.resolve();
    expect(insert).toHaveBeenCalledExactlyOnceWith("original-tab", structureTemplates[0]!.id);
    await receive("action", { action: "insert", templateId: structureTemplates[0]!.id }, "concurrent");
    expect(insert).toHaveBeenCalledTimes(1);
    finish(); await first;
    await receive("action", { action: "insert", templateId: structureTemplates[0]!.id }, "first");
    expect(insert).toHaveBeenCalledTimes(1);
    expect(transport.close).not.toHaveBeenCalled();
    const retained = snapshot;
    await coordinator.openStructureTemplates("original-tab", { title: "Changed", templateIds: [structureTemplates[0]!.id] });
    expect(transport.open).toHaveBeenLastCalledWith(retained);
    insert.mockResolvedValueOnce(undefined);
    await receive("action", { action: "insert", templateId: structureTemplates[1]!.id }, "unlisted");
    expect(insert).toHaveBeenCalledTimes(1);
    await receive("action", { action: "insert", templateId: structureTemplates[0]!.id }, "next");
    expect(insert).toHaveBeenCalledTimes(2);
    await coordinator.closeTab("original-tab");
    expect(transport.close).toHaveBeenCalledExactlyOnceWith("host", "ownerTabClose");
    await receive("action", { action: "insert", templateId: structureTemplates[0]!.id }, "late");
    expect(insert).toHaveBeenCalledTimes(2);
  } finally { await coordinator.dispose(); }
});

it("accepts the next insertion when receipt delivery precedes publish completion", async () => {
  let snapshot!: DialogSnapshot, release!: () => void;
  let delivered!: () => void;
  const delivery = new Promise<void>(resolve => { delivered = resolve; });
  const transport: DialogTransport = { subscribe: async () => () => {},
    open: async message => { snapshot = message as DialogSnapshot; return { hostId: "host", windowLabel: "dialog-main-structureTemplates-0" }; },
    publish: async (_id, message) => {
      if (message.type === "result" && message.data.status === "inserted" && message.requestId === "first") {
        delivered(); await new Promise<void>(resolve => { release = resolve; });
      }
    }, close: async () => {} };
  const insert = vi.fn();
  const coordinator = new DialogCoordinator(transport, { applyPageSize() {}, insertTemplate: insert, onError: vi.fn() });
  const receive = (type: "ready" | "action", requestId: string) => coordinator.receive({ senderWindowId: "dialog-main-structureTemplates-0",
    windowLabel: "dialog-main-structureTemplates-0", message: { ...dialogEnvelope(snapshot), type, requestId,
      data: type === "ready" ? {} : { action: "insert", templateId: structureTemplates[0]!.id } } });
  try {
    await coordinator.openStructureTemplates("original-tab", { title: "A", templateIds: [structureTemplates[0]!.id] });
    await receive("ready", "ready");
    const first = receive("action", "first");
    await delivery;
    await receive("action", "second");
    expect(insert).toHaveBeenCalledTimes(2);
    release(); await first;
  } finally { release?.(); await coordinator.dispose(); }
});
