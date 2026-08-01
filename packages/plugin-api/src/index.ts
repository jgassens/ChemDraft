import type { ChemDraftDocument, DocumentPatch } from "@chemdraft/chem-core";
import { z } from "zod";

// Re-export the chem-core types the SDK's own signatures reference (e.g. `getActiveDocument()` returns
// a `ChemDraftDocument`, `proposePatch()` takes a `DocumentPatch`). Surfacing them here keeps the plugin
// boundary a single package: a plugin — and a host merging only the SDK — names these without importing
// chem-core directly (see docs/plugin-architecture and the M33 boundary guard).
export type { ChemDraftDocument, DocumentObject, DocumentPatch } from "@chemdraft/chem-core";
import type { DocumentObject } from "@chemdraft/chem-core";

/**
 * 0.1.1 adds `PluginChemistryAPI.nameToStructure`; 0.1.2 adds `structureFromSmiles`.
 *
 * The MINOR stays at 1 for both. For a 0.x release `isPluginApiVersionCompatible` treats the minor as
 * the compatibility boundary, so 0.2.0 would have made every plugin declaring `^0.1.0` — the NMR
 * predictor among them — refuse to install against this host, for purely additive methods. A plugin
 * declares the patch it needs (`^0.1.1` for name→structure, `^0.1.2` to also insert), which this host
 * satisfies and an older one correctly does not.
 */
export const PluginApiVersion = "0.1.2" as const;

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

function namespacedContributionIdSchema(namespace: "plugin" | "menu" | "panel" | "analyzer", label: string) {
  return IdSchema.regex(
    new RegExp(`^${namespace}\\.[A-Za-z0-9][A-Za-z0-9_-]*(?:\\.[A-Za-z0-9][A-Za-z0-9_-]*)+$`),
    `${label} ids must use the form "${namespace}.<pluginName>.<name>".`
  );
}

/** Command ids occupy the shared application registry, so plugin commands must never use a core id. */
export const PluginCommandIdSchema = namespacedContributionIdSchema("plugin", "Plugin command");
export const PluginMenuIdSchema = namespacedContributionIdSchema("menu", "Plugin menu");
export const PluginPanelIdSchema = namespacedContributionIdSchema("panel", "Plugin panel");
export const PluginAnalyzerIdSchema = namespacedContributionIdSchema("analyzer", "Plugin analyzer");

// M39 extracted the already-packaged NMR plugin while its analyzer id still used the older
// `plugin.*` prefix. Accept that legacy wire shape only at this field boundary and immediately
// canonicalize it; every parsed manifest and all newly authored output still use `analyzer.*`.
const CompatiblePluginAnalyzerIdSchema = z.preprocess((candidate) => {
  const legacy = PluginCommandIdSchema.safeParse(candidate);
  return legacy.success ? `analyzer.${legacy.data.slice("plugin.".length)}` : candidate;
}, PluginAnalyzerIdSchema);

export const PluginCommandContributionSchema = z
  .object({
    id: PluginCommandIdSchema,
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
    id: PluginMenuIdSchema,
    title: NonEmptyStringSchema,
    commandId: PluginCommandIdSchema,
    location: z.enum(["file", "edit", "view", "structure", "tools", "analyze", "plugins"]).default("plugins"),
    requiredPermissions: OptionalPermissionListSchema
  })
  .strict();

export const PluginToolbarContributionSchema = z
  .object({
    id: IdSchema,
    commandId: PluginCommandIdSchema,
    title: NonEmptyStringSchema.optional(),
    group: z.string().optional(),
    order: z.number().finite().optional(),
    requiredPermissions: OptionalPermissionListSchema
  })
  .strict();

/** Base64 data-URI icons keep plugin toolbars UI-framework-free and avoid file access. */
const IconDataUriSchema = z
  .string()
  .regex(/^data:image\/(png|svg\+xml);base64,/, "Toolset icons must be base64 png or svg+xml data URIs.")
  .max(64_000);

export const PluginToolsetItemSchema = z
  .object({
    commandId: PluginCommandIdSchema,
    title: NonEmptyStringSchema.optional(),
    iconDataUri: IconDataUriSchema.optional(),
    shortcutDisplay: z.string().optional()
  })
  .strict();

export const PluginToolsetGroupSchema = z
  .object({
    id: IdSchema.optional(),
    title: NonEmptyStringSchema.optional(),
    items: z.array(PluginToolsetItemSchema).min(1)
  })
  .strict();

export const PluginToolsetContributionSchema = z
  .object({
    id: IdSchema.regex(/^plugin\.[A-Za-z0-9][A-Za-z0-9._-]*$/, 'Plugin toolset ids must be namespaced under "plugin.".'),
    title: NonEmptyStringSchema,
    defaultVisible: z.boolean().default(false),
    groups: z.array(PluginToolsetGroupSchema).min(1),
    preferredWindowSize: z
      .object({
        width: z.number().positive(),
        height: z.number().positive()
      })
      .strict()
      .optional(),
    requiredPermissions: OptionalPermissionListSchema
  })
  .strict();

export const PluginPanelContributionSchema = z
  .object({
    id: PluginPanelIdSchema,
    title: NonEmptyStringSchema,
    commandId: PluginCommandIdSchema.optional(),
    requiredPermissions: OptionalPermissionListSchema
  })
  .strict();

export const PluginTemplateContributionSchema = z
  .object({
    id: IdSchema,
    title: NonEmptyStringSchema,
    category: z.string().optional(),
    commandId: PluginCommandIdSchema.optional(),
    requiredPermissions: OptionalPermissionListSchema
  })
  .strict();

export const PluginFormatContributionSchema = z
  .object({
    id: IdSchema,
    title: NonEmptyStringSchema,
    fileExtensions: z.array(z.string().min(1)).default([]),
    commandId: PluginCommandIdSchema,
    requiredPermissions: OptionalPermissionListSchema
  })
  .strict();

export const PluginAnalyzerContributionSchema = z
  .object({
    id: CompatiblePluginAnalyzerIdSchema,
    title: NonEmptyStringSchema,
    commandId: PluginCommandIdSchema,
    requiredPermissions: OptionalPermissionListSchema
  })
  .strict();

export const PluginTransformerContributionSchema = z
  .object({
    id: IdSchema,
    title: NonEmptyStringSchema,
    commandId: PluginCommandIdSchema,
    requiredPermissions: OptionalPermissionListSchema
  })
  .strict();

export const PluginRecognizerContributionSchema = z
  .object({
    id: IdSchema,
    title: NonEmptyStringSchema,
    input: z.enum(["selected-image", "pasted-image", "image-file"]).default("selected-image"),
    commandId: PluginCommandIdSchema,
    requiredPermissions: OptionalPermissionListSchema
  })
  .strict();

export const PluginContributionsSchema = z
  .object({
    commands: z.array(PluginCommandContributionSchema).default([]),
    menus: z.array(PluginMenuContributionSchema).default([]),
    panels: z.array(PluginPanelContributionSchema).default([]),
    toolbarButtons: z.array(PluginToolbarContributionSchema).default([]),
    toolsets: z.array(PluginToolsetContributionSchema).default([]),
    inspectors: z.array(PluginPanelContributionSchema).default([]),
    templates: z.array(PluginTemplateContributionSchema).default([]),
    importers: z.array(PluginFormatContributionSchema).default([]),
    exporters: z.array(PluginFormatContributionSchema).default([]),
    analyzers: z.array(PluginAnalyzerContributionSchema).default([]),
    transformers: z.array(PluginTransformerContributionSchema).default([]),
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

    addDuplicateIssue(
      manifest.contributes.toolsets.map((toolset) => toolset.id),
      ["contributes", "toolsets"],
      "toolset id",
      ctx
    );

    addDuplicateIssue(
      manifest.contributes.menus.map((menu) => menu.id),
      ["contributes", "menus"],
      "menu id",
      ctx
    );

    addDuplicateIssue(
      manifest.contributes.panels.map((panel) => panel.id),
      ["contributes", "panels"],
      "panel id",
      ctx
    );

    addDuplicateIssue(
      manifest.contributes.analyzers.map((analyzer) => analyzer.id),
      ["contributes", "analyzers"],
      "analyzer id",
      ctx
    );

    // Toolbar buttons never own behavior: every toolset item must invoke a command this
    // same plugin contributes, so permissions and provenance stay attached to the command.
    const contributedCommandIds = new Set(manifest.contributes.commands.map((command) => command.id));
    manifest.contributes.toolsets.forEach((toolset, toolsetIndex) => {
      toolset.groups.forEach((group, groupIndex) => {
        group.items.forEach((item, itemIndex) => {
          if (!contributedCommandIds.has(item.commandId)) {
            ctx.addIssue({
              code: z.ZodIssueCode.custom,
              path: ["contributes", "toolsets", toolsetIndex, "groups", groupIndex, "items", itemIndex, "commandId"],
              message: `Toolset item references command "${item.commandId}" that this plugin does not contribute.`
            });
          }
        });
      });
    });
  });

/** Declarative panel content: plugins describe results as data (never framework
 *  components), and the host renders them with core UI. Static spectra travel as SVG
 *  strings rendered in an <img> context so scripts can never execute. The `linkedFigure`
 *  section is richer: the plugin ships only *data* (peaks + chemistry-agnostic point/line
 *  geometry) and the trusted core renders an interactive, zoomable figure with hover
 *  cross-highlighting — no plugin-supplied script or components (ADR-0015). */
export const PluginPanelSectionSchema = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("text"),
      title: NonEmptyStringSchema.optional(),
      body: z.string()
    })
    .strict(),
  z
    .object({
      kind: z.literal("keyValue"),
      title: NonEmptyStringSchema.optional(),
      rows: z.array(z.object({ label: z.string(), value: z.string() }).strict())
    })
    .strict(),
  z
    .object({
      kind: z.literal("table"),
      title: NonEmptyStringSchema.optional(),
      columns: z.array(z.string()),
      rows: z.array(z.array(z.string()))
    })
    .strict(),
  z
    .object({
      kind: z.literal("svg"),
      title: NonEmptyStringSchema.optional(),
      svg: z.string().max(512_000),
      caption: z.string().optional()
    })
    .strict(),
  // Core-owned interactive figure (ADR-0015). Plugins supply serializable data only; the desktop
  // renders a zoomable spectrum linked to an annotated structure with hover cross-highlighting.
  // Geometry is chemistry-agnostic (points, lines, labels) so the section stays domain-neutral.
  z
    .object({
      kind: z.literal("linkedFigure"),
      title: NonEmptyStringSchema.optional(),
      caption: z.string().optional(),
      spectrum: z
        .object({
          /** Free-form axis label token, e.g. "1H" or "13C". Rendered, not interpreted. */
          nucleus: z.string(),
          /** Suggested ppm range. The renderer expands it when a supplied peak falls outside. */
          domain: z.object({ min: z.number(), max: z.number() }).strict(),
          /** NMR convention plots high→low left→right; default true. */
          reversed: z.boolean().optional(),
          /** Solvent context of the reference data (e.g. "CDCl₃ (predominant reference solvent)"). */
          solvent: z.string().min(1).max(120).optional(),
          /** Provider-owned comparison capability and labels. This may be present with zero
           * currently applicable alternative values; per-peak `alternativePpm` is the availability
           * source of truth, allowing the renderer to explain a primary-only result. */
          comparison: z
            .object({
              primaryLabel: NonEmptyStringSchema,
              alternativeLabel: NonEmptyStringSchema,
              /** Short visual suffix for the alternative value, e.g. "ᵢ". */
              alternativeMarker: z.string().min(1).max(8).optional()
            })
            .strict()
            .optional(),
          peaks: z
            .array(
              z
                .object({
                  id: NonEmptyStringSchema,
                  ppm: z.number(),
                  /** Relative stick height (e.g. equivalent-nuclei count); >= 0. */
                  intensity: z.number().min(0),
                  label: z.string().optional(),
                  /** Structure atom `index` values this peak is assigned to (for cross-highlight). */
                  atomIndices: z.array(z.number().int().min(0)).max(4000),
                  /** True when the shift is a coarse rule estimate, not a reference-DB match. */
                  estimated: z.boolean().optional(),
                  /** Plugin-supplied confidence tier; low peaks draw muted. */
                  confidence: z.enum(["high", "medium", "low"]).optional(),
                  /** Optional alternative estimate for the same peak. A renderer may show it beside
                   * the primary value; the producing plugin owns its method and eligibility policy. */
                  alternativePpm: z.number().optional(),
                  /** First-order couplings (Hz + equivalent-partner count) for drawing split peaks. */
                  couplings: z
                    .array(z.object({ jHz: z.number(), partnerCount: z.number().int().min(0) }).strict())
                    .max(16)
                    .optional()
                })
                .strict()
            )
            .max(4000)
        })
        .strict(),
      /** Optional 2D depiction. Omitted when the backend has no molecule geometry (e.g. a fixture). */
      structure: z
        .object({
          atoms: z
            .array(
              z
                .object({
                  index: z.number().int().min(0),
                  x: z.number(),
                  y: z.number(),
                  element: z.string()
                })
                .strict()
            )
            .max(4000),
          bonds: z
            .array(
              z
                .object({
                  from: z.number().int().min(0),
                  to: z.number().int().min(0),
                  order: z.number().int().min(1).max(3)
                })
                .strict()
            )
            .max(8000)
        })
        .strict()
        .optional()
    })
    .strict()
]);

export const PluginPanelReportSchema = z
  .object({
    title: NonEmptyStringSchema,
    sections: z.array(PluginPanelSectionSchema),
    /**
     * Optional reference to the document object this report was computed from, with the selection
     * fingerprint at computation time. Desktop chrome compares it against the live document to flag a
     * stale report (the structure changed since it was computed). See createStructureSourceFingerprint.
     */
    source: z
      .object({
        objectId: NonEmptyStringSchema,
        sourceFingerprint: NonEmptyStringSchema
      })
      .optional(),
    /**
     * The command the host's "Run again" should re-invoke for this report. Lets a report re-run the
     * exact variant that produced it (e.g. the ¹H command for a ¹H report) instead of the panel
     * contribution's single default command. When absent, chrome falls back to the panel's commandId.
     */
    rerunCommandId: NonEmptyStringSchema.optional()
  })
  .strict();

export type PluginPanelSection = z.infer<typeof PluginPanelSectionSchema>;
export type PluginPanelReport = z.infer<typeof PluginPanelReportSchema>;

/** The interactive figure section (ADR-0015), extracted for composers and the core renderer. */
export type PluginLinkedFigureSection = Extract<PluginPanelSection, { kind: "linkedFigure" }>;
export type PluginLinkedFigureSpectrum = PluginLinkedFigureSection["spectrum"];
export type PluginLinkedFigurePeak = PluginLinkedFigureSpectrum["peaks"][number];
export type PluginLinkedFigureStructure = NonNullable<PluginLinkedFigureSection["structure"]>;
export type PluginLinkedFigureAtom = PluginLinkedFigureStructure["atoms"][number];
export type PluginLinkedFigureBond = PluginLinkedFigureStructure["bonds"][number];

export interface PluginPanelAPI {
  showReport(panelId: string, report: PluginPanelReport): Promise<void>;
}

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

/** Own-property names that poison `Object.prototype` (or an object's prototype chain) when copied
 *  onto a target by ordinary assignment/merge. `JSON.parse` and `structuredClone` both produce these
 *  as real own keys, so a worker can send one across the boundary. */
const PROTOTYPE_POLLUTION_KEYS = new Set(["__proto__", "constructor", "prototype"]);

/**
 * Refuse a patch whose object graph carries a prototype-polluting own key.
 *
 * `DocumentPatchLikeSchema` is deliberately `passthrough()`: the patch interior is chem-core's
 * business, and plugin-api may not take a runtime dependency on chem-core (the M33 SDK boundary), so
 * it cannot re-validate the op union here. That leaves this schema as the only checkpoint between
 * untrusted worker output and a trusted `applyPatch`, so it at least refuses the one class of key
 * that is dangerous purely by virtue of being copied. Rejecting (rather than silently stripping)
 * keeps a malformed or hostile plugin loud instead of half-applied.
 */
function hasPrototypePollutionKey(value: unknown, seen: Set<object> = new Set()): boolean {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  if (seen.has(value)) {
    return false; // already inspected; also stops a cyclic graph from recursing forever
  }
  seen.add(value);
  if (Array.isArray(value)) {
    return value.some((entry) => hasPrototypePollutionKey(entry, seen));
  }
  for (const key of Object.getOwnPropertyNames(value)) {
    if (PROTOTYPE_POLLUTION_KEYS.has(key)) {
      return true;
    }
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    // Read through the descriptor: a getter would otherwise run during traversal.
    if (descriptor && "value" in descriptor && hasPrototypePollutionKey(descriptor.value, seen)) {
      return true;
    }
  }
  return false;
}

const DocumentPatchLikeSchema = z
  .unknown()
  // Checked on the RAW input, before the object parse. zod writes a top-level `__proto__` with
  // ordinary assignment, which invokes the prototype setter instead of creating an own key — so by
  // the time a `.superRefine()` on the parsed output runs, the most dangerous case is invisible.
  .superRefine((raw, ctx) => {
    if (hasPrototypePollutionKey(raw)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Proposed patch contains a prototype-polluting key (__proto__, constructor, or prototype)."
      });
    }
  })
  .pipe(
    z
      .object({
        op: NonEmptyStringSchema
      })
      .passthrough()
  )
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
export type PluginToolsetItem = z.infer<typeof PluginToolsetItemSchema>;
export type PluginToolsetGroup = z.infer<typeof PluginToolsetGroupSchema>;
export type PluginToolsetContribution = z.infer<typeof PluginToolsetContributionSchema>;
export type PluginPanelContribution = z.infer<typeof PluginPanelContributionSchema>;
export type PluginTemplateContribution = z.infer<typeof PluginTemplateContributionSchema>;
export type PluginFormatContribution = z.infer<typeof PluginFormatContributionSchema>;
export type PluginAnalyzerContribution = z.infer<typeof PluginAnalyzerContributionSchema>;
export type PluginTransformerContribution = z.infer<typeof PluginTransformerContributionSchema>;
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

export const PluginStructureFormatSchema = z.enum(["smiles", "molfile-v2000", "molfile-v3000", "unknown"]);

/** Structure serialization a selection snapshot may carry. Mirrors the document model's structure
 *  formats; a consumer (e.g. the NMR request) rejects "unknown" before use. */
export type PluginStructureFormat = z.infer<typeof PluginStructureFormatSchema>;

export interface PluginSelectedMolecule {
  objectId: string;
  /** ChemDraft document/page identity, when the provider has page context. */
  documentId?: string;
  pageId?: string;
  structureFormat: PluginStructureFormat;
  structure: string;
  /**
   * Change detector for the source payload — NOT a canonical chemical identity or molecular hash.
   * A redraw or reserialization of an equivalent molecule may change it (safe over-invalidation).
   * Produced by {@link createStructureSourceFingerprint}.
   */
  sourceFingerprint: string;
}

export interface PluginSelectionSnapshot {
  objectIds: readonly string[];
  molecules: readonly PluginSelectedMolecule[];
}

export interface PluginSelectionAPI {
  getSelection(): Promise<PluginSelectionSnapshot>;
}

/**
 * Deterministic, synchronous, NON-cryptographic fingerprint of a selected structure's source
 * payload, used to detect when a stored analysis no longer matches the current selection. It is a
 * change detector, not a molecular identity: equivalent molecules with different serializations can
 * hash differently. FNV-1a (64-bit) over the joined identity + trimmed payload — dependency-free and
 * platform-stable (deliberately not `crypto.subtle`, which is async and absent in some worker/webview
 * contexts).
 */
export function createStructureSourceFingerprint(input: {
  documentId: string;
  pageId: string;
  objectId: string;
  structureFormat: string;
  structure: string;
}): string {
  const material = [
    input.documentId,
    input.pageId,
    input.objectId,
    input.structureFormat,
    input.structure.trim()
  ].join("\u001f");

  const OFFSET_BASIS = 0xcbf29ce484222325n;
  const PRIME = 0x100000001b3n;
  const MASK_64 = 0xffffffffffffffffn;
  let hash = OFFSET_BASIS;
  for (const byte of new TextEncoder().encode(material)) {
    hash ^= BigInt(byte);
    hash = (hash * PRIME) & MASK_64;
  }
  return hash.toString(16).padStart(16, "0");
}

/** Generic, framework- and domain-neutral derived-analysis records. The host owns id/plugin/time;
 *  the payload is opaque (`unknown`) and interpreted only by the plugin and desktop that share its
 *  `analysisType`/`schemaVersion`. No NMR (or any domain) concepts appear here. */
export const PluginAnalysisSourceSchema = z
  .object({
    documentId: NonEmptyStringSchema,
    pageId: NonEmptyStringSchema,
    objectId: NonEmptyStringSchema,
    sourceFingerprint: NonEmptyStringSchema
  })
  .strict();

export interface PluginAnalysisSource {
  documentId: string;
  pageId: string;
  objectId: string;
  /** The selection fingerprint the analysis was computed against; see createStructureSourceFingerprint. */
  sourceFingerprint: string;
}

export const PluginAnalysisProvenanceSchema = z
  .object({
    engineId: NonEmptyStringSchema,
    engineVersion: NonEmptyStringSchema.optional(),
    dataVersion: NonEmptyStringSchema.optional(),
    method: NonEmptyStringSchema
  })
  .strict();

export interface PluginAnalysisProvenance {
  engineId: string;
  engineVersion?: string;
  dataVersion?: string;
  method: string;
}

export const PluginAnalysisWarningSchema = z
  .object({
    code: NonEmptyStringSchema,
    message: NonEmptyStringSchema,
    severity: z.enum(["info", "warning", "error"]),
    details: z.record(z.string(), z.unknown()).optional()
  })
  .strict();

export interface PluginAnalysisWarning {
  code: string;
  message: string;
  severity: "info" | "warning" | "error";
  details?: Readonly<Record<string, unknown>>;
}

/** Runtime boundary for analysis writes received from worker or third-party plugin code. The
 *  domain payload intentionally remains opaque; the host validates the identity/query fields that
 *  it dereferences and rejects stray or malformed envelope data before storing it. */
export const PluginAnalysisRecordInputSchema = z
  .object({
    analysisType: NonEmptyStringSchema,
    schemaVersion: NonEmptyStringSchema,
    source: PluginAnalysisSourceSchema,
    status: z.enum(["complete", "partial", "failed"]),
    payload: z.unknown(),
    warnings: z.array(PluginAnalysisWarningSchema).optional(),
    provenance: PluginAnalysisProvenanceSchema
  })
  .strict();

export interface PluginAnalysisRecordInput<TPayload = unknown> {
  analysisType: string;
  schemaVersion: string;
  source: PluginAnalysisSource;
  status: "complete" | "partial" | "failed";
  payload: TPayload;
  warnings?: readonly PluginAnalysisWarning[];
  provenance: PluginAnalysisProvenance;
}

export function parsePluginAnalysisRecordInput<TPayload = unknown>(candidate: unknown): PluginAnalysisRecordInput<TPayload> {
  return PluginAnalysisRecordInputSchema.parse(candidate) as PluginAnalysisRecordInput<TPayload>;
}

export interface PluginAnalysisRecord<TPayload = unknown> extends PluginAnalysisRecordInput<TPayload> {
  /** Host-generated. */
  id: string;
  /** Host-stamped from the invoking plugin. */
  pluginId: string;
  /** Host-stamped from the injectable clock. */
  createdAt: string;
}

export interface PluginAnalysisQuery {
  pluginId?: string;
  analysisType?: string;
  documentId?: string;
  pageId?: string;
  objectId?: string;
}

export interface PluginAnalysisAPI {
  write<TPayload>(input: PluginAnalysisRecordInput<TPayload>): Promise<PluginAnalysisRecord<TPayload>>;
  list<TPayload = unknown>(query?: PluginAnalysisQuery): Promise<readonly PluginAnalysisRecord<TPayload>[]>;
  getLatest<TPayload = unknown>(query: PluginAnalysisQuery): Promise<PluginAnalysisRecord<TPayload> | undefined>;
}

/**
 * Chemistry the host computes on a plugin's behalf, gated by `chemistry.compute`.
 *
 * This exists so a plugin need not reimplement chemistry the application already owns. The
 * mass-fragment demo shipped its own eight-element abundance table and a first-order M/M+1/M+2
 * estimate precisely because the SDK boundary (ADR-0028 §1) stops a plugin reaching the core's
 * engines — and the result was a second, worse, unsourced implementation of something the host does
 * properly. Asking the host is the way out that leaves the boundary intact.
 */
export interface PluginIsotopeEnvelopeRequest {
  format: "smiles" | "molfile-v2000" | "molfile-v3000";
  structure: string;
}

export const PluginIsotopeEnvelopeRequestSchema = z
  .object({
    format: z.enum(["smiles", "molfile-v2000", "molfile-v3000"]),
    structure: NonEmptyStringSchema
  })
  .strict();

export interface PluginIsotopeEnvelopePeak {
  /** Neutral-molecule mass in daltons — not m/z: no adduct, no charge. */
  mass: number;
  /** Normalised to the base peak at 100. */
  relativeIntensity: number;
}

/**
 * Either the envelope, or why there is not one.
 *
 * A discriminated result rather than a throw or an empty list, because the host declines for real
 * chemical reasons a plugin has to be able to show a reader: a charged structure has no neutral mass
 * to report, and an isotope-labelled one cannot be expressed to the engine at all.
 */
export type PluginIsotopeEnvelopeResult =
  | {
      available: true;
      peaks: readonly PluginIsotopeEnvelopePeak[];
      /** What the engine dropped, and how much of the distribution survived. */
      truncation: { policy: string; threshold: number; coveredProbability?: number };
      engine: { id: string; version: string };
      /** The named choices behind these intensities — above all, which abundance table produced them. */
      conventions: readonly string[];
    }
  | { available: false; reason: string };

export interface PluginNameToStructureRequest {
  /** A systematic chemical name, e.g. "2-acetyloxybenzoic acid". */
  name: string;
}

export const PluginNameToStructureRequestSchema = z
  .object({ name: NonEmptyStringSchema })
  .strict();

/**
 * Either a structure, or why the name did not become one.
 *
 * The two failure modes are deliberately distinct, because a plugin should tell a reader different
 * things about them. `available: false` means the engine is not there to ask — a build without the
 * bundled runtime — and nothing about the name. A `parsed: false` result means the engine ran and
 * could not interpret the name, and carries the engine's own words for why.
 */
export type PluginNameToStructureResult =
  | {
      available: true;
      parsed: true;
      /** SMILES for the named compound, from the engine. Stereodescriptors are preserved. */
      smiles: string;
      engine: { id: string; version: string };
    }
  | {
      available: true;
      parsed: false;
      /** The engine's own diagnostic, never a synthesised one. */
      reason: string;
      engine: { id: string; version: string };
    }
  | { available: false; reason: string };

export interface PluginStructureFromSmilesRequest {
  smiles: string;
  /** Recorded on the object so a reader can tell what produced it. Free text, e.g. a plugin name. */
  origin?: string;
}

export const PluginStructureFromSmilesRequestSchema = z
  .object({ smiles: NonEmptyStringSchema, origin: z.string().max(200).optional() })
  .strict();

/**
 * A drawable object, or why there is not one.
 *
 * The object is returned rather than inserted, because inserting is `proposePatch`'s job and that
 * queue is what gives the user a review step. A plugin gets the thing it could not build for itself —
 * atoms, bonds, and **2D coordinates** — and still has to propose it like any other change.
 */
export type PluginStructureFromSmilesResult =
  | { available: true; built: true; object: DocumentObject }
  | { available: true; built: false; reason: string }
  | { available: false; reason: string };

export interface PluginChemistryAPI {
  isotopeEnvelope(request: PluginIsotopeEnvelopeRequest): Promise<PluginIsotopeEnvelopeResult>;
  /**
   * Lay a SMILES out as a document object a plugin can propose.
   *
   * This exists because 2D layout is the drawing application's work, not a plugin's: a plugin that
   * invented coordinates would produce a molecule with unusable geometry, and one that shipped its own
   * layout engine would be the mass-fragment demo's abundance table all over again. Optional for the
   * same version-skew reason as `nameToStructure`.
   */
  structureFromSmiles?(
    request: PluginStructureFromSmilesRequest
  ): Promise<PluginStructureFromSmilesResult>;
  /**
   * Name → structure. Optional on purpose: a host that cannot offer it simply omits it, and a plugin
   * that finds it missing reports the capability as absent rather than failing. Making it required
   * would break every existing host implementation of this interface for a capability that is, by
   * design, allowed not to be there.
   */
  nameToStructure?(request: PluginNameToStructureRequest): Promise<PluginNameToStructureResult>;
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
  /** Present only when the plugin declares "selection.read". */
  selection?: PluginSelectionAPI;
  /** Present only when the plugin declares "ui.panel" and the host renders panels. */
  panels?: PluginPanelAPI;
  /** Present only when the plugin declares "analysis.write". */
  analysis?: PluginAnalysisAPI;
  /** Present only when the plugin declares "chemistry.compute" and the host provides an engine. */
  chemistry?: PluginChemistryAPI;
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
    ...contributions.toolsets.map((contribution, index) => ({
      path: ["contributes", "toolsets", index, "requiredPermissions"],
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

// --- Per-plugin Web Worker isolation boundary (ADR-0029, M34) --------------------------------------
// The versioned message protocol and the worker-side runtime that lets a bundled plugin run in its own
// Worker with its whole capability contract crossing as async request/response messages. Kept behind
// this single SDK import so a plugin's source needs no new `@chemdraft/*` import to run in a worker.
export {
  PLUGIN_WORKER_PROTOCOL_VERSION,
  PLUGIN_WORKER_CAPABILITY_METHODS,
  PluginWorkerErrorCodes,
  isPluginApiVersionCompatible,
  checkWorkerHandshake,
  type PluginWorkerCapabilityNamespace,
  type PluginWorkerErrorPayload,
  type WorkerToHostMessage,
  type HostToWorkerMessage,
  type PluginWorkerEndpoint,
  type PluginWorkerHandle
} from "./workerProtocol";

export { runPluginWorker, PluginWorkerCapabilityError, type PluginWorkerRegistration } from "./workerRuntime";

// --- Built plugin package (ADR-0029 §5, M35) -------------------------------------------------------
// The `manifest.json` contract of the installable zip: a superset of PluginManifest carrying the built
// entry filename plus packaging provenance. Shared by the `plugin:package` tool that writes it and the
// host that reads it, so a package stays loadable without this monorepo.
export {
  PACKAGED_PLUGIN_MANIFEST_FILE,
  PACKAGED_PLUGIN_PROVENANCE_KEY,
  PackagedPluginProvenanceSchema,
  createPackagedPluginManifestDocument,
  isPackagedPluginManifestDocument,
  parsePackagedPluginManifest,
  type PackagedPluginManifest,
  type PackagedPluginManifestDocument,
  type PackagedPluginProvenance
} from "./packageManifest";
