import type { ChemDraftDocument, DocumentObject, PluginCapabilityResult, PluginRequestArguments } from "@chemdraft/plugin-api";
import type { RequestObjectRef } from "./requestWrites";

/** Host-owned document snapshot and revision issuer for a single live capability call. */
export interface RequestDepictionBinding {
  document: ChemDraftDocument;
  writeSelection?: readonly RequestObjectRef[];
  signal: AbortSignal;
  revision(object: DocumentObject): string;
  check(): void;
}

export interface RequestFigurePlanProviders {
  listStylePresets(input: PluginRequestArguments<"depiction", "listStylePresets">,
    binding: RequestDepictionBinding): PluginCapabilityResult<"depiction", "listStylePresets">;
  planStyle(input: PluginRequestArguments<"depiction", "planStyle">,
    binding: RequestDepictionBinding): PluginCapabilityResult<"depiction", "planStyle"> | Promise<PluginCapabilityResult<"depiction", "planStyle">>;
  planLayout(input: PluginRequestArguments<"depiction", "planLayout">,
    binding: RequestDepictionBinding): Promise<PluginCapabilityResult<"depiction", "planLayout">>;
}

export interface RequestDepictionProviders extends Partial<RequestFigurePlanProviders> {
  inspectStructure(input: PluginRequestArguments<"chemistry", "inspectStructure">, signal: AbortSignal,
    binding?: RequestDepictionBinding): Promise<PluginCapabilityResult<"chemistry", "inspectStructure">>;
  rings(input: PluginRequestArguments<"chemistry", "rings">,
    binding: RequestDepictionBinding): Promise<PluginCapabilityResult<"chemistry", "rings">>;
  measure(input: PluginRequestArguments<"depiction", "measure">,
    binding: RequestDepictionBinding): PluginCapabilityResult<"depiction", "measure">;
  renderRegion(input: PluginRequestArguments<"depiction", "renderRegion">,
    binding: RequestDepictionBinding): Promise<PluginCapabilityResult<"depiction", "renderRegion">>;
}
