import type { z } from "zod";
import type { PluginCommandContext, PluginPermission } from "./index";
import * as schemas from "./requestSchemas";

function capability<Request extends z.ZodTypeAny, Result extends z.ZodTypeAny>(
  permissions: readonly PluginPermission[], request: Request, result: Result
) {
  return { permissions, request, result };
}

const read = ["document.read"] as const;
const capture = ["document.read", "selection.read"] as const;
const resize = ["document.read", "selection.read", "document.write"] as const;
const write = ["document.read", "document.write", "chemistry.compute"] as const;

export const PluginRequestCapabilities = {
  requests: {
    begin: capability(capture, schemas.PluginBeginRequestSchema, schemas.PluginBeginRequestResultSchema),
    getContext: capability(capture, schemas.PluginRequestIdSchema, schemas.PluginRequestContextResultSchema),
    end: capability(capture, schemas.PluginRequestIdSchema, schemas.PluginEndRequestResultSchema),
    requestPageSpace: capability(resize, schemas.PluginRequestPageSpaceSchema, schemas.PluginRequestPageSpaceResultSchema)
  },
  documents: {
    readRequest: capability(read, schemas.PluginReadRequestSchema, schemas.PluginReadRequestResultSchema),
    applyRequestPatch: capability(write, schemas.PluginApplyRequestPatchSchema, schemas.PluginApplyRequestPatchResultSchema)
  },
  toolSessions: {
    open: capability(capture, schemas.PluginOpenToolSessionSchema, schemas.PluginOpenToolSessionResultSchema),
    close: capability(capture, schemas.PluginCloseToolSessionSchema, schemas.PluginEmptyRequestResultSchema)
  },
  chemistry: {
    inspectStructure: capability(["chemistry.compute"], schemas.PluginInspectStructureSchema, schemas.PluginInspectStructureResultSchema),
    rings: capability(["document.read", "chemistry.compute"], schemas.PluginRingsSchema, schemas.PluginRingsResultSchema)
  },
  depiction: {
    measure: capability(read, schemas.PluginMeasureDepictionSchema, schemas.PluginMeasureDepictionResultSchema),
    renderRegion: capability(read, schemas.PluginRenderRegionSchema, schemas.PluginRenderRegionResultSchema),
    planLayout: capability(read, schemas.PluginPlanLayoutSchema, schemas.PluginPlanLayoutResultSchema),
    listStylePresets: capability(read, schemas.PluginListStylePresetsSchema, schemas.PluginListStylePresetsResultSchema),
    planStyle: capability(read, schemas.PluginPlanStyleSchema, schemas.PluginPlanStyleResultSchema)
  }
} as const;

type Capabilities = typeof PluginRequestCapabilities;
export type PluginRequestNamespace = keyof Capabilities;
type Method<N extends PluginRequestNamespace> = keyof Capabilities[N] & string;
export function pluginRequestMethods<N extends PluginRequestNamespace>(namespace: N): Method<N>[] {
  return Object.keys(PluginRequestCapabilities[namespace]) as Method<N>[];
}

type SchemaOf<N extends PluginRequestNamespace, M extends Method<N>, K extends "request" | "result"> =
  Capabilities[N][M] extends Record<K, infer S extends z.ZodTypeAny> ? S : never;
export type PluginRequestArguments<N extends PluginRequestNamespace, M extends Method<N>> = z.output<SchemaOf<N, M, "request">>;
export type PluginCapabilityResult<N extends PluginRequestNamespace, M extends Method<N>> = z.output<SchemaOf<N, M, "result">>;

type API<N extends PluginRequestNamespace> = {
  [M in Method<N>]: (request: PluginRequestArguments<N, M>) => Promise<PluginCapabilityResult<N, M>>;
};
export type PluginRequestsAPI = Omit<API<"requests">, "requestPageSpace"> & Pick<Partial<API<"requests">>, "requestPageSpace">;
export type PluginRequestDocumentAPI = Partial<API<"documents">>;
export type PluginToolSessionsAPI = API<"toolSessions">;
export type PluginRequestChemistryAPI = Partial<API<"chemistry">>;
export type PluginDepictionAPI = API<"depiction">;

export type PluginRequestContext = Extract<PluginCapabilityResult<"requests", "getContext">, { ok: true }>["value"];
export type PluginRequestPatchReceipt = Extract<PluginCapabilityResult<"documents", "applyRequestPatch">, { ok: true }>["value"];
export type PluginExpectedStructure = NonNullable<PluginRequestArguments<"documents", "applyRequestPatch">["expectedStructures"]>[number];
export type PluginToolCall = z.output<typeof schemas.PluginToolCallSchema>;
export type PluginToolCallResult = z.output<typeof schemas.PluginToolCallResultSchema>;
export type PluginToolHandler = (context: PluginCommandContext, call: PluginToolCall, signal: AbortSignal) =>
  PluginToolCallResult | Promise<PluginToolCallResult>;
export type PluginActiveDocumentChanged = z.output<typeof schemas.PluginActiveDocumentChangedSchema>;
export type PluginActiveDocumentChangedHandler = (event: PluginActiveDocumentChanged) => void | Promise<void>;

type Capability = { permissions: readonly PluginPermission[]; request: z.ZodTypeAny; result: z.ZodTypeAny };
type CapabilityMap = Readonly<Record<string, Readonly<Record<string, Capability>>>>;
const capabilityMap: CapabilityMap = PluginRequestCapabilities;

export function getPluginRequestCapability(namespace: string, method: string): Capability | undefined {
  const methods = Object.hasOwn(capabilityMap, namespace) ? capabilityMap[namespace] : undefined;
  return methods && Object.hasOwn(methods, method) ? methods[method] : undefined;
}

/** Document-backed inspection has an extra read gate. Supplied structures need compute only. */
export function pluginRequestPermissions(namespace: string, method: string, request: unknown): readonly PluginPermission[] {
  if (namespace === "chemistry" && method === "inspectStructure" &&
      (request as PluginRequestArguments<"chemistry", "inspectStructure">).kind === "molecule") {
    return PluginRequestCapabilities.chemistry.rings.permissions;
  }
  if (namespace === "depiction" && method === "planLayout") {
    const { spec } = request as PluginRequestArguments<"depiction", "planLayout">;
    const steps = spec.kind === "reactionRows" ? spec.steps : spec.kind === "reaction" ? [spec] : [];
    if (steps.some(step => [...step.reactants, ...step.products].some(
      component => typeof component !== "string" && "smiles" in component))) return ["document.read", "chemistry.compute"];
  }
  return getPluginRequestCapability(namespace, method)?.permissions ?? [];
}

/** Shared declared-permission surface for in-process and worker contexts. The dispatcher
 * checks permissions again on each validated request before invoking a provider. */
export function bindPluginRequestCapabilities<N extends PluginRequestNamespace>(
  namespace: N,
  hasPermission: (permission: PluginPermission) => boolean,
  dispatch: (method: Method<N>, request: unknown) => Promise<unknown>
): Partial<API<N>> {
  const methods = capabilityMap[namespace];
  return Object.fromEntries(pluginRequestMethods(namespace)
    .filter(method => methods[method].permissions.every(hasPermission))
    .map(method => [method, (request: unknown) => dispatch(method, request)])) as Partial<API<N>>;
}
