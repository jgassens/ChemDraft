/** Internal host contract. Advance independently of the public plugin API. No document/path URLs. */
import type { ExportOptions } from "./exportOptions";
import { validExportOptions } from "./exportOptionsValidation";
export const DIALOG_PROTOCOL_VERSION = 1;
export const DIALOG_MAX_BYTES = 16 * 1024;
export type DialogKind = "pageSize" | "export";
export type DialogPlatform = "macos" | "windows" | "linux";
export type PageUnit = "inch" | "mm" | "css-px";
export interface PageSize { width: number; height: number; unit: PageUnit }
export interface DialogEnvelope {
  protocolVersion: 1;
  ownerWindowId: string;
  documentTabId: string;
  dialogKind: DialogKind;
  sessionId: string;
  requestId: string;
  snapshotRevision: number;
}
export type DialogCloseReason = "apply" | "cancel" | "close" | "destroy" | "ownerTabClose" | "ownerClose" | "quit" | "error";
export interface ExportDialogResult {
  status: "picked" | "exported" | "cancelled" | "error";
  destinationPath?: string;
  filename?: string;
  notice?: string;
  error?: string;
}
export type DialogMessage = DialogEnvelope & (
  | { dialogKind: "pageSize"; type: "snapshot"; data: PageSize & { title: string } }
  | { dialogKind: "export"; type: "snapshot"; data: { title: string; options: ExportOptions } }
  | { type: "request" | "ready"; data: Record<string, never> }
  | { type: "action"; data: ({ action: "apply" } & PageSize) | { action: "cancel" } | { action: "export" | "chooseDestination"; options: ExportOptions } }
  | { type: "result"; data: { status: "applied" | "progress" | ExportDialogResult["status"]; error?: string; destinationPath?: string; filename?: string; notice?: string } }
  | { type: "closed"; data: { reason: DialogCloseReason } }
);
export interface DialogRegistration { hostId: string; windowLabel: string }

const reasons = new Set<DialogCloseReason>(["apply", "cancel", "close", "destroy", "ownerTabClose", "ownerClose", "quit", "error"]);
const record = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === "object" && !Array.isArray(v);
const keys = (v: Record<string, unknown>, required: string[], optional: string[] = []) =>
  required.every(k => Object.hasOwn(v, k)) && Object.keys(v).every(k => required.includes(k) || optional.includes(k));
const token = (v: unknown): v is string => typeof v === "string" && /^[A-Za-z0-9_-]{1,128}$/.test(v);
export function validPageSize(v: unknown): v is PageSize {
  return record(v) && typeof v.unit === "string" && ["inch", "mm", "css-px"].includes(v.unit) &&
    typeof v.width === "number" && Number.isFinite(v.width) && v.width > 0 && v.width <= 100000 &&
    typeof v.height === "number" && Number.isFinite(v.height) && v.height > 0 && v.height <= 100000;
}
export function parseDialogMessage(value: unknown): DialogMessage | undefined {
  try {
    if (new TextEncoder().encode(JSON.stringify(value)).length > DIALOG_MAX_BYTES) return undefined;
    if (!record(value) || !keys(value, ["protocolVersion", "ownerWindowId", "documentTabId", "dialogKind", "sessionId", "requestId", "snapshotRevision", "type", "data"])) return undefined;
    if (value.protocolVersion !== 1 || value.ownerWindowId !== "main" || typeof value.dialogKind !== "string" || !["pageSize", "export"].includes(value.dialogKind) ||
        !token(value.documentTabId) || !token(value.sessionId) || !token(value.requestId) ||
        !Number.isSafeInteger(value.snapshotRevision) || Number(value.snapshotRevision) < 1 || !record(value.data)) return undefined;
    const d = value.data;
    let valid = false;
    switch (value.type) {
      case "snapshot": valid = typeof d.title === "string" && d.title.length > 0 && d.title.length <= 256 &&
        (value.dialogKind === "pageSize" ? keys(d, ["title", "width", "height", "unit"]) && validPageSize(d) :
          keys(d, ["title", "options"]) && validExportOptions(d.options)); break;
      case "request": case "ready": valid = keys(d, []); break;
      case "action": valid = d.action === "cancel" ? keys(d, ["action"]) : value.dialogKind === "pageSize"
        ? d.action === "apply" && keys(d, ["action", "width", "height", "unit"]) && validPageSize(d)
        : typeof d.action === "string" && ["export", "chooseDestination"].includes(d.action) && keys(d, ["action", "options"]) && validExportOptions(d.options); break;
      case "result": valid = keys(d, ["status"], value.dialogKind === "pageSize" ? ["error"] : ["error", "notice", "destinationPath", "filename"]) &&
        typeof d.status === "string" && (value.dialogKind === "pageSize" ? ["applied", "cancelled", "error"] : ["progress", "picked", "exported", "cancelled", "error"]).includes(d.status) &&
        (d.error === undefined || (typeof d.error === "string" && d.error.length <= 2048)) &&
        (d.notice === undefined || (typeof d.notice === "string" && d.notice.length <= 1024)) &&
        (d.destinationPath === undefined || (typeof d.destinationPath === "string" && d.destinationPath.length <= 1024 && !d.destinationPath.includes("\0"))) &&
        (d.filename === undefined || (typeof d.filename === "string" && d.filename.length <= 256)); break;
      case "closed": valid = keys(d, ["reason"]) && reasons.has(d.reason as DialogCloseReason); break;
    }
    return valid ? value as unknown as DialogMessage : undefined;
  } catch { return undefined; }
}
export function sameDialog(message: DialogEnvelope, snapshot: DialogEnvelope): boolean {
  return message.ownerWindowId === snapshot.ownerWindowId && message.documentTabId === snapshot.documentTabId &&
    message.dialogKind === snapshot.dialogKind && message.sessionId === snapshot.sessionId && message.snapshotRevision === snapshot.snapshotRevision;
}
/** Envelope consistency check for Rust channel deliveries. Sender fields alone are not authentication. */
export function validateDialogDelivery(value: unknown, sender: string, snapshot: DialogEnvelope, label: string): DialogMessage | undefined {
  const message = parseDialogMessage(value);
  if (!message || !sameDialog(message, snapshot)) return undefined;
  const expected = message.type === "snapshot" || message.type === "result" || message.type === "closed" ? snapshot.ownerWindowId : label;
  return sender === expected ? message : undefined;
}
export function detectDialogPlatform(): DialogPlatform {
  return typeof navigator !== "undefined" && /Mac/.test(navigator.platform) ? "macos" : "windows";
}
export function dialogEnvelope(message: DialogEnvelope): DialogEnvelope {
  const { protocolVersion, ownerWindowId, documentTabId, dialogKind, sessionId, requestId, snapshotRevision } = message;
  return { protocolVersion, ownerWindowId, documentTabId, dialogKind, sessionId, requestId, snapshotRevision };
}
