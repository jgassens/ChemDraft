import { z } from "zod";
import { ChemDraftDocumentSchema } from "@chemdraft/chem-core";
import {
  AppliedPatchReceiptSchema, PluginCommandInputSchema, PluginManifestSchema,
  PluginStructureFormatSchema, ProposedDocumentPatchSchema, PluginPermissionSchema
} from "@chemdraft/plugin-api";
import { isDocumentWindowId } from "../documentIdentity";
import { assistantSession, assistantSnapshot, assistantPreparedWrite, assistantWritePlan, assistantResult } from "./runtimeAssistantProtocol";
import { runtimeDialogRequest, runtimeDialogAction } from "./runtimeDialogProtocol";
import { RuntimeViewActionSchema } from "./runtimeViewProtocol";

/** Internal desktop protocol, independent of the public plugin API's version. */
export const RUNTIME_BROKER_VERSION = 1 as const;
export const RUNTIME_HOST_LABEL = "runtime";
export const RUNTIME_BROKER_MAX_BYTES = 32 * 1024 * 1024;
const id = z.string().min(1).max(256);
export function isRuntimeDocumentLabel(value: string): boolean {
  return value.length <= 128 && isDocumentWindowId(value) && !/[\r\n]/.test(value);
}
export const RuntimeTargetSchema = z.object({
  windowId: id.refine(isRuntimeDocumentLabel),
  tabId: id
}).strict();
export type RuntimeTarget = z.infer<typeof RuntimeTargetSchema>;
export const RuntimeProposalCommitSchema = z.object({ proposalId: id, target: RuntimeTargetSchema,
  documentKey: id, preparationId: z.string().uuid() }).strict();

/** Created and retained by the document, never by a plugin. documentKey is an incarnation token:
 * edits, selection, undo and activation leave it alone; replacement and tab hand-off invalidate it. */
export const RuntimeInvocationSchema = z.object({
  id, target: RuntimeTargetSchema, documentKey: id, pluginId: id, commandId: id,
  writeScopeObjectIds: z.array(id).max(100_000)
}).strict();
export type RuntimeInvocation = z.infer<typeof RuntimeInvocationSchema>;
const reference = RuntimeInvocationSchema.omit({ writeScopeObjectIds: true });
export type RuntimeInvocationReference = z.infer<typeof reference>;

const selection = z.object({
  objectIds: z.array(id).max(100_000),
  molecules: z.array(z.object({
    objectId: id, documentId: id.optional(), pageId: id.optional(),
    structureFormat: PluginStructureFormatSchema, structure: z.string(), sourceFingerprint: z.string()
  }).strict()).max(100_000)
}).strict();
const application = z.object({
  plugin: z.object({ id, name: z.string(), version: z.string() }).strict(),
  command: z.object({ id, title: z.string() }).strict(),
  patch: ProposedDocumentPatchSchema, undoLabel: z.string().min(1).max(1000),
  writeScopeObjectIds: z.array(id).max(100_000)
}).strict();
const coreCommand = z.object({ id, title: z.string(), source: z.literal("core").optional(), category: z.string().optional(),
  description: z.string().optional(), requiredPermissions: z.array(PluginPermissionSchema).optional(),
  defaultShortcut: z.string().optional(), enabled: z.boolean().optional() }).strict();

/** Manifests carry every menu, toolbar, panel and overlay declaration; enabled ids reflect handlers
 * actually installed in the sole host. Receivers independently preserve ownership/toolbar gates. */
export const RuntimeContributionsSchema = z.object({
  revision: z.number().int().nonnegative(),
  plugins: z.array(PluginManifestSchema).max(1000),
  enabledCommandIds: z.array(id).max(100_000)
}).strict();
export type RuntimeContributions = z.infer<typeof RuntimeContributionsSchema>;

export const runtimeMethods = {
  runtimeDocumentClosed: { request: z.object({}).strict(), response: z.null(), destination: "runtime" },
  initializeRuntime: { request: z.object({}).strict(), response: z.null(), destination: "runtime" },
  chooseRuntimeFile: { request: z.object({ kind: z.enum(["pluginPackage", "image"]) }).strict(),
    response: z.string().nullable(), destination: "document" },
  captureDocumentTarget: { request: z.object({ windowId: id }).strict(),
    response: z.object({ target: RuntimeTargetSchema, documentKey: id }).strict(), destination: "document" },
  invokeDocumentPlugin: { request: z.object({ target: RuntimeTargetSchema, documentKey: id, commandId: id, input: PluginCommandInputSchema.optional(), collectWarnings: z.boolean().optional() }).strict(),
    response: z.unknown(), destination: "document" },
  setDocumentMetadata: { request: z.object({ target: RuntimeTargetSchema,
    documentKey: id, titles: z.array(z.object({ id, title: z.string().max(10000) }).strict()).max(1000) }).strict(), response: z.null(), destination: "runtime" },
  runtimeDialogRequest: { request: runtimeDialogRequest, response: z.null(), destination: "document" },
  runtimeDialogAction: { request: runtimeDialogAction, response: z.null(), destination: "runtime" },
  assistantBegin: { request: z.object({ invocation: reference, label: z.string().max(20_000) }).strict(), response: z.object({ session: assistantSession, snapshot: assistantSnapshot, selection: z.array(id) }).strict(), destination: "document" },
  assistantOpenInvocation: { request: z.object({ session: assistantSession, commandId: id, writeScopeObjectIds: z.array(id) }).strict(),
    response: RuntimeInvocationSchema, destination: "document" },
  assistantRead: { request: assistantSession, response: assistantSnapshot, destination: "document" },
  assistantWrite: { request: z.object({ session: assistantSession, writeId: id, plan: assistantWritePlan }).strict(), response: assistantSnapshot, destination: "document" },
  prepareAssistantWrite: { request: z.object({ session: assistantSession, writeId: id, snapshot: assistantSnapshot }).strict(), response: assistantPreparedWrite, destination: "runtime" },
  cancelAssistantWrite: { request: z.object({ session: assistantSession, writeId: id }).strict(), response: z.null(), destination: "document" },
  assistantConsent: { request: z.object({ session: assistantSession, decisionId: id, platform: z.enum(["macos", "windows", "linux"]).optional() }).strict(), response: z.enum(["enlarge", "keep", "unanswered"]), destination: "document" },
  cancelAssistantConsent: { request: z.object({ session: assistantSession, decisionId: id }).strict(), response: z.null(), destination: "document" },
  assistantEnd: { request: z.object({ session: assistantSession, touchedIds: z.array(id) }).strict(), response: assistantResult, destination: "document" },
  assistantUndo: { request: assistantSession, response: z.boolean(), destination: "document" },
  getDocument: { request: reference, response: ChemDraftDocumentSchema.optional(), destination: "document" },
  getSelection: { request: reference.extend({ collectWarnings: z.boolean().optional() }), response: selection, destination: "document" },
  getViewportRect: { request: reference, response: z.object({ x: z.number().finite(), y: z.number().finite(),
    width: z.number().finite().nonnegative(), height: z.number().finite().nonnegative() }).strict().optional(), destination: "document" },
  applyPatch: { request: z.object({ invocation: reference, application }).strict(), response: AppliedPatchReceiptSchema, destination: "document" },
  undoOwnTransaction: { request: z.object({ invocation: reference, transactionId: id }).strict(), response: z.boolean(), destination: "document" },
  endInvocation: { request: reference, response: z.null(), destination: "document" },
  invokeCommand: { request: z.object({ invocation: RuntimeInvocationSchema, input: PluginCommandInputSchema.optional() }).strict(), response: z.unknown(), destination: "runtime" },
  getContributions: { request: z.object({}).strict(), response: RuntimeContributionsSchema, destination: "runtime" },
  getRuntimeView: { request: z.object({}).strict(), response: z.unknown(), destination: "runtime" },
  // Reconciliation uses the same authenticated route and identity. A negative receipt also
  // revokes the preparation, so an undelivered commit cannot arrive after a reservation is freed.
  commitProposal: { request: RuntimeProposalCommitSchema.extend({ reconcile: z.literal(true).optional() }), response: z.boolean(), destination: "document" },
  acceptPreparedProposal: { request: RuntimeProposalCommitSchema, response: z.null(), destination: "runtime" },
  // Omit preparationId only after the host has resolved the whole proposal. A failed,
  // reconciled attempt retires just its preparation while the proposal remains pending.
  retireProposalCommits: { request: z.object({ proposalId: id, preparationId: z.string().uuid().optional() }).strict(),
    response: z.null(), destination: "document" },
  setCoreCommands: { request: z.object({ commands: z.array(coreCommand), revision: z.number().int().nonnegative() }).strict(), response: z.null(), destination: "runtime" },
  getCoreCommands: { request: z.object({}).strict(), response: z.array(coreCommand), destination: "document" },
  getCoreCommand: { request: z.object({ commandId: id }).strict(), response: coreCommand.optional(), destination: "document" },
  invokeCoreCommand: { request: z.object({ commandId: id, input: PluginCommandInputSchema.optional(), pluginId: id.optional(),
    permissions: z.array(PluginPermissionSchema) }).strict(), response: z.unknown(), destination: "document" },
  runtimeViewAction: { request: RuntimeViewActionSchema, response: z.unknown(), destination: "runtime" }
} as const;
export type RuntimeMethod = keyof typeof runtimeMethods;
export type RuntimeRequest<M extends RuntimeMethod> = z.infer<(typeof runtimeMethods)[M]["request"]>;
export type RuntimeResponse<M extends RuntimeMethod> = z.infer<(typeof runtimeMethods)[M]["response"]>;
const method = z.enum(Object.keys(runtimeMethods) as [RuntimeMethod, ...RuntimeMethod[]]);
const envelope = { version: z.literal(RUNTIME_BROKER_VERSION), id, method };
const MessageSchema = z.union([
  z.object({ ...envelope, kind: z.literal("request"), payload: z.unknown() }).strict(),
  z.object({ ...envelope, kind: z.literal("response"), ok: z.literal(true), value: z.unknown() }).strict(),
  z.object({ ...envelope, kind: z.literal("response"), ok: z.literal(false), error: z.string().max(4000) }).strict(),
  z.object({ version: z.literal(RUNTIME_BROKER_VERSION), kind: z.literal("contributions"), payload: RuntimeContributionsSchema }).strict(),
  z.object({ version: z.literal(RUNTIME_BROKER_VERSION), kind: z.literal("runtimeView"), topic: z.string().max(40), payload: z.unknown() }).strict()
]);
export type RuntimeMessage = z.infer<typeof MessageSchema>;

/** The transport supplies sender identity from native IPC, never from message fields or events. */
export interface RuntimeDelivery { sender: string; message: unknown }
export interface RuntimeTransport {
  /** Only the JSON in-process channel can preserve existing synchronous user-action commits. */
  readonly immediate?: boolean;
  subscribe(listener: (delivery: RuntimeDelivery) => void): () => void;
  send(recipient: string, message: RuntimeMessage): Promise<void>;
}

export function parseRuntimeMessage(raw: unknown): RuntimeMessage {
  const json = JSON.stringify(raw);
  if (json === undefined || new TextEncoder().encode(json).byteLength > RUNTIME_BROKER_MAX_BYTES) {
    throw new Error("Plugin runtime message exceeds the 32 MiB limit.");
  }
  const message = MessageSchema.parse(JSON.parse(json));
  if (message.kind === "request") {
    return { ...message, payload: runtimeMethods[message.method].request.parse(message.payload) };
  }
  if (message.kind === "response" && message.ok) {
    return { ...message, value: runtimeMethods[message.method].response.parse(message.value) };
  }
  return message;
}

export function invocationReference(invocation: RuntimeInvocation): RuntimeInvocationReference {
  const { writeScopeObjectIds: _scope, ...ref } = invocation;
  return ref;
}
