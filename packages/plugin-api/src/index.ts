import type { ChemDraftDocument, DocumentPatch } from "@chemdraft/chem-core";
import { z } from "zod";

export const PluginApiVersion = "0.1.0" as const;

export const pluginPermissions = [
  "document.read",
  "document.write",
  "document.proposePatch",
  "selection.read",
  "selection.write",
  "analysis.write",
  "ui.panel",
  "ui.toolbar",
  "ui.menu",
  "chemistry.compute",
  "clipboard.read",
  "clipboard.write",
  "image.read",
  "ml.inference",
  "model.load",
  "model.download",
  "filesystem.read",
  "filesystem.write",
  "network.fetch",
  "native.execute",
  "plugin.storage"
] as const;

export const dangerousPluginPermissions = [
  "filesystem.write",
  "network.fetch",
  "native.execute",
  "model.load",
  "model.download",
  "clipboard.read",
  "document.write",
  "image.read"
] as const satisfies readonly PluginPermission[];

export const PluginPermissionSchema = z.enum(pluginPermissions);

export type PluginPermission = (typeof pluginPermissions)[number];
export type PermissionName = PluginPermission;

const IdSchema = z.string().min(1);
const NonEmptyStringSchema = z.string().min(1);
const PermissionListSchema = z.array(PluginPermissionSchema);
const OptionalPermissionListSchema = z.array(PluginPermissionSchema).default([]);

export const PluginCommandContributionSchema = z
  .object({
    id: IdSchema,
    title: NonEmptyStringSchema,
    category: z.string().optional(),
    description: z.string().optional(),
    requiredPermissions: OptionalPermissionListSchema,
    defaultShortcut: z.string().optional(),
    enabled: z.boolean().default(true)
  })
  .strict();

export const PluginMenuContributionSchema = z
  .object({
    id: IdSchema,
    title: NonEmptyStringSchema,
    commandId: IdSchema,
    location: z.enum(["file", "edit", "view", "structure", "tools", "analyze", "plugins"]).default("plugins"),
    requiredPermissions: OptionalPermissionListSchema
  })
  .strict();

export const PluginToolbarContributionSchema = z
  .object({
    id: IdSchema,
    commandId: IdSchema,
    title: NonEmptyStringSchema.optional(),
    group: z.string().optional(),
    order: z.number().finite().optional(),
    requiredPermissions: OptionalPermissionListSchema
  })
  .strict();

export const PluginPanelContributionSchema = z
  .object({
    id: IdSchema,
    title: NonEmptyStringSchema,
    commandId: IdSchema.optional(),
    requiredPermissions: OptionalPermissionListSchema
  })
  .strict();

export const PluginTemplateContributionSchema = z
  .object({
    id: IdSchema,
    title: NonEmptyStringSchema,
    category: z.string().optional(),
    commandId: IdSchema.optional(),
    requiredPermissions: OptionalPermissionListSchema
  })
  .strict();

export const PluginFormatContributionSchema = z
  .object({
    id: IdSchema,
    title: NonEmptyStringSchema,
    fileExtensions: z.array(z.string().min(1)).default([]),
    commandId: IdSchema,
    requiredPermissions: OptionalPermissionListSchema
  })
  .strict();

export const PluginAnalyzerContributionSchema = z
  .object({
    id: IdSchema,
    title: NonEmptyStringSchema,
    commandId: IdSchema,
    requiredPermissions: OptionalPermissionListSchema
  })
  .strict();

export const PluginRecognizerContributionSchema = z
  .object({
    id: IdSchema,
    title: NonEmptyStringSchema,
    input: z.enum(["selected-image", "pasted-image", "image-file"]).default("selected-image"),
    commandId: IdSchema,
    requiredPermissions: OptionalPermissionListSchema
  })
  .strict();

export const PluginContributionsSchema = z
  .object({
    commands: z.array(PluginCommandContributionSchema).default([]),
    menus: z.array(PluginMenuContributionSchema).default([]),
    panels: z.array(PluginPanelContributionSchema).default([]),
    toolbarButtons: z.array(PluginToolbarContributionSchema).default([]),
    inspectors: z.array(PluginPanelContributionSchema).default([]),
    templates: z.array(PluginTemplateContributionSchema).default([]),
    importers: z.array(PluginFormatContributionSchema).default([]),
    exporters: z.array(PluginFormatContributionSchema).default([]),
    analyzers: z.array(PluginAnalyzerContributionSchema).default([]),
    transformers: z.array(PluginAnalyzerContributionSchema).default([]),
    recognizers: z.array(PluginRecognizerContributionSchema).default([])
  })
  .strict()
  .default({});

export const PluginManifestSchema = z
  .object({
    id: IdSchema,
    name: NonEmptyStringSchema,
    version: NonEmptyStringSchema,
    apiVersion: NonEmptyStringSchema,
    entry: NonEmptyStringSchema,
    permissions: PermissionListSchema,
    description: z.string().optional(),
    author: z.string().optional(),
    license: z.string().optional(),
    contributes: PluginContributionsSchema
  })
  .strict()
  .superRefine((manifest, ctx) => {
    addDuplicateIssue(manifest.permissions, ["permissions"], "permission", ctx);

    const declaredPermissions = new Set(manifest.permissions);
    for (const { path, permissions } of collectContributionPermissions(manifest.contributes)) {
      for (const permission of permissions) {
        if (!declaredPermissions.has(permission)) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path,
            message: `Contribution requires undeclared permission "${permission}".`
          });
        }
      }
    }

    addDuplicateIssue(
      manifest.contributes.commands.map((command) => command.id),
      ["contributes", "commands"],
      "command id",
      ctx
    );
  });

export const RecognitionWarningSchema = z
  .object({
    code: NonEmptyStringSchema,
    message: NonEmptyStringSchema
  })
  .strict();

export const RecognitionConfidencePointSchema = z
  .object({
    id: IdSchema,
    confidence: z.number().min(0).max(1)
  })
  .strict();

const DocumentPatchLikeSchema = z
  .object({
    op: NonEmptyStringSchema
  })
  .passthrough()
  .transform((patch) => patch as unknown as DocumentPatch);

export const ProposedDocumentPatchSchema = z
  .object({
    patch: DocumentPatchLikeSchema,
    reason: NonEmptyStringSchema,
    warnings: z.array(RecognitionWarningSchema).default([]),
    requiresUserApproval: z.literal(true).default(true)
  })
  .strict();

export const RecognizedStructureResultSchema = z
  .object({
    sourceImageRef: NonEmptyStringSchema,
    proposedSmiles: z.string().optional(),
    proposedMolfile: z.string().optional(),
    confidence: z.number().min(0).max(1),
    atomConfidence: z.array(RecognitionConfidencePointSchema).default([]),
    bondConfidence: z.array(RecognitionConfidencePointSchema).default([]),
    warnings: z.array(RecognitionWarningSchema).default([]),
    proposedPatch: ProposedDocumentPatchSchema.optional()
  })
  .strict();

export type PluginCommandContribution = z.infer<typeof PluginCommandContributionSchema>;
export type PluginMenuContribution = z.infer<typeof PluginMenuContributionSchema>;
export type PluginToolbarContribution = z.infer<typeof PluginToolbarContributionSchema>;
export type PluginPanelContribution = z.infer<typeof PluginPanelContributionSchema>;
export type PluginTemplateContribution = z.infer<typeof PluginTemplateContributionSchema>;
export type PluginFormatContribution = z.infer<typeof PluginFormatContributionSchema>;
export type PluginAnalyzerContribution = z.infer<typeof PluginAnalyzerContributionSchema>;
export type PluginRecognizerContribution = z.infer<typeof PluginRecognizerContributionSchema>;
export type PluginContributions = z.infer<typeof PluginContributionsSchema>;
export type PluginManifest = z.infer<typeof PluginManifestSchema>;
export type RecognitionWarning = z.infer<typeof RecognitionWarningSchema>;
export type RecognitionConfidencePoint = z.infer<typeof RecognitionConfidencePointSchema>;
export type ProposedDocumentPatch = z.input<typeof ProposedDocumentPatchSchema>;
export type NormalizedProposedDocumentPatch = z.output<typeof ProposedDocumentPatchSchema>;
export type RecognizedStructureResult = z.infer<typeof RecognizedStructureResultSchema>;

export type ProposedPatchStatus = "pending" | "accepted" | "rejected";

export interface ProposedPatchReceipt {
  id: string;
  pluginId: string;
  status: ProposedPatchStatus;
  createdAt: string;
  resolvedAt?: string;
}

export interface PluginStorage {
  get<T = unknown>(key: string): Promise<T | undefined>;
  set(key: string, value: unknown): Promise<void>;
  delete(key: string): Promise<void>;
  listKeys(): Promise<string[]>;
}

export interface PluginDocumentAPI {
  getActiveDocument(): Promise<ChemDraftDocument | undefined>;
  proposePatch(proposal: ProposedDocumentPatch): Promise<ProposedPatchReceipt>;
}

export interface PluginRuntimeIdentity {
  id: string;
  name: string;
  version: string;
  permissions: readonly PluginPermission[];
}

export interface PluginCommandContext {
  plugin: PluginRuntimeIdentity;
  documents: PluginDocumentAPI;
  storage?: PluginStorage;
  hasPermission(permission: PluginPermission): boolean;
  requirePermission(permission: PluginPermission): void;
}

export type PluginCommandHandler<Result = unknown> = (
  context: PluginCommandContext
) => Result | Promise<Result>;

export type PluginCommandResult<Result = unknown> =
  | {
      ok: true;
      data?: Result;
      warnings?: RecognitionWarning[];
      proposedPatches?: ProposedPatchReceipt[];
    }
  | {
      ok: false;
      error: {
        code: string;
        message: string;
      };
      warnings?: RecognitionWarning[];
    };

export interface PluginManifestValidationResult {
  ok: boolean;
  manifest?: PluginManifest;
  errors: string[];
}

const pluginPermissionSet = new Set<string>(pluginPermissions);

export function isPluginPermission(value: unknown): value is PluginPermission {
  return typeof value === "string" && pluginPermissionSet.has(value);
}

export function validatePluginManifest(candidate: unknown): PluginManifestValidationResult {
  const result = PluginManifestSchema.safeParse(candidate);

  if (result.success) {
    return { ok: true, manifest: result.data, errors: [] };
  }

  return {
    ok: false,
    errors: result.error.issues.map(formatManifestIssue)
  };
}

export function parsePluginManifest(candidate: unknown): PluginManifest {
  const result = validatePluginManifest(candidate);
  if (!result.ok || !result.manifest) {
    throw new Error(`Invalid plugin manifest: ${result.errors.join(" ")}`);
  }

  return result.manifest;
}

function addDuplicateIssue(
  values: readonly string[],
  path: (string | number)[],
  label: string,
  ctx: z.RefinementCtx
): void {
  if (new Set(values).size !== values.length) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path,
      message: `Duplicate ${label} values are not allowed.`
    });
  }
}

function collectContributionPermissions(contributions: PluginContributions): Array<{
  path: (string | number)[];
  permissions: readonly PluginPermission[];
}> {
  return [
    ...contributions.commands.map((contribution, index) => ({
      path: ["contributes", "commands", index, "requiredPermissions"],
      permissions: contribution.requiredPermissions
    })),
    ...contributions.menus.map((contribution, index) => ({
      path: ["contributes", "menus", index, "requiredPermissions"],
      permissions: contribution.requiredPermissions
    })),
    ...contributions.panels.map((contribution, index) => ({
      path: ["contributes", "panels", index, "requiredPermissions"],
      permissions: contribution.requiredPermissions
    })),
    ...contributions.toolbarButtons.map((contribution, index) => ({
      path: ["contributes", "toolbarButtons", index, "requiredPermissions"],
      permissions: contribution.requiredPermissions
    })),
    ...contributions.inspectors.map((contribution, index) => ({
      path: ["contributes", "inspectors", index, "requiredPermissions"],
      permissions: contribution.requiredPermissions
    })),
    ...contributions.templates.map((contribution, index) => ({
      path: ["contributes", "templates", index, "requiredPermissions"],
      permissions: contribution.requiredPermissions
    })),
    ...contributions.importers.map((contribution, index) => ({
      path: ["contributes", "importers", index, "requiredPermissions"],
      permissions: contribution.requiredPermissions
    })),
    ...contributions.exporters.map((contribution, index) => ({
      path: ["contributes", "exporters", index, "requiredPermissions"],
      permissions: contribution.requiredPermissions
    })),
    ...contributions.analyzers.map((contribution, index) => ({
      path: ["contributes", "analyzers", index, "requiredPermissions"],
      permissions: contribution.requiredPermissions
    })),
    ...contributions.transformers.map((contribution, index) => ({
      path: ["contributes", "transformers", index, "requiredPermissions"],
      permissions: contribution.requiredPermissions
    })),
    ...contributions.recognizers.map((contribution, index) => ({
      path: ["contributes", "recognizers", index, "requiredPermissions"],
      permissions: contribution.requiredPermissions
    }))
  ];
}

function formatManifestIssue(issue: z.ZodIssue): string {
  if (issue.code === z.ZodIssueCode.invalid_enum_value) {
    const value = "received" in issue ? String(issue.received) : "<unknown>";
    if (issue.path.includes("permissions")) {
      return `Unsupported plugin permission "${value}".`;
    }
  }

  const path = issue.path.join(".");
  return path ? `${path}: ${issue.message}` : issue.message;
}
