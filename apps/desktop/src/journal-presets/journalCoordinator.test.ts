import { describe, expect, it, vi } from "vitest";
import { DialogCoordinator } from "../dialogs/DialogCoordinator";
import { dialogEnvelope, type DialogMessage, type DialogSnapshot } from "../dialogs/dialogProtocol";
import type { DialogTransport } from "../dialogs/dialogTransport";
import { initialJournalRequest } from "./catalog";

async function setup() {
  let snapshot!: DialogSnapshot;
  const transport: DialogTransport = { subscribe: vi.fn(async () => () => {}),
    open: vi.fn(async s => { snapshot = s as DialogSnapshot; return { hostId: "host", windowLabel: "dialog-main-journalPresets-1" }; }),
    publish: vi.fn(async () => {}), close: vi.fn(async () => {}) };
  const owner = { applyPageSize: vi.fn(), applyJournalPreset: vi.fn(), previewJournalPreset: vi.fn(async () => ({ url: "data:image/svg+xml;base64,PHN2Zy8+", kind: "image" as const, width: 100, height: 100, warnings: [] })), onError: vi.fn(), onJournalSettled: vi.fn() };
  const coordinator = new DialogCoordinator(transport, owner);
  await coordinator.openJournalPresets("origin", { title: "Original drawing", selectionCount: 3 });
  const deliver = (type: string, data: unknown, id: string = crypto.randomUUID()) => coordinator.receive({ message: { ...dialogEnvelope(snapshot), type, data, requestId: id }, senderWindowId: "dialog-main-journalPresets-1", windowLabel: "dialog-main-journalPresets-1" });
  await deliver("ready", {});
  return { coordinator, transport, owner, deliver };
}
it("previews without applying, reserves Apply against double delivery, and addresses the origin tab", async () => {
  const h = await setup();
  await h.deliver("action", { action: "preview", journal: initialJournalRequest });
  expect(h.owner.applyJournalPreset).not.toHaveBeenCalled(); expect(h.owner.previewJournalPreset).toHaveBeenCalledWith("origin", initialJournalRequest);
  let finish!: () => void;
  h.owner.applyJournalPreset.mockImplementation(() => new Promise<void>(resolve => { finish = resolve; }));
  const first = h.deliver("action", { action: "apply", journal: initialJournalRequest }, "apply-first");
  await h.deliver("action", { action: "apply", journal: initialJournalRequest }, "apply-second");
  expect(h.owner.applyJournalPreset).toHaveBeenCalledExactlyOnceWith("origin", initialJournalRequest);
  finish(); await first;
  expect(h.transport.close).toHaveBeenCalledWith("host", "apply"); await h.coordinator.dispose();
});
it("cancels without mutating and closes when the originating tab closes", async () => {
  const h = await setup(); await h.deliver("action", { action: "cancel" });
  expect(h.owner.applyJournalPreset).not.toHaveBeenCalled(); expect(h.owner.onJournalSettled).toHaveBeenCalledWith("origin");
  await h.coordinator.dispose();
  const other = await setup(); await other.coordinator.closeTab("origin");
  expect(other.transport.close).toHaveBeenCalledWith("host", "ownerTabClose"); await other.coordinator.dispose();
});
it("keeps the window open for a stale-document error and allows a deliberate retry", async () => {
  const h = await setup(); h.owner.applyJournalPreset.mockRejectedValueOnce(new Error("Drawing changed"));
  await h.deliver("action", { action: "apply", journal: initialJournalRequest });
  const receipts = vi.mocked(h.transport.publish).mock.calls.map(call => call[1] as DialogMessage);
  expect(receipts).toContainEqual(expect.objectContaining({ type: "result", data: { status: "error", error: "Error: Drawing changed" } }));
  expect(h.transport.close).not.toHaveBeenCalled(); await h.coordinator.dispose();
});
