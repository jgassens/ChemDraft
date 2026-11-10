import type { ReactionConditionsDraft } from "@chemdraft/document-workflow-core";
export type ConditionsSnapshot = { title: string; arrowId: string; draft: ReactionConditionsDraft };
/** Internal host contract. Advance independently of the public plugin API. No document/path URLs. */
import type { ExportOptions, ExportFrame, ExportPreviewResult } from "./exportOptions";
import type { CustomSwatchNumber, CustomSwatchSlot } from "../customColorSwatches";
import { validExportOptions } from "./exportOptionsValidation";
import { validInsertTableOptions, type InsertTableOptions } from "./insertTableOptions";
export { validInsertTableOptions, type InsertTableOptions } from "./insertTableOptions";
import { structureTemplateById } from "@chemdraft/template-library";
import { validDialogContentFit, type DialogContentFit } from "./dialogContentFit";
export type { DialogContentFit } from "./dialogContentFit";
export const DIALOG_PROTOCOL_VERSION = 1;
export const DIALOG_MAX_BYTES = 16 * 1024;
export const DIALOG_PREVIEW_MAX_BYTES = 5 * 1024 * 1024;
export type DialogKind = "pageSize" | "arrangementSpacing" | "reactionConditions" | "export" | "engineInstall" | "toolInstall" | "customColor" | "insertTable" | "structureTemplates" | "atomProblem" | "vibeCodeGuide";
export type { AtomProblemAction } from "@chemdraft/document-workflow-core";
import type { AtomProblemAction } from "@chemdraft/document-workflow-core";
export interface AtomProblemSnapshot {
  title: string; explanation: string; targetVersion: number;
  fixes: { action: AtomProblemAction; label: string }[];
}
const problemActions = ["hydrogens", "charge", "ignore", "restore"];
const SMALL_DIALOG_MAX_BYTES = 3400;
const serializedBytes = (value: unknown) => new TextEncoder().encode(JSON.stringify(value)).length;

/** Clip JSON string content by encoded bytes and schema length without splitting a code point. */
function clipDialogText(text: string, maxLength: number, maxBytes: number): string {
  let result = "", bytes = 0;
  for (const character of text) {
    const size = serializedBytes(character) - 2; // Exclude JSON's surrounding quotes.
    if (result.length + character.length > maxLength || bytes + size > maxBytes) break;
    result += character;
    bytes += size;
  }
  return result;
}

export function boundedAtomProblemSnapshot(data: AtomProblemSnapshot): AtomProblemSnapshot {
  // Reserve the largest valid envelope, including later snapshot revisions and retargets.
  const empty = { ...data, title: "", explanation: "" };
  const overhead = serializedBytes({ protocolVersion: 1, ownerWindowId: "main", dialogKind: "atomProblem",
    documentTabId: "x".repeat(128), sessionId: "x".repeat(128), requestId: "x".repeat(128),
    snapshotRevision: Number.MAX_SAFE_INTEGER, type: "snapshot", data: empty });
  const title = clipDialogText(data.title, 256, 768);
  const remaining = SMALL_DIALOG_MAX_BYTES - overhead - (serializedBytes(title) - 2);
  return { ...data, title, explanation: clipDialogText(data.explanation, 1024, remaining) };
}
export interface CustomColorSnapshot { title: string; swatch: CustomSwatchNumber; slot: CustomSwatchSlot; color: string | null }
const validCustomHex = (value: unknown): value is string => typeof value === "string" && /^#[0-9a-f]{6}$(?![\s\S])/.test(value);
export interface StructureTemplatesSnapshot { title: string; templateIds: string[] }
export type EngineInstallAction = "install" | "cancelInstall" | "close";
export type ToolInstallAction = "install" | "allow" | "cancelInstall" | "close";
export type EngineInstallState =
  | { status: "notInstalled" | "installed" }
  | { status: "broken"; detail: string }
  | { status: "failed"; message: string }
  | { status: "installing"; phase: string; step: number; steps: number; bytesDone: number; bytesTotal: number; estimated: boolean };
export interface EngineInstallSnapshot {
  title: string;
  engineName: string;
  pluginName: string;
  pluginId: string;
  disclosure: string;
  requiredDiskBytes: number;
  freeDiskBytes: number;
  state: EngineInstallState;
  buttons: EngineInstallAction[];
}
export type ToolInstallState =
  | { status: "notInstalled" | "consent" | "installed" }
  | { status: "installing"; phase: string; bytesDone?: number; bytesTotal?: number }
  | { status: "failed"; message: string }
  | { status: "broken"; detail: string };
export interface ToolInstallSnapshot {
  title: string; toolName: string; publisher: string; version: string; downloadHost: string; downloadBytes: number;
  pluginName: string; pluginId: string; disclosure: string; requiredDiskBytes: number; freeDiskBytes: number | null;
  state: ToolInstallState; buttons: ToolInstallAction[];
  intent?: "download" | "update" | "use";
}
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
  | { dialogKind: "atomProblem"; type: "snapshot"; data: AtomProblemSnapshot }
  | { dialogKind: "customColor"; type: "snapshot"; data: CustomColorSnapshot }
  | { dialogKind: "insertTable"; type: "snapshot"; data: InsertTableOptions & { title: string } }
  | { dialogKind: "pageSize"; type: "snapshot"; data: PageSize & { title: string } }
  | { dialogKind: "arrangementSpacing"; type: "snapshot"; data: SpacingSnapshot }
  | { dialogKind: "reactionConditions"; type: "snapshot"; data: ConditionsSnapshot }
  | { dialogKind: "export"; type: "snapshot"; data: { title: string; options: ExportOptions; frame?: ExportFrame } }
  | { dialogKind: "engineInstall"; type: "snapshot"; data: EngineInstallSnapshot }
  | { dialogKind: "toolInstall"; type: "snapshot"; data: ToolInstallSnapshot }
  | { dialogKind: "structureTemplates"; type: "snapshot"; data: StructureTemplatesSnapshot }
  | { dialogKind: "vibeCodeGuide"; type: "snapshot"; data: { title: string } }
);
export type DialogMessage = DialogSnapshot | (DialogEnvelope & (
  | { type: "request"; data: Record<string, never> }
  /** Native host only: explicitly repeat a measurement, even if it has not changed. */
  | { type: "remeasure"; data: Record<string, never> }
  | { type: "ready"; data: Record<string, never> | DialogContentFit }
  | { type: "action"; data: ({ action: "apply" } & (PageSize | InsertTableOptions)) | { action: "apply"; hex: string } | { action: "clear" } | { action: "apply"; draft: ReactionConditionsDraft } | { action: AtomProblemAction; targetVersion: number } | { action: "apply" | "preview"; percent: number } | { action: "insert"; templateId: string } | { action: "cancel" | "saveStarter" | "openPluginManager" } | { action: EngineInstallAction | ToolInstallAction } | { action: "export" | "chooseDestination" | "preview"; options: ExportOptions } }
  | { type: "preview"; data: SpacingPreview }
  | { type: "result"; data: { status: "accepted" | "applied" | "inserted" | "progress" | ExportDialogResult["status"] | "preview" | "frame"; preview?: ExportPreviewResult; frame?: ExportFrame; error?: string; destinationPath?: string; filename?: string; notice?: string } }
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
export function validConditionsDraft(v: unknown): v is ReactionConditionsDraft {
  return record(v) && keys(v, ["side", "spans"]) && ["above", "below"].includes(String(v.side)) &&
    Array.isArray(v.spans) && v.spans.length <= 128 && v.spans.every(span => record(span) && keys(span, ["text", "script"]) &&
      typeof span.text === "string" && ["normal", "subscript", "superscript"].includes(String(span.script))) &&
    v.spans.map(span => span.text).join("").length <= 2000 && new TextEncoder().encode(JSON.stringify(v)).length <= 2500;
}
export function parseDialogMessage(value: unknown): DialogMessage | undefined {
  try {
    if (new TextEncoder().encode(JSON.stringify(value)).length > (record(value) && value.dialogKind === "export" && value.type === "result" && record(value.data) && value.data.status === "preview" ? DIALOG_PREVIEW_MAX_BYTES : DIALOG_MAX_BYTES)) return undefined;
    if (!record(value) || !keys(value, ["protocolVersion", "ownerWindowId", "documentTabId", "dialogKind", "sessionId", "requestId", "snapshotRevision", "type", "data"])) return undefined;
    if (value.protocolVersion !== 1 || value.ownerWindowId !== "main" || typeof value.dialogKind !== "string" || !["pageSize", "arrangementSpacing", "reactionConditions", "export", "engineInstall", "toolInstall", "insertTable", "customColor", "structureTemplates", "atomProblem", "vibeCodeGuide"].includes(value.dialogKind) ||
        !token(value.documentTabId) || !token(value.sessionId) || !token(value.requestId) ||
        !Number.isSafeInteger(value.snapshotRevision) || Number(value.snapshotRevision) < 1 || !record(value.data)) return undefined;
    const d = value.data;
    // Room for the Rust-written delivery wrapper, including the longest native label.
    if ((value.dialogKind === "engineInstall" || value.dialogKind === "toolInstall" || value.dialogKind === "atomProblem") && serializedBytes(value) > SMALL_DIALOG_MAX_BYTES) return undefined;
    let valid = false;
    if (value.dialogKind === "atomProblem") {
      const text = (v: unknown, max: number) => typeof v === "string" && v.length > 0 && v.length <= max && !v.includes("\0");
      switch (value.type) {
        case "snapshot": valid = keys(d, ["title", "explanation", "targetVersion", "fixes"]) && text(d.title, 256) && text(d.explanation, 1024) &&
          Number.isSafeInteger(d.targetVersion) && Number(d.targetVersion) > 0 && Array.isArray(d.fixes) && d.fixes.length <= 4 &&
          d.fixes.every(f => record(f) && keys(f, ["action", "label"]) && problemActions.includes(String(f.action)) && text(f.label, 128)) &&
          new Set(d.fixes.map(f => f.action)).size === d.fixes.length; break;
        case "action": valid = d.action === "cancel" ? keys(d, ["action"]) : keys(d, ["action", "targetVersion"]) && problemActions.includes(String(d.action)) && Number.isSafeInteger(d.targetVersion) && Number(d.targetVersion) > 0; break;
        case "request": valid = keys(d, []); break;
        case "ready": valid = keys(d, []) || validDialogContentFit(d); break;
        case "closed": valid = keys(d, ["reason"]) && reasons.has(d.reason as DialogCloseReason); break;
        case "result": valid = keys(d, ["status"], ["error"]) && ["accepted", "applied", "cancelled", "error"].includes(String(d.status)) && (d.error === undefined || typeof d.error === "string" && d.error.length <= 2048); break;
      }
      return valid ? value as unknown as DialogMessage : undefined;
    }
    if (value.dialogKind === "structureTemplates") {
      switch (value.type) {
        case "snapshot": valid = keys(d, ["title", "templateIds"]) && typeof d.title === "string" && d.title.length > 0 && d.title.length <= 256 && !d.title.includes("\0") &&
          Array.isArray(d.templateIds) && d.templateIds.length > 0 && d.templateIds.length <= 64 && new Set(d.templateIds).size === d.templateIds.length &&
          d.templateIds.every(id => typeof id === "string" && !!structureTemplateById(id)); break;
        case "action": valid = d.action === "cancel" ? keys(d, ["action"]) : d.action === "insert" && keys(d, ["action", "templateId"]) && typeof d.templateId === "string" && !!structureTemplateById(d.templateId); break;
        case "request": valid = keys(d, []); break;
        case "ready": valid = keys(d, []) || validDialogContentFit(d); break;
        case "closed": valid = keys(d, ["reason"]) && reasons.has(d.reason as DialogCloseReason); break;
        case "result": valid = keys(d, ["status"], ["error"]) && ["accepted", "inserted", "cancelled", "error"].includes(String(d.status)) &&
          (d.error === undefined || typeof d.error === "string" && d.error.length <= 2048); break;
      }
      return valid ? value as unknown as DialogMessage : undefined;
    }
    switch (value.type) {
      case "snapshot": valid = typeof d.title === "string" && d.title.length > 0 && d.title.length <= 256 &&
        (value.dialogKind === "customColor" ? keys(d, ["title", "swatch", "slot", "color"]) && !d.title.includes("\0") && [1, 2, 3, 4].includes(Number(d.swatch)) && Number.isInteger(d.swatch) && (d.slot === 1 || d.slot === 2) && (d.color === null || validCustomHex(d.color)) : value.dialogKind === "vibeCodeGuide" ? keys(d, ["title"]) && !d.title.includes("\0") : value.dialogKind === "insertTable" ? keys(d, ["title", "rows", "columns", "headerRows", "preset"]) && validInsertTableOptions(d) : value.dialogKind === "engineInstall" ? validEngineInstallSnapshot(d) : value.dialogKind === "toolInstall" ? validToolInstallSnapshot(d) : value.dialogKind === "pageSize" ? keys(d, ["title", "width", "height", "unit"]) && validPageSize(d) :
          value.dialogKind === "arrangementSpacing" ? keys(d, ["title", "minPercent", "maxPercent"]) && validSpacingPercent(d.minPercent) && validSpacingPercent(d.maxPercent) && d.minPercent <= 100 && d.maxPercent >= 100 :
          value.dialogKind === "reactionConditions" ? keys(d, ["title", "arrowId", "draft"]) && typeof d.arrowId === "string" && d.arrowId.length > 0 && d.arrowId.length <= 128 && validConditionsDraft(d.draft) :
          keys(d, ["title", "options"], ["frame"]) && validExportOptions(d.options) && (d.frame === undefined || validExportFrame(d.frame))); break;
      case "request": valid = keys(d, []); break;
      case "remeasure": valid = keys(d, []); break;
      case "ready": valid = keys(d, []) || validDialogContentFit(d); break;
      case "action": valid = value.dialogKind === "customColor" ? d.action === "apply" ? keys(d, ["action", "hex"]) && validCustomHex(d.hex) : keys(d, ["action"]) && ["clear", "cancel"].includes(String(d.action)) : value.dialogKind === "vibeCodeGuide" ? keys(d, ["action"]) && ["cancel", "saveStarter", "openPluginManager"].includes(String(d.action)) : value.dialogKind === "engineInstall" ? keys(d, ["action"]) && typeof d.action === "string" && ["install", "cancelInstall", "close"].includes(d.action) : value.dialogKind === "toolInstall" ? keys(d, ["action"]) && typeof d.action === "string" && ["install", "allow", "cancelInstall", "close"].includes(d.action) : d.action === "cancel" ? keys(d, ["action"]) : value.dialogKind === "pageSize"
        ? d.action === "apply" && keys(d, ["action", "width", "height", "unit"]) && validPageSize(d)
        : value.dialogKind === "insertTable" ? d.action === "apply" && keys(d, ["action", "rows", "columns", "headerRows", "preset"]) && validInsertTableOptions(d)
        : value.dialogKind === "arrangementSpacing" ? ["apply", "preview"].includes(String(d.action)) && keys(d, ["action", "percent"]) && validSpacingPercent(d.percent)
        : value.dialogKind === "reactionConditions" ? d.action === "apply" && keys(d, ["action", "draft"]) && validConditionsDraft(d.draft)
        : typeof d.action === "string" && ["export", "chooseDestination", "preview"].includes(d.action) && keys(d, ["action", "options"]) && validExportOptions(d.options); break;
      case "result": if (value.dialogKind === "engineInstall" || value.dialogKind === "toolInstall") { valid = keys(d, ["status"], ["error"]) && typeof d.status === "string" && ["accepted", "cancelled", "error"].includes(d.status) && (d.error === undefined || typeof d.error === "string" && d.error.length <= 1024); break; } if (value.dialogKind === "export" && d.status === "frame") { valid = keys(d, ["status", "frame"]) && validExportFrame(d.frame); break; } if (value.dialogKind === "export" && d.status === "preview") { valid = keys(d, ["status", "preview"]) && validExportPreview(d.preview); break; } valid = keys(d, ["status"], value.dialogKind !== "export" ? ["error"] : ["error", "notice", "destinationPath", "filename"]) &&
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
  const expected = message.type === "snapshot" || message.type === "preview" || message.type === "result" || message.type === "closed" || message.type === "remeasure" ? snapshot.ownerWindowId : label;
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

export function validEngineInstallSnapshot(v: unknown): v is EngineInstallSnapshot {
  const text = (s: unknown, max: number) => typeof s === "string" && s.length <= max && !s.includes("\0");
  const bytes = (n: unknown) => Number.isSafeInteger(n) && Number(n) >= 0;
  if (!record(v) || !keys(v, ["title", "engineName", "pluginName", "pluginId", "disclosure", "requiredDiskBytes", "freeDiskBytes", "state", "buttons"]) ||
      !text(v.title, 256) || !text(v.engineName, 80) || !text(v.pluginName, 128) || !text(v.pluginId, 256) || !text(v.disclosure, 1024) ||
      ![v.title, v.engineName, v.pluginName, v.pluginId, v.disclosure].every(s => typeof s === "string" && s.length > 0) ||
      !bytes(v.requiredDiskBytes) || !bytes(v.freeDiskBytes) || !record(v.state)) return false;
  const state = v.state;
  let valid = false;
  switch (state.status) {
    case "notInstalled": case "installed": valid = keys(state, ["status"]); break;
    case "broken": valid = keys(state, ["status", "detail"]) && text(state.detail, 1024); break;
    case "failed": valid = keys(state, ["status", "message"]) && text(state.message, 1024); break;
    case "installing": valid = keys(state, ["status", "phase", "step", "steps", "bytesDone", "bytesTotal", "estimated"]) &&
      text(state.phase, 128) && Number.isInteger(state.step) && Number.isInteger(state.steps) &&
      Number(state.step) >= 1 && Number(state.step) <= Number(state.steps) && Number(state.steps) <= 32 &&
      bytes(state.bytesDone) && bytes(state.bytesTotal) && typeof state.estimated === "boolean"; break;
  }
  const buttons = state.status === "installing" ? ["cancelInstall", "close"] : state.status === "installed" || state.status === "failed" ? ["close"] : ["install", "close"];
  return valid && JSON.stringify(v.buttons) === JSON.stringify(buttons);
}

export function validToolInstallSnapshot(v: unknown): v is ToolInstallSnapshot {
  const text = (s: unknown, max: number) => typeof s === "string" && s.length > 0 && s.length <= max && !s.includes("\0");
  const bytes = (n: unknown) => Number.isSafeInteger(n) && Number(n) >= 0;
  if (!record(v) || !keys(v, ["title", "toolName", "publisher", "version", "downloadHost", "downloadBytes", "pluginName", "pluginId", "disclosure", "requiredDiskBytes", "freeDiskBytes", "state", "buttons"], ["intent"]) ||
      !text(v.title, 256) || !text(v.toolName, 80) || !text(v.publisher, 80) || !text(v.version, 40) || !text(v.downloadHost, 128) || !text(v.pluginName, 128) || !text(v.pluginId, 256) || !text(v.disclosure, 1024) ||
      !bytes(v.downloadBytes) || !bytes(v.requiredDiskBytes) || !(v.freeDiskBytes === null || bytes(v.freeDiskBytes)) || !record(v.state)) return false;
  if (v.intent !== undefined && (typeof v.intent !== "string" || !["download", "update", "use"].includes(v.intent))) return false;
  const state = v.state;
  let valid = false;
  switch (state.status) {
    case "notInstalled": case "consent": case "installed": valid = keys(state, ["status"]); break;
    case "failed": valid = keys(state, ["status", "message"]) && text(state.message, 1024); break;
    case "broken": valid = keys(state, ["status", "detail"]) && text(state.detail, 1024); break;
    case "installing": valid = keys(state, ["status", "phase"], ["bytesDone", "bytesTotal"]) && text(state.phase, 128) &&
      (state.bytesDone === undefined || bytes(state.bytesDone)) && (state.bytesTotal === undefined || bytes(state.bytesTotal)); break;
  }
  const buttons = state.status === "notInstalled" || state.status === "broken" || state.status === "failed" ? ["install", "close"] : state.status === "consent" ? ["allow", "close"] :
    state.status === "installing" ? ["cancelInstall", "close"] : ["close"];
  return valid && JSON.stringify(v.buttons) === JSON.stringify(buttons);
}
