import { describe, expect, it } from "vitest";
import { DIALOG_MAX_BYTES, parseDialogMessage, validateDialogDelivery, type DialogMessage } from "./dialogProtocol";

export const snapshot = (): Extract<DialogMessage, { type: "snapshot" }> => ({ protocolVersion: 1, ownerWindowId: "main", documentTabId: "tab-1", dialogKind: "pageSize", sessionId: "session-1", requestId: "request-1", snapshotRevision: 1, type: "snapshot", data: { title: "Drawing", width: 8.5, height: 11, unit: "inch" } });
describe.each(["macos", "windows"] as const)("dialog contract on %s", platform => {
  it("accepts only the registered sender and current envelope", () => {
    const s = snapshot();
    const ready: DialogMessage = { ...s, type: "ready", data: {} };
    expect(validateDialogDelivery(ready, "dialog-main-pageSize-1", s, "dialog-main-pageSize-1", platform)).toEqual(ready);
    for (const sender of ["main", "preferences", "dialog-main-pageSize-2"]) expect(validateDialogDelivery(ready, sender, s, "dialog-main-pageSize-1", platform)).toBeUndefined();
    for (const change of [{ sessionId: "old" }, { snapshotRevision: 2 }, { ownerWindowId: "other" }, { documentTabId: "tab-2" }, { dialogKind: "export" }]) {
      expect(validateDialogDelivery({ ...ready, ...change }, "dialog-main-pageSize-1", s, "dialog-main-pageSize-1", platform)).toBeUndefined();
    }
    expect(validateDialogDelivery(s, "main", s, "dialog-main-pageSize-1", platform)).toEqual(s);
    expect(validateDialogDelivery(s, "dialog-main-pageSize-1", s, "dialog-main-pageSize-1", platform)).toBeUndefined();
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
