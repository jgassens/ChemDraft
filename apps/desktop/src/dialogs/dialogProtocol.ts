/** Internal host contract. Advance independently of the public plugin API. No document/path URLs. */
import type { ExportOptions, ExportFrame, ExportPreviewResult } from "./exportOptions";
import { validExportOptions } from "./exportOptionsValidation";
export const DIALOG_PROTOCOL_VERSION = 1;
export const DIALOG_MAX_BYTES = 16 * 1024;
export const DIALOG_PREVIEW_MAX_BYTES = 5 * 1024 * 1024;
export type DialogKind = "pageSize" | "arrangementSpacing" | "export";
export type DialogPlatform = "macos" | "windows" | "linux";
export type PageUnit = "inch" | "mm" | "css-px";
export interface PageSize { width: number; height: number; unit: PageUnit }
export interface SpacingSnapshot { title: string; minPercent: number; maxPercent: number }
export interface SpacingPreview { percent: number; index: number; count: number; chunk: string; error?: string }
export const SPACING_PREVIEW_CHUNK_SIZE = 2000;
export const SPACING_PREVIEW_MAX_CHUNKS = 1024;
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
export type DialogSnapshot = DialogEnvelope & (
  | { dialogKind: "pageSize"; type: "snapshot"; data: PageSize & { title: string } }
  | { dialogKind: "arrangementSpacing"; type: "snapshot"; data: SpacingSnapshot }
  | { dialogKind: "export"; type: "snapshot"; data: { title: string; options: ExportOptions; frame?: ExportFrame } }
);
export type DialogMessage = DialogSnapshot | (DialogEnvelope & (
  | { type: "request" | "ready"; data: Record<string, never> }
  | { type: "action"; data: ({ action: "apply" } & PageSize) | { action: "apply" | "preview"; percent: number } | { action: "cancel" } | { action: "export" | "chooseDestination" | "preview"; options: ExportOptions } }
  | { type: "preview"; data: SpacingPreview }
  | { type: "result"; data: { status: "accepted" | "applied" | "progress" | ExportDialogResult["status"] | "preview" | "frame"; preview?: ExportPreviewResult; frame?: ExportFrame; error?: string; destinationPath?: string; filename?: string; notice?: string } }
  | { type: "closed"; data: { reason: DialogCloseReason } }
));
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
export const validSpacingPercent = (v: unknown): v is number => Number.isInteger(v) && Number(v) >= 25 && Number(v) <= 150;
export function parseDialogMessage(value: unknown): DialogMessage | undefined {
  try {
    if (new TextEncoder().encode(JSON.stringify(value)).length > (record(value) && value.dialogKind === "export" && value.type === "result" && record(value.data) && value.data.status === "preview" ? DIALOG_PREVIEW_MAX_BYTES : DIALOG_MAX_BYTES)) return undefined;
    if (!record(value) || !keys(value, ["protocolVersion", "ownerWindowId", "documentTabId", "dialogKind", "sessionId", "requestId", "snapshotRevision", "type", "data"])) return undefined;
    if (value.protocolVersion !== 1 || value.ownerWindowId !== "main" || typeof value.dialogKind !== "string" || !["pageSize", "arrangementSpacing", "export"].includes(value.dialogKind) ||
        !token(value.documentTabId) || !token(value.sessionId) || !token(value.requestId) ||
        !Number.isSafeInteger(value.snapshotRevision) || Number(value.snapshotRevision) < 1 || !record(value.data)) return undefined;
    const d = value.data;
    let valid = false;
    switch (value.type) {
      case "snapshot": valid = typeof d.title === "string" && d.title.length > 0 && d.title.length <= 256 &&
        (value.dialogKind === "pageSize" ? keys(d, ["title", "width", "height", "unit"]) && validPageSize(d) :
          value.dialogKind === "arrangementSpacing" ? keys(d, ["title", "minPercent", "maxPercent"]) && validSpacingPercent(d.minPercent) && validSpacingPercent(d.maxPercent) && d.minPercent <= 100 && d.maxPercent >= 100 :
          keys(d, ["title", "options"], ["frame"]) && validExportOptions(d.options) && (d.frame === undefined || validExportFrame(d.frame))); break;
      case "request": case "ready": valid = keys(d, []); break;
      case "action": valid = d.action === "cancel" ? keys(d, ["action"]) : value.dialogKind === "pageSize"
        ? d.action === "apply" && keys(d, ["action", "width", "height", "unit"]) && validPageSize(d)
        : value.dialogKind === "arrangementSpacing" ? ["apply", "preview"].includes(String(d.action)) && keys(d, ["action", "percent"]) && validSpacingPercent(d.percent)
        : typeof d.action === "string" && ["export", "chooseDestination", "preview"].includes(d.action) && keys(d, ["action", "options"]) && validExportOptions(d.options); break;
      case "result": if (value.dialogKind === "export" && d.status === "frame") { valid = keys(d, ["status", "frame"]) && validExportFrame(d.frame); break; } if (value.dialogKind === "export" && d.status === "preview") { valid = keys(d, ["status", "preview"]) && validExportPreview(d.preview); break; } valid = keys(d, ["status"], value.dialogKind !== "export" ? ["error"] : ["error", "notice", "destinationPath", "filename"]) &&
        typeof d.status === "string" && (value.dialogKind !== "export" ? ["accepted", "applied", "cancelled", "error"] : ["accepted", "progress", "picked", "exported", "cancelled", "error"]).includes(d.status) &&
        (d.error === undefined || (typeof d.error === "string" && d.error.length <= 2048)) &&
        (d.notice === undefined || (typeof d.notice === "string" && d.notice.length <= 1024)) &&
        (d.destinationPath === undefined || (typeof d.destinationPath === "string" && d.destinationPath.length <= 1024 && !d.destinationPath.includes("\0"))) &&
        (d.filename === undefined || (typeof d.filename === "string" && d.filename.length <= 256)); break;
      case "preview": valid = value.dialogKind === "arrangementSpacing" && keys(d, ["percent", "index", "count", "chunk"], ["error"]) && validSpacingPercent(d.percent) &&
        Number.isInteger(d.count) && Number(d.count) >= 1 && Number(d.count) <= SPACING_PREVIEW_MAX_CHUNKS && Number.isInteger(d.index) && Number(d.index) >= 0 && Number(d.index) < Number(d.count) &&
        typeof d.chunk === "string" && d.chunk.length <= SPACING_PREVIEW_CHUNK_SIZE && /^[A-Za-z0-9+/=]*$/.test(d.chunk) &&
        (d.error === undefined || (typeof d.error === "string" && d.error.length <= 256 && d.chunk === "" && d.index === 0 && d.count === 1)); break;
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
  const expected = message.type === "snapshot" || message.type === "preview" || message.type === "result" || message.type === "closed" ? snapshot.ownerWindowId : label;
  return sender === expected ? message : undefined;
}
export function detectDialogPlatform(): DialogPlatform {
  return typeof navigator !== "undefined" && /Mac/.test(navigator.platform) ? "macos" : "windows";
}
export function dialogEnvelope(message: DialogEnvelope): DialogEnvelope {
  const { protocolVersion, ownerWindowId, documentTabId, dialogKind, sessionId, requestId, snapshotRevision } = message;
  return { protocolVersion, ownerWindowId, documentTabId, dialogKind, sessionId, requestId, snapshotRevision };
}

export function validExportFrame(v: unknown): v is ExportFrame {
  const size = (s: unknown) => record(s) && keys(s, ["width", "height"]) && [s.width, s.height].every(n => typeof n === "number" && Number.isFinite(n) && n > 0 && n <= 100000);
  return record(v) && keys(v, ["page", "content"], ["revision"]) && (v.revision === undefined || Number.isSafeInteger(v.revision) && Number(v.revision) > 0) && size(v.page) && size(v.content);
}
export function validExportPreview(v: unknown): v is ExportPreviewResult {
  return record(v) && keys(v, ["url", "kind", "width", "height", "warnings"]) &&
    typeof v.url === "string" && (v.kind === "pdf" ? /^data:application\/pdf;base64,[A-Za-z0-9+/]*={0,2}$/.test(v.url) : v.kind === "image" && /^data:image\/(png|jpeg|svg\+xml);base64,[A-Za-z0-9+/]*={0,2}$/.test(v.url)) &&
    [v.width, v.height].every(n => typeof n === "number" && Number.isFinite(n) && n > 0 && n <= 8192) &&
    Array.isArray(v.warnings) && v.warnings.length <= 100 && v.warnings.every(w => typeof w === "string" && w.length <= 2048);
}
