// Frozen from tag v1.1.1:packages/toolset-registry/src/index.ts.
// Do not import current schemas here: this fixture guards downgrade compatibility.
// Only the helper type annotation/cast is adapted to keep this snapshot self-contained.
import { z } from "zod";

const NonEmptyStringSchema = z.string().trim().min(1);
const CommandIdSchema = NonEmptyStringSchema.regex(
  /^[A-Za-z0-9]+(?:[._:-][A-Za-z0-9]+)*$/,
  "Command IDs must be non-empty identifiers without whitespace."
);

export function isValidToolsetCommandId(id: string): boolean {
  return CommandIdSchema.safeParse(id).success;
}

const IconDataUriSchema = z
  .string()
  .regex(/^data:image\/(png|svg\+xml);base64,/, "Toolset icons must be base64 png or svg+xml data URIs.")
  .max(64_000);

export const ToolsetSourceSchema = z.enum(["core", "plugin", "user"]);
export const ToolsetModeSchema = z.enum(["floating", "docked", "hidden"]);
export const ToolsetOrientationSchema = z.enum(["vertical", "horizontal"]);

export const ToolsetGridLayoutSchema = z
  .object({
    orientation: ToolsetOrientationSchema.optional(),
    rows: z.number().int().positive().optional(),
    columns: z.number().int().positive().optional(),
    cellWidth: z.number().positive().optional(),
    cellHeight: z.number().positive().optional(),
    gap: z.number().int().nonnegative().optional(),
    padding: z.number().int().nonnegative().optional()
  })
  .strict();

export const ToolsetItemPlacementSchema = z
  .object({
    groupId: NonEmptyStringSchema.optional(),
    row: z.number().int().nonnegative().optional(),
    column: z.number().int().nonnegative().optional(),
    order: z.number().int().nonnegative().optional()
  })
  .strict();

export const ToolsetWindowSizeSchema = z
  .object({
    width: z.number().positive(),
    height: z.number().positive(),
    minWidth: z.number().positive().optional(),
    minHeight: z.number().positive().optional()
  })
  .strict();

export const ToolsetItemKindSchema = z.enum(["button", "toggle", "control", "separator", "spacer"]);

export const ToolsetPrimaryActionSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("command"), commandId: CommandIdSchema }).strict(),
  z.object({ type: z.literal("control"), controlId: NonEmptyStringSchema }).strict(),
  z.object({ type: z.literal("none") }).strict()
]);

export const ToolsetTooltipSchema = z
  .object({
    title: NonEmptyStringSchema.optional(),
    description: z.string().nullable().optional(),
    shortcut: z.string().nullable().optional()
  })
  .strict();

export const ToolsetSubmenuItemSchema = z
  .object({
    commandId: CommandIdSchema,
    label: NonEmptyStringSchema.optional(),
    title: NonEmptyStringSchema.optional(),
    icon: NonEmptyStringSchema.optional(),
    assetName: NonEmptyStringSchema.optional(),
    iconDataUri: IconDataUriSchema.optional(),
    tooltip: ToolsetTooltipSchema.optional()
  })
  .strict();

export const ToolsetSubmenuSchema = z
  .object({
    type: z.literal("command-grid"),
    id: NonEmptyStringSchema.optional(),
    title: NonEmptyStringSchema.optional(),
    columns: z.number().int().positive().optional(),
    items: z.array(ToolsetSubmenuItemSchema).min(1)
  })
  .strict();

export const ToolsetItemLayoutSchema = z
  .object({
    colSpan: z.number().int().positive().optional(),
    rowSpan: z.number().int().positive().optional()
  })
  .strict();

export const ToolsetItemSchema = z
  .object({
    commandId: CommandIdSchema.optional(),
    id: NonEmptyStringSchema.optional(),
    kind: ToolsetItemKindSchema.optional(),
    label: NonEmptyStringSchema.optional(),
    title: NonEmptyStringSchema.optional(),
    icon: NonEmptyStringSchema.optional(),
    assetName: NonEmptyStringSchema.optional(),
    /** Inline icon for contributions that cannot ship named assets (plugins). */
    iconDataUri: IconDataUriSchema.optional(),
    shortcutDisplay: z.string().optional(),
    disabledReason: z.string().optional(),
    category: z.string().optional(),
    placement: ToolsetItemPlacementSchema.optional(),
    primary: ToolsetPrimaryActionSchema.optional(),
    submenu: ToolsetSubmenuSchema.nullish(),
    tooltip: ToolsetTooltipSchema.optional(),
    layout: ToolsetItemLayoutSchema.optional()
  })
  .strict()
  .superRefine((item, context) => {
    if (
      item.primary === undefined &&
      item.commandId === undefined &&
      item.kind !== "separator" &&
      item.kind !== "spacer"
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Toolset items require commandId, primary, or separator/spacer kind."
      });
    }
    if (item.primary?.type === "command" && item.commandId !== undefined && item.primary.commandId !== item.commandId) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Toolset item commandId must match primary.commandId."
      });
    }
  });

export const ToolsetGroupSchema = z
  .object({
    id: NonEmptyStringSchema.optional(),
    title: NonEmptyStringSchema.optional(),
    items: z.array(ToolsetItemSchema).min(1)
  })
  .strict();

export const ToolsetDefinitionSchema = z
  .object({
    id: NonEmptyStringSchema,
    title: NonEmptyStringSchema,
    source: ToolsetSourceSchema,
    defaultVisible: z.boolean(),
    defaultMode: ToolsetModeSchema,
    groups: z.array(ToolsetGroupSchema).min(1),
    preferredWindowSize: ToolsetWindowSizeSchema.optional(),
    category: z.string().optional(),
    gridLayout: ToolsetGridLayoutSchema.optional(),
    clonedFromToolsetId: NonEmptyStringSchema.optional()
  })
  .strict();

export const ToolsetItemOverrideSchema = z
  .object({
    commandId: CommandIdSchema,
    hidden: z.boolean().optional(),
    placement: ToolsetItemPlacementSchema.optional(),
    layout: ToolsetItemLayoutSchema.optional()
  })
  .strict();

// The ONE way a CORE (or plugin) toolset gains a *new* item via layout state: an explicit,
// add-only insertion. Structural edits to core toolsets are otherwise forbidden (only user.*
// toolsets carry their own groups); an addition never mutates a manifest item, only appends one.
// The item must yield a customization id (command id / control id / explicit id on a spacer) so
// itemOrder / hiddenCommandIds can address it and applyUserToolsetOverride can reorder/hide it.
export const ToolsetItemAdditionSchema = z
  .object({
    groupId: NonEmptyStringSchema,
    index: z.number().int().nonnegative().optional(),
    item: ToolsetItemSchema
  })
  .strict()
  .superRefine((addition, context) => {
    if (toolsetItemCustomizationId(addition.item) === undefined) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message:
          "Toolset item additions require a customization id (commandId, control primary, or an explicit id on a spacer/separator)."
      });
    }
  });

export const UserToolsetOverrideSchema = z
  .object({
    toolsetId: NonEmptyStringSchema,
    title: NonEmptyStringSchema.optional(),
    visible: z.boolean().optional(),
    mode: ToolsetModeSchema.optional(),
    groupOrder: z.array(NonEmptyStringSchema).optional(),
    itemOrder: z.record(z.array(CommandIdSchema)).optional(),
    hiddenCommandIds: z.array(CommandIdSchema).optional(),
    itemOverrides: z.array(ToolsetItemOverrideSchema).optional(),
    itemAdditions: z.array(ToolsetItemAdditionSchema).optional(),
    preferredWindowSize: ToolsetWindowSizeSchema.optional(),
    gridLayout: ToolsetGridLayoutSchema.optional()
  })
  .strict();

// User toolsets may have empty groups (a freshly created toolbar, or one being emptied mid-edit in
// the Customize dialog). Core/plugin toolsets keep the stricter `items.min(1)` via ToolsetGroupSchema.
export const UserToolsetGroupSchema = z
  .object({
    id: NonEmptyStringSchema.optional(),
    title: NonEmptyStringSchema.optional(),
    items: z.array(ToolsetItemSchema)
  })
  .strict();

export const UserToolsetDefinitionSchema = ToolsetDefinitionSchema.extend({
  source: z.literal("user"),
  clonedFromToolsetId: NonEmptyStringSchema.optional(),
  groups: z.array(UserToolsetGroupSchema).min(1)
}).strict();

// Toolsets handed to a ToolsetRegistry may be DERIVED — the output of applyToolsetLayoutState, where
// customization can legitimately empty a group (hidden items) or empty a whole toolset (every item
// hidden, or a freshly-created user toolbar). This lenient schema validates the shape but tolerates
// those empties. The STRICT non-empty invariant for authored manifests stays in ToolsetManifestSchema
// (parseToolsetManifest), so registering a derived layout can never crash the way register() did.
export const RegisteredToolsetSchema = ToolsetDefinitionSchema.extend({
  groups: z.array(UserToolsetGroupSchema)
}).strict();

export const ToolsetLayoutStateSchema = z
  .object({
    version: z.literal(1),
    toolsetOrder: z.array(NonEmptyStringSchema).optional(),
    toolsetOverrides: z.array(UserToolsetOverrideSchema).default([]),
    userToolsets: z.array(UserToolsetDefinitionSchema).default([])
  })
  .strict();


function toolsetItemCustomizationId(
  item: z.infer<typeof ToolsetItemSchema>
): string | undefined {
  if (item.commandId !== undefined) {
    return item.commandId;
  }
  if (item.primary?.type === "command") {
    return item.primary.commandId;
  }
  // Control (widget) items are customizable by their controlId, so the editor can hide/reorder them
  // like commands (a `widget.*` controlId is a valid CommandId per CommandIdSchema).
  if (item.primary?.type === "control") {
    return item.primary.controlId;
  }
  // A spacer/separator carrying an EXPLICIT id (as customize-added items always do) is addressable
  // by that id — so it can be reordered and removed like any other item. Position-synthesized
  // separator ids (no explicit item.id) stay unaddressable, exactly as before.
  if ((item.kind === "spacer" || item.kind === "separator") && item.id !== undefined) {
    return item.id;
  }
  return undefined;
}
