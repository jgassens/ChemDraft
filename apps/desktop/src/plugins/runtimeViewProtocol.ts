import { z } from "zod";
import type { PluginRuntimeView } from "./pluginRuntimeOwner";
import type { DesktopPluginRuntime } from "./createPluginRuntime";
import type { QueuedProposedPatch } from "@chemdraft/plugin-host";
import { PluginCommandInputSchema, PluginImageSourceSchema, PluginExternalToolIdSchema } from "@chemdraft/plugin-api";

const id = z.string().min(1).max(1000);
const requestId = z.number().int().nonnegative();
const noArgs = z.tuple([]);
const oneId = z.tuple([id]);
const oneRequestId = z.tuple([requestId]);
const optional = <T extends z.ZodTypeAny>(schema: T) => z.union([schema, z.undefined(), z.object({ runtimeUndefined: z.literal(true) }).strict()]);
const packageHandle = z.object({ runtimePackageHandle: z.string().uuid() }).passthrough();
const actionArgs = {
  invokePluginCommand: z.tuple([id, optional(PluginCommandInputSchema), z.boolean()]),
  pickPackage: noArgs, installPackage: z.tuple([packageHandle]), prepareOfficialPluginInstall: oneId,
  uninstallInstalledPlugin: oneId, checkInstalledPluginUpdates: noArgs,
  prepareInstalledPluginUpdate: z.tuple([z.object({ pluginId: id, installedVersion: id, version: id }).passthrough()]),
  updateInstalledPlugin: z.tuple([z.object({ inspection: packageHandle, offer: z.object({ pluginId: id, installedVersion: id }).passthrough() }).passthrough()]),
  closePanel: noArgs, submitTextPrompt: z.tuple([requestId, z.string().max(100_000)]), cancelTextPrompt: oneRequestId,
  acquireImage: z.tuple([requestId, PluginImageSourceSchema]),
  openImagePermissionSettings: oneRequestId, refreshImagePermission: oneRequestId, relaunchForImagePermission: oneRequestId,
  cancelImageRequest: oneRequestId, installRecognitionEngine: oneRequestId, cancelRecognitionEngineInstall: oneRequestId,
  declineRecognitionEngineInstall: oneRequestId, refreshRecognitionEngineStatus: noArgs, startRecognitionEngineInstall: noArgs,
  cancelRunningRecognitionEngineInstall: noArgs, uninstallRecognitionEngine: noArgs, cancelRecognition: oneRequestId,
  closeDetachedPanel: z.tuple([id, id]), detachPanel: z.tuple([id, id]), reattachPanel: z.tuple([id, id]),
  reportDiagnostic: z.tuple([id, z.string().max(100_000)]), applyEnabled: z.tuple([z.array(id).max(1000)]),
  namingCancelActivity: oneRequestId, namingRefresh: noArgs, namingInstall: noArgs, namingCancel: noArgs, namingUninstall: noArgs,
  consentList: noArgs, consentRevoke: z.tuple([PluginExternalToolIdSchema, id]),
  clearDraftRestore: z.tuple([id, optional(requestId)]), closeProposalDocumentTab: z.tuple([id, z.string()]),
  acceptProposal: oneId, rejectProposal: oneId,
  registerFixture: noArgs, unregisterFixture: noArgs, listCanvasOverlays: noArgs, screenCaptureOf: oneId,
  discardPreparedPackages: noArgs, proposalDocumentTab: oneId,
  previewImageChunk: z.tuple([z.string().uuid(), z.number().int().nonnegative()])
} as const;

/** Private owner/view actions, never a plugin capability or an arbitrary property/method path. */
export const RuntimeViewActionSchema = z.object({
  action: z.enum([
    "invokePluginCommand", "pickPackage", "installPackage", "prepareOfficialPluginInstall",
    "uninstallInstalledPlugin", "checkInstalledPluginUpdates", "prepareInstalledPluginUpdate", "updateInstalledPlugin",
    "closePanel", "submitTextPrompt", "cancelTextPrompt", "acquireImage", "openImagePermissionSettings",
    "refreshImagePermission", "relaunchForImagePermission", "cancelImageRequest", "installRecognitionEngine",
    "cancelRecognitionEngineInstall", "declineRecognitionEngineInstall", "refreshRecognitionEngineStatus",
    "startRecognitionEngineInstall", "cancelRunningRecognitionEngineInstall", "uninstallRecognitionEngine", "cancelRecognition",
    "closeDetachedPanel", "detachPanel", "reattachPanel", "reportDiagnostic", "applyEnabled",
    "namingCancelActivity", "namingRefresh", "namingInstall", "namingCancel", "namingUninstall", "consentList", "consentRevoke",
    "clearDraftRestore", "closeProposalDocumentTab", "acceptProposal", "rejectProposal", "registerFixture", "unregisterFixture",
    "listCanvasOverlays", "screenCaptureOf", "discardPreparedPackages", "proposalDocumentTab", "previewImageChunk"
  ]),
  args: z.array(z.unknown()).max(4)
}).strict().superRefine((request, context) => {
  const result = actionArgs[request.action].safeParse(request.args);
  if (!result.success) context.addIssue({ code: z.ZodIssueCode.custom, message: `Invalid arguments for runtime action ${request.action}.`, path: ["args"] });
});
export type RuntimeViewAction = z.infer<typeof RuntimeViewActionSchema>;
export function isRuntimeViewAction(value: string): value is RuntimeViewAction["action"] {
  return Object.hasOwn(actionArgs, value);
}
/** React may supply its click event to a zero-argument action. Preserve the original callback's
 * arity: an event is never input to an owner action. */
export function runtimeViewActionArguments(action: RuntimeViewAction["action"], args: unknown[]): unknown[] {
  return args.slice(0, actionArgs[action].items.length);
}

export type RuntimeViewState = Pick<PluginRuntimeView,
  "installedPluginCatalogReady" | "cachedPluginUpdateResults" | "plugins" | "pluginMenuItems" | "canvasOverlays" |
  "openPanel" | "detachedPanels" | "openTextPrompt" | "openImageRequest" | "openRecognitionInstall" |
  "recognitionEngineStatus" | "recognitionEngineInstall" | "diagnostics"> & {
  bundledPlugins: Array<{ manifest: PluginRuntimeView["bundledPlugins"][number]["manifest"] }>;
  installedPlugins: Array<Pick<PluginRuntimeView["installedPlugins"][number], "record" | "manifest">>;
  availableActions: RuntimeViewAction["action"][];
  proposals: QueuedProposedPatch[];
  proposalTabs: Array<[string, ReturnType<DesktopPluginRuntime["proposalDocumentTab"]>]>;
  toolsets: ReturnType<DesktopPluginRuntime["listPluginToolsets"]>;
  commands: Array<{ id: string; pluginId?: string; enabled: boolean; source?: string }>;
};

/** JSON wire encoding for package bytes. Reject executable values rather than silently retaining
 * a descriptor, signal, callback or controller in a supposedly serializable view. */
export function encodeRuntimeView(value: unknown): unknown {
  const active = new Set<object>();
  const encode = (item: unknown): unknown => {
    if (item === undefined) return { runtimeUndefined: true };
    if (typeof item === "number" && !Number.isFinite(item)) throw new Error("Runtime view numbers must be finite.");
    if (typeof item === "function" || typeof item === "symbol" || typeof item === "bigint") throw new Error("Runtime views and actions must contain data only.");
    if (item instanceof Uint8Array) return { runtimeBytes: Array.from(item) };
    if (item === null || typeof item !== "object") return item;
    if (active.has(item)) throw new Error("Runtime views and actions cannot contain cycles.");
    if (!Array.isArray(item) && Object.getPrototypeOf(item) !== Object.prototype && Object.getPrototypeOf(item) !== null) {
      throw new Error("Runtime views and actions must contain data only.");
    }
    active.add(item);
    try {
      if (Array.isArray(item)) return item.map(encode);
      const entries = Object.entries(item).map(([key, value]) => [key, encode(value)]);
      // Escape literal objects that resemble a wire tag. Plugin payloads may use these keys too.
      if (entries.length === 1 && ["runtimeUndefined", "runtimeBytes", "runtimeEntries"].includes(entries[0]![0] as string)) return { runtimeEntries: entries };
      return Object.fromEntries(entries);
    } finally { active.delete(item); }
  };
  return encode(value);
}

export function decodeRuntimeView<T>(value: unknown): T {
  const decode = (item: unknown): unknown => {
    if (item === null || typeof item !== "object") return item;
    if (Array.isArray(item)) return item.map(decode);
    if (Object.keys(item).length === 1) {
      if ("runtimeUndefined" in item && item.runtimeUndefined === true) return undefined;
      if ("runtimeBytes" in item) return new Uint8Array(z.array(z.number().int().min(0).max(255)).parse(item.runtimeBytes));
      if ("runtimeEntries" in item) {
        const entries = z.array(z.tuple([z.string(), z.unknown()])).parse(item.runtimeEntries);
        return Object.fromEntries(entries.map(([key, value]) => [key, decode(value)]));
      }
    }
    return Object.fromEntries(Object.entries(item).map(([key, value]) => [key, decode(value)]));
  };
  return decode(value) as T;
}
