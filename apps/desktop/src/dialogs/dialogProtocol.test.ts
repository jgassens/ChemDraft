import { describe, expect, it } from "vitest";
import { structureTemplates } from "@chemdraft/template-library";
import { engineInstallFixture } from "./engineInstallTestFixtures";
import { toolInstallFixture } from "./toolInstallTestFixtures";
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

it("validates spacing kinds, bounded preview chunks and typed actions without broadening page-size messages", () => {
  const s = { ...snapshot(), dialogKind: "arrangementSpacing", data: { title: "Selection", minPercent: 25, maxPercent: 150 } };
  expect(parseDialogMessage(s)).toBeDefined();
  const preview = { ...s, type: "preview", data: { percent: 100, index: 0, count: 1, chunk: "PHN2Zy8+" } };
  expect(parseDialogMessage(preview)).toBeDefined();
  for (const data of [ { ...preview.data, chunk: "x".repeat(2001) }, { ...preview.data, count: 1025 }, { ...preview.data, index: 1 }, { ...preview.data, percent: 24 }, { ...preview.data, error: "bad" }, { ...preview.data, chunk: "https://example.com" } ]) expect(parseDialogMessage({...preview,data})).toBeUndefined();
  expect(parseDialogMessage({...s,type:"action",data:{action:"preview",percent:80}})).toBeDefined();
  expect(parseDialogMessage({...snapshot(),type:"action",data:{action:"preview",percent:80}})).toBeUndefined();
  expect(parseDialogMessage({...s,type:"action",data:{action:"apply",percent:NaN}})).toBeUndefined();
  expect(parseDialogMessage({...s,type:"result",data:{status:"accepted"}})).toBeDefined();
  expect(parseDialogMessage({...s,type:"result",data:{status:"exported"}})).toBeUndefined();
  expect(parseDialogMessage({...preview,dialogKind:"export"})).toBeUndefined();
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

it("validates engine install snapshots, states and actions strictly within the delivery budget", () => {
  const data = engineInstallFixture();
  const message = { ...snapshot(), dialogKind: "engineInstall", data };
  expect(parseDialogMessage(message)).toBeDefined();
  const states = [
    { state: { status: "broken", detail: "Damaged receipt" }, buttons: ["install", "close"] },
    { state: { status: "installing", phase: "Installing Python", step: 2, steps: 5, bytesDone: 100, bytesTotal: 200, estimated: true }, buttons: ["cancelInstall", "close"] },
    { state: { status: "installed" }, buttons: ["close"] },
    { state: { status: "failed", message: "Download failed" }, buttons: ["close"] }
  ];
  for (const state of states) expect(parseDialogMessage({ ...message, data: { ...data, ...state } })).toBeDefined();
  for (const action of ["install", "cancelInstall", "close"]) {
    expect(parseDialogMessage({ ...message, type: "action", data: { action } })).toBeDefined();
    expect(parseDialogMessage({ ...message, type: "action", data: { action, path: "/tmp" } })).toBeUndefined();
  }
  for (const change of [
    { path: "/tmp" }, { freeDiskBytes: -1 }, { requiredDiskBytes: 1.5 }, { freeDiskBytes: Number.MAX_SAFE_INTEGER + 1 },
    { state: { status: "notInstalled", detail: "unknown" } }, { state: { status: "unsupported" } },
    { state: { status: "broken", detail: null } }, { buttons: ["install", "cancelInstall", "close"] },
    { ...states[1], state: { ...states[1]!.state, step: 6 } },
    { ...states[1], state: { ...states[1]!.state, estimated: "yes" } },
    { disclosure: "x".repeat(16384) },
    { disclosure: "\\u0001".repeat(1024) }
  ]) expect(parseDialogMessage({ ...message, data: { ...data, ...change } })).toBeUndefined();
  expect(parseDialogMessage({ ...message, type: "action", data: { action: "cancel" } })).toBeUndefined();
  expect(parseDialogMessage({ ...message, type: "action", data: { action: ["install"] } })).toBeUndefined();
  expect(parseDialogMessage({ ...message, type: "result", data: { status: ["accepted"] } })).toBeUndefined();
  expect(parseDialogMessage({ ...message, type: "result", data: { status: "exported" } })).toBeUndefined();
});

it("validates tool install snapshots, states and actions fail closed", () => {
  const data = toolInstallFixture();
  const message = { ...snapshot(), dialogKind: "toolInstall", data };
  expect(parseDialogMessage(message)).toBeDefined();
  for (const state of [
    { state: { status: "consent" }, buttons: ["allow", "close"] },
    { state: { status: "installing", phase: "Downloading", bytesDone: 1, bytesTotal: 2 }, buttons: ["cancelInstall", "close"] },
    { state: { status: "installed" }, buttons: ["close"] },
    { state: { status: "broken", detail: "Receipt missing" }, buttons: ["install", "close"] }
  ]) expect(parseDialogMessage({ ...message, data: { ...data, ...state } })).toBeDefined();
  expect(parseDialogMessage({ ...message, data: { ...data, freeDiskBytes: null } })).toBeDefined();
  for (const intent of ["download", "update", "use"]) {
    expect(parseDialogMessage({ ...message, data: { ...data, intent } })).toBeDefined();
  }
  for (const action of ["install", "allow", "cancelInstall", "close"]) expect(parseDialogMessage({ ...message, type: "action", data: { action } })).toBeDefined();
  for (const change of [
    { publisher: "" }, { version: "x".repeat(41) }, { downloadBytes: -1 },
    { intent: "repair" }, { intent: null }, { intent: ["update"] }, { intent: true },
    { freeDiskBytes: -1 }, { freeDiskBytes: "unknown" },
    { state: { status: "consent", extra: true } }, { buttons: ["install", "allow", "close"] },
    { state: { status: "installing", phase: "Downloading", bytesDone: 1.5 }, buttons: ["cancelInstall", "close"] }
  ]) expect(parseDialogMessage({ ...message, data: { ...data, ...change } })).toBeUndefined();
});
it("validates the template picker snapshot and its restricted actions", () => {
  const message = { ...snapshot(), dialogKind: "structureTemplates", data: { title: "Drawing", templateIds: structureTemplates.map(template => template.id) } };
  expect(parseDialogMessage(message)).toEqual(message);
  for (const data of [{ title: "Drawing" }, { title: "", templateIds: [] }, { ...message.data, templateIds: ["unknown"] },
    { ...message.data, templateIds: [structureTemplates[0]!.id, structureTemplates[0]!.id] }, { ...message.data, svg: "<script/>" }]) {
    expect(parseDialogMessage({ ...message, data })).toBeUndefined();
  }
  expect(parseDialogMessage({ ...message, type: "action", data: { action: "insert", templateId: structureTemplates[0]!.id } })).toBeDefined();
  for (const data of [{ action: "insert" }, { action: "insert", templateId: "../main" }, { action: "insert", templateId: "unknown" },
    { action: "insert", templateId: structureTemplates[0]!.id, commandId: "document.new" }, { action: "apply" }]) {
    expect(parseDialogMessage({ ...message, type: "action", data })).toBeUndefined();
  }
  expect(parseDialogMessage({ ...message, type: "result", data: { status: "inserted" } })).toBeDefined();
});
