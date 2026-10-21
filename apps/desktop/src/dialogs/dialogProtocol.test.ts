import { describe, expect, it } from "vitest";
import { DIALOG_PREVIEW_MAX_BYTES, DIALOG_MAX_BYTES, parseDialogMessage, validateDialogDelivery, type DialogMessage } from "./dialogProtocol";

export const snapshot = (): Extract<DialogMessage, { type: "snapshot" }> => ({ protocolVersion: 1, ownerWindowId: "main", documentTabId: "tab-1", dialogKind: "pageSize", sessionId: "session-1", requestId: "request-1", snapshotRevision: 1, type: "snapshot", data: { title: "Drawing", width: 8.5, height: 11, unit: "inch" } });
describe("dialog contract", () => {
  it("accepts only the registered sender and current envelope", () => {
    const s = snapshot();
    const ready: DialogMessage = { ...s, type: "ready", data: {} };
    expect(validateDialogDelivery(ready, "dialog-main-pageSize-1", s, "dialog-main-pageSize-1")).toEqual(ready);
    for (const sender of ["main", "preferences", "dialog-main-pageSize-2"]) expect(validateDialogDelivery(ready, sender, s, "dialog-main-pageSize-1")).toBeUndefined();
    for (const change of [{ sessionId: "old" }, { snapshotRevision: 2 }, { ownerWindowId: "other" }, { documentTabId: "tab-2" }, { dialogKind: "export" }]) {
      expect(validateDialogDelivery({ ...ready, ...change }, "dialog-main-pageSize-1", s, "dialog-main-pageSize-1")).toBeUndefined();
    }
    expect(validateDialogDelivery(s, "main", s, "dialog-main-pageSize-1")).toEqual(s);
    expect(validateDialogDelivery(s, "dialog-main-pageSize-1", s, "dialog-main-pageSize-1")).toBeUndefined();
  });
  it("rejects unknown types, malformed dimensions, extra fields, and oversized payloads", () => {
    const s = snapshot();
    const bad = [null, [], "{}", { ...s, callback: "edit.undo" }, { ...s, protocolVersion: 2 }, { ...s, type: "command" },
      { ...s, snapshotRevision: 1.5 }, { ...s, data: { ...s.data, width: NaN } }, { ...s, data: { ...s.data, height: 0 } },
      { ...s, data: { ...s.data, title: "x".repeat(DIALOG_MAX_BYTES) } }, { ...s, data: { ...s.data, path: "/private" } },
      { ...s, type: "action", data: { action: "invoke", commandId: "edit.undo" } },
      { ...s, type: "action", data: { action: "cancel", width: 10 } }];
    for (const value of bad) expect(parseDialogMessage(value)).toBeUndefined();
    expect(parseDialogMessage({ ...s, data: { ...s.data, title: "😀".repeat(128) } })).toBeDefined();
    expect(parseDialogMessage({ ...s, data: { ...s.data, title: "😀".repeat(129) } })).toBeUndefined();
    expect(parseDialogMessage({ ...s, type: "result", data: { status: "error", error: null } })).toBeUndefined();
    const cycle: Record<string, unknown> = {}; cycle.self = cycle;
    expect(parseDialogMessage(cycle)).toBeUndefined();
  });
});

it("restricts large payloads to typed inline image/PDF previews", () => {
  const message = { ...snapshot(), dialogKind: "export", type: "result", data: { status: "preview", preview: { url: "data:image/png;base64," + "A".repeat(20000), kind: "image", width: 600, height: 400, warnings: [] } } };
  expect(parseDialogMessage(message)).toBeDefined();
  for (const change of [{ url: "https://example.com/image.png" }, { url: "data:image/html;base64,AAAA" }, { width: Infinity }, { warnings: [null] }, { kind: "html" }, { url: "data:image/png;base64," + "A".repeat(DIALOG_PREVIEW_MAX_BYTES) }]) {
    expect(parseDialogMessage({ ...message, data: { ...message.data, preview: { ...message.data.preview, ...change } } })).toBeUndefined();
  }
  expect(parseDialogMessage({ ...message, dialogKind: "pageSize" })).toBeUndefined();
});

it("validates owner frame updates and presentation fields strictly", () => {
  const frame = { page: { width: 100, height: 200 }, content: { width: 80, height: 120 }, revision: 2 };
  const message = { ...snapshot(), dialogKind: "export", type: "result", data: { status: "frame", frame } };
  expect(parseDialogMessage(message)).toBeDefined();
  for (const change of [{ revision: 0 }, { revision: 1.5 }, { page: { width: 0, height: 10 } }, { url: "file:///private" }]) {
    expect(parseDialogMessage({ ...message, data: { status: "frame", frame: { ...frame, ...change } } })).toBeUndefined();
  }
});
